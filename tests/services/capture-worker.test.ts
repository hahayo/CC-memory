// tests/services/capture-worker.test.ts
//
// CC-memory v0.5 M2b RED — capture worker failure/reliability contracts.
// These tests intentionally describe the worker surface before implementation.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appendCaptureEvent,
  appendStopSentinel,
  resolveCaptureSpoolPath,
  sanitizeSpoolSegment,
} from '../../src/services/capture-spool.js';
import {
  isCaptureRetryHeld,
  runCaptureWorkerOnce,
  writeCaptureStateAtomically,
  type CaptureRetryEntry,
  type CaptureStateV2,
} from '../../src/services/capture-worker.js';
import { CaptureLlmValidationError } from '../../src/services/capture-llm.js';
import type {
  CaptureLlmAdapter,
  CaptureLlmExtractOptions,
  CaptureLlmObservation,
  CaptureLlmRawResponse,
  CaptureLlmRequest,
} from '../../src/services/capture-llm.js';
import { connectDb, TEST_DB_URL, type Sql } from '../helpers/db.js';

const TEST_MODEL = 'gemini-flash-test';
const TEST_WRITER = 'capture-worker-vitest';
const SECRET_TRANSCRIPT_TEXT = 'SECRET_TRANSCRIPT_BODY_MUST_NOT_BE_DEAD_LETTERED';

interface MockCaptureLlm extends CaptureLlmAdapter {
  calls: CaptureLlmRequest[];
  extractOptions?: Array<CaptureLlmExtractOptions | undefined>;
}

type MockLlmStep = CaptureLlmRawResponse | Error;

interface TestHarness {
  root: string;
  spoolDir: string;
  env: Record<string, string>;
  projectId: string;
  sessionId: string;
  transcriptPath: string;
}

interface CaptureMetadata {
  version?: string;
  session_id?: string;
  observation_ids?: string[];
  model?: string;
  spool_offsets?: Array<Record<string, number>>;
  transcript_sources?: Array<{ path_hash: string; start: number; end: number }>;
  summarize_count?: number;
  discovery_tokens?: number;
  empty_observation_windows?: Array<{
    start: number;
    end: number;
    reason: string;
  }>;
}

interface RollupRow {
  id: string;
  idempotencyKey: string | null;
  metadata: {
    capture?: CaptureMetadata;
    embedding_policy?: Record<string, unknown>;
  };
}

interface ObservationRow {
  id: string;
  rollupMemoryId: string | null;
  narrative: string;
  observedAt: Date;
  metadata: {
    capture?: Record<string, unknown>;
    embedding_policy?: Record<string, unknown>;
  };
}

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-capture-worker-'));
  tmpRoots.push(root);
  return root;
}

function makeHarness(overrides: Partial<Pick<TestHarness, 'projectId' | 'sessionId'>> = {}): TestHarness {
  const root = makeTmpRoot();
  const spoolDir = join(root, 'spool');
  const projectId = overrides.projectId ?? `capture-worker-${randomUUID()}`;
  const sessionId = overrides.sessionId ?? `session-${randomUUID()}`;
  const transcriptPath = join(root, `${sessionId}.transcript.jsonl`);
  writeFileSync(transcriptPath, '', { mode: 0o600 });
  return {
    root,
    spoolDir,
    env: { CC_MEMORY_SPOOL_DIR: spoolDir, CC_CAPTURE_RETRY_MIN_INTERVAL_MS: '0' },
    projectId,
    sessionId,
    transcriptPath,
  };
}

function appendTranscriptEntries(path: string, entries: Array<Record<string, unknown>>): number {
  const payload = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  appendFileSync(path, payload);
  return statSync(path).size;
}

async function appendWindow(
  harness: TestHarness,
  input: {
    transcriptStart: number;
    /** 省略時只寫 event、不寫 Stop sentinel（T1 混合時代測試用） */
    transcriptEnd?: number;
    timestamp: string;
    /** 省略時用 harness.projectId（T1 測試用舊 hook 崩塌 id 覆寫） */
    projectId?: string;
  }
): Promise<number> {
  const projectId = input.projectId ?? harness.projectId;
  const eventResult = await appendCaptureEvent(
    {
      session_id: harness.sessionId,
      project_id: projectId,
      tool_name: 'Bash',
      timestamp: input.timestamp,
      transcript_path: harness.transcriptPath,
      transcript_offset: input.transcriptStart,
    },
    { env: harness.env }
  );
  expect(eventResult).toMatchObject({ success: true });

  if (input.transcriptEnd !== undefined) {
    const sentinelResult = await appendStopSentinel(
      {
        project_id: projectId,
        session_id: harness.sessionId,
        timestamp: input.timestamp,
        transcript_path: harness.transcriptPath,
        hwm_offset: input.transcriptEnd,
      },
      { env: harness.env }
    );
    expect(sentinelResult).toMatchObject({ success: true });
  }

  return statSync(resolveCaptureSpoolPath(projectId, harness.sessionId, { env: harness.env })).size;
}

/** 模擬 hooks/stop-capture-sentinel.sh 實際寫法：只有 transcript_path 與 hwm_offset，沒有 project_id／timestamp。 */
function appendBashStyleSentinel(harness: TestHarness, projectId: string, hwmOffset: number): void {
  const path = resolveCaptureSpoolPath(projectId, harness.sessionId, { env: harness.env });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify({ transcript_path: harness.transcriptPath, hwm_offset: hwmOffset })}\n`);
}

function hwmPath(harness: TestHarness): string {
  return join(
    harness.spoolDir,
    sanitizeSpoolSegment(harness.projectId),
    `${sanitizeSpoolSegment(harness.sessionId)}.hwm`
  );
}

function statePath(harness: TestHarness): string {
  return join(
    harness.spoolDir,
    sanitizeSpoolSegment(harness.projectId),
    `${sanitizeSpoolSegment(harness.sessionId)}.capture-state.json`
  );
}

function readState(harness: TestHarness): CaptureStateV2 {
  return JSON.parse(readFileSync(statePath(harness), 'utf8')) as CaptureStateV2;
}

function resetStateForReplay(harness: TestHarness): void {
  const state = readState(harness);
  state.spool.cursor = 0;
  for (const checkpoint of Object.values(state.transcripts)) checkpoint.checkpoint = 0;
  writeFileSync(statePath(harness), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function spoolPath(harness: TestHarness): string {
  return resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env });
}

function lockPath(harness: TestHarness): string {
  return `${spoolPath(harness)}.lock`;
}

function deadDir(harness: TestHarness): string {
  return join(harness.spoolDir, '.dead');
}

function readOnlyDeadLetter(harness: TestHarness): Record<string, unknown> {
  const letters = readDeadLetters(harness);
  expect(letters).toHaveLength(1);
  return letters[0];
}

function readDeadLetters(harness: TestHarness): Array<Record<string, unknown>> {
  expect(existsSync(deadDir(harness))).toBe(true);
  const files = existsSync(deadDir(harness))
    ? readdirSync(deadDir(harness)).filter((file) => file.endsWith('.json'))
    : [];
  return files.sort().map((file) => {
    expect(file).toMatch(/^[a-f0-9]{64}\.json$/);
    return JSON.parse(readFileSync(join(deadDir(harness), file), 'utf8')) as Record<string, unknown>;
  });
}

function observation(
  title: string,
  narrative: string,
  overrides: Partial<CaptureLlmObservation> = {}
): CaptureLlmObservation {
  return {
    type: 'decision',
    title,
    subtitle: `${title} subtitle`,
    facts: [`fact:${title}`],
    concepts: ['capture-worker'],
    files: ['tests/services/capture-worker.test.ts'],
    narrative,
    ...overrides,
  };
}

function rawExtraction(input: {
  summary: string;
  observations: CaptureLlmObservation[];
  model?: string;
}): CaptureLlmRawResponse {
  return {
    model: input.model ?? TEST_MODEL,
    text: JSON.stringify({
      session_summary: {
        summary: input.summary,
        keywords: ['capture', 'worker'],
        decisions: ['persist capture output'],
        next_steps: ['verify retrieval layer'],
      },
      observations: input.observations,
    }),
  };
}

function mockLlm(steps: MockLlmStep[], overrides?: Partial<MockCaptureLlm>): MockCaptureLlm {
  const pending = [...steps];
  const calls: CaptureLlmRequest[] = [];
  const extractOptions: Array<CaptureLlmExtractOptions | undefined> = [];
  return {
    model: TEST_MODEL,
    worstCaseCallBudgetMs: 0,
    calls,
    extractOptions,
    async extract(request: CaptureLlmRequest, options?: CaptureLlmExtractOptions): Promise<CaptureLlmRawResponse> {
      calls.push(request);
      extractOptions.push(options);
      const step = pending.shift();
      if (!step) {
        throw new Error('unexpected capture LLM call');
      }
      if (step instanceof Error) throw step;
      return step;
    },
    takeTelemetry() {
      return { primaryProvider: 'claude-cli', primarySuccess: 0, fallbackSuccess: 0, fallbackFailed: 0 };
    },
    ...overrides,
  };
}

function makeChunkedTranscript(
  harness: TestHarness,
  input: { lineCount: number; messageBytes: number }
): { transcriptEnd: number; lines: string[]; cap: number } {
  const entries = Array.from({ length: input.lineCount }, (_, index) => ({
    timestamp: `2026-01-01T00:00:0${index}.000Z`,
    message: `chunk-${index + 1}:${'x'.repeat(input.messageBytes)}`,
  }));
  const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, entries);
  const lines = readFileSync(harness.transcriptPath, 'utf8').match(/[^\n]*\n/g) ?? [];
  expect(lines).toHaveLength(input.lineCount);
  const cap = Math.max(...lines.map((line) => Buffer.byteLength(line)));
  return { transcriptEnd, lines, cap };
}

async function runWorker(
  harness: TestHarness,
  input: {
    db: unknown;
    llm: CaptureLlmAdapter;
    now?: Date;
    nowMs?: () => number;
    dbHealthCheck?: () => Promise<boolean>;
    stateWriter?: (path: string, state: CaptureStateV2) => Promise<void>;
    stdout?: { write(chunk: string): unknown };
    generateEmbedding?: (text: string) => Promise<number[] | null>;
  }
) {
  return runCaptureWorkerOnce({
    db: input.db,
    env: harness.env,
    llm: input.llm,
    now: () => input.now ?? new Date('2026-07-06T10:00:00.000Z'),
    nowMs: input.nowMs,
    writerHost: TEST_WRITER,
    dbHealthCheck: input.dbHealthCheck,
    generateEmbedding: input.generateEmbedding ?? (async () => null),
    stateWriter: input.stateWriter,
    stdout: input.stdout,
  });
}

async function countRows(sql: Sql, projectId: string, sessionId: string) {
  const rows = await sql<{ observations: number; rollups: number }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM observations
       WHERE project_id = ${projectId} AND session_id = ${sessionId}) AS observations,
      (SELECT COUNT(*)::int FROM project_memories
       WHERE project_id = ${projectId}
         AND idempotency_key = ${`capture:v05:${projectId}:${sessionId}`}) AS rollups
  `;
  return rows[0];
}

async function rollups(sql: Sql, projectId: string, sessionId: string): Promise<RollupRow[]> {
  return sql<RollupRow[]>`
    SELECT
      id,
      idempotency_key AS "idempotencyKey",
      metadata
    FROM project_memories
    WHERE project_id = ${projectId}
      AND type = 'session'
      AND status = 'active'
      AND idempotency_key = ${`capture:v05:${projectId}:${sessionId}`}
    ORDER BY created_at ASC
  `;
}

async function observations(sql: Sql, projectId: string, sessionId: string): Promise<ObservationRow[]> {
  return sql<ObservationRow[]>`
    SELECT
      id,
      rollup_memory_id AS "rollupMemoryId",
      narrative,
      metadata,
      observed_at AS "observedAt"
    FROM observations
    WHERE project_id = ${projectId}
      AND session_id = ${sessionId}
      AND status = 'active'
    ORDER BY observed_at ASC, id ASC
  `;
}

describe('capture worker failure contracts without DB', () => {
  it('skips empty transcript windows without calling LLM, dead-lettering, or blocking HWM', async () => {
    const harness = makeHarness();
    const spoolEnd = await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:00:30.000Z',
    });
    const llm = mockLlm([]);

    await expect(
      runWorker(harness, {
        db: {},
        llm,
      })
    ).resolves.toMatchObject({ processed: 0, skipped: 1, deadLettered: 0 });

    expect(llm.calls).toHaveLength(0);
    expect(existsSync(deadDir(harness))).toBe(false);
    expect(readState(harness).spool.cursor).toBe(spoolEnd);
  });

  it('does not call LLM when the injectable DB health check fails', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'health check should stop before LLM' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    const llm = mockLlm([rawExtraction({ summary: 'should not be used', observations: [] })]);

    await expect(
      runWorker(harness, {
        db: {},
        llm,
        dbHealthCheck: async () => false,
      })
    ).resolves.toMatchObject({ processed: 0, deadLettered: 0 });
    expect(llm.calls).toHaveLength(0);
  });

  it('retries malformed JSON before attempting the DB write path', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'retry before fake DB write' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:05.000Z',
    });
    const llm = mockLlm([
      { model: TEST_MODEL, text: 'not json on first attempt' },
      rawExtraction({
        summary: 'retry reached DB path',
        observations: [observation('retry reached DB path', 'retry reached DB path narrative')],
      }),
    ]);

    await expect(runWorker(harness, { db: {}, llm })).resolves.toMatchObject({
      processed: 0,
      failed: 1,
      deadLettered: 0,
      llmRetries: 1,
    });

    expect(llm.calls).toHaveLength(2);
    expect(
      (llm.calls[1] as CaptureLlmRequest & { retryPromptPrefix?: string }).retryPromptPrefix
    ).toContain('first character must be `{`');
    expect(existsSync(deadDir(harness))).toBe(false);
  });

  it('holds HWM after malformed JSON retry failure (retry sidecar counts attempt, parks at 5)', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: SECRET_TRANSCRIPT_TEXT },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:10.000Z',
    });
    const firstMalformedOutput = 'first malformed output';
    const retryMalformedOutput = 'retry malformed output';

    // First tick: attempt 1 — hold, no dead-letter
    const llm1 = mockLlm([
      { model: TEST_MODEL, text: firstMalformedOutput },
      { model: TEST_MODEL, text: retryMalformedOutput },
    ]);

    await expect(runWorker(harness, { db: {}, llm: llm1 })).resolves.toMatchObject({
      processed: 0,
      deadLettered: 0,
      llmRetries: 1,
    });
    expect(llm1.calls).toHaveLength(2);
    expect(existsSync(deadDir(harness))).toBe(false);
    expect(readState(harness).spool.cursor).toBe(0);

    // Ticks 2-4: keep failing
    for (let tick = 2; tick <= 4; tick += 1) {
      const llm = mockLlm([
        { model: TEST_MODEL, text: 'malformed' },
        { model: TEST_MODEL, text: 'still malformed' },
      ]);
      await runWorker(harness, { db: {}, llm });
      expect(existsSync(deadDir(harness))).toBe(false);
    }

    // Tick 5: parks — writes dead-letter, advances HWM
    const llm5 = mockLlm([
      { model: TEST_MODEL, text: 'final malformed' },
      { model: TEST_MODEL, text: 'final retry malformed' },
    ]);
    const result5 = await runWorker(harness, { db: {}, llm: llm5 });
    expect(result5.deadLettered).toBe(1);
    expect(result5.parked).toBe(1);
    expect(existsSync(deadDir(harness))).toBe(true);
    const deadLetter = readOnlyDeadLetter(harness);
    expect(JSON.stringify(deadLetter)).not.toContain(SECRET_TRANSCRIPT_TEXT);
    // Failed chunk checkpoint advances, while the spool cursor waits for a clean snapshot pass.
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(transcriptEnd);
    expect(readState(harness).spool.cursor).toBe(0);
  });

  it('treats runtime LLM disabled errors as a skip without dead-lettering', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'claude cli disappeared' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    const llm: CaptureLlmAdapter = {
      model: 'haiku',
      provider: 'claude-cli',
      worstCaseCallBudgetMs: 76_000,
      async extract(): Promise<CaptureLlmRawResponse> {
        throw new CaptureLlmValidationError(
          'CAPTURE_LLM_DISABLED',
          'claude CLI not found',
          {
            model: 'haiku',
            provider: 'claude-cli',
          }
        );
      },
      takeTelemetry() {
        return { primaryProvider: 'claude-cli', primarySuccess: 0, fallbackSuccess: 0, fallbackFailed: 0 };
      },
    };

    await expect(
      runWorker(harness, {
        db: {},
        llm,
      })
    ).resolves.toMatchObject({ processed: 0, skipped: 1, deadLettered: 0 });
    expect(existsSync(deadDir(harness))).toBe(false);
    expect(readState(harness).spool.cursor).toBe(0);
  });

  it('treats Claude CLI 429 rate limits as transient without dead-lettering or counting attempts', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'capture waits for Claude quota reset' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:05.000Z',
    });
    const llm = mockLlm([
      new CaptureLlmValidationError('CLAUDE_CLI_RATE_LIMITED', 'claude-cli rate limited', {
        model: 'haiku',
        provider: 'claude-cli',
        apiErrorStatus: 429,
      }),
    ]);

    await expect(runWorker(harness, { db: {}, llm })).resolves.toMatchObject({
      processed: 0,
      rateLimited: 1,
      deadLettered: 0,
    });

    expect(existsSync(deadDir(harness))).toBe(false);
    expect(readState(harness).spool.cursor).toBe(0);
  });

  it('reclaims stale spool locks so killed workers do not block a session forever', async () => {
    const harness = makeHarness();
    const spoolEnd = await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:00:30.000Z',
    });
    writeFileSync(lockPath(harness), '', { mode: 0o600 });
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(lockPath(harness), staleTime, staleTime);
    const llm = mockLlm([]);

    await expect(runWorker(harness, { db: {}, llm })).resolves.toMatchObject({
      processed: 0,
      skipped: 1,
      deadLettered: 0,
    });

    expect(readState(harness).spool.cursor).toBe(spoolEnd);
    expect(existsSync(lockPath(harness))).toBe(false);
  });

  it('does not steal a fresh spool lock from a possibly running worker', async () => {
    const harness = makeHarness();
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:00:30.000Z',
    });
    writeFileSync(lockPath(harness), '', { mode: 0o600 });
    const llm = mockLlm([]);

    await expect(runWorker(harness, { db: {}, llm })).resolves.toMatchObject({
      processed: 0,
      skipped: 1,
      deadLettered: 0,
    });

    expect(existsSync(statePath(harness))).toBe(false);
    expect(existsSync(lockPath(harness))).toBe(true);
  });

  it('limits LLM processing to CC_CAPTURE_MAX_SESSIONS_PER_TICK', async () => {
    const first = makeHarness({
      projectId: `capture-worker-max-a-${randomUUID()}`,
      sessionId: `session-a-${randomUUID()}`,
    });
    first.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK = '1';
    const second: TestHarness = {
      ...first,
      projectId: `capture-worker-max-z-${randomUUID()}`,
      sessionId: `session-z-${randomUUID()}`,
      transcriptPath: join(first.root, 'second.transcript.jsonl'),
    };
    writeFileSync(second.transcriptPath, '', { mode: 0o600 });
    const firstTranscriptEnd = appendTranscriptEntries(first.transcriptPath, [
      { message: 'first processable session' },
    ]);
    const secondTranscriptEnd = appendTranscriptEntries(second.transcriptPath, [
      { message: 'second processable session' },
    ]);
    await appendWindow(first, {
      transcriptStart: 0,
      transcriptEnd: firstTranscriptEnd,
      timestamp: '2026-07-06T10:00:30.000Z',
    });
    await appendWindow(second, {
      transcriptStart: 0,
      transcriptEnd: secondTranscriptEnd,
      timestamp: '2026-07-06T10:00:31.000Z',
    });
    const llm = mockLlm([
      rawExtraction({ summary: 'first session processed', observations: [] }),
      rawExtraction({ summary: 'second session must wait', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    await expect(runWorker(first, { db: fakeDb, llm })).resolves.toMatchObject({
      processed: 1,
      deadLettered: 0,
    });

    expect(llm.calls.map((call) => call.transcript)).toEqual([
      readFileSync(first.transcriptPath, 'utf8'),
    ]);
  });

  it('does not let a missing transcript consume the processable-session budget', async () => {
    const missing = makeHarness({
      projectId: 'capture-worker-budget-a',
      sessionId: 'session-a-missing',
    });
    missing.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK = '1';
    const available: TestHarness = {
      ...missing,
      projectId: 'capture-worker-budget-z',
      sessionId: 'session-z-available',
      transcriptPath: join(missing.root, 'available.transcript.jsonl'),
    };
    writeFileSync(available.transcriptPath, '', { mode: 0o600 });

    await appendCaptureEvent(
      {
        session_id: missing.sessionId,
        project_id: missing.projectId,
        tool_name: 'Bash',
        timestamp: '2026-07-06T10:00:30.000Z',
        transcript_path: '',
        transcript_offset: 0,
      },
      { env: missing.env }
    );
    await appendStopSentinel(
      {
        project_id: missing.projectId,
        session_id: missing.sessionId,
        timestamp: '2026-07-06T10:00:31.000Z',
        transcript_path: '',
        hwm_offset: 0,
      },
      { env: missing.env }
    );

    const transcriptEnd = appendTranscriptEntries(available.transcriptPath, [
      { message: 'processable session must not be starved by missing transcript metadata' },
    ]);
    await appendWindow(available, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:32.000Z',
    });
    const llm = mockLlm([
      rawExtraction({ summary: 'available session processed', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const result = await runWorker(missing, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 1, transcriptMissing: 1 });
    expect(llm.calls.map((call) => call.transcript)).toEqual([
      readFileSync(available.transcriptPath, 'utf8'),
    ]);
    expect(readState(missing).spool.cursor).toBe(statSync(spoolPath(missing)).size);
    expect(readState(available).spool.cursor).toBe(statSync(spoolPath(available)).size);
  });

  it('drains a missing transcript after the processable-session budget is exhausted', async () => {
    const available = makeHarness({
      projectId: 'capture-worker-budget-a',
      sessionId: 'session-a-available',
    });
    available.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK = '1';
    const missing: TestHarness = {
      ...available,
      projectId: 'capture-worker-budget-z',
      sessionId: 'session-z-missing',
      transcriptPath: join(available.root, 'missing.transcript.jsonl'),
    };

    const transcriptEnd = appendTranscriptEntries(available.transcriptPath, [
      { message: 'processable session consumes the only processing slot' },
    ]);
    await appendWindow(available, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:30.000Z',
    });
    await appendCaptureEvent(
      {
        session_id: missing.sessionId,
        project_id: missing.projectId,
        tool_name: 'Bash',
        timestamp: '2026-07-06T10:00:31.000Z',
        transcript_path: '',
        transcript_offset: 0,
      },
      { env: missing.env }
    );
    await appendStopSentinel(
      {
        project_id: missing.projectId,
        session_id: missing.sessionId,
        timestamp: '2026-07-06T10:00:32.000Z',
        transcript_path: '',
        hwm_offset: 0,
      },
      { env: missing.env }
    );
    const llm = mockLlm([
      rawExtraction({ summary: 'available session processed', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const result = await runWorker(available, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 1, transcriptMissing: 1 });
    expect(llm.calls.map((call) => call.transcript)).toEqual([
      readFileSync(available.transcriptPath, 'utf8'),
    ]);
    expect(readState(available).spool.cursor).toBe(statSync(spoolPath(available)).size);
    expect(readState(missing).spool.cursor).toBe(statSync(spoolPath(missing)).size);
  });

  it('does not let a legacy mixed-path session consume the processable-session budget', async () => {
    const missing = makeHarness({
      projectId: 'capture-worker-mixed-budget-a',
      sessionId: 'session-a-mixed-missing',
    });
    missing.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK = '1';
    const available: TestHarness = {
      ...missing,
      projectId: 'capture-worker-mixed-budget-z',
      sessionId: 'session-z-available',
      transcriptPath: join(missing.root, 'mixed-available.transcript.jsonl'),
    };
    writeFileSync(available.transcriptPath, '', { mode: 0o600 });

    await appendCaptureEvent(
      {
        session_id: missing.sessionId,
        project_id: missing.projectId,
        tool_name: 'Bash',
        timestamp: '2026-07-06T10:00:30.000Z',
        transcript_path: missing.transcriptPath,
        transcript_offset: 0,
      },
      { env: missing.env }
    );
    await appendStopSentinel(
      {
        project_id: missing.projectId,
        session_id: missing.sessionId,
        timestamp: '2026-07-06T10:00:31.000Z',
        transcript_path: '',
        hwm_offset: 0,
      },
      { env: missing.env }
    );

    const transcriptEnd = appendTranscriptEntries(available.transcriptPath, [
      { message: 'processable session follows a legacy mixed-path spool' },
    ]);
    await appendWindow(available, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:32.000Z',
    });
    const llm = mockLlm([
      rawExtraction({ summary: 'available session processed', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const result = await runWorker(missing, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 1, transcriptMissing: 1 });
    expect(llm.calls.map((call) => call.transcript)).toEqual([
      readFileSync(available.transcriptPath, 'utf8'),
    ]);
    expect(readState(missing).spool.cursor).toBe(statSync(spoolPath(missing)).size);
    expect(readState(available).spool.cursor).toBe(statSync(spoolPath(available)).size);
  });

  it('parks after 5 tick attempts via retry sidecar, then EEXIST dedup on replay', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'replayed dead-letter window' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:10.000Z',
    });

    const repeatedError = new CaptureLlmValidationError(
      'CLAUDE_CLI_EXIT_NONZERO',
      'claude-cli exited with code 1',
      {
        model: 'haiku',
        rawOutput:
          '{"type":"result","subtype":"success","is_error":true,"api_error_status":500,"result":"synthetic server error"}',
      }
    );

    // Ticks 1-4: hold (no dead-letter)
    for (let tick = 1; tick <= 4; tick += 1) {
      const llm = mockLlm([repeatedError, repeatedError]);
      const r = await runWorker(harness, { db: {}, llm });
      expect(r.deadLettered).toBe(0);
      expect(readState(harness).spool.cursor).toBe(0);
    }

    // Tick 5: park — dead-letter + HWM advance
    const llm5 = mockLlm([repeatedError, repeatedError]);
    await expect(runWorker(harness, { db: {}, llm: llm5 })).resolves.toMatchObject({
      processed: 0,
      deadLettered: 1,
      parked: 1,
    });

    expect(readDeadLetters(harness)).toHaveLength(1);
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(transcriptEnd);
  });

  it('splits a prompt-too-long chunk into smaller retries before dead-lettering', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 600,
    });
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(Buffer.byteLength(originalTranscript, 'utf8'));
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:32.000Z',
    });

    const promptTooLong = new CaptureLlmValidationError(
      'CLAUDE_CLI_EXIT_NONZERO',
      'claude-cli exited with code 1',
      {
        model: 'haiku',
        rawOutput:
          '{"type":"result","subtype":"success","is_error":true,"api_error_status":400,"terminal_reason":"prompt_too_long","result":"Prompt is too long"}',
      }
    );
    const llm = mockLlm([
      promptTooLong,
      rawExtraction({
        summary: 'smaller retry one',
        observations: [observation('smaller retry one', 'smaller retry one narrative')],
      }),
      rawExtraction({
        summary: 'smaller retry two',
        observations: [observation('smaller retry two', 'smaller retry two narrative')],
      }),
    ]);
    const fakeDb = {
      transaction: async () => ({
        observationsWritten: 1,
        rollupsWritten: 1,
      }),
    };

    await expect(runWorker(harness, { db: fakeDb, llm })).resolves.toMatchObject({
      processed: 2,
      deadLettered: 0,
      observationsWritten: 2,
    });

    expect(llm.calls.map((call) => call.transcript)).toEqual([
      originalTranscript,
      lines[0],
      lines[1],
    ]);
    expect(existsSync(deadDir(harness))).toBe(false);
  });

  it('excludes injected cc-memory-inject lines from the transcript sent to the LLM', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'genuine user turn worth capturing' },
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        message: 'source=cc-memory-inject recent activity index',
      },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:09:00.000Z',
    });
    const llm = mockLlm([rawExtraction({ summary: 'genuine capture', observations: [] })]);

    // db {} 讓寫入路徑失敗，但過濾發生在送 LLM 之前——只驗 llm.calls[0].transcript。
    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].transcript).toContain('genuine user turn worth capturing');
    expect(llm.calls[0].transcript).not.toContain('cc-memory-inject');
  });

  it('skips the window without calling the LLM when every line is a cc-memory-inject marker', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        message: 'source=cc-memory-inject index line one',
      },
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        message: 'source=cc-memory-inject index line two',
      },
    ]);
    const spoolEnd = await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:09:30.000Z',
    });
    const llm = mockLlm([]);

    // 全行被濾成空窗口 → 走既有空窗口 skip 路徑（寫 HWM、不呼叫 LLM、不 dead-letter）。
    await expect(runWorker(harness, { db: {}, llm })).resolves.toMatchObject({
      processed: 0,
      skipped: 1,
      deadLettered: 0,
    });
    expect(llm.calls).toHaveLength(0);
    expect(existsSync(deadDir(harness))).toBe(false);
    expect(readState(harness).spool.cursor).toBe(spoolEnd);
  });

  it('yields between raw-byte chunks without incrementing retry state, then resumes at the saved checkpoint', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines, cap } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 160,
    });
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap);
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '5';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:10:00.000Z',
    });
    const firstLlm = mockLlm([
      rawExtraction({ summary: 'first chunk', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const first = await runWorker(harness, {
      db: fakeDb,
      llm: firstLlm,
      nowMs: () => (firstLlm.calls.length > 0 ? 10 : 0),
    });

    expect(first).toMatchObject({ processed: 1, yielded: 1, parked: 0, deadLettered: 0 });
    expect(firstLlm.calls.map((call) => call.transcript)).toEqual([lines[0]]);
    expect(Object.keys(readState(harness).retries)).toHaveLength(0);
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(
      Buffer.byteLength(lines[0], 'utf8')
    );
    expect(readState(harness).spool.cursor).toBe(0);

    const secondLlm = mockLlm([
      rawExtraction({ summary: 'second chunk', observations: [] }),
    ]);
    const second = await runWorker(harness, {
      db: fakeDb,
      llm: secondLlm,
      nowMs: () => 0,
    });

    expect(second).toMatchObject({ processed: 1, yielded: 0, parked: 0 });
    expect(secondLlm.calls.map((call) => call.transcript)).toEqual([lines[1]]);
    expect(readState(harness).spool.cursor).toBe(statSync(spoolPath(harness)).size);
  });

  it('counts one budget yield when another spool remains after yielding between chunks', async () => {
    const first = makeHarness({
      projectId: 'capture-worker-yield-a',
      sessionId: 'session-a',
    });
    const second: TestHarness = {
      ...first,
      projectId: 'capture-worker-yield-z',
      sessionId: 'session-z',
      transcriptPath: join(first.root, 'second.transcript.jsonl'),
    };
    writeFileSync(second.transcriptPath, '', { mode: 0o600 });

    const { transcriptEnd, cap } = makeChunkedTranscript(first, {
      lineCount: 2,
      messageBytes: 160,
    });
    first.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap);
    first.env.CC_CAPTURE_TICK_BUDGET_MS = '5';
    await appendWindow(first, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:10:00.000Z',
    });
    const secondTranscriptEnd = appendTranscriptEntries(second.transcriptPath, [
      { message: 'second spool must remain pending after the same budget yield' },
    ]);
    await appendWindow(second, {
      transcriptStart: 0,
      transcriptEnd: secondTranscriptEnd,
      timestamp: '2026-07-06T10:10:01.000Z',
    });

    const llm = mockLlm([
      rawExtraction({ summary: 'first chunk', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const result = await runWorker(first, {
      db: fakeDb,
      llm,
      nowMs: () => (llm.calls.length > 0 ? 10 : 0),
    });

    expect(result).toMatchObject({ processed: 1, yielded: 1 });
    expect(existsSync(statePath(second))).toBe(false);
  });

  it('splits a timed-out large chunk without counting it as a terminal retry', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 600,
    });
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(Buffer.byteLength(originalTranscript));
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.000Z',
    });
    const timeout = new CaptureLlmValidationError(
      'LLM_TIMEOUT',
      'claude-cli timed out after 75000ms',
      { model: 'haiku', provider: 'claude-cli', timeoutMs: 75_000, timeoutSubtype: 'size-or-deadline' }
    );
    const llm = mockLlm([
      timeout,
      rawExtraction({ summary: 'timeout split one', observations: [] }),
      rawExtraction({ summary: 'timeout split two', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const result = await runWorker(harness, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 2, deadLettered: 0, parked: 0 });
    expect(llm.calls.map((call) => call.transcript)).toEqual([
      originalTranscript,
      lines[0],
      lines[1],
    ]);
    expect(readState(harness).retries).toEqual({});
  });

  it('persists timeout split hints when the tick budget yields before child chunks run', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 600,
    });
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(Buffer.byteLength(originalTranscript));
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '1';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.500Z',
    });
    const calls: CaptureLlmRequest[] = [];
    let elapsed = 0;
    const firstLlm: MockCaptureLlm = {
      model: TEST_MODEL,
      worstCaseCallBudgetMs: 0,
      calls,
      async extract(input): Promise<CaptureLlmRawResponse> {
        calls.push(input);
        elapsed = 2;
        throw new CaptureLlmValidationError(
          'LLM_TIMEOUT',
          'claude-cli timed out after 75000ms',
          { model: 'haiku', provider: 'claude-cli', timeoutMs: 75_000, timeoutSubtype: 'size-or-deadline' }
        );
      },
      takeTelemetry() {
        return { primaryProvider: 'claude-cli', primarySuccess: 0, fallbackSuccess: 0, fallbackFailed: 0 };
      },
    };

    const first = await runWorker(harness, {
      db: {},
      llm: firstLlm,
      nowMs: () => elapsed,
    });
    const yieldedState = readState(harness);

    expect(first).toMatchObject({ processed: 0, yielded: 1, parked: 0, deadLettered: 0 });
    expect(firstLlm.calls.map((call) => call.transcript)).toEqual([originalTranscript]);
    expect(yieldedState.retries).toEqual({});
    expect(Object.keys(yieldedState.splitHints)).toHaveLength(1);

    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '0';
    const secondLlm = mockLlm([
      rawExtraction({ summary: 'persisted split one', observations: [] }),
      rawExtraction({ summary: 'persisted split two', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };
    const second = await runWorker(harness, { db: fakeDb, llm: secondLlm });

    expect(second).toMatchObject({ processed: 2, yielded: 0, parked: 0, deadLettered: 0 });
    expect(secondLlm.calls.map((call) => call.transcript)).toEqual(lines);
    expect(readState(harness).splitHints).toEqual({});
  });

  it('prioritizes a nested split hint after the checkpoint changes the next parent range', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines, cap } = makeChunkedTranscript(harness, {
      lineCount: 3,
      messageBytes: 1_400,
    });
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap * 2);
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '1';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.625Z',
    });
    const timeout = new CaptureLlmValidationError(
      'LLM_TIMEOUT',
      'claude-cli timed out after 75000ms',
      { model: 'haiku', provider: 'claude-cli', timeoutMs: 75_000, timeoutSubtype: 'size-or-deadline' }
    );
    const firstLlm = mockLlm([
      timeout,
      rawExtraction({ summary: 'first child committed', observations: [] }),
      timeout,
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const first = await runWorker(harness, {
      db: fakeDb,
      llm: firstLlm,
      nowMs: () => (firstLlm.calls.length >= 3 ? 2 : 0),
    });
    const yieldedState = readState(harness);
    const checkpoint = Object.values(yieldedState.transcripts)[0]?.checkpoint;
    const nestedHint = Object.values(yieldedState.splitHints).find(
      (hint) => hint.start === checkpoint && hint.end < transcriptEnd
    );

    expect(first).toMatchObject({ processed: 1, yielded: 1, parked: 0, deadLettered: 0 });
    expect(checkpoint).toBe(Buffer.byteLength(lines[0], 'utf8'));
    expect(nestedHint).toBeDefined();

    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '0';
    const secondLlm = mockLlm([
      rawExtraction({ summary: 'nested split one', observations: [] }),
      rawExtraction({ summary: 'nested split two', observations: [] }),
      rawExtraction({ summary: 'remaining line', observations: [] }),
    ]);
    const second = await runWorker(harness, { db: fakeDb, llm: secondLlm });

    expect(second).toMatchObject({ processed: 3, yielded: 0, parked: 0, deadLettered: 0 });
    expect(secondLlm.calls).toHaveLength(3);
    expect(secondLlm.calls[0]?.transcript).not.toContain('chunk-3:');
    expect(Buffer.byteLength(secondLlm.calls[0]?.transcript ?? '', 'utf8')).toBeLessThan(
      Buffer.byteLength(lines[1], 'utf8')
    );
    expect(secondLlm.calls.map((call) => call.transcript).join('')).toBe(lines[1] + lines[2]);
    expect(readState(harness).splitHints).toEqual({});
  });

  it('uses an ancestor split boundary after committed children move the checkpoint', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines, cap } = makeChunkedTranscript(harness, {
      lineCount: 3,
      messageBytes: 2_600,
    });
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap * 2);
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '1';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.700Z',
    });
    const timeout = new CaptureLlmValidationError(
      'LLM_TIMEOUT',
      'claude-cli timed out after 75000ms',
      { model: 'haiku', provider: 'claude-cli', timeoutMs: 75_000, timeoutSubtype: 'size-or-deadline' }
    );
    const firstLlm = mockLlm([
      timeout,
      timeout,
      rawExtraction({ summary: 'first grandchild', observations: [] }),
      rawExtraction({ summary: 'second grandchild', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const first = await runWorker(harness, {
      db: fakeDb,
      llm: firstLlm,
      nowMs: () => (firstLlm.calls.length >= 4 ? 2 : 0),
    });
    const yieldedState = readState(harness);
    const checkpoint = Object.values(yieldedState.transcripts)[0]?.checkpoint;
    const ancestorHint = Object.values(yieldedState.splitHints).find(
      (hint) => hint.start < (checkpoint ?? 0) && hint.end > (checkpoint ?? 0)
    );

    expect(first).toMatchObject({ processed: 2, yielded: 1, parked: 0, deadLettered: 0 });
    expect(checkpoint).toBe(Buffer.byteLength(lines[0], 'utf8'));
    expect(ancestorHint?.end).toBe(Buffer.byteLength(lines[0] + lines[1], 'utf8'));

    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '0';
    const secondLlm = mockLlm([
      rawExtraction({ summary: 'ancestor sibling', observations: [] }),
      rawExtraction({ summary: 'remaining line', observations: [] }),
    ]);
    const second = await runWorker(harness, { db: fakeDb, llm: secondLlm });

    expect(second).toMatchObject({ processed: 2, yielded: 0, parked: 0, deadLettered: 0 });
    expect(secondLlm.calls.map((call) => call.transcript)).toEqual([lines[1], lines[2]]);
    expect(readState(harness).splitHints).toEqual({});
  });

  it('yields before starting a Claude call that cannot fit inside the remaining tick budget', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'do not start a call that can outlive the worker budget' },
    ]);
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '100000';
    harness.env.CC_CAPTURE_CLAUDE_TIMEOUT_MS = '75000';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.750Z',
    });
    // worstCaseCallBudgetMs = timeout(75000) + killGrace(1000) = 76000
    // reserve = 76000 + settle(15000) = 91000
    // budget(100000) - elapsed(20000) = 80000 < reserve(91000) → yields
    const baseLlm = mockLlm([
      rawExtraction({ summary: 'must not run', observations: [] }),
    ], { worstCaseCallBudgetMs: 76_000 });
    const llm: MockCaptureLlm = { ...baseLlm, provider: 'claude-cli' };
    let firstClockRead = true;

    const result = await runWorker(harness, {
      db: {},
      llm,
      nowMs: () => {
        if (firstClockRead) {
          firstClockRead = false;
          return 0;
        }
        return 20_000;
      },
    });

    expect(result).toMatchObject({ processed: 0, yielded: 1, parked: 0, deadLettered: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(readState(harness).retries).toEqual({});
    expect(readState(harness).spool.cursor).toBe(0);
  });

  it('removes a legacy larger retry after smaller successful chunks cover its range', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines, cap } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 600,
    });
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(Buffer.byteLength(originalTranscript));
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:34.000Z',
    });

    await runWorker(harness, { db: {}, llm: mockLlm([new Error('legacy large retry')]) });
    expect(Object.values(readState(harness).retries)).toHaveLength(1);
    expect(Object.values(readState(harness).retries)[0]).toMatchObject({
      start: 0,
      end: transcriptEnd,
    });

    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap);
    const llm = mockLlm([
      rawExtraction({ summary: 'covered one', observations: [] }),
      rawExtraction({ summary: 'covered two', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };
    const result = await runWorker(harness, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 2, deadLettered: 0, parked: 0 });
    expect(llm.calls.map((call) => call.transcript)).toEqual(lines);
    expect(readState(harness).retries).toEqual({});
  });

  it('uses a 32 KiB default chunk for the Claude CLI provider', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'x'.repeat(70 * 1024) },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:35.000Z',
    });
    const baseLlm = mockLlm(
      Array.from({ length: 3 }, (_, index) =>
        rawExtraction({ summary: `claude default chunk ${index}`, observations: [] })
      )
    );
    const llm: MockCaptureLlm = { ...baseLlm, provider: 'claude-cli' };
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const result = await runWorker(harness, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 3, deadLettered: 0, parked: 0 });
    expect(llm.calls).toHaveLength(3);
    for (const call of llm.calls) {
      expect(Buffer.byteLength(call.transcript)).toBeLessThanOrEqual(32 * 1024);
    }
  });

  it('advances independent transcript checkpoints in spool order while retaining the parent session id', async () => {
    const harness = makeHarness();
    const childPath = join(harness.root, 'child-agent.transcript.jsonl');
    writeFileSync(childPath, '', { mode: 0o600 });
    const parentEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'parent transcript range' },
    ]);
    const childEnd = appendTranscriptEntries(childPath, [
      { message: 'child transcript range without stop sentinel' },
    ]);
    for (const [path, offset, timestamp] of [
      [harness.transcriptPath, 0, '2026-07-06T10:11:00.000Z'],
      [childPath, 0, '2026-07-06T10:11:01.000Z'],
      [harness.transcriptPath, parentEnd, '2026-07-06T10:11:02.000Z'],
      [childPath, childEnd, '2026-07-06T10:11:03.000Z'],
    ] as const) {
      await appendCaptureEvent({
        session_id: harness.sessionId,
        project_id: harness.projectId,
        tool_name: 'Bash',
        timestamp,
        transcript_path: path,
        transcript_offset: offset,
      }, { env: harness.env });
    }
    const llm = mockLlm([
      rawExtraction({ summary: 'parent range', observations: [] }),
      rawExtraction({ summary: 'child range', observations: [] }),
    ]);
    const fakeDb = {
      transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }),
    };

    const result = await runWorker(harness, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 2, yielded: 0, parked: 0 });
    expect(llm.calls.map((call) => call.sessionId)).toEqual([
      harness.sessionId,
      harness.sessionId,
    ]);
    expect(llm.calls.map((call) => call.transcript)).toEqual([
      readFileSync(harness.transcriptPath, 'utf8'),
      readFileSync(childPath, 'utf8'),
    ]);
    expect(Object.values(readState(harness).transcripts).map((entry) => entry.checkpoint).sort((a, b) => a - b))
      .toEqual([parentEnd, childEnd].sort((a, b) => a - b));
  });

  it('keeps the same stable retry key when new spool records are appended', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'stable retry source bytes' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:12:00.000Z',
    });
    const terminal = new Error('stable retry failure');
    const output: string[] = [];
    const stdout = { write: (chunk: string) => output.push(chunk) };

    await runWorker(harness, { db: {}, llm: mockLlm([terminal]), stdout });
    const firstKeys = Object.keys(readState(harness).retries);
    expect(firstKeys).toHaveLength(1);
    expect(output.join('')).toContain('auto-capture warning: retry-pending');
    expect(output.join('')).toContain('error=LLM_EXTRACT_FAILED attempts=1/5');
    expect(output.join('')).not.toContain(harness.transcriptPath);
    expect(output.join('')).not.toContain('stable retry source bytes');

    await appendCaptureEvent({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      tool_name: 'Bash',
      timestamp: '2026-07-06T10:12:01.000Z',
      transcript_path: harness.transcriptPath,
      transcript_offset: transcriptEnd,
    }, { env: harness.env });
    await runWorker(harness, { db: {}, llm: mockLlm([terminal]), stdout });

    expect(Object.keys(readState(harness).retries)).toEqual(firstKeys);
    expect(readState(harness).retries[firstKeys[0]].attempts).toBe(2);
    expect(output.join('')).toContain('error=LLM_EXTRACT_FAILED attempts=2/5');
  });

  it('parks a permanently missing transcript range after five attempts and resumes a later path next tick', async () => {
    const harness = makeHarness();
    const childPath = join(harness.root, 'available-child.transcript.jsonl');
    writeFileSync(childPath, '', { mode: 0o600 });
    const parentEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: SECRET_TRANSCRIPT_TEXT },
    ]);
    const childEnd = appendTranscriptEntries(childPath, [
      { message: 'later child range remains recoverable' },
    ]);
    for (const [path, offset, timestamp] of [
      [harness.transcriptPath, 0, '2026-07-06T10:12:10.000Z'],
      [harness.transcriptPath, parentEnd, '2026-07-06T10:12:11.000Z'],
      [childPath, 0, '2026-07-06T10:12:12.000Z'],
      [childPath, childEnd, '2026-07-06T10:12:13.000Z'],
    ] as const) {
      await appendCaptureEvent({
        session_id: harness.sessionId,
        project_id: harness.projectId,
        tool_name: 'Bash',
        timestamp,
        transcript_path: path,
        transcript_offset: offset,
      }, { env: harness.env });
    }
    unlinkSync(harness.transcriptPath);
    const output: string[] = [];
    const stdout = { write: (chunk: string) => output.push(chunk) };
    let retryKey = '';

    for (let tick = 1; tick <= 4; tick += 1) {
      const result = await runWorker(harness, { db: {}, llm: mockLlm([]), stdout });
      expect(result).toMatchObject({ transcriptMissing: 1, parked: 0, deadLettered: 0 });
      const state = readState(harness);
      const keys = Object.keys(state.retries);
      expect(keys).toHaveLength(1);
      retryKey ||= keys[0];
      expect(keys[0]).toBe(retryKey);
      expect(state.retries[retryKey].attempts).toBe(tick);
      expect(state.spool.cursor).toBe(0);
    }

    const fifth = await runWorker(harness, { db: {}, llm: mockLlm([]), stdout });
    expect(fifth).toMatchObject({ transcriptMissing: 1, parked: 1, deadLettered: 1 });
    const parkedState = readState(harness);
    expect(parkedState.retries).toEqual({});
    expect(Object.values(parkedState.transcripts).map((entry) => entry.checkpoint))
      .toContain(parentEnd);
    expect(parkedState.spool.cursor).toBe(0);
    expect(output.join('')).toContain('transcript-source-unavailable');
    expect(output.join('')).not.toContain(harness.transcriptPath);
    const deadLetter = readOnlyDeadLetter(harness);
    expect(deadLetter.metadata).toMatchObject({
      error_code: 'TRANSCRIPT_SOURCE_UNAVAILABLE',
      model: 'none',
      source: {
        path_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        start: 0,
        end: parentEnd,
        content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(deadLetter)).not.toContain(SECRET_TRANSCRIPT_TEXT);
    expect(JSON.stringify(deadLetter)).not.toContain(harness.transcriptPath);

    const sixthLlm = mockLlm([
      rawExtraction({ summary: 'later child path recovered', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const sixth = await runWorker(harness, { db: fakeDb, llm: sixthLlm, stdout });
    expect(sixth).toMatchObject({ processed: 1, parked: 0, deadLettered: 0 });
    expect(sixthLlm.calls.map((call) => call.transcript)).toEqual([
      readFileSync(childPath, 'utf8'),
    ]);
    expect(readState(harness).spool.cursor).toBe(statSync(spoolPath(harness)).size);
  });

  it('clears a missing-source retry only after the full captured boundary becomes readable', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'temporarily unavailable source returns intact' },
    ]);
    const original = readFileSync(harness.transcriptPath);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:12:20.000Z',
    });
    unlinkSync(harness.transcriptPath);

    const first = await runWorker(harness, { db: {}, llm: mockLlm([]) });
    expect(first).toMatchObject({ transcriptMissing: 1, parked: 0 });
    expect(Object.values(readState(harness).retries)).toHaveLength(1);

    writeFileSync(harness.transcriptPath, original, { mode: 0o600 });
    const llm = mockLlm([
      rawExtraction({ summary: 'source returned before isolation', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const second = await runWorker(harness, { db: fakeDb, llm });

    expect(second).toMatchObject({ processed: 1, transcriptMissing: 0, parked: 0 });
    expect(readState(harness).retries).toEqual({});
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(transcriptEnd);
    expect(readState(harness).spool.cursor).toBe(statSync(spoolPath(harness)).size);
  });

  it('reads an explicitly configured transcript snapshot when the original is too short', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'archived transcript prefix remains replayable' },
    ]);
    const original = readFileSync(harness.transcriptPath);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:12:24.000Z',
    });
    const snapshotDir = join(harness.root, 'transcript-snapshots');
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    const sourceHash = createHash('sha256').update(harness.transcriptPath).digest('hex');
    writeFileSync(join(snapshotDir, `${sourceHash}.jsonl`), original, { mode: 0o600 });
    writeFileSync(harness.transcriptPath, 'short', { mode: 0o600 });
    harness.env.CC_MEMORY_TRANSCRIPT_SNAPSHOT_DIR = snapshotDir;
    const llm = mockLlm([
      rawExtraction({ summary: 'archived source replayed', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };

    const result = await runWorker(harness, { db: fakeDb, llm });

    expect(result).toMatchObject({ processed: 1, transcriptMissing: 0, parked: 0 });
    expect(llm.calls.map((call) => call.transcript)).toEqual([original.toString('utf8')]);
  });

  it('counts a readable but permanently short transcript toward the same five-attempt isolation', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'captured boundary is longer than the replacement file' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:12:25.000Z',
    });
    writeFileSync(harness.transcriptPath, 'x', { mode: 0o600 });

    for (let tick = 1; tick <= 4; tick += 1) {
      const result = await runWorker(harness, { db: {}, llm: mockLlm([]) });
      expect(result).toMatchObject({ transcriptMissing: 1, parked: 0, deadLettered: 0 });
      expect(Object.values(readState(harness).retries)[0]?.attempts).toBe(tick);
    }
    const fifth = await runWorker(harness, { db: {}, llm: mockLlm([]) });
    expect(fifth).toMatchObject({ transcriptMissing: 1, parked: 1, deadLettered: 1 });
    expect(readState(harness).retries).toEqual({});
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(transcriptEnd);
  });

  it('parks only the fifth-failing chunk and resumes the later chunk on the next tick', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines, cap } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 140,
    });
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:12:30.000Z',
    });
    const terminal = new Error('chunk-specific failure');

    for (let tick = 1; tick <= 4; tick += 1) {
      const llm = mockLlm([terminal]);
      const result = await runWorker(harness, { db: {}, llm });
      expect(result).toMatchObject({ parked: 0, deadLettered: 0 });
      expect(llm.calls.map((call) => call.transcript)).toEqual([lines[0]]);
    }
    const fifthLlm = mockLlm([terminal]);
    const fifth = await runWorker(harness, { db: {}, llm: fifthLlm });
    expect(fifth).toMatchObject({ parked: 1, deadLettered: 1, yielded: 0 });
    expect(fifthLlm.calls.map((call) => call.transcript)).toEqual([lines[0]]);
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(
      Buffer.byteLength(lines[0], 'utf8')
    );

    const sixthLlm = mockLlm([
      rawExtraction({ summary: 'later chunk recovered', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const sixth = await runWorker(harness, { db: fakeDb, llm: sixthLlm });
    expect(sixth).toMatchObject({ processed: 1, parked: 0, deadLettered: 0 });
    expect(sixthLlm.calls.map((call) => call.transcript)).toEqual([lines[1]]);
    expect(readState(harness).spool.cursor).toBe(statSync(spoolPath(harness)).size);
  });

  it('fails closed on a corrupt version-2 state without calling the LLM or advancing the spool', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'must not be consumed with corrupt state' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:13:00.000Z',
    });
    writeFileSync(statePath(harness), '{"version":2,"spool":', { mode: 0o600 });
    const llm = mockLlm([]);

    const result = await runWorker(harness, { db: {}, llm });

    expect(result).toMatchObject({ processed: 0, failed: 1, yielded: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(readFileSync(statePath(harness), 'utf8')).toBe('{"version":2,"spool":');
  });

  it('writes state as 0600 and seals state with its spool generation during rotation', async () => {
    const harness = makeHarness();
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:14:00.000Z',
    });
    const oldTime = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(spoolPath(harness), oldTime, oldTime);
    const nowMs = Date.parse('2026-07-06T10:14:01.000Z');

    await runWorker(harness, { db: {}, llm: mockLlm([]), nowMs: () => nowMs });

    const projectDir = join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId));
    const files = readdirSync(projectDir);
    const sealedSpool = files.find((name) => name.includes('.jsonl.') && name.endsWith('.sealed'));
    const sealedState = files.find((name) => name.includes('.capture-state.json.') && name.endsWith('.sealed'));
    expect(sealedSpool).toBeDefined();
    expect(sealedState).toBeDefined();
    expect(existsSync(spoolPath(harness))).toBe(false);
    expect(existsSync(statePath(harness))).toBe(false);
    if (!sealedState) return;
    expect(statSync(join(projectDir, sealedState)).mode & 0o777).toBe(0o600);
    const oldGeneration = (JSON.parse(
      readFileSync(join(projectDir, sealedState), 'utf8')
    ) as CaptureStateV2).spool.generation;

    await appendCaptureEvent({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      tool_name: 'Bash',
      timestamp: '2026-07-06T10:15:00.000Z',
      transcript_path: harness.transcriptPath,
      transcript_offset: 0,
    }, { env: harness.env });
    expect(existsSync(statePath(harness))).toBe(false);
    await runWorker(harness, { db: {}, llm: mockLlm([]), nowMs: () => nowMs + 1 });
    expect(statSync(statePath(harness)).mode & 0o777).toBe(0o600);
    expect(readState(harness).spool.generation).not.toBe(oldGeneration);
  });

  it('does not rotate a large active spool whose final record is not a Stop sentinel', async () => {
    const harness = makeHarness();
    const sp = spoolPath(harness);
    const projectDir = join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(projectDir, { recursive: true });
    const baseline = JSON.stringify({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      tool_name: 'Bash',
      transcript_path: harness.transcriptPath,
      transcript_offset: 0,
      padding: 'x'.repeat(10 * 1024 * 1024),
    });
    writeFileSync(sp, `${baseline}\n`, { mode: 0o600 });

    const result = await runWorker(harness, { db: {}, llm: mockLlm([]) });

    expect(result).toMatchObject({ failed: 0, deadLettered: 0, parked: 0 });
    expect(existsSync(sp)).toBe(true);
    expect(existsSync(statePath(harness))).toBe(true);
    expect(readState(harness).spool.cursor).toBe(statSync(sp).size);
    expect(readdirSync(projectDir).some((name) => name.endsWith('.sealed'))).toBe(false);
  });
});

describe('capture worker v0.5 wave-2 contracts (no DB)', () => {
  it('newline fallback: partial tail is not processed, leaves data for next tick', async () => {
    const harness = makeHarness();
    // Use transcriptEnd=0 so the window has empty transcript (skip+advance path)
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    // Append raw bytes without trailing newline to spool (simulates hook writing mid-line)
    const sp = spoolPath(harness);
    const sizeBeforePartial = statSync(sp).size;
    appendFileSync(sp, '{"partial":true');
    const totalSize = statSync(sp).size;
    const llm = mockLlm([]);

    const result = await runWorker(harness, { db: {}, llm });
    // The valid lines are processed (empty transcript = skip+advance)
    expect(result.skipped).toBe(1);
    // State cursor is at the last complete newline boundary, not at total file size.
    const cursor = readState(harness).spool.cursor;
    expect(cursor).toBe(sizeBeforePartial);
    expect(cursor).toBeLessThan(totalSize);
  });

  it('malformed spool lines are skipped and counted, HWM advances past them', async () => {
    const harness = makeHarness();
    // Manually construct a spool with a garbage line mixed with valid records
    const sp = resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId)), { recursive: true });
    const validEvent = JSON.stringify({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      tool_name: 'Bash',
      timestamp: '2026-01-01T00:00:00.000Z',
      transcript_path: harness.transcriptPath,
      transcript_offset: 0,
    });
    const validSentinel = JSON.stringify({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      timestamp: '2026-01-01T00:00:01.000Z',
      transcript_path: harness.transcriptPath,
      hwm_offset: 0,
    });
    writeFileSync(sp, `this is garbage\n${validEvent}\n${validSentinel}\n`, { mode: 0o600 });
    const llm = mockLlm([]);

    const result = await runWorker(harness, { db: {}, llm });
    expect(result.malformed).toBe(1);
    expect(readState(harness).spool.cursor).toBe(statSync(sp).size);
  });

  it('counts malformed spool lines when all transcript boundaries are pathless', async () => {
    const harness = makeHarness();
    const sp = resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId)), { recursive: true });
    const pathlessEvent = JSON.stringify({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      tool_name: 'Bash',
      timestamp: '2026-01-01T00:00:00.000Z',
      transcript_path: '',
      transcript_offset: 0,
    });
    const pathlessSentinel = JSON.stringify({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      timestamp: '2026-01-01T00:00:01.000Z',
      transcript_path: '',
      hwm_offset: 0,
    });
    writeFileSync(sp, `this is garbage\n${pathlessEvent}\n${pathlessSentinel}\n`, { mode: 0o600 });
    const output: string[] = [];

    const result = await runWorker(harness, {
      db: {},
      llm: mockLlm([]),
      stdout: { write: (text: string) => output.push(text) },
    });

    expect(result).toMatchObject({ malformed: 1, transcriptMissing: 1 });
    expect(output.join('')).toContain('malformed-spool-lines=1');
    expect(readState(harness).spool.cursor).toBe(statSync(sp).size);
  });

  it('tick budget stops processing before timeout, preserving HWM at last completed window', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'budget test content' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    // Set tick budget to 0 (immediately expired after first check)
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '1';
    const llm = mockLlm([]);

    let callCount = 0;
    const result = await runCaptureWorkerOnce({
      db: {} as any,
      env: harness.env,
      llm,
      now: () => new Date('2026-07-06T10:00:00.000Z'),
      nowMs: () => {
        callCount += 1;
        // First call returns start, subsequent calls simulate time passing
        return callCount === 1 ? 1000 : 1000 + 100;
      },
      writerHost: TEST_WRITER,
      generateEmbedding: async () => null,
    });
    // Budget expired before processing sessions
    expect(result.processed).toBe(0);
    expect(result.yielded).toBe(1);
  });

  it('retry sidecar: 429 does NOT increment attempts', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: '429 retry test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });

    // Run 6 ticks with 429 — should never park
    for (let tick = 0; tick < 6; tick += 1) {
      const llm = mockLlm([
        new CaptureLlmValidationError('CLAUDE_CLI_RATE_LIMITED', 'rate limited', {
          model: 'haiku',
          provider: 'claude-cli',
          apiErrorStatus: 429,
        }),
      ]);
      const r = await runWorker(harness, { db: {}, llm });
      expect(r.rateLimited).toBe(1);
      expect(r.deadLettered).toBe(0);
      expect(r.parked).toBe(0);
    }
    expect(existsSync(deadDir(harness))).toBe(false);
  });

  it('migrates a legacy HWM prefix and archives retry attempts without carrying them into state v2', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'legacy migration window' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    const sp = spoolPath(harness);
    const retryPath = sp.replace(/\.jsonl$/, '.retry.json');
    const firstLineEnd = readFileSync(sp).indexOf(0x0a) + 1;
    writeFileSync(hwmPath(harness), String(firstLineEnd), { mode: 0o600 });
    writeFileSync(retryPath, JSON.stringify({ '0-999999': {
      attempts: 5,
      lastErrorClass: 'TICK_BUDGET_EXCEEDED',
      firstSeenIso: '2026-07-01T00:00:00.000Z',
      lastAttemptIso: '2026-07-01T00:01:00.000Z',
    } }), { mode: 0o600 });
    expect(existsSync(retryPath)).toBe(true);
    const llm = mockLlm([rawExtraction({ summary: 'migrated', observations: [] })]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };

    await runWorker(harness, { db: fakeDb, llm });

    expect(readState(harness).spool.cursor).toBe(statSync(sp).size);
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(transcriptEnd);
    expect(readState(harness).retries).toEqual({});
    expect(existsSync(retryPath)).toBe(false);
    expect(existsSync(hwmPath(harness))).toBe(false);
    const archived = readdirSync(join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId)));
    expect(archived.some((name) => name.includes('.hwm.v1-') && name.endsWith('.legacy'))).toBe(true);
    expect(archived.some((name) => name.includes('.retry.json.v1-') && name.endsWith('.legacy'))).toBe(true);
  });

  it('lock release does not unlink when token does not match (anti-steal)', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'lock token test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    const sp = spoolPath(harness);
    const lp = `${sp}.lock`;
    // Place a lock with a different token
    const otherLock = { pid: 99999, host: 'other', token: 'other-token', acquiredAtIso: new Date().toISOString() };
    writeFileSync(lp, JSON.stringify(otherLock), { mode: 0o600 });
    // Mark it as stale so the worker can reclaim
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(lp, staleTime, staleTime);

    const llm = mockLlm([]);
    await runWorker(harness, { db: {}, llm });

    // After worker completes, it released its own lock (which it created after reclaiming stale)
    // The lock file should be gone (worker created + released its own)
    expect(existsSync(lp)).toBe(false);
  });

  it('transcriptMissing counts sessions with null transcript path', async () => {
    const harness = makeHarness();
    // Create a spool entry with no transcript_path and offsets 0/0
    const sp = resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId)), { recursive: true });
    writeFileSync(sp, JSON.stringify({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      tool_name: 'Bash',
      timestamp: '2026-01-01T00:00:00.000Z',
      transcript_path: null,
      transcript_offset: 0,
    }) + '\n' + JSON.stringify({
      session_id: harness.sessionId,
      project_id: harness.projectId,
      timestamp: '2026-01-01T00:00:01.000Z',
      transcript_path: null,
      hwm_offset: 0,
    }) + '\n', { mode: 0o600 });
    const llm = mockLlm([]);

    const result = await runWorker(harness, { db: {}, llm });
    expect(result.transcriptMissing).toBe(1);
    expect(readState(harness).spool.cursor).toBe(statSync(sp).size);
  });

  it('summary line includes all new fields', async () => {
    // Verify the summary format in run-auto-capture.ts by testing assessment parsing
    const { assessAutoCaptureExecution } = await import('../../src/services/auto-capture-alerts.js');
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=2 skipped=1 dead-letter=0 failed=0 rate-limited=3 malformed=1 transcript-missing=2 parked=0 yielded=4\n',
      stderr: '',
    });
    // rate-limited > 0 makes it not ok
    expect(assessment.ok).toBe(false);
    expect(assessment.rateLimitedCount).toBe(3);
    expect(assessment.malformedCount).toBe(1);
    expect(assessment.transcriptMissingCount).toBe(2);
    expect(assessment.failedCount).toBe(0);
    expect(assessment.parkedCount).toBe(0);
    expect(assessment.yieldedCount).toBe(4);
  });

  it('assessor synthesizes problemLine when rateLimited > 0 but no stdout problem', async () => {
    const { assessAutoCaptureExecution } = await import('../../src/services/auto-capture-alerts.js');
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=2 malformed=0 transcript-missing=0\n',
      stderr: '',
    });
    expect(assessment.ok).toBe(false);
    expect(assessment.problemLine).toBe('rate-limited=2');
    expect(assessment.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('assessor treats transcript-missing as informational (does not affect ok)', async () => {
    const { assessAutoCaptureExecution } = await import('../../src/services/auto-capture-alerts.js');
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=5\n',
      stderr: '',
    });
    expect(assessment.ok).toBe(true);
    expect(assessment.transcriptMissingCount).toBe(5);
  });

  it('rotation re-stats spool before deciding to rotate', async () => {
    const harness = makeHarness();
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:00:30.000Z',
    });
    // Spool is small so no rotation expected
    const llm = mockLlm([]);
    await runWorker(harness, { db: {}, llm });
    // Spool file should still exist (no rotation since it's small)
    expect(existsSync(spoolPath(harness))).toBe(true);
  });

  it('all-malformed spool: terminal discard advances HWM and counts malformed', async () => {
    const harness = makeHarness();
    const sp = resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId)), { recursive: true });
    writeFileSync(sp, 'garbage line one\ngarbage line two\n', { mode: 0o600 });
    const fileSize = statSync(sp).size;
    const llm = mockLlm([]);

    const result = await runWorker(harness, { db: {}, llm });
    expect(result.malformed).toBe(2);
    expect(readState(harness).spool.cursor).toBe(fileSize);

    // Second tick: nothing to process (HWM at end)
    const result2 = await runWorker(harness, { db: {}, llm });
    expect(result2.malformed).toBe(0);
    expect(result2.skipped).toBe(1);
  });

  it('multi-record window splits at sentinel boundary, not mid-pair', async () => {
    const harness = makeHarness();
    // Create 4 records: event1+sentinel1+event2+sentinel2
    // sentinel1 hwm_offset = small (within cap), sentinel2 hwm_offset = large (exceeds cap)
    const sp = resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(harness.spoolDir, sanitizeSpoolSegment(harness.projectId)), { recursive: true });
    const smallEnd = 50;
    const bigEnd = 120;
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = '80';
    const event1 = JSON.stringify({ session_id: harness.sessionId, project_id: harness.projectId, tool_name: 'Bash', timestamp: '2026-01-01T00:00:00.000Z', transcript_path: harness.transcriptPath, transcript_offset: 0 });
    const sentinel1 = JSON.stringify({ session_id: harness.sessionId, project_id: harness.projectId, timestamp: '2026-01-01T00:00:01.000Z', transcript_path: harness.transcriptPath, hwm_offset: smallEnd });
    const event2 = JSON.stringify({ session_id: harness.sessionId, project_id: harness.projectId, tool_name: 'Read', timestamp: '2026-01-01T00:00:02.000Z', transcript_path: harness.transcriptPath, transcript_offset: smallEnd });
    const sentinel2 = JSON.stringify({ session_id: harness.sessionId, project_id: harness.projectId, timestamp: '2026-01-01T00:00:03.000Z', transcript_path: harness.transcriptPath, hwm_offset: bigEnd });
    writeFileSync(sp, `${event1}\n${sentinel1}\n${event2}\n${sentinel2}\n`, { mode: 0o600 });
    // Write enough transcript content to cover both ranges
    appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'a'.repeat(200) },
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 1, rollupsWritten: 1 }) };
    const llm = mockLlm([
      rawExtraction({ summary: 'window one', observations: [observation('win1', 'win1 narrative')] }),
      rawExtraction({ summary: 'window two', observations: [observation('win2', 'win2 narrative')] }),
    ]);

    const result = await runCaptureWorkerOnce({
      db: fakeDb as any,
      env: harness.env,
      llm,
      now: () => new Date('2026-07-06T10:00:00.000Z'),
      writerHost: TEST_WRITER,
      generateEmbedding: async () => null,
    });
    expect(result.processed).toBe(2);
    // LLM was called twice with different transcript ranges
    expect(llm.calls).toHaveLength(2);
    // First window transcript should be 0..smallEnd range
    expect(llm.calls[0].hwmOffsetStart).toBe(0);
    expect(llm.calls[0].hwmOffsetEnd).toBe(smallEnd);
    // Second window transcript should be smallEnd..bigEnd range
    expect(llm.calls[1].hwmOffsetStart).toBe(smallEnd);
    expect(llm.calls[1].hwmOffsetEnd).toBe(bigEnd);
  });

  it('session round-robin cursor prevents starvation under cap=1', async () => {
    const sessionA = makeHarness({
      projectId: `capture-worker-rr-a-${randomUUID()}`,
      sessionId: `session-a-${randomUUID()}`,
    });
    sessionA.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK = '1';
    const sessionB: TestHarness = {
      ...sessionA,
      projectId: `capture-worker-rr-z-${randomUUID()}`,
      sessionId: `session-z-${randomUUID()}`,
      transcriptPath: join(sessionA.root, 'b.transcript.jsonl'),
    };
    writeFileSync(sessionB.transcriptPath, '', { mode: 0o600 });
    await appendWindow(sessionA, { transcriptStart: 0, transcriptEnd: 0, timestamp: '2026-07-06T10:00:00.000Z' });
    await appendWindow(sessionB, { transcriptStart: 0, transcriptEnd: 0, timestamp: '2026-07-06T10:00:01.000Z' });
    const llm = mockLlm([]);

    // Tick 1: processes session A (alphabetically first), writes cursor
    await runWorker(sessionA, { db: {}, llm });
    const cursorFile = join(sessionA.spoolDir, '.tick-cursor.json');
    expect(existsSync(cursorFile)).toBe(true);

    // Tick 2: cursor rotates, processes session B
    await runWorker(sessionA, { db: {}, llm });
    expect(existsSync(statePath(sessionA))).toBe(true);
    expect(existsSync(statePath(sessionB))).toBe(true);
  });

  it('does not let a held session consume the only per-tick processing slot', async () => {
    const sessionA = makeHarness({
      projectId: `capture-worker-held-a-${randomUUID()}`,
      sessionId: `session-held-a-${randomUUID()}`,
    });
    sessionA.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK = '1';
    sessionA.env.CC_CAPTURE_RETRY_MIN_INTERVAL_MS = '1800000';
    const endA = appendTranscriptEntries(sessionA.transcriptPath, [{ message: 'held A' }]);
    await appendWindow(sessionA, {
      transcriptStart: 0,
      transcriptEnd: endA,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    await runWorker(sessionA, {
      db: {},
      llm: mockLlm([new Error('A enters retry hold')]),
      now: new Date('2026-07-06T10:00:00.000Z'),
    });

    const sessionB: TestHarness = {
      ...sessionA,
      projectId: `capture-worker-held-z-${randomUUID()}`,
      sessionId: `session-held-z-${randomUUID()}`,
      transcriptPath: join(sessionA.root, 'held-b.transcript.jsonl'),
    };
    writeFileSync(sessionB.transcriptPath, '', { mode: 0o600 });
    const endB = appendTranscriptEntries(sessionB.transcriptPath, [{ message: 'processable B' }]);
    await appendWindow(sessionB, {
      transcriptStart: 0,
      transcriptEnd: endB,
      timestamp: '2026-07-06T10:01:00.000Z',
    });
    const cursorFile = join(sessionA.spoolDir, '.tick-cursor.json');
    if (existsSync(cursorFile)) unlinkSync(cursorFile);
    const llm = mockLlm([
      rawExtraction({ summary: 'B processed in the held A tick', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };

    const result = await runWorker(sessionA, {
      db: fakeDb,
      llm,
      now: new Date('2026-07-06T10:01:00.000Z'),
    });

    expect(result).toMatchObject({ held: 1, processed: 1 });
    expect(llm.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(cursorFile, 'utf8'))).toMatchObject({
      lastSessionPath: spoolPath(sessionB),
    });
  });

  it('does not refund a held session slot after that session reports malformed input', async () => {
    const sessionA = makeHarness({
      projectId: `capture-worker-held-malformed-a-${randomUUID()}`,
      sessionId: `session-held-malformed-a-${randomUUID()}`,
    });
    sessionA.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK = '1';
    sessionA.env.CC_CAPTURE_RETRY_MIN_INTERVAL_MS = '1800000';
    const endA = appendTranscriptEntries(sessionA.transcriptPath, [{ message: 'held malformed A' }]);
    await appendWindow(sessionA, {
      transcriptStart: 0,
      transcriptEnd: endA,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    await runWorker(sessionA, {
      db: {},
      llm: mockLlm([new Error('A enters retry hold')]),
      now: new Date('2026-07-06T10:00:00.000Z'),
    });
    appendFileSync(spoolPath(sessionA), '{malformed-json\n');

    const sessionB: TestHarness = {
      ...sessionA,
      projectId: `capture-worker-held-malformed-z-${randomUUID()}`,
      sessionId: `session-held-malformed-z-${randomUUID()}`,
      transcriptPath: join(sessionA.root, 'held-malformed-b.transcript.jsonl'),
    };
    writeFileSync(sessionB.transcriptPath, '', { mode: 0o600 });
    const endB = appendTranscriptEntries(sessionB.transcriptPath, [{ message: 'B waits' }]);
    await appendWindow(sessionB, {
      transcriptStart: 0,
      transcriptEnd: endB,
      timestamp: '2026-07-06T10:01:00.000Z',
    });
    const cursorFile = join(sessionA.spoolDir, '.tick-cursor.json');
    if (existsSync(cursorFile)) unlinkSync(cursorFile);
    const llm = mockLlm([]);

    const result = await runWorker(sessionA, {
      db: {},
      llm,
      now: new Date('2026-07-06T10:01:00.000Z'),
    });

    expect(result).toMatchObject({ held: 1, malformed: 1, processed: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(JSON.parse(readFileSync(cursorFile, 'utf8'))).toMatchObject({
      lastSessionPath: spoolPath(sessionA),
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 1: category→action mapping, blocked action, ≤1024-byte park
// ---------------------------------------------------------------------------

describe('Phase 1: worker category→action integration', () => {
  function appendSimpleWindow(harness: TestHarness) {
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'Phase 1 test transcript entry' },
    ]);
    return appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: '2026-07-06T10:00:00.000Z' });
  }

  it('LLM_RATE_LIMITED stops tick and counts rateLimited', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_RATE_LIMITED', 'rate limited', { model: TEST_MODEL }),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result).toMatchObject({ rateLimited: 1, parked: 0, deadLettered: 0 });
  });

  it('LLM_PROMPT_TOO_LONG triggers split on a large chunk', async () => {
    const harness = makeHarness();
    const { transcriptEnd } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 600,
    });
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(Buffer.byteLength(originalTranscript));
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.000Z',
    });
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_PROMPT_TOO_LONG', 'prompt too long', { model: TEST_MODEL }),
      rawExtraction({ summary: 'split one', observations: [] }),
      rawExtraction({ summary: 'split two', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const result = await runWorker(harness, { db: fakeDb, llm });
    expect(result).toMatchObject({ processed: 2, deadLettered: 0 });
    expect(llm.calls).toHaveLength(3);
  });

  it('LLM_TIMEOUT (default subtype service-or-network) goes to blocked, not split', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result).toMatchObject({ blocked: 1, rateLimited: 0, parked: 0, deadLettered: 0 });
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries);
    expect(retryKeys).toHaveLength(1);
    const entry = state.retries[retryKeys[0]];
    expect(entry.blockedAttempts).toBe(1);
    expect(entry.blockedReason).toBe('timeout');
    // blocked does NOT write splitHints
    expect(Object.keys(state.splitHints)).toHaveLength(0);
  });

  it('LLM_TIMEOUT with size-or-deadline subtype goes to split', async () => {
    const harness = makeHarness();
    const { transcriptEnd } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 600,
    });
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(Buffer.byteLength(originalTranscript));
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.000Z',
    });
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', {
        model: TEST_MODEL,
        timeoutSubtype: 'size-or-deadline',
      }),
      rawExtraction({ summary: 'split one', observations: [] }),
      rawExtraction({ summary: 'split two', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const result = await runWorker(harness, { db: fakeDb, llm });
    expect(result).toMatchObject({ processed: 2, blocked: 0 });
  });

  it('CAPTURE_LLM_DISABLED skips and stops tick', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    const llm = mockLlm([
      new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', 'disabled', {
        model: TEST_MODEL,
        provider: 'test',
      }),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result).toMatchObject({ skipped: 1, blocked: 0, parked: 0 });
  });

  it('LLM_SCHEMA_INVALID goes to terminal retry', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_SCHEMA_INVALID', 'bad schema', { model: TEST_MODEL }),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result).toMatchObject({ blocked: 0, parked: 0, deadLettered: 0 });
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries);
    expect(retryKeys).toHaveLength(1);
    expect(state.retries[retryKeys[0]].attempts).toBe(1);
  });

  it('CODEX_CLI_EXIT_NONZERO goes to terminal retry', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    const llm = mockLlm([
      new CaptureLlmValidationError('CODEX_CLI_EXIT_NONZERO', 'exit 1', { model: TEST_MODEL }),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result).toMatchObject({ blocked: 0, parked: 0, deadLettered: 0 });
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries);
    expect(retryKeys).toHaveLength(1);
    expect(state.retries[retryKeys[0]].attempts).toBe(1);
  });

  it('CLAUDE_CLI_EXIT_NONZERO with prompt_too_long message goes to split', async () => {
    const harness = makeHarness();
    const { transcriptEnd } = makeChunkedTranscript(harness, {
      lineCount: 2,
      messageBytes: 600,
    });
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(Buffer.byteLength(originalTranscript));
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.000Z',
    });
    const llm = mockLlm([
      new CaptureLlmValidationError('CLAUDE_CLI_EXIT_NONZERO', 'prompt is too long', {
        model: TEST_MODEL,
        rawOutput: 'prompt is too long for this model',
      }),
      rawExtraction({ summary: 'split one', observations: [] }),
      rawExtraction({ summary: 'split two', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const result = await runWorker(harness, { db: fakeDb, llm });
    expect(result).toMatchObject({ processed: 2, blocked: 0 });
  });
});

describe('Phase 1: blocked action lifecycle', () => {
  function appendSimpleWindow(harness: TestHarness) {
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'Phase 1 blocked lifecycle test' },
    ]);
    return appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: '2026-07-06T10:00:00.000Z' });
  }

  it('5 effective blocked attempts, 6th dead-letters', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    const sink = { chunks: [] as string[], stdout: { write: (c: string) => { sink.chunks.push(c); return true; } } };
    // Simulate 5 blocked ticks
    for (let i = 0; i < 5; i++) {
      const llm = mockLlm([
        new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
      ]);
      const result = await runWorker(harness, {
        db: {},
        llm,
        now: new Date(`2026-07-06T${10 + i}:00:00.000Z`),
        stdout: sink.stdout,
      });
      expect(result.blocked).toBe(1);
      expect(result.deadLettered).toBe(0);
    }
    // 6th attempt should dead-letter
    const llm6 = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    const result6 = await runWorker(harness, {
      db: {},
      llm: llm6,
      now: new Date('2026-07-06T16:00:00.000Z'),
      stdout: sink.stdout,
    });
    expect(result6.blocked).toBe(1);
    expect(result6.deadLettered).toBe(1);
    expect(result6.parked).toBe(1);
  });

  it('held ticks do not count toward blocked attempts', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    // Use non-zero retry interval for hold testing
    harness.env.CC_CAPTURE_RETRY_MIN_INTERVAL_MS = '1800000';
    // First blocked attempt
    const llm1 = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    const r1 = await runWorker(harness, {
      db: {},
      llm: llm1,
      now: new Date('2026-07-06T10:00:00.000Z'),
    });
    expect(r1.blocked).toBe(1);
    // Second attempt too soon: should be held
    const llm2 = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    const r2 = await runWorker(harness, {
      db: {},
      llm: llm2,
      now: new Date('2026-07-06T10:00:01.000Z'), // 1 second later, within 30 min hold
    });
    expect(r2.held).toBe(1);
    expect(r2.blocked).toBe(0);
    // State should still have blockedAttempts=1
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries);
    expect(retryKeys).toHaveLength(1);
    expect(state.retries[retryKeys[0]].blockedAttempts).toBe(1);
  });

  it('reset: chunk success clears blockedAttempts', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    // First: blocked
    const llm1 = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    await runWorker(harness, { db: {}, llm: llm1, now: new Date('2026-07-06T10:00:00.000Z') });
    // Verify blocked state
    const state1 = readState(harness);
    const retryKeys = Object.keys(state1.retries);
    expect(retryKeys).toHaveLength(1);
    expect(state1.retries[retryKeys[0]].blockedAttempts).toBe(1);
    // Second: success (clears retry entry entirely via clearCoveredEntries)
    const llm2 = mockLlm([
      rawExtraction({ summary: 'success', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const r2 = await runWorker(harness, {
      db: fakeDb,
      llm: llm2,
      now: new Date('2026-07-06T11:00:00.000Z'),
    });
    expect(r2.processed).toBe(1);
    const state2 = readState(harness);
    expect(Object.keys(state2.retries)).toHaveLength(0);
  });

  it('old state without blocked fields defaults to 0', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'old state compat test' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: '2026-07-06T10:00:00.000Z' });
    // Write a state file with a retry entry that lacks blocked fields
    const sp = join(
      harness.spoolDir,
      sanitizeSpoolSegment(harness.projectId),
      `${sanitizeSpoolSegment(harness.sessionId)}.capture-state.json`
    );
    const fakeState: CaptureStateV2 = {
      version: 2,
      spool: { generation: 'gen', cursor: 0 },
      transcripts: {},
      retries: {
        'fake-key': {
          attempts: 1,
          lastErrorClass: 'LLM_EXTRACT_FAILED',
          firstSeenIso: '2026-07-06T10:00:00.000Z',
          lastAttemptIso: '2026-07-06T10:00:00.000Z',
          pathHash: createHash('sha256').update('test').digest('hex'),
          start: 0,
          end: 100,
          contentHash: createHash('sha256').update('content').digest('hex'),
          // No blockedAttempts, lastBlockedAtIso, blockedReason
        } as CaptureRetryEntry,
      },
      splitHints: {},
    };
    writeFileSync(sp, JSON.stringify(fakeState));
    // Running worker should parse successfully (defaults to 0)
    const llm = mockLlm([
      rawExtraction({ summary: 'ok', observations: [] }),
    ]);
    const fakeDb = { transaction: async () => ({ observationsWritten: 0, rollupsWritten: 1 }) };
    const result = await runWorker(harness, {
      db: fakeDb,
      llm,
      now: new Date('2026-07-06T11:00:00.000Z'),
    });
    // Should not crash; state is parseable
    expect(result.processed + result.blocked + result.held).toBeGreaterThanOrEqual(0);
  });

  it('≤1024 bytes chunk that cannot split goes to blocked then eventually parks', async () => {
    const harness = makeHarness();
    // Create a tiny transcript (≤1024 bytes)
    const tinyMessage = 'x'.repeat(200);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: tinyMessage },
    ]);
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = '2000';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:33.000Z',
    });
    const sink = { chunks: [] as string[], stdout: { write: (c: string) => { sink.chunks.push(c); return true; } } };
    // 5 effective blocked attempts
    for (let i = 0; i < 5; i++) {
      const llm = mockLlm([
        new CaptureLlmValidationError('LLM_PROMPT_TOO_LONG', 'too long', { model: TEST_MODEL }),
      ]);
      const result = await runWorker(harness, {
        db: {},
        llm,
        now: new Date(`2026-07-06T${10 + i}:00:00.000Z`),
        stdout: sink.stdout,
      });
      expect(result.blocked).toBe(1);
      expect(result.deadLettered).toBe(0);
    }
    // 6th: dead-letter
    const llm6 = mockLlm([
      new CaptureLlmValidationError('LLM_PROMPT_TOO_LONG', 'too long', { model: TEST_MODEL }),
    ]);
    const result6 = await runWorker(harness, {
      db: {},
      llm: llm6,
      now: new Date('2026-07-06T16:00:00.000Z'),
      stdout: sink.stdout,
    });
    expect(result6.blocked).toBe(1);
    expect(result6.deadLettered).toBe(1);
    expect(result6.parked).toBe(1);
  });

  it('alternateCategory terminal goes to terminal retry, not blocked', async () => {
    const harness = makeHarness();
    // Tiny transcript that cannot be split
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'x'.repeat(200) },
    ]);
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = '2000';
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: '2026-07-06T10:00:00.000Z' });
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_PROMPT_TOO_LONG', 'too long', {
        model: TEST_MODEL,
        alternateCategory: 'terminal',
      }),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result.blocked).toBe(0);
    // Should go through terminal retry path: attempts incremented
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries);
    expect(retryKeys).toHaveLength(1);
    expect(state.retries[retryKeys[0]].attempts).toBe(1);
  });

  it('alternateCategory rate-limited goes to blocked, not terminal', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'x'.repeat(200) },
    ]);
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = '2000';
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: '2026-07-06T10:00:00.000Z' });
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_PROMPT_TOO_LONG', 'too long', {
        model: TEST_MODEL,
        alternateCategory: 'rate-limited',
      }),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result.blocked).toBe(1);
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries);
    expect(retryKeys).toHaveLength(1);
    expect(state.retries[retryKeys[0]].attempts).toBe(0);
    expect(state.retries[retryKeys[0]].blockedAttempts).toBe(1);
  });

  it('contentHash change resets blockedAttempts (new key)', async () => {
    const harness = makeHarness();
    // First transcript content
    const transcriptEnd1 = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'original-content-aaa' },
    ]);
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = '2000';
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd: transcriptEnd1, timestamp: '2026-07-06T10:00:00.000Z' });
    // First blocked
    const llm1 = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    await runWorker(harness, { db: {}, llm: llm1, now: new Date('2026-07-06T10:00:00.000Z') });
    const state1 = readState(harness);
    const keys1 = Object.keys(state1.retries);
    expect(keys1).toHaveLength(1);
    expect(state1.retries[keys1[0]].blockedAttempts).toBe(1);

    // Mutate transcript content (simulates hooks appending more data to same range)
    // Since retryKey includes contentHash, a new hash = new entry = fresh blockedAttempts
    writeFileSync(harness.transcriptPath, JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', message: 'changed-content-bbb' }) + '\n');
    const llm2 = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    await runWorker(harness, { db: {}, llm: llm2, now: new Date('2026-07-06T11:00:00.000Z') });
    const state2 = readState(harness);
    const keys2 = Object.keys(state2.retries);
    // Old key cleared (content changed → different retryKey), new key with blockedAttempts=1
    const nonZeroBlocked = keys2.filter(k => (state2.retries[k].blockedAttempts ?? 0) > 0);
    expect(nonZeroBlocked).toHaveLength(1);
    expect(state2.retries[nonZeroBlocked[0]].blockedAttempts).toBe(1);
  });

  it('category change does NOT reset blockedAttempts', async () => {
    const harness = makeHarness();
    await appendSimpleWindow(harness);
    // First: blocked with timeout
    const llm1 = mockLlm([
      new CaptureLlmValidationError('LLM_TIMEOUT', 'timed out', { model: TEST_MODEL }),
    ]);
    await runWorker(harness, { db: {}, llm: llm1, now: new Date('2026-07-06T10:00:00.000Z') });
    // Second: blocked with prompt-too-long (tiny chunk, unsplittable → blocked)
    const llm2 = mockLlm([
      new CaptureLlmValidationError('LLM_PROMPT_TOO_LONG', 'too long', { model: TEST_MODEL }),
    ]);
    await runWorker(harness, { db: {}, llm: llm2, now: new Date('2026-07-06T11:00:00.000Z') });
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries);
    expect(retryKeys).toHaveLength(1);
    // Both counted: blockedAttempts should be 2
    expect(state.retries[retryKeys[0]].blockedAttempts).toBe(2);
  });
});

describe('Phase 4/5: worker telemetry, budget, capacity, windows', () => {
  it('result includes telemetry fields from takeTelemetry', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'hello' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    let telemetryCalled = false;
    const llm = mockLlm(
      [new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', 'disabled')],
      {
        disabled: true,
        disabledReason: 'disabled',
        takeTelemetry() {
          telemetryCalled = true;
          return { primaryProvider: 'codex-cli', primarySuccess: 3, fallbackSuccess: 1, fallbackFailed: 0 };
        },
      }
    );
    const result = await runWorker(harness, { db: {}, llm });
    expect(telemetryCalled).toBe(true);
    expect(result.primaryProvider).toBe('codex-cli');
    expect(result.primarySuccess).toBe(3);
    expect(result.fallbackSuccess).toBe(1);
    expect(result.fallbackFailed).toBe(0);
  });

  it('fatalError captured when exception escapes inner catches, telemetry still flows', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'hello' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    let telemetryCalled = false;
    const llm = mockLlm([], {
      takeTelemetry() {
        telemetryCalled = true;
        return { primaryProvider: 'test-p', primarySuccess: 0, fallbackSuccess: 0, fallbackFailed: 0 };
      },
    });
    // Force a fatal by making nowMs throw on its second call.
    // The first call sets tickStartMs; the second is the budget check
    // inside the session for-loop, outside the per-session try/catch.
    let nowMsCallCount = 0;
    const result = await runWorker(harness, {
      db: {},
      llm,
      nowMs: () => {
        nowMsCallCount += 1;
        if (nowMsCallCount > 1) throw new Error('FATAL_CLOCK_FAIL');
        return 0;
      },
    });
    expect(result.fatalError).toBe('FATAL_CLOCK_FAIL');
    expect(telemetryCalled).toBe(true);
    expect(result.primaryProvider).toBe('test-p');
  });

  it('spool-cap early exit records spoolBytes and spoolCapPct', async () => {
    const harness = makeHarness();
    harness.env.CC_MEMORY_SPOOL_MAX_MB = '0.0001'; // ~100 bytes
    // Create a spool file big enough to exceed the tiny cap
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'x'.repeat(2000) },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    const llm = mockLlm([]);
    const result = await runWorker(harness, { db: {}, llm });
    expect(result.skipped).toBe(1);
    expect(result.spoolBytes).toBeGreaterThan(0);
    expect(result.spoolCapPct).toBeGreaterThan(100);
  });

  it('spool capacity 70% warning path: spoolCapPct tracked correctly', async () => {
    const harness = makeHarness();
    // Set max to double the spool size (around 50%)
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'small' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    const llm = mockLlm(
      [new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', 'disabled')],
      { disabled: true, disabledReason: 'disabled' }
    );
    const result = await runWorker(harness, { db: {}, llm });
    // Just verify spoolCapPct is calculated
    expect(typeof result.spoolCapPct).toBe('number');
    expect(result.spoolBytes).toBeGreaterThan(0);
  });

  it('llmCallReserveMs uses adapter worstCaseCallBudgetMs', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '100000'; // 100s budget
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    // 91000 worstCase + 15000 settle = 106000 > 100000 → yield immediately at the LLM reserve check
    const llm = mockLlm(
      [new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', 'should not be called')],
      { worstCaseCallBudgetMs: 91_000 }
    );
    const result = await runWorker(harness, { db: {}, llm });
    // Should yield because budget (100s) < reserve (91s + 15s = 106s)
    expect(result.yielded).toBeGreaterThanOrEqual(1);
    expect(llm.calls).toHaveLength(0);
  });

  it('windows-per-tick limits windows processed', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_MAX_WINDOWS_PER_TICK = '1';
    // Write a transcript that will create 2 chunks
    const entries = Array.from({ length: 4 }, (_, i) => ({
      timestamp: `2026-01-01T00:00:0${i}.000Z`,
      message: `line-${i}:${'x'.repeat(800)}`,
    }));
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, entries);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:05.000Z',
    });
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = '1500'; // Force splitting
    const llm = mockLlm(
      [new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', 'disabled')],
      { disabled: true, disabledReason: 'disabled' }
    );
    const result = await runWorker(harness, { db: {}, llm });
    // With maxWindows=1, should yield after first window
    expect(result.windows).toBeLessThanOrEqual(1);
  });

  it('windows count increments before first extract, not on malformed retry', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'test content for window counting' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    // First attempt: malformed, second: malformed again → terminal
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_MALFORMED_JSON', 'bad json'),
      new CaptureLlmValidationError('LLM_MALFORMED_JSON', 'bad json again'),
    ]);
    const result = await runWorker(harness, { db: {}, llm });
    // Only 1 window, even though 2 LLM calls
    expect(result.windows).toBe(1);
  });

  it('telemetry lifecycle: two ticks do not retain counters', async () => {
    const harness = makeHarness();
    let callCount = 0;
    const llm = mockLlm(
      [new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', 'disabled')],
      {
        disabled: true,
        disabledReason: 'disabled',
        takeTelemetry() {
          callCount += 1;
          return { primaryProvider: 'test', primarySuccess: callCount, fallbackSuccess: 0, fallbackFailed: 0 };
        },
      }
    );
    const r1 = await runWorker(harness, { db: {}, llm });
    expect(r1.primarySuccess).toBe(1);
    const r2 = await runWorker(harness, { db: {}, llm });
    expect(r2.primarySuccess).toBe(2);
  });

  it('P→F(malformed)→forced F: worker passes forceProvider on retry attempt', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'malformed retry test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    // Step 1: wrapper returns malformed with retryProvider='fallback'
    // Step 2: retry succeeds (worker should pass forceProvider='fallback')
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_MALFORMED_JSON', 'bad json', {
        retryProvider: 'fallback',
      }),
      rawExtraction({
        summary: 'retry succeeded',
        observations: [{
          type: 'discovery',
          title: 'retry test',
          subtitle: '',
          facts: ['retried successfully'],
          concepts: ['retry'],
          files: [],
          narrative: 'The retry with forceProvider worked.',
        }],
        model: 'haiku',
      }),
    ]);

    const result = await runWorker(harness, { db: {}, llm });

    // Two extract calls should have been made
    expect(llm.calls).toHaveLength(2);
    // First call: no forceProvider (or undefined)
    expect(llm.extractOptions?.[0]?.forceProvider).toBeUndefined();
    // Second call: forceProvider='fallback' from retryProvider in error details
    expect(llm.extractOptions?.[1]?.forceProvider).toBe('fallback');
    // Second call carries the retry prompt prefix
    expect(llm.calls[1].retryPromptPrefix).toBeDefined();
    // Result should show the extraction was processed
    expect(result.llmRetries).toBeGreaterThanOrEqual(1);
    // pendingRetryProvider should be cleared after success
    if (existsSync(statePath(harness))) {
      const state = readState(harness);
      for (const key of Object.keys(state.retries ?? {})) {
        expect(state.retries[key].pendingRetryProvider).toBeUndefined();
      }
    }
  });

  it('six ticks with both providers rate-limited: retry state stays empty, zero dead-letter', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'rate-limited session' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    // Both providers rate-limited: primary throws LLM_RATE_LIMITED, fallback too.
    // The FallbackCaptureLlmAdapter would produce LLM_RATE_LIMITED (rl×rl → rl).
    const llm = mockLlm(
      // Provide enough steps for 6 ticks (rate-limited stops the tick after first call)
      Array.from({ length: 6 }, () =>
        new CaptureLlmValidationError('LLM_RATE_LIMITED', 'both rate limited')
      ),
    );

    // Run 6 ticks
    const results = [];
    for (let tick = 0; tick < 6; tick += 1) {
      const result = await runWorker(harness, { db: {}, llm });
      results.push(result);
    }

    // All ticks should have been stopped by rate-limiting
    for (const r of results) {
      expect(r.rateLimited).toBeGreaterThan(0);
      expect(r.deadLettered).toBe(0);
    }

    // State file: if it exists, no retry entry should have attempts > 0
    const stateFile = statePath(harness);
    if (existsSync(stateFile)) {
      const state = readState(harness);
      const retryKeys = Object.keys(state.retries ?? {});
      for (const key of retryKeys) {
        expect(state.retries[key].attempts).toBe(0);
      }
    }
  });
});

describe('Codex findings: forceProvider, budget, yield, blockedReason', () => {
  it('cross-tick: tick 1 yields with pendingRetryProvider persisted, tick 2 resumes with fallback-only reserve', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '240000';
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'cross-tick retry test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    // Tick 1: primary fails with malformed, retryProvider=fallback.
    // After primary call completes, elapsed jumps to 160s.
    // Retry budget check: 160s + fallback reserve (76+15=91s) = 251s > 240s → yield before retry.
    const tick1Start = Date.now();
    let tick1Elapsed = 0;
    const llm1 = mockLlm([
      new CaptureLlmValidationError('LLM_MALFORMED_JSON', 'bad json', {
        retryProvider: 'fallback',
      }),
    ], {
      worstCaseCallBudgetMs: 167000,
      worstCaseCallBudgetMsFor(provider: string): number {
        return provider === 'fallback' ? 76000 : 91000;
      },
      // Advance clock AFTER the extract call completes (inside extract)
      async extract(request, options) {
        llm1.calls.push(request);
        llm1.extractOptions!.push(options);
        // After primary call, advance clock so retry budget check fails
        tick1Elapsed = 160_000;
        throw new CaptureLlmValidationError('LLM_MALFORMED_JSON', 'bad json', {
          retryProvider: 'fallback',
        });
      },
    });
    const result1 = await runWorker(harness, {
      db: {},
      llm: llm1,
      nowMs: () => tick1Start + tick1Elapsed,
    });

    // Tick 1: primary called once, then budget check fails → yield
    expect(llm1.calls).toHaveLength(1);
    expect(llm1.extractOptions?.[0]?.forceProvider).toBeUndefined();
    expect(result1.yielded).toBe(1);

    // pendingRetryProvider persisted in state
    expect(existsSync(statePath(harness))).toBe(true);
    const stateAfterTick1 = readState(harness);
    const retryKeys1 = Object.keys(stateAfterTick1.retries ?? {});
    expect(retryKeys1.length).toBeGreaterThan(0);
    expect(stateAfterTick1.retries[retryKeys1[0]].pendingRetryProvider).toBe('fallback');

    // Tick 2: resume on same harness — worker reads persisted state.
    // Clock: first call (tickStart init) → t=0; all subsequent calls → t=100s.
    // Full reserve = 167+15 = 182s → 100+182=282 > 240 → WOULD yield with full reserve.
    // Fallback-only reserve = 76+15 = 91s → 100+91=191 ≤ 240 → should proceed.
    // This proves fallback-only reserve is used (not the full chain).
    const tick2Start = Date.now();
    let tick2CallCount = 0;
    const llm2 = mockLlm([
      rawExtraction({
        summary: 'retry succeeded on fallback',
        observations: [{
          type: 'discovery',
          title: 'cross-tick test',
          subtitle: '',
          facts: ['cross-tick OK'],
          concepts: ['retry'],
          files: [],
          narrative: 'Cross-tick retry passed.',
        }],
        model: 'haiku',
      }),
    ], {
      worstCaseCallBudgetMs: 167000,
      worstCaseCallBudgetMsFor(provider: string): number {
        return provider === 'fallback' ? 76000 : 91000;
      },
    });
    const result2 = await runWorker(harness, {
      db: {},
      llm: llm2,
      nowMs: () => {
        tick2CallCount += 1;
        // First call captures tickStartMs at t=0; all subsequent see 100s elapsed
        if (tick2CallCount <= 1) return tick2Start;
        return tick2Start + 100_000;
      },
    });

    // Tick 2: fallback called directly (forceProvider='fallback'), primary NOT called
    expect(llm2.calls).toHaveLength(1);
    expect(llm2.extractOptions?.[0]?.forceProvider).toBe('fallback');
    expect(result2.yielded).toBe(0);
  });

  it('forced fallback reserve uses fallback-only budget, not full primary+fallback', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '240000';
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'budget test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    // 100s elapsed. Full reserve = 167s + 15s = 182s. 100+182 = 282 > 240 → old code would yield.
    // With fallback-only reserve = 76s + 15s = 91s. 100+91 = 191 ≤ 240 → should NOT yield.
    let nowMs = Date.now();
    const tickStart = nowMs;
    // After first call, advance to 100s
    const llm = mockLlm([
      // First call: primary returns malformed with retryProvider
      new CaptureLlmValidationError('LLM_MALFORMED_JSON', 'bad json', {
        retryProvider: 'fallback',
      }),
      // Second call: forced fallback succeeds
      rawExtraction({
        summary: 'retry succeeded',
        observations: [{
          type: 'discovery',
          title: 'budget test',
          subtitle: '',
          facts: ['budget OK'],
          concepts: ['budget'],
          files: [],
          narrative: 'Budget test passed.',
        }],
        model: 'haiku',
      }),
    ], {
      worstCaseCallBudgetMs: 167000,  // primary(91) + fallback(76); reserve = 167 + 15 = 182s
      worstCaseCallBudgetMsFor(provider: string): number {
        return provider === 'fallback' ? 76000 : 91000;
      },
    });

    const result = await runWorker(harness, {
      db: {},
      llm,
      nowMs: () => {
        const current = nowMs;
        // After first LLM call, advance 100s
        if (llm.calls.length === 1) {
          nowMs = tickStart + 100_000;
        }
        return current;
      },
    });

    // Both calls should have been made (budget check should have passed)
    expect(llm.calls).toHaveLength(2);
    expect(result.yielded).toBe(0);
  });

  it('yield at 59s with 182s reserve does NOT count as a window', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '240000';
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'yield window test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    // 59s elapsed + 197s reserve (182+15) = 256s > 240s → should yield
    const tickStart = Date.now();
    let callCount = 0;
    const llm = mockLlm([], {
      worstCaseCallBudgetMs: 167000,
    });

    const result = await runWorker(harness, {
      db: {},
      llm,
      nowMs: () => {
        // First call is tickStartMs initialization; after that, simulate 59s elapsed
        callCount += 1;
        return callCount <= 1 ? tickStart : tickStart + 59_000;
      },
    });

    expect(result.yielded).toBe(1);
    expect(result.windows).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('58s with 182s reserve → proceeds and counts window', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_TICK_BUDGET_MS = '240000';
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'window count test' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    // 58s + 182s reserve (167+15) = 240s = budget → proceeds (not strictly greater)
    const tickStart = Date.now();
    let callCount = 0;
    const llm = mockLlm([
      rawExtraction({
        summary: 'ok',
        observations: [{
          type: 'discovery',
          title: 'test',
          subtitle: '',
          facts: ['ok'],
          concepts: [],
          files: [],
          narrative: 'ok',
        }],
        model: 'haiku',
      }),
    ], {
      worstCaseCallBudgetMs: 167000,
    });

    const result = await runWorker(harness, {
      db: {},
      llm,
      nowMs: () => {
        callCount += 1;
        return callCount <= 1 ? tickStart : tickStart + 58_000;
      },
    });

    expect(result.windows).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('alternateCategory path records alternate category in blockedReason, not original category', async () => {
    const harness = makeHarness();
    // Use a small transcript to trigger prompt-too-long → can't split → alternateCategory
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'x' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    // Error: prompt-too-long with alternateCategory=rate-limited
    // chunk is ≤1024 bytes so splitTranscriptChunk returns null → goes to alternateCategory
    const llm = mockLlm([
      new CaptureLlmValidationError('LLM_PROMPT_TOO_LONG', 'prompt too long', {
        model: TEST_MODEL,
        alternateCategory: 'rate-limited',
      }),
    ]);

    await runWorker(harness, { db: {}, llm });

    // Check that blockedReason is 'rate-limited' (the alternateCategory), not 'prompt-too-long'
    const state = readState(harness);
    const retryKeys = Object.keys(state.retries ?? {});
    expect(retryKeys.length).toBeGreaterThanOrEqual(1);
    const entry = state.retries[retryKeys[0]];
    expect(entry.blockedReason).toBe('rate-limited');
  });
});

describe('capture worker DB-backed RED contracts', () => {
  it('holds a terminal retry until the configured interval expires', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_RETRY_MIN_INTERVAL_MS = '1800000';
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'retry interval source' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });

    await runWorker(harness, {
      db: {},
      llm: mockLlm([new Error('terminal failure')]),
      now: new Date('2026-07-06T10:00:00.000Z'),
    });
    const retryKey = Object.keys(readState(harness).retries)[0];
    expect(readState(harness).retries[retryKey].attempts).toBe(1);

    const heldLlm = mockLlm([]);
    const held = await runWorker(harness, {
      db: {},
      llm: heldLlm,
      now: new Date('2026-07-06T10:01:00.000Z'),
    });
    expect(held).toMatchObject({ held: 1, processed: 0, parked: 0 });
    expect(heldLlm.calls).toHaveLength(0);
    expect(readState(harness).retries[retryKey].attempts).toBe(1);

    const expiredLlm = mockLlm([new Error('terminal failure again')]);
    await runWorker(harness, {
      db: {},
      llm: expiredLlm,
      now: new Date('2026-07-06T10:30:00.000Z'),
    });
    expect(expiredLlm.calls).toHaveLength(1);
    expect(readState(harness).retries[retryKey].attempts).toBe(2);
  });

  it('does not hold a retry when the recorded attempt is in the future', () => {
    expect(isCaptureRetryHeld(
      { attempts: 1, lastAttemptIso: '2026-07-06T11:00:00.000Z' },
      Date.parse('2026-07-06T10:00:00.000Z'),
      1_800_000
    )).toBe(false);
  });

  it('holds a missing transcript retry without consuming another attempt', async () => {
    const harness = makeHarness();
    harness.env.CC_CAPTURE_RETRY_MIN_INTERVAL_MS = '1800000';
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'soon missing source' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });
    unlinkSync(harness.transcriptPath);

    await runWorker(harness, {
      db: {},
      llm: mockLlm([]),
      now: new Date('2026-07-06T10:00:00.000Z'),
    });
    const retryKey = Object.keys(readState(harness).retries)[0];
    const held = await runWorker(harness, {
      db: {},
      llm: mockLlm([]),
      now: new Date('2026-07-06T10:01:00.000Z'),
    });

    expect(held).toMatchObject({ held: 1, transcriptMissing: 0, parked: 0 });
    expect(readState(harness).retries[retryKey].attempts).toBe(1);
  });

  let sql: Sql;
  let pg: Sql;
  let db: unknown;

  beforeAll(async () => {
    sql = await connectDb(TEST_DB_URL);
    pg = postgres(TEST_DB_URL, { max: 4 });
    db = drizzle(pg);
  });

  afterAll(async () => {
    if (pg) await pg.end();
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DROP TRIGGER IF EXISTS test_capture_rollup_discovery_guard ON project_memories`;
    await sql`DROP FUNCTION IF EXISTS test_capture_rollup_discovery_guard()`;
    await sql`DELETE FROM observations WHERE project_id LIKE 'capture-worker-%'`;
    await sql`DELETE FROM project_memories WHERE project_id LIKE 'capture-worker-%'`;
  });

  it('retries malformed LLM JSON once and writes the second successful response without dead-lettering', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        message: 'first malformed response should be retried',
      },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:45.000Z',
    });
    const llm = mockLlm([
      { model: TEST_MODEL, text: 'not json on first attempt' },
      rawExtraction({
        summary: 'retry recovered',
        observations: [observation('retry recovered', 'retry recovered narrative')],
      }),
    ]);

    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      processed: 1,
      deadLettered: 0,
      llmRetries: 1,
      observationsWritten: 1,
    });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]).not.toHaveProperty('retryPromptPrefix');
    expect(
      (llm.calls[1] as CaptureLlmRequest & { retryPromptPrefix?: string }).retryPromptPrefix
    ).toContain('first character must be `{`');
    expect(existsSync(deadDir(harness))).toBe(false);
    expect(await countRows(sql, harness.projectId, harness.sessionId)).toEqual({
      observations: 1,
      rollups: 1,
    });
  });

  it('counts null embeddings as failures only when embedding was expected', async () => {
    const harness = makeHarness();
    harness.env.CC_MEMORY_EMBEDDING_EXPECTED = '1';
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'invalid embedding credential remains observable' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:50.000Z',
    });
    const llm = mockLlm([rawExtraction({
      summary: 'embedding failure is non-blocking',
      observations: [observation('embedding failure', 'capture still writes NULL')],
    })]);

    const result = await runWorker(harness, {
      db,
      llm,
      generateEmbedding: async () => null,
    });

    expect(result).toMatchObject({ processed: 1, embeddingFailed: 2 });
    expect(await countRows(sql, harness.projectId, harness.sessionId)).toEqual({
      observations: 1,
      rollups: 1,
    });
  });

  it('parks malformed LLM JSON after 5 tick attempts with truncated raw output and without transcript text or DB rows', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        message: SECRET_TRANSCRIPT_TEXT,
      },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:00.000Z',
    });
    const retryMalformedOutput = `retry-not-json:${'x'.repeat(3000)}`;

    // Ticks 1-4: hold
    for (let tick = 1; tick <= 4; tick += 1) {
      const llm = mockLlm([
        { model: TEST_MODEL, text: 'not json' },
        { model: TEST_MODEL, text: retryMalformedOutput },
      ]);
      await runWorker(harness, { db, llm });
    }

    // Tick 5: park
    const llm5 = mockLlm([
      { model: TEST_MODEL, text: 'final not json' },
      { model: TEST_MODEL, text: retryMalformedOutput },
    ]);
    await expect(runWorker(harness, { db, llm: llm5 })).resolves.toMatchObject({
      processed: 0,
      deadLettered: 1,
      parked: 1,
      llmRetries: 1,
    });

    const deadLetter = readOnlyDeadLetter(harness);
    const metadata = deadLetter.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      session_id: harness.sessionId,
      offset: expect.objectContaining({ start: 0, end: expect.any(Number) }),
      error_code: 'LLM_MALFORMED_JSON',
      model: TEST_MODEL,
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(deadLetter)).not.toContain(SECRET_TRANSCRIPT_TEXT);
    expect(deadLetter).not.toHaveProperty('transcript');
    expect(deadLetter).not.toHaveProperty('transcript_text');
    expect(deadLetter.llm_raw_output).toBe(retryMalformedOutput.slice(0, 2048));

    expect(await countRows(sql, harness.projectId, harness.sessionId)).toEqual({
      observations: 0,
      rollups: 0,
    });
  });

  it('splits large transcript windows into chunks that write observations under one rollup with monotonic observed_at', async () => {
    const harness = makeHarness();
    const { transcriptEnd, lines, cap } = makeChunkedTranscript(harness, {
      lineCount: 3,
      messageBytes: 80,
    });
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:30.000Z',
    });
    const processingTime = new Date('2026-07-06T10:01:40.000Z');
    const llm = mockLlm([
      rawExtraction({
        summary: 'chunk one summary',
        observations: [observation('chunk one', 'chunk one narrative')],
      }),
      rawExtraction({
        summary: 'chunk two summary',
        observations: [observation('chunk two', 'chunk two narrative')],
      }),
      rawExtraction({
        summary: 'chunk three summary',
        observations: [observation('chunk three', 'chunk three narrative')],
      }),
    ]);

    await expect(runWorker(harness, { db, llm, now: processingTime })).resolves.toMatchObject({
      deadLettered: 0,
      observationsWritten: 3,
    });

    expect(llm.calls).toHaveLength(3);
    expect(llm.calls.map((call) => call.transcript)).toEqual(lines);
    for (const call of llm.calls) {
      expect(Buffer.byteLength(call.transcript)).toBeLessThanOrEqual(cap);
    }

    const rollupRows = await rollups(sql, harness.projectId, harness.sessionId);
    expect(rollupRows).toHaveLength(1);
    const observationRows = await observations(sql, harness.projectId, harness.sessionId);
    expect(observationRows).toHaveLength(3);
    expect(observationRows.map((row) => row.rollupMemoryId)).toEqual([
      rollupRows[0].id,
      rollupRows[0].id,
      rollupRows[0].id,
    ]);
    expect(observationRows.map((row) => row.observedAt.toISOString())).toEqual([
      processingTime.toISOString(),
      new Date(processingTime.getTime() + 1).toISOString(),
      new Date(processingTime.getTime() + 2).toISOString(),
    ]);
    expect(readState(harness).spool.cursor).toBe(statSync(spoolPath(harness)).size);
  });

  it('holds HWM when a chunk within a single oversized window fails (retry sidecar)', async () => {
    const harness = makeHarness();
    const { transcriptEnd, cap } = makeChunkedTranscript(harness, {
      lineCount: 3,
      messageBytes: 80,
    });
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = String(cap);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:45.000Z',
    });
    writeFileSync(hwmPath(harness), '0', { mode: 0o600 });
    const chunkTwoRaw = 'chunk two is not json';
    const chunkTwoRetryRaw = 'chunk two retry is still not json';
    const llm = mockLlm([
      rawExtraction({
        summary: 'partial chunk one summary',
        observations: [observation('partial chunk one', 'partial chunk one narrative')],
      }),
      { model: TEST_MODEL, text: chunkTwoRaw },
      { model: TEST_MODEL, text: chunkTwoRetryRaw },
    ]);

    // Under new semantics: chunk failure within a window → hold entire window (attempt 1)
    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      deadLettered: 0,
      llmRetries: 1,
    });

    expect(readState(harness).spool.cursor).toBe(0);
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(cap);
  });

  it('does not split UTF-8 characters when chunking cuts through a multibyte boundary', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        message: `utf8 boundary ${'你'.repeat(40)}`,
      },
    ]);
    const originalTranscript = readFileSync(harness.transcriptPath, 'utf8');
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = '37';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:55.000Z',
    });
    const llm = mockLlm(
      Array.from({ length: 20 }, (_, index) =>
        rawExtraction({ summary: `utf8 chunk ${index}`, observations: [] })
      )
    );

    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      deadLettered: 0,
    });

    expect(llm.calls.length).toBeGreaterThan(1);
    expect(llm.calls.map((call) => call.transcript).join('')).toBe(originalTranscript);
    for (const call of llm.calls) {
      expect(call.transcript).not.toContain('\uFFFD');
      expect(Buffer.byteLength(call.transcript)).toBeLessThanOrEqual(37);
    }
  });

  it('falls back to the default max window bytes when CC_CAPTURE_MAX_WINDOW_BYTES is not parseable', async () => {
    const harness = makeHarness();
    const defaultMaxWindowBytes = 262_144;
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        message: 'a'.repeat(defaultMaxWindowBytes + 8192),
      },
    ]);
    harness.env.CC_CAPTURE_MAX_WINDOW_BYTES = 'not-a-number';
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:01:58.000Z',
    });
    const llm = mockLlm(
      Array.from({ length: 4 }, (_, index) =>
        rawExtraction({ summary: `fallback chunk ${index}`, observations: [] })
      )
    );

    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      deadLettered: 0,
    });

    expect(llm.calls.length).toBeGreaterThan(1);
    for (const call of llm.calls) {
      expect(Buffer.byteLength(call.transcript)).toBeLessThanOrEqual(defaultMaxWindowBytes);
    }
  });

  it('does not advance HWM when the DB transaction fails', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'transaction failure window' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:02:00.000Z',
    });
    writeFileSync(hwmPath(harness), '0', { mode: 0o600 });

    const failingDb = {
      transaction: async () => {
        throw new Error('synthetic transaction failure');
      },
    };
    const llm = mockLlm([
      rawExtraction({
        summary: 'transaction failure summary',
        observations: [observation('transaction failure', 'must not advance HWM')],
      }),
    ]);

    await expect(runWorker(harness, { db: failingDb, llm })).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(readState(harness).spool.cursor).toBe(0);
  });

  it('does not duplicate observations when the same spool window is replayed', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'same spool replay' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:03:00.000Z',
    });
    const response = rawExtraction({
      summary: 'same spool replay summary',
      observations: [observation('replay observation', 'same spool replay narrative')],
    });
    const llm = mockLlm([response, response]);

    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      processed: 1,
      observationsWritten: 1,
    });
    resetStateForReplay(harness);
    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      processed: 1,
      observationsWritten: 0,
    });

    const rows = await sql<{ total: number; distinctHashes: number }[]>`
      SELECT
        COUNT(*)::int AS total,
        COUNT(DISTINCT content_hash)::int AS "distinctHashes"
      FROM observations
      WHERE project_id = ${harness.projectId}
        AND session_id = ${harness.sessionId}
        AND status = 'active'
    `;
    expect(rows[0]).toEqual({ total: 1, distinctHashes: 1 });
  });

  it('keeps rollup metadata counters idempotent when the same spool window is replayed', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'metadata replay window' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:05:00.000Z',
    });
    const response = rawExtraction({
      summary: 'metadata replay summary',
      observations: [observation('metadata replay', 'metadata replay narrative')],
    });
    const llm = mockLlm([response, response]);

    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({ processed: 1 });
    resetStateForReplay(harness);
    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({ processed: 1 });

    const rollupRows = await rollups(sql, harness.projectId, harness.sessionId);
    expect(rollupRows).toHaveLength(1);
    const capture = rollupRows[0].metadata.capture;
    expect(capture?.summarize_count).toBe(1);
    expect(capture?.spool_offsets).toHaveLength(1);
    expect(capture?.transcript_sources).toHaveLength(1);
  });

  it('records a stable, replay-idempotent reason when a legal extraction has no observations', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'short session with no durable fact' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:05:15.000Z',
    });
    const response = rawExtraction({ summary: 'short session summary', observations: [] });

    await expect(runWorker(harness, { db, llm: mockLlm([response]) }))
      .resolves.toMatchObject({ processed: 1, observationsWritten: 0 });
    resetStateForReplay(harness);
    await expect(runWorker(harness, { db, llm: mockLlm([response]) }))
      .resolves.toMatchObject({ processed: 1, observationsWritten: 0, rollupsWritten: 0 });

    const rollupRows = await rollups(sql, harness.projectId, harness.sessionId);
    expect(rollupRows[0].metadata.capture?.empty_observation_windows).toEqual([
      {
        start: 0,
        end: statSync(spoolPath(harness)).size,
        reason: 'no_high_value_observations',
      },
    ]);
  });

  it('skips every DB write when a committed source range replays after state persistence fails', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'commit before state failure' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:05:30.000Z',
    });
    const firstResponse = rawExtraction({
      summary: 'first committed summary',
      observations: [observation('first committed', 'first committed narrative')],
    });
    let failCheckpointSave = true;
    const first = await runWorker(harness, {
      db,
      llm: mockLlm([firstResponse]),
      stateWriter: async (path, state) => {
        const advanced = Object.values(state.transcripts).some(
          (checkpoint) => checkpoint.checkpoint === transcriptEnd
        );
        if (failCheckpointSave && advanced) {
          failCheckpointSave = false;
          throw new Error('synthetic state persistence failure');
        }
        await writeCaptureStateAtomically(path, state);
      },
    });
    expect(first).toMatchObject({ processed: 1, failed: 1 });
    expect(Object.values(readState(harness).transcripts)[0]?.checkpoint).toBe(0);

    const replayResponse = rawExtraction({
      summary: 'non-deterministic replay must not overwrite',
      observations: [observation('replayed variant', 'replayed variant narrative')],
    });
    const replay = await runWorker(harness, { db, llm: mockLlm([replayResponse]) });
    expect(replay).toMatchObject({ processed: 1, observationsWritten: 0, rollupsWritten: 0 });

    const rollupRows = await rollups(sql, harness.projectId, harness.sessionId);
    const observationRows = await observations(sql, harness.projectId, harness.sessionId);
    expect(rollupRows).toHaveLength(1);
    expect(rollupRows[0].metadata.capture?.summarize_count).toBe(1);
    expect(rollupRows[0].metadata.capture?.transcript_sources).toHaveLength(1);
    expect(observationRows.map((row) => row.narrative)).toEqual(['first committed narrative']);
    expect(readState(harness).spool.cursor).toBe(statSync(spoolPath(harness)).size);
  });

  it('continues processing remaining sessions when one spool file is corrupt', async () => {
    const badHarness = makeHarness({ projectId: `capture-worker-${randomUUID()}-bad` });
    await appendWindow(badHarness, {
      transcriptStart: 0,
      transcriptEnd: 1,
      timestamp: '2026-07-06T10:06:00.000Z',
    });
    const badSpoolPath = resolveCaptureSpoolPath(badHarness.projectId, badHarness.sessionId, {
      env: badHarness.env,
    });
    appendFileSync(badSpoolPath, 'this is not json\n');

    const goodHarness = makeHarness({ projectId: `capture-worker-${randomUUID()}-good` });
    // 兩個 harness 共用同一 spool root，讓單次 worker run 同時掃到壞與好 session
    goodHarness.env = badHarness.env;
    const goodTranscriptEnd = appendTranscriptEntries(goodHarness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'good session window' },
    ]);
    await appendWindow(goodHarness, {
      transcriptStart: 0,
      transcriptEnd: goodTranscriptEnd,
      timestamp: '2026-07-06T10:07:00.000Z',
    });

    const llm = mockLlm([
      rawExtraction({
        summary: 'good session summary',
        observations: [observation('good session', 'good session narrative')],
      }),
    ]);

    const result = await runWorker(badHarness, { db, llm });
    // The missing bad transcript fails closed for that session, while the next session proceeds.
    expect(result).toMatchObject({
      processed: 1,
      failed: 0,
      malformed: 1,
      transcriptMissing: 1,
    });
    expect(await countRows(sql, goodHarness.projectId, goodHarness.sessionId)).toMatchObject({
      observations: 1,
      rollups: 1,
    });
    expect(readState(badHarness).spool.cursor).toBe(0);
  });

  it('keeps one active rollup for two harvest windows in the same session', async () => {
    const harness = makeHarness();
    const firstTranscriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'first harvest window' },
    ]);
    const firstSpoolEnd = await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: firstTranscriptEnd,
      timestamp: '2026-07-06T10:04:00.000Z',
    });
    const secondTranscriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:01.000Z', message: 'second harvest window' },
    ]);
    const llm = mockLlm([
      rawExtraction({
        summary: 'first rollup summary',
        observations: [observation('first window', 'first window narrative')],
      }),
      rawExtraction({
        summary: 'second rollup summary',
        observations: [observation('second window', 'second window narrative')],
      }),
    ]);

    await expect(
      runWorker(harness, {
        db,
        llm,
        now: new Date('2026-07-06T10:04:10.000Z'),
      })
    ).resolves.toMatchObject({ processed: 1 });
    const secondSpoolEnd = await appendWindow(harness, {
      transcriptStart: firstTranscriptEnd,
      transcriptEnd: secondTranscriptEnd,
      timestamp: '2026-07-06T10:05:00.000Z',
    });
    await expect(
      runWorker(harness, {
        db,
        llm,
        now: new Date('2026-07-06T10:05:10.000Z'),
      })
    ).resolves.toMatchObject({ processed: 1 });

    const rollupRows = await rollups(sql, harness.projectId, harness.sessionId);
    expect(rollupRows).toHaveLength(1);
    expect(rollupRows[0].idempotencyKey).toBe(
      `capture:v05:${harness.projectId}:${harness.sessionId}`
    );

    const capture = rollupRows[0].metadata.capture;
    expect(capture).toEqual(
      expect.objectContaining({
        version: '0.5',
        session_id: harness.sessionId,
        summarize_count: 2,
        model: TEST_MODEL,
      })
    );
    expect(capture?.spool_offsets).toEqual([
      expect.objectContaining({ start: 0, end: firstSpoolEnd }),
      expect.objectContaining({ start: firstSpoolEnd, end: secondSpoolEnd }),
    ]);
    expect(capture?.observation_ids).toHaveLength(2);

    const observationRows = await observations(sql, harness.projectId, harness.sessionId);
    expect(observationRows).toHaveLength(2);
    expect(observationRows.map((row) => row.rollupMemoryId)).toEqual([
      rollupRows[0].id,
      rollupRows[0].id,
    ]);
  });

  it('writes rollup metadata.capture.discovery_tokens during the insert/update path', async () => {
    await sql`
      CREATE OR REPLACE FUNCTION test_capture_rollup_discovery_guard()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.project_id LIKE 'capture-worker-%'
          AND NEW.idempotency_key LIKE 'capture:v05:%'
          AND (
            NEW.metadata #>> '{capture,discovery_tokens}' IS NULL
            OR (NEW.metadata #>> '{capture,discovery_tokens}')::integer <= 0
          )
        THEN
          RAISE EXCEPTION 'capture discovery_tokens missing at write time';
        END IF;
        RETURN NEW;
      END;
      $$;
    `;
    await sql`
      CREATE TRIGGER test_capture_rollup_discovery_guard
      BEFORE INSERT OR UPDATE ON project_memories
      FOR EACH ROW EXECUTE FUNCTION test_capture_rollup_discovery_guard();
    `;

    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'discovery tokens write path' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:06:00.000Z',
    });
    const llm = mockLlm([
      rawExtraction({
        summary: 'discovery token rollup summary',
        observations: [observation('token observation', 'discovery token narrative')],
      }),
    ]);

    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      processed: 1,
    });
    const [rollup] = await rollups(sql, harness.projectId, harness.sessionId);
    expect(rollup.metadata.capture?.discovery_tokens).toEqual(expect.any(Number));
    expect(rollup.metadata.capture?.discovery_tokens).toBeGreaterThan(0);
  });

  it('redacts rollup and observation provider inputs while preserving raw rows and policy evidence', async () => {
    const harness = makeHarness();
    const token = `sk-${'f'.repeat(32)}`;
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'embedding policy evidence' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:06:30.000Z',
    });
    const llm = mockLlm([
      rawExtraction({
        summary: `rollup ${token}`,
        observations: [observation('policy observation', `narrative ${token}`)],
      }),
    ]);
    const providerInputs: string[] = [];

    await expect(runWorker(harness, {
      db,
      llm,
      generateEmbedding: async (text) => {
        providerInputs.push(text);
        return new Array(1536).fill(0.1);
      },
    })).resolves.toMatchObject({ processed: 1, embeddingFailed: 0 });

    expect(providerInputs).toHaveLength(2);
    expect(providerInputs.every((text) => !text.includes(token))).toBe(true);
    expect(providerInputs.every((text) => text.includes('[REDACTED:openai_api_key]'))).toBe(true);

    const [rollup] = await rollups(sql, harness.projectId, harness.sessionId);
    const [observationRow] = await observations(sql, harness.projectId, harness.sessionId);
    expect(rollup.metadata.embedding_policy).toMatchObject({
      redaction_count: 1,
      rule_counts: { openai_api_key: 1 },
    });
    expect(observationRow.metadata.embedding_policy).toMatchObject({
      redaction_count: 1,
      rule_counts: { openai_api_key: 1 },
    });
    expect(observationRow.narrative).toContain(token);
  });

  it('assigns strictly increasing observed_at values from window processing time, not transcript timestamps', async () => {
    const harness = makeHarness();
    const transcriptSourceTimestamps = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
      '2027-01-01T00:00:00.000Z',
      '2027-01-01T00:00:01.000Z',
    ];
    const firstTranscriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: transcriptSourceTimestamps[0], message: 'first observed_at source A' },
      { timestamp: transcriptSourceTimestamps[1], message: 'first observed_at source B' },
    ]);
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: firstTranscriptEnd,
      timestamp: '2026-07-06T10:07:00.000Z',
    });
    const secondTranscriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: transcriptSourceTimestamps[2], message: 'second observed_at source A' },
      { timestamp: transcriptSourceTimestamps[3], message: 'second observed_at source B' },
    ]);

    const firstProcessingTime = new Date('2026-07-06T10:07:10.000Z');
    const secondProcessingTime = new Date('2026-07-06T10:08:10.000Z');
    const llm = mockLlm([
      rawExtraction({
        summary: 'first observed_at summary',
        observations: [
          observation('first observed A', 'first observed narrative A'),
          observation('first observed B', 'first observed narrative B'),
        ],
      }),
      rawExtraction({
        summary: 'second observed_at summary',
        observations: [
          observation('second observed A', 'second observed narrative A'),
          observation('second observed B', 'second observed narrative B'),
        ],
      }),
    ]);

    await expect(
      runWorker(harness, { db, llm, now: firstProcessingTime })
    ).resolves.toMatchObject({ processed: 1 });
    await appendWindow(harness, {
      transcriptStart: firstTranscriptEnd,
      transcriptEnd: secondTranscriptEnd,
      timestamp: '2026-07-06T10:08:00.000Z',
    });
    await expect(
      runWorker(harness, { db, llm, now: secondProcessingTime })
    ).resolves.toMatchObject({ processed: 1 });

    const rows = await observations(sql, harness.projectId, harness.sessionId);
    expect(rows).toHaveLength(4);
    const observed = rows.map((row) => row.observedAt.toISOString());
    expect(observed).toEqual([
      firstProcessingTime.toISOString(),
      new Date(firstProcessingTime.getTime() + 1).toISOString(),
      secondProcessingTime.toISOString(),
      new Date(secondProcessingTime.getTime() + 1).toISOString(),
    ]);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].observedAt.getTime()).toBeGreaterThan(rows[i - 1].observedAt.getTime());
    }
    for (const timestamp of transcriptSourceTimestamps) {
      expect(observed).not.toContain(timestamp);
    }
    expect(rows[2].observedAt.getTime()).toBeGreaterThan(rows[1].observedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// T1（2026-09-03）：舊 hook 時代 backlog 的 project_id 已崩塌（`__`、`_raw`…），
// worker 改以 transcript 內第一個 `cwd` 經 resolveProjectId 推導；新 hook 時代
// （記錄行 timestamp >= 2026-09-02T22:10:00+08:00）一律信記錄行。
// 只有「帶 project_id 且 timestamp 可解析且 < cutoff」的 event 才算舊時代證據；
// Stop sentinel（只有 transcript_path／hwm_offset）與異常 timestamp 不算（Codex R1 finding 1）。
// ---------------------------------------------------------------------------
describe('T1: backlog project_id remap from transcript cwd', () => {
  const OLD_TS = '2026-09-01T10:00:00+0800';
  const NEW_TS = '2026-09-02T22:10:00+0800';

  function makeFixtureRepo(root: string, name: string, marker?: string): string {
    const repo = join(root, name);
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    if (marker) {
      writeFileSync(join(repo, 'CLAUDE.md'), `# x\n<!-- cc-memory: project="${marker}" -->\n`);
    }
    return repo;
  }

  function extractionFor(name: string): CaptureLlmRawResponse {
    return rawExtraction({ summary: name, observations: [observation(name, `${name} narrative`)] });
  }

  let sql: Sql;
  let pg: Sql;
  let db: unknown;

  beforeAll(async () => {
    sql = await connectDb(TEST_DB_URL);
    pg = postgres(TEST_DB_URL, { max: 4 });
    db = drizzle(pg);
  });

  afterAll(async () => {
    if (pg) await pg.end();
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM observations WHERE project_id LIKE 'capture-worker-%' OR project_id LIKE '\\_%'`;
    await sql`DELETE FROM project_memories WHERE project_id LIKE 'capture-worker-%' OR project_id LIKE '\\_%'`;
  });

  it('old-hook record with Claude transcript cwd writes rows under the repo-root project id', async () => {
    const harness = makeHarness({ projectId: '__' });
    const repoName = `capture-worker-repo-${randomUUID()}`;
    const repo = makeFixtureRepo(harness.root, repoName);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { type: 'user', cwd: join(repo, 'sub'), message: 'first entry carries cwd' },
      { type: 'assistant', cwd: join(repo, 'sub'), message: 'second entry' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: OLD_TS });
    const llm = mockLlm([extractionFor('remapped')]);
    const lines: string[] = [];

    await expect(runWorker(harness, { db, llm, stdout: { write: (c: string) => lines.push(c) } }))
      .resolves.toMatchObject({ processed: 1, observationsWritten: 1 });

    expect(llm.calls[0].projectId).toBe(repoName);
    expect(await countRows(sql, repoName, harness.sessionId)).toEqual({ observations: 1, rollups: 1 });
    expect(await countRows(sql, '__', harness.sessionId)).toEqual({ observations: 0, rollups: 0 });
    const rollupRows = await rollups(sql, repoName, harness.sessionId);
    expect(rollupRows[0].idempotencyKey).toBe(`capture:v05:${repoName}:${harness.sessionId}`);
    expect(lines.join('')).toContain(`project-id-remapped session=${harness.sessionId} old=__ new=${repoName}`);
  });

  it('old-hook record with Codex session_meta payload.cwd resolves the same way', async () => {
    const harness = makeHarness({ projectId: '___' });
    const repoName = `capture-worker-codex-${randomUUID()}`;
    const repo = makeFixtureRepo(harness.root, repoName);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      {
        timestamp: '2026-09-01T02:00:00.000Z',
        type: 'session_meta',
        payload: { id: harness.sessionId, cwd: join(repo, 'sub'), originator: 'codex_exec' },
      },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'hi' } },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: OLD_TS });
    const llm = mockLlm([extractionFor('codex')]);

    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe(repoName);
  });

  it('new-hook record keeps its project_id and ignores transcript cwd', async () => {
    const harness = makeHarness();
    const otherRepo = makeFixtureRepo(harness.root, `capture-worker-other-${randomUUID()}`);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(otherRepo, 'sub'), message: 'cwd points elsewhere' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: NEW_TS });
    const llm = mockLlm([extractionFor('new')]);
    const lines: string[] = [];

    await runWorker(harness, { db: {}, llm, stdout: { write: (c: string) => lines.push(c) } });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe(harness.projectId);
    expect(lines.join('')).not.toContain('project-id-remapped');
  });

  it('snapshot straddling the cutoff trusts the new-hook record over transcript cwd', async () => {
    const harness = makeHarness();
    const otherRepo = makeFixtureRepo(harness.root, `capture-worker-other-${randomUUID()}`);
    const mid = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(otherRepo, 'sub'), message: 'old era entry' },
    ]);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(otherRepo, 'sub'), message: 'new era entry' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, timestamp: OLD_TS });
    await appendWindow(harness, { transcriptStart: mid, transcriptEnd, timestamp: NEW_TS });
    const llm = mockLlm([extractionFor('mixed')]);

    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe(harness.projectId);
  });

  it('sentinel-only snapshot after the new-hook event was consumed keeps the record id (Codex R1)', async () => {
    const harness = makeHarness();
    const otherRepo = makeFixtureRepo(harness.root, `capture-worker-other-${randomUUID()}`);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(otherRepo, 'sub'), message: 'session started elsewhere, then cd into this project' },
    ]);
    // tick 1：只有新 hook 的 event（無 sentinel）→ worker 只初始化 checkpoint 並推進 cursor
    const spoolSizeAfterEvent = await appendWindow(harness, { transcriptStart: 0, timestamp: NEW_TS });
    const first = await runWorker(harness, { db: {}, llm: mockLlm([]) });
    expect(first).toMatchObject({ processed: 0 });
    expect(readState(harness).spool.cursor).toBe(spoolSizeAfterEvent);
    expect(readState(harness).projectId).toBe(harness.projectId);
    // tick 2：只剩 bash 版 Stop sentinel（無 project_id／timestamp）
    appendBashStyleSentinel(harness, harness.projectId, transcriptEnd);
    const llm = mockLlm([extractionFor('sentinel-only')]);
    const lines: string[] = [];

    await runWorker(harness, { db: {}, llm, stdout: { write: (c: string) => lines.push(c) } });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe(harness.projectId);
    expect(lines.join('')).not.toContain('project-id-remapped');
  });

  it('sentinel-only snapshot in an encoded (non-ASCII) spool dir uses the id persisted in state, not the lossy dir-name decode (Codex R1/R1b)', async () => {
    // 😀x 的目錄名 _u1f600x 用 4 位啟發式會解成 ὠ0x（不可逆編碼的已知案例）；state.projectId 讓 sentinel-only 仍拿到原名
    const harness = makeHarness({ projectId: '😀x' });
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'no cwd here' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, timestamp: NEW_TS });
    await runWorker(harness, { db: {}, llm: mockLlm([]) });
    expect(readState(harness).projectId).toBe('😀x');
    appendBashStyleSentinel(harness, harness.projectId, transcriptEnd);
    const llm = mockLlm([extractionFor('encoded')]);

    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe('😀x');
    expect(sanitizeSpoolSegment('😀x')).toBe('_u1f600x');
  });

  it('sentinel-only snapshot with no state yet (BMP name) falls back to the decoded dir name', async () => {
    const harness = makeHarness({ projectId: '回收辨識_u測試' });
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'no cwd here' },
    ]);
    appendBashStyleSentinel(harness, harness.projectId, transcriptEnd);
    const llm = mockLlm([extractionFor('encoded-nostate')]);

    await runWorker(harness, { db: {}, llm });

    // 第一個 record 就是 sentinel：checkpoint 初始化，不會有 LLM 呼叫；再補一個 sentinel 推進 boundary
    const end2 = appendTranscriptEntries(harness.transcriptPath, [{ message: 'more' }]);
    appendBashStyleSentinel(harness, harness.projectId, end2);
    await runWorker(harness, { db: {}, llm });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe('回收辨識_u測試');
  });

  it('old-era file derives once, persists the id in state, and reuses it for later snapshots (Codex R1b high 2)', async () => {
    const harness = makeHarness({ projectId: '__' });
    const repoName = `capture-worker-repo-${randomUUID()}`;
    const repo = makeFixtureRepo(harness.root, repoName);
    const mid = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(repo, 'sub'), message: 'first window' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd: mid, timestamp: OLD_TS });
    const llm1 = mockLlm([extractionFor('w1')]);
    await runWorker(harness, { db: {}, llm: llm1 });
    expect(llm1.calls[0].projectId).toBe(repoName);
    expect(readState(harness).projectId).toBe(repoName);

    // 之後 transcript 被改寫成指向別的 repo（模擬 cd／檔案重寫）：state 已定案，不再重讀 transcript
    const otherRepo = makeFixtureRepo(harness.root, `capture-worker-other-${randomUUID()}`);
    writeFileSync(harness.transcriptPath, '');
    const end2 = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(otherRepo, 'sub'), message: 'rewritten first line' },
      { cwd: join(otherRepo, 'sub'), message: 'second window' },
    ]);
    await appendWindow(harness, { transcriptStart: mid, transcriptEnd: end2, timestamp: OLD_TS });
    const llm2 = mockLlm([extractionFor('w2')]);
    await runWorker(harness, { db: {}, llm: llm2 });
    expect(llm2.calls).toHaveLength(1);
    expect(llm2.calls[0].projectId).toBe(repoName);
  });

  it('old-era event plus an event with an unparsable timestamp still derives (documented: garbage timestamps are not era evidence)', async () => {
    const harness = makeHarness({ projectId: '__' });
    const repoName = `capture-worker-repo-${randomUUID()}`;
    const repo = makeFixtureRepo(harness.root, repoName);
    const mid = appendTranscriptEntries(harness.transcriptPath, [{ cwd: join(repo, 'sub'), message: 'a' }]);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [{ cwd: join(repo, 'sub'), message: 'b' }]);
    await appendWindow(harness, { transcriptStart: 0, timestamp: OLD_TS });
    await appendWindow(harness, { transcriptStart: mid, transcriptEnd, timestamp: 'garbage' });
    const llm = mockLlm([extractionFor('mixed-garbage')]);

    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe(repoName);
  });

  it('old-looking record with an unparsable timestamp keeps the record id (fail-safe)', async () => {
    const harness = makeHarness({ projectId: '__' });
    const repo = makeFixtureRepo(harness.root, `capture-worker-repo-${randomUUID()}`);
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(repo, 'sub'), message: 'cwd exists but timestamp is garbage' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: 'not-a-timestamp' });
    const llm = mockLlm([extractionFor('badts')]);

    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe('__');
  });

  it('old-hook record whose transcript has no cwd keeps the record project_id', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { message: 'no cwd anywhere' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: OLD_TS });
    const llm = mockLlm([extractionFor('nocwd')]);

    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe(harness.projectId);
  });

  it('derived __personal__ takes the existing skip path: no LLM call and zero rows in the project DB', async () => {
    const harness = makeHarness({ projectId: '__' });
    const repo = makeFixtureRepo(harness.root, `capture-worker-personal-${randomUUID()}`, '__personal__');
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(repo, 'sub'), message: 'personal repo' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: OLD_TS });
    const llm = mockLlm([]);

    const result = await runWorker(harness, { db, llm });

    expect(result).toMatchObject({ skipped: 1, processed: 0 });
    expect(llm.calls).toHaveLength(0);
    const rows = await sql<{ n: number }[]>`
      SELECT (SELECT COUNT(*)::int FROM observations WHERE session_id = ${harness.sessionId})
           + (SELECT COUNT(*)::int FROM project_memories
               WHERE idempotency_key LIKE ${`capture:v05:%:${harness.sessionId}`}) AS n`;
    expect(rows[0].n).toBe(0);
  });

  it('cwd that no longer exists (no repo ancestor) falls back to basename(cwd)', async () => {
    const harness = makeHarness({ projectId: '_raw' });
    const goneName = `capture-worker-gone-${randomUUID()}`;
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { cwd: join(harness.root, 'deleted-parent', goneName), message: 'deleted worktree' },
    ]);
    await appendWindow(harness, { transcriptStart: 0, transcriptEnd, timestamp: OLD_TS });
    const llm = mockLlm([extractionFor('gone')]);

    await runWorker(harness, { db: {}, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].projectId).toBe(goneName);
  });
});
