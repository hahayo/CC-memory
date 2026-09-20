import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTestDb, type Sql } from '../helpers/db.js';
import { finalizeSession } from '../../src/services/session-finalize.js';
import type { CaptureLlmAdapter, CaptureLlmRequest } from '../../src/services/capture-llm.js';

const response = { model: 'test', text: JSON.stringify({ session_summary: {
  summary: '先前以為 X，後來改成 Y，因為實測 Z。', keywords: ['Y'], decisions: ['Y'], next_steps: [],
}, observations: [] }) };

describe('finalization database contract', () => {
  let db: Sql;
  const projectId = `finalize-${randomUUID()}`;
  const sessionId = 'session';
  let now = 1_800_000_000_000;
  const extract = vi.fn(async (_request: CaptureLlmRequest) => response);
  const llm: CaptureLlmAdapter = { model: 'test', worstCaseCallBudgetMs: 100, extract,
    takeTelemetry: () => ({ primaryProvider: 'test', primarySuccess: 0, fallbackSuccess: 0, fallbackFailed: 0 }) };
  beforeAll(async () => { db = await connectTestDb(); });
  afterAll(async () => {
    if (db) { await db`DELETE FROM observations WHERE project_id IN (${projectId}, ${projectId + '-other'})`; await db`DELETE FROM project_memories WHERE project_id=${projectId}`; await db.end(); }
  });
  beforeEach(async () => {
    extract.mockReset().mockResolvedValue(response);
    now = 1_800_000_000_000;
    await db`DELETE FROM observations WHERE project_id IN (${projectId}, ${projectId + '-other'})`;
    await db`DELETE FROM project_memories WHERE project_id=${projectId}`;
    await db`INSERT INTO project_memories (project_id,type,summary,keywords,decisions,next_steps,status,idempotency_key,metadata)
      VALUES (${projectId},'session','old',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'active',
      ${`capture:v05:${projectId}:${sessionId}`},${JSON.stringify({ capture: { summarize_count: 1,
        summary_guard_pending: { summary: 'last rejected window', decisions: ['pending decision'], next_steps: [] } } })}::jsonb)`;
  });
  const run = (hasBudget?: () => boolean) => finalizeSession({ hasBudget, db: drizzle(db), projectId, sessionId, llm, nowMs: () => now,
    env: {}, stillReady: async () => true, generateEmbedding: async () => null });
  const row = async () => (await db`SELECT * FROM project_memories WHERE project_id=${projectId}`)[0];

  it('consumes pending, replaces authoritatively, clears pending and avoids repeats', async () => {
    expect(await run()).toEqual({ attempted: true, status: 'finalized' });
    expect(extract.mock.calls[0][0].priorSummary?.pendingSummary?.summary).toBe('last rejected window');
    const saved = await row();
    expect(saved.summary).toContain('後來改成 Y');
    expect(saved.metadata.capture.summary_guard_pending).toBeUndefined();
    expect(saved.metadata.capture.finalized_generation).toBe(1);
    expect(await run()).toEqual({ attempted: false, status: 'current' });
    expect(extract).toHaveBeenCalledTimes(1);
    await db`UPDATE project_memories SET metadata=jsonb_set(metadata,'{capture,summarize_count}','2') WHERE project_id=${projectId}`;
    expect((await run()).status).toBe('finalized');
    expect((await row()).metadata.capture.finalize_count).toBe(2);
  });

  it('includes only active observations from the exact project and session, in time order', async () => {
    for (const [project, session, status, narrative, time] of [
      [projectId, sessionId, 'active', 'later correction', '2026-01-02'],
      [projectId, sessionId, 'active', 'earlier hypothesis', '2026-01-01'],
      [projectId, sessionId, 'archived', 'deleted evidence', '2026-01-03'],
      [projectId + '-other', sessionId, 'active', 'other project secret', '2026-01-04'],
      [projectId, 'other-session', 'active', 'other session secret', '2026-01-05'],
    ]) {
      await db`INSERT INTO observations (project_id,session_id,type,title,narrative,discovery_tokens,source_hook,
        content_hash,writer_host,status,observed_at) VALUES (${project},${session},'decision','evidence',${narrative},
        1,'test',${randomUUID()},'test',${status},${time}::timestamptz)`;
    }
    await run();
    const input = extract.mock.calls[0][0].transcript;
    expect(input.indexOf('earlier hypothesis')).toBeLessThan(input.indexOf('later correction'));
    expect(input).not.toContain('secret');
    expect(input).not.toContain('deleted evidence');
    expect((await row()).metadata.capture.finalized_observation_count).toBe(2);
  });

  it('returns an unused claim when input preparation exhausts the tick budget', async () => {
    expect(await run(() => false)).toEqual({ attempted: false, status: 'skipped' });
    expect(extract).not.toHaveBeenCalled();
    expect((await row()).metadata.capture.finalize_retry).toBeUndefined();
    expect((await run()).status).toBe('finalized');
  });

  it('claims a generation once across concurrent workers', async () => {
    const results = await Promise.all([run(), run()]);
    expect(results.filter(r => r.status === 'finalized')).toHaveLength(1);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('preserves content on failure and bounds retries with an interval', async () => {
    extract.mockRejectedValue(new Error('timeout'));
    expect((await run()).status).toBe('failed');
    expect((await row()).summary).toBe('old');
    expect((await row()).metadata.capture.summary_guard_pending.summary).toBe('last rejected window');
    expect((await run()).attempted).toBe(false);
    for (let i = 0; i < 4; i++) { now += 1_800_000; await run(); }
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid output without changing content', async () => {
    extract.mockResolvedValue({ model: 'bad', text: '{}' });
    expect((await run()).status).toBe('failed');
    expect((await row()).summary).toBe('old');
  });

  it('does not publish a result if new content arrives during the call', async () => {
    extract.mockImplementation(async () => {
      await db`UPDATE project_memories SET metadata=jsonb_set(metadata,'{capture,summarize_count}','2') WHERE project_id=${projectId}`;
      return response;
    });
    expect((await run()).status).toBe('stale');
    expect((await row()).summary).toBe('old');
    extract.mockResolvedValue(response);
    expect((await run()).status).toBe('finalized');
  });
});
