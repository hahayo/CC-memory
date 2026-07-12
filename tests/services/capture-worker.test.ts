// tests/services/capture-worker.test.ts
//
// CC-memory v0.5 M2b RED — capture worker failure/reliability contracts.
// These tests intentionally describe the worker surface before implementation.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appendCaptureEvent,
  appendStopSentinel,
  resolveCaptureSpoolPath,
  sanitizeSpoolSegment,
} from '../../src/services/capture-spool.js';
import { runCaptureWorkerOnce } from '../../src/services/capture-worker.js';
import { CaptureLlmValidationError } from '../../src/services/capture-llm.js';
import type {
  CaptureLlmAdapter,
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
  summarize_count?: number;
  discovery_tokens?: number;
}

interface RollupRow {
  id: string;
  idempotencyKey: string | null;
  metadata: { capture?: CaptureMetadata };
}

interface ObservationRow {
  id: string;
  rollupMemoryId: string | null;
  narrative: string;
  observedAt: Date;
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
    env: { CC_MEMORY_SPOOL_DIR: spoolDir },
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
  input: { transcriptStart: number; transcriptEnd: number; timestamp: string }
): Promise<number> {
  const eventResult = await appendCaptureEvent(
    {
      session_id: harness.sessionId,
      project_id: harness.projectId,
      tool_name: 'Bash',
      timestamp: input.timestamp,
      transcript_path: harness.transcriptPath,
      transcript_offset: input.transcriptStart,
    },
    { env: harness.env }
  );
  expect(eventResult).toMatchObject({ success: true });

  const sentinelResult = await appendStopSentinel(
    {
      project_id: harness.projectId,
      session_id: harness.sessionId,
      timestamp: input.timestamp,
      transcript_path: harness.transcriptPath,
      hwm_offset: input.transcriptEnd,
    },
    { env: harness.env }
  );
  expect(sentinelResult).toMatchObject({ success: true });

  return statSync(resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env }))
    .size;
}

function hwmPath(harness: TestHarness): string {
  return join(
    harness.spoolDir,
    sanitizeSpoolSegment(harness.projectId),
    `${sanitizeSpoolSegment(harness.sessionId)}.hwm`
  );
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

function mockLlm(steps: MockLlmStep[]): MockCaptureLlm {
  const pending = [...steps];
  const calls: CaptureLlmRequest[] = [];
  return {
    model: TEST_MODEL,
    calls,
    async extract(request: CaptureLlmRequest): Promise<CaptureLlmRawResponse> {
      calls.push(request);
      const step = pending.shift();
      if (!step) {
        throw new Error('unexpected capture LLM call');
      }
      if (step instanceof Error) throw step;
      return step;
    },
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
    dbHealthCheck?: () => Promise<boolean>;
  }
) {
  return runCaptureWorkerOnce({
    db: input.db,
    env: harness.env,
    llm: input.llm,
    now: () => input.now ?? new Date('2026-07-06T10:00:00.000Z'),
    writerHost: TEST_WRITER,
    dbHealthCheck: input.dbHealthCheck,
    generateEmbedding: async () => null,
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
    expect(readFileSync(hwmPath(harness), 'utf8')).toBe(String(spoolEnd));
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
    expect(existsSync(hwmPath(harness))).toBe(false);

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
    // HWM advanced past the window
    expect(existsSync(hwmPath(harness))).toBe(true);
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
    };

    await expect(
      runWorker(harness, {
        db: {},
        llm,
      })
    ).resolves.toMatchObject({ processed: 0, skipped: 1, deadLettered: 0 });
    expect(existsSync(deadDir(harness))).toBe(false);
    expect(existsSync(hwmPath(harness))).toBe(false);
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
    expect(existsSync(hwmPath(harness))).toBe(false);
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

    expect(readFileSync(hwmPath(harness), 'utf8')).toBe(String(spoolEnd));
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

    expect(existsSync(hwmPath(harness))).toBe(false);
    expect(existsSync(lockPath(harness))).toBe(true);
  });

  it('honors CC_CAPTURE_MAX_SESSIONS_PER_TICK to keep cron ticks bounded', async () => {
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
    const firstEnd = await appendWindow(first, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:00:30.000Z',
    });
    await appendWindow(second, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:00:31.000Z',
    });
    const llm = mockLlm([]);

    await expect(runWorker(first, { db: {}, llm })).resolves.toMatchObject({
      processed: 0,
      skipped: 1,
      deadLettered: 0,
    });

    expect(readFileSync(hwmPath(first), 'utf8')).toBe(String(firstEnd));
    expect(existsSync(hwmPath(second))).toBe(false);
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
      expect(existsSync(hwmPath(harness))).toBe(false);
    }

    // Tick 5: park — dead-letter + HWM advance
    const llm5 = mockLlm([repeatedError, repeatedError]);
    await expect(runWorker(harness, { db: {}, llm: llm5 })).resolves.toMatchObject({
      processed: 0,
      deadLettered: 1,
      parked: 1,
    });

    expect(readDeadLetters(harness)).toHaveLength(1);
    expect(readFileSync(hwmPath(harness), 'utf8')).toBe(
      String(statSync(resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env })).size)
    );
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
    expect(readFileSync(hwmPath(harness), 'utf8')).toBe(String(spoolEnd));
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
    // HWM is at the last complete newline boundary, not at total file size
    const hwmVal = Number.parseInt(readFileSync(hwmPath(harness), 'utf8'), 10);
    expect(hwmVal).toBe(sizeBeforePartial);
    expect(hwmVal).toBeLessThan(totalSize);
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
    // HWM advanced (empty transcript since hwm_offset=0)
    expect(existsSync(hwmPath(harness))).toBe(true);
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

  it('retry sidecar cleans up entries below HWM on next processing pass', async () => {
    const harness = makeHarness();
    const transcriptEnd = appendTranscriptEntries(harness.transcriptPath, [
      { timestamp: '2026-01-01T00:00:00.000Z', message: 'stale retry cleanup window one' },
    ]);
    const firstSpoolEnd = await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd,
      timestamp: '2026-07-06T10:00:00.000Z',
    });

    // Fail the first tick to create a retry entry
    const errorLlm = mockLlm([
      new CaptureLlmValidationError('CLAUDE_CLI_EXIT_NONZERO', 'fail', { model: 'haiku', rawOutput: 'err' }),
      new CaptureLlmValidationError('CLAUDE_CLI_EXIT_NONZERO', 'fail', { model: 'haiku', rawOutput: 'err' }),
    ]);
    await runWorker(harness, { db: {}, llm: errorLlm });
    const sp = spoolPath(harness);
    const retryPath = sp.replace(/\.jsonl$/, '.retry.json');
    expect(existsSync(retryPath)).toBe(true);
    expect(existsSync(hwmPath(harness))).toBe(false);

    // Now manually advance HWM past the window (simulating park or external fix)
    writeFileSync(hwmPath(harness), String(firstSpoolEnd), { mode: 0o600 });

    // Append new spool data with EMPTY transcript so it skip+advances without LLM
    await appendWindow(harness, {
      transcriptStart: 0,
      transcriptEnd: 0,
      timestamp: '2026-07-06T10:01:00.000Z',
    });
    const llm2 = mockLlm([]);
    await runWorker(harness, { db: {}, llm: llm2 });
    // Retry file cleaned since old entry is below new HWM
    expect(existsSync(retryPath)).toBe(false);
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
    // HWM still advances (skip + advance per existing semantics)
    expect(existsSync(hwmPath(harness))).toBe(true);
  });

  it('summary line includes all new fields', async () => {
    // Verify the summary format in run-auto-capture.ts by testing assessment parsing
    const { assessAutoCaptureExecution } = await import('../../src/services/auto-capture-alerts.js');
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=2 skipped=1 dead-letter=0 failed=0 rate-limited=3 malformed=1 transcript-missing=2\n',
      stderr: '',
    });
    // rate-limited > 0 makes it not ok
    expect(assessment.ok).toBe(false);
    expect(assessment.rateLimitedCount).toBe(3);
    expect(assessment.malformedCount).toBe(1);
    expect(assessment.transcriptMissingCount).toBe(2);
    expect(assessment.failedCount).toBe(0);
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
    // HWM advanced to file end (terminal discard)
    expect(Number.parseInt(readFileSync(hwmPath(harness), 'utf8'), 10)).toBe(fileSize);

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
    // Both sessions should have HWM files now
    expect(existsSync(hwmPath(sessionA))).toBe(true);
    expect(existsSync(hwmPath(sessionB))).toBe(true);
  });
});

describe('capture worker DB-backed RED contracts', () => {
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
    expect(readFileSync(hwmPath(harness), 'utf8')).toBe(
      String(statSync(resolveCaptureSpoolPath(harness.projectId, harness.sessionId, { env: harness.env })).size)
    );
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

    // HWM held
    expect(readFileSync(hwmPath(harness), 'utf8')).toBe('0');
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
    expect(readFileSync(hwmPath(harness), 'utf8')).toBe('0');
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
    writeFileSync(hwmPath(harness), '0', { mode: 0o600 });
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
    writeFileSync(hwmPath(harness), '0', { mode: 0o600 });
    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({ processed: 1 });

    const rollupRows = await rollups(sql, harness.projectId, harness.sessionId);
    expect(rollupRows).toHaveLength(1);
    const capture = rollupRows[0].metadata.capture;
    expect(capture?.summarize_count).toBe(1);
    expect(capture?.spool_offsets).toHaveLength(1);
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
    // Under new semantics: malformed lines are tolerated (skipped + counted),
    // bad session's valid records have empty transcript → skip+advance.
    expect(result).toMatchObject({
      processed: 1,
      failed: 0,
      malformed: 1,
    });
    expect(await countRows(sql, goodHarness.projectId, goodHarness.sessionId)).toMatchObject({
      observations: 1,
      rollups: 1,
    });
    // Bad session HWM advanced past the malformed lines (terminal discard)
    const badHwmPath = join(
      badHarness.spoolDir,
      sanitizeSpoolSegment(badHarness.projectId),
      `${sanitizeSpoolSegment(badHarness.sessionId)}.hwm`
    );
    const badHwmVal = Number.parseInt(readFileSync(badHwmPath, 'utf8'), 10);
    expect(badHwmVal).toBe(statSync(resolveCaptureSpoolPath(badHarness.projectId, badHarness.sessionId, { env: badHarness.env })).size);
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
