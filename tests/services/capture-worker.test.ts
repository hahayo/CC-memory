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

function deadDir(harness: TestHarness): string {
  return join(harness.spoolDir, '.dead');
}

function readOnlyDeadLetter(harness: TestHarness): Record<string, unknown> {
  expect(existsSync(deadDir(harness))).toBe(true);
  const files = existsSync(deadDir(harness))
    ? readdirSync(deadDir(harness)).filter((file) => file.endsWith('.json'))
    : [];
  expect(files).toHaveLength(1);
  const file = files[0] ?? '';
  expect(file).toMatch(/^[a-f0-9]{64}\.json$/);
  return JSON.parse(readFileSync(join(deadDir(harness), file), 'utf8')) as Record<string, unknown>;
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
    discovery_tokens: 17,
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

function mockLlm(responses: CaptureLlmRawResponse[]): MockCaptureLlm {
  const pending = [...responses];
  const calls: CaptureLlmRequest[] = [];
  return {
    model: TEST_MODEL,
    calls,
    async extract(request: CaptureLlmRequest): Promise<CaptureLlmRawResponse> {
      calls.push(request);
      const response = pending.shift();
      if (!response) {
        throw new Error('unexpected capture LLM call');
      }
      return response;
    },
  };
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

  it('dead-letters malformed LLM JSON without storing transcript text or DB rows', async () => {
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
    const llm = mockLlm([{ model: TEST_MODEL, text: '{"session_summary":' }]);

    await expect(runWorker(harness, { db, llm })).resolves.toMatchObject({
      processed: 0,
      deadLettered: 1,
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

    expect(await countRows(sql, harness.projectId, harness.sessionId)).toEqual({
      observations: 0,
      rollups: 0,
    });
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

    await expect(runWorker(badHarness, { db, llm })).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(await countRows(sql, goodHarness.projectId, goodHarness.sessionId)).toMatchObject({
      observations: 1,
      rollups: 1,
    });
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
