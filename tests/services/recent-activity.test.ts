// tests/services/recent-activity.test.ts
//
// v0.5 M4 4b — Recent Activity builder 行為測試（真 PG）。
// 覆蓋：rollup 過濾（active + 有 capture）、project scope 隔離、updated_at desc + limit、
// row 欄位正確性、token budget 三步截斷、__personal__ ForbiddenError。
//
// 慣例照 tests/services/discovery-tokens.test.ts 案 5：TEST_PREFIX、裸 SQL seed、
// afterEach 自清、afterAll 關連線。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, type Sql } from '../helpers/db.js';
import { estimateDiscoveryTokens } from '../../src/services/capture-llm.js';
import { buildRecentActivity } from '../../src/services/recent-activity.js';
import { ForbiddenError, InvalidArgumentError } from '../../src/services/errors.js';

const TEST_PREFIX = `ract-${randomUUID().slice(0, 8)}`;

interface SeedRollupInput {
  projectId: string;
  summary: string;
  discoveryTokens?: number; // 省略 = capture 不含 discovery_tokens key（測 fallback 0）
  observationIds?: string[];
  updatedAt?: Date;
  status?: string; // 預設 'active'
}

async function seedRollup(sql: Sql, input: SeedRollupInput): Promise<string> {
  const sessionId = `session-${randomUUID()}`;
  const capture: Record<string, unknown> = {
    version: '0.5',
    session_id: sessionId,
    observation_ids: input.observationIds ?? [],
    model: 'test',
    spool_offsets: [],
    summarize_count: 1,
  };
  if (input.discoveryTokens !== undefined) {
    capture.discovery_tokens = input.discoveryTokens;
  }
  const updatedAt = input.updatedAt ?? new Date();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO project_memories (
      project_id, type, summary, status, metadata,
      idempotency_key, writer_host, created_at, updated_at
    )
    VALUES (
      ${input.projectId},
      'session',
      ${input.summary},
      ${input.status ?? 'active'},
      ${JSON.stringify({ capture })}::jsonb,
      ${`capture:v05:${input.projectId}:${sessionId}`},
      'vitest',
      ${updatedAt.toISOString()}::timestamptz,
      ${updatedAt.toISOString()}::timestamptz
    )
    RETURNING id
  `;
  return rows[0].id;
}

/** 手動 memory：metadata 無 capture key，builder 應排除。 */
async function seedManual(sql: Sql, projectId: string, summary: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO project_memories (project_id, type, summary, status, metadata, writer_host)
    VALUES (${projectId}, 'session', ${summary}, 'active', ${'{}'}::jsonb, 'vitest')
    RETURNING id
  `;
  return rows[0].id;
}

async function cleanup(sql: Sql): Promise<void> {
  await sql`DELETE FROM observations WHERE project_id LIKE ${TEST_PREFIX + '%'}`;
  await sql`DELETE FROM project_memories WHERE project_id LIKE ${TEST_PREFIX + '%'}`;
}

/** 測試側複製 impl 的 excerpt 規則，供 budget 期望值計算。 */
function excerpt(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

describe('buildRecentActivity (integration, real PG)', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    sql = await connectTestDb();
    db = drizzle(sql);
  });

  afterEach(async () => {
    await cleanup(sql);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  it('只回 active 且有 metadata.capture 的 rollup（archived 排除、manual 排除）', async () => {
    const projectId = `${TEST_PREFIX}-filter`;
    const rollupId = await seedRollup(sql, { projectId, summary: 'active rollup', discoveryTokens: 42 });
    await seedRollup(sql, { projectId, summary: 'archived rollup', discoveryTokens: 7, status: 'archived' });
    await seedManual(sql, projectId, 'manual memory without capture');

    const result = await buildRecentActivity(db, { projectId });

    expect(result.rows.map((r) => r.id)).toEqual([rollupId]);
  });

  it('project scope 隔離：他 project 的 rollup 不出現', async () => {
    const projectId = `${TEST_PREFIX}-scope-a`;
    const otherId = `${TEST_PREFIX}-scope-b`;
    const mine = await seedRollup(sql, { projectId, summary: 'mine', discoveryTokens: 10 });
    await seedRollup(sql, { projectId: otherId, summary: 'theirs', discoveryTokens: 20 });

    const result = await buildRecentActivity(db, { projectId });

    expect(result.rows.map((r) => r.id)).toEqual([mine]);
  });

  it('updated_at DESC 排序 + limit 生效', async () => {
    const projectId = `${TEST_PREFIX}-order`;
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    const oldId = await seedRollup(sql, {
      projectId,
      summary: 'oldest',
      discoveryTokens: 1,
      updatedAt: new Date(base),
    });
    const midId = await seedRollup(sql, {
      projectId,
      summary: 'middle',
      discoveryTokens: 2,
      updatedAt: new Date(base + 60_000),
    });
    const newId = await seedRollup(sql, {
      projectId,
      summary: 'newest',
      discoveryTokens: 3,
      updatedAt: new Date(base + 120_000),
    });

    const all = await buildRecentActivity(db, { projectId });
    expect(all.rows.map((r) => r.id)).toEqual([newId, midId, oldId]);

    const limited = await buildRecentActivity(db, { projectId, limit: 2 });
    expect(limited.rows.map((r) => r.id)).toEqual([newId, midId]);
  });

  it('row 欄位齊全與正確（ISO updatedAt、excerpt 截斷、count、discoveryTokens 讀值）', async () => {
    const projectId = `${TEST_PREFIX}-fields`;
    const longSummary = 'A'.repeat(130); // 130 > 120 → 截斷加 '…'
    const updatedAt = new Date('2026-07-05T12:34:56.000Z');
    const obsIds = [randomUUID(), randomUUID(), randomUUID()];
    const id = await seedRollup(sql, {
      projectId,
      summary: longSummary,
      discoveryTokens: 555,
      observationIds: obsIds,
      updatedAt,
    });

    const result = await buildRecentActivity(db, { projectId });
    const row = result.rows.find((r) => r.id === id);

    expect(row).toBeDefined();
    expect(row?.updatedAt).toBe('2026-07-05T12:34:56.000Z');
    expect(row?.summaryExcerpt).toBe(`${'A'.repeat(120)}…`);
    expect(row?.summaryExcerpt.length).toBe(121);
    expect(row?.observationIds).toEqual(obsIds);
    expect(row?.observationCount).toBe(3);
    expect(row?.discoveryTokens).toBe(555);
  });

  it('短 summary 不截斷、且 metadata 缺 discovery_tokens 時 fallback 0', async () => {
    const projectId = `${TEST_PREFIX}-fallback`;
    const id = await seedRollup(sql, { projectId, summary: 'short one' }); // 無 discoveryTokens

    const result = await buildRecentActivity(db, { projectId });
    const row = result.rows.find((r) => r.id === id);

    expect(row?.summaryExcerpt).toBe('short one');
    expect(row?.discoveryTokens).toBe(0);
    expect(row?.observationCount).toBe(0);
    expect(row?.observationIds).toEqual([]);
  });

  it('budget 第一步：超過時清空 observationIds、保留 observationCount、不丟 row', async () => {
    const projectId = `${TEST_PREFIX}-budget-ids`;
    // 每筆塞很多 observation ids，讓「含 ids」明顯大於「清空 ids」。
    const manyIds = () => Array.from({ length: 30 }, () => randomUUID());
    await seedRollup(sql, { projectId, summary: 'r1', discoveryTokens: 1, observationIds: manyIds() });
    await seedRollup(sql, { projectId, summary: 'r2', discoveryTokens: 2, observationIds: manyIds() });
    await seedRollup(sql, { projectId, summary: 'r3', discoveryTokens: 3, observationIds: manyIds() });

    // 先用超大 budget 取「完整 rows」，據此算兩個門檻。
    const full = await buildRecentActivity(db, { projectId, tokenBudget: 10_000_000 });
    const fullTokens = estimateDiscoveryTokens(JSON.stringify(full.rows));
    const clearedRows = full.rows.map((r) => ({ ...r, observationIds: [] as string[] }));
    const clearedTokens = estimateDiscoveryTokens(JSON.stringify(clearedRows));
    expect(clearedTokens).toBeLessThan(fullTokens); // 前提：ids 確實佔用可觀 token

    const budget = Math.floor((clearedTokens + fullTokens) / 2);
    const result = await buildRecentActivity(db, { projectId, tokenBudget: budget });

    // 第一步觸發：全部 ids 清空、count 保留、row 數不變。
    expect(result.rows.length).toBe(full.rows.length);
    expect(result.rows.every((r) => r.observationIds.length === 0)).toBe(true);
    expect(result.rows.map((r) => r.observationCount)).toEqual(full.rows.map((r) => r.observationCount));
  });

  it('budget 第三步：更小 budget 從最舊 row 開始丟', async () => {
    const projectId = `${TEST_PREFIX}-budget-drop`;
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    const newId = await seedRollup(sql, {
      projectId,
      summary: 'newest short',
      discoveryTokens: 3,
      observationIds: [randomUUID()],
      updatedAt: new Date(base + 120_000),
    });
    const midId = await seedRollup(sql, {
      projectId,
      summary: 'middle short',
      discoveryTokens: 2,
      observationIds: [randomUUID()],
      updatedAt: new Date(base + 60_000),
    });
    await seedRollup(sql, {
      projectId,
      summary: 'oldest short',
      discoveryTokens: 1,
      observationIds: [randomUUID()],
      updatedAt: new Date(base),
    });

    const full = await buildRecentActivity(db, { projectId, tokenBudget: 10_000_000 });
    // 短 summary（< 60）→ 第二步無效；ids 清空後即等同各步後樣貌。
    const clearedRows = full.rows.map((r) => ({
      ...r,
      observationIds: [] as string[],
      summaryExcerpt: excerpt(r.summaryExcerpt, 60),
    }));
    // budget = 只保留最新 2 筆時的估值 → 觸發丟最舊 1 筆。
    const budget = estimateDiscoveryTokens(JSON.stringify(clearedRows.slice(0, 2)));

    const result = await buildRecentActivity(db, { projectId, tokenBudget: budget });

    expect(result.rows.map((r) => r.id)).toEqual([newId, midId]);
  });

  it('__personal__ → ForbiddenError', async () => {
    await expect(buildRecentActivity(db, { projectId: '__personal__' })).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('limit / tokenBudget 非正數 → InvalidArgumentError（不打 DB）', async () => {
    const projectId = `${TEST_PREFIX}-bad-args`;
    await expect(buildRecentActivity(db, { projectId, limit: -1 })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(buildRecentActivity(db, { projectId, limit: 1.5 })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(buildRecentActivity(db, { projectId, tokenBudget: 0 })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
  });

  it('updated_at 相同時以 id DESC tie-break，順序穩定', async () => {
    const projectId = `${TEST_PREFIX}-tiebreak`;
    const sameTime = '2026-07-07T03:00:00.000Z';
    const a = await seedRollup(sql, { projectId, summary: 'a' });
    const b = await seedRollup(sql, { projectId, summary: 'b' });
    await sql`UPDATE project_memories SET updated_at = ${sameTime}::timestamptz WHERE id IN (${a}, ${b})`;

    const result = await buildRecentActivity(db, { projectId });
    const expected = [a, b].sort().reverse(); // uuid 文字序 DESC
    expect(result.rows.map((r) => r.id)).toEqual(expected);
  });
});
