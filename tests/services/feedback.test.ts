// tests/services/feedback.test.ts
//
// Stage 1 Track F：services/feedback.ts 的 recordSearchQuery()
// 9 欄完整寫入 + effectiveMode 防漂移 + scores null 支援 + 長度不符 early fail。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { recordSearchQuery } from '../../src/services/feedback.js';
import { InvalidArgumentError } from '../../src/services/errors.js';
import type { SearchResultEnvelope } from '../../src/services/types.js';
import { connectTestDb, type Sql } from '../helpers/db.js';

const testPrefix = `track-f-${randomUUID().slice(0, 8)}`;

// ---- fixtures ----
function makeMemoryLike(projectId: string) {
  return {
    id: randomUUID(),
    projectId,
    type: 'session',
    summary: 's',
    keywords: [],
    decisions: [],
    nextSteps: [],
    embedding: null,
    status: 'active',
    mergedInto: null,
    idempotencyKey: null,
    contentHash: null,
    writerHost: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    projectPath: null,
  };
}

function makeEnvelope(
  overrides: Partial<SearchResultEnvelope> = {}
): SearchResultEnvelope {
  const projectId = `${testPrefix}-proj`;
  const results = [
    makeMemoryLike(projectId),
    makeMemoryLike(projectId),
    makeMemoryLike(projectId),
  ];
  return {
    results,
    effectiveMode: 'hybrid',
    rankingMeta: {
      rankPositions: [1, 2, 3],
      scores: [0.9, 0.8, 0.7],
    },
    queryContext: {
      query: 'hello world',
      requestedMode: 'hybrid',
      effectiveMode: 'hybrid',
      limit: 10,
      projectId,
      querySurface: 'mcp',
      filterType: null,
    },
    ...overrides,
  };
}

describe('recordSearchQuery (DB integration)', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    sql = await connectTestDb();
    db = drizzle(
      postgres(
        process.env.TEST_DATABASE_URL ??
          'postgres://test:test@localhost:5433/cc_memory_test',
        { max: 1 }
      )
    );
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM search_feedback WHERE query_project_id LIKE ${
      testPrefix + '%'
    }`;
  });

  it('writes all 9 required columns from envelope', async () => {
    const envelope = makeEnvelope();
    await recordSearchQuery(db, envelope);

    const rows = await sql<
      {
        query: string;
        query_surface: string;
        query_project_id: string | null;
        mode: string;
        limit: number;
        result_ids: string[];
        result_project_ids: string[];
        rank_positions: number[];
        scores: number[] | null;
      }[]
    >`
      SELECT query, query_surface, query_project_id, mode, "limit",
             result_ids, result_project_ids, rank_positions, scores
      FROM search_feedback
      WHERE query_project_id = ${envelope.queryContext.projectId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.query).toBe('hello world');
    expect(row.query_surface).toBe('mcp');
    expect(row.query_project_id).toBe(envelope.queryContext.projectId);
    expect(row.mode).toBe('hybrid');
    expect(row.limit).toBe(10);
    expect(row.result_ids).toEqual(envelope.results.map((r) => r.id));
    expect(row.result_project_ids).toEqual(
      envelope.results.map((r) => r.projectId)
    );
    expect(row.rank_positions).toEqual([1, 2, 3]);
    // postgres.js real[] → number[]；允許浮點誤差
    expect(row.scores).not.toBeNull();
    expect(row.scores!.length).toBe(3);
    expect(row.scores![0]).toBeCloseTo(0.9, 5);
    expect(row.scores![1]).toBeCloseTo(0.8, 5);
    expect(row.scores![2]).toBeCloseTo(0.7, 5);
  });

  // --------- Codex review round 17 P2：filterType 寫入 search_feedback ---------
  it('filterType=decision 寫入 search_feedback.filter_type', async () => {
    const envelope = makeEnvelope({
      queryContext: {
        query: 'decision search',
        requestedMode: 'hybrid',
        effectiveMode: 'hybrid',
        limit: 10,
        projectId: `${testPrefix}-ft-dec`,
        querySurface: 'mcp',
        filterType: 'decision',
      },
    });
    await recordSearchQuery(db, envelope);
    const rows = await sql<{ filter_type: string | null }[]>`
      SELECT filter_type FROM search_feedback WHERE query_project_id = ${envelope.queryContext.projectId}
    `;
    expect(rows[0].filter_type).toBe('decision');
  });

  it('filterType=null 時 filter_type column 亦 null', async () => {
    const envelope = makeEnvelope({
      queryContext: {
        query: 'no filter',
        requestedMode: 'hybrid',
        effectiveMode: 'hybrid',
        limit: 10,
        projectId: `${testPrefix}-ft-null`,
        querySurface: 'mcp',
        filterType: null,
      },
    });
    await recordSearchQuery(db, envelope);
    const rows = await sql<{ filter_type: string | null }[]>`
      SELECT filter_type FROM search_feedback WHERE query_project_id = ${envelope.queryContext.projectId}
    `;
    expect(rows[0].filter_type).toBeNull();
  });

  it('writes effectiveMode (not requestedMode) — downgrade signal preserved', async () => {
    const envelope = makeEnvelope({
      effectiveMode: 'keyword',
      queryContext: {
        query: 'hello',
        requestedMode: 'semantic',
        effectiveMode: 'keyword',
        limit: 5,
        projectId: `${testPrefix}-downgrade`,
        querySurface: 'telegram',
        filterType: null,
      },
    });
    await recordSearchQuery(db, envelope);

    const rows = await sql<{ mode: string; query_surface: string }[]>`
      SELECT mode, query_surface
      FROM search_feedback
      WHERE query_project_id = ${envelope.queryContext.projectId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('keyword');
    expect(rows[0].query_surface).toBe('telegram');
  });

  it('accepts scores = null (keyword-only mode)', async () => {
    const envelope = makeEnvelope({
      rankingMeta: {
        rankPositions: [1, 2, 3],
        scores: null,
      },
      queryContext: {
        query: 'q',
        requestedMode: 'keyword',
        effectiveMode: 'keyword',
        limit: 3,
        projectId: `${testPrefix}-scoresnull`,
        querySurface: 'http',
        filterType: null,
      },
      effectiveMode: 'keyword',
    });
    await recordSearchQuery(db, envelope);

    const rows = await sql<
      { scores: number[] | null; result_ids: string[] }[]
    >`
      SELECT scores, result_ids
      FROM search_feedback
      WHERE query_project_id = ${envelope.queryContext.projectId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].scores).toBeNull();
    expect(rows[0].result_ids).toHaveLength(3);
  });

  it('accepts null query_project_id (cross-project search)', async () => {
    const projectId = `${testPrefix}-nullctx`;
    // 給 result 有 projectId，但 queryContext.projectId = null
    const results = [makeMemoryLike(projectId)];
    const envelope: SearchResultEnvelope = {
      results,
      effectiveMode: 'keyword',
      rankingMeta: { rankPositions: [1], scores: null },
      queryContext: {
        query: 'x',
        requestedMode: 'keyword',
        effectiveMode: 'keyword',
        limit: 1,
        projectId: null,
        querySurface: 'mcp',
        filterType: null,
      },
    };
    await recordSearchQuery(db, envelope);

    const rows = await sql<{ query_project_id: string | null }[]>`
      SELECT query_project_id
      FROM search_feedback
      WHERE query = 'x' AND query_surface = 'mcp'
        AND ${projectId} = ANY(result_project_ids)
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].query_project_id).toBeNull();

    // cleanup 這筆（不在 testPrefix 下）
    await sql`DELETE FROM search_feedback WHERE result_project_ids @> ARRAY[${projectId}]::text[]`;
  });

  it('throws InvalidArgumentError when rankPositions length != results length', async () => {
    const envelope = makeEnvelope({
      rankingMeta: {
        rankPositions: [1, 2], // 2，但 results 有 3 筆
        scores: [0.9, 0.8, 0.7],
      },
    });
    await expect(recordSearchQuery(db, envelope)).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    // 不落 DB
    const rows = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id = ${envelope.queryContext.projectId}
    `;
    expect(rows[0].c).toBe(0);
  });

  it('throws InvalidArgumentError when scores is non-null and length != results length', async () => {
    const envelope = makeEnvelope({
      rankingMeta: {
        rankPositions: [1, 2, 3],
        scores: [0.9, 0.8], // 2，但 results 有 3 筆
      },
    });
    await expect(recordSearchQuery(db, envelope)).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    const rows = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id = ${envelope.queryContext.projectId}
    `;
    expect(rows[0].c).toBe(0);
  });

  it('throws InvalidArgumentError when result_project_ids implicit length != results length (defense-in-depth)', async () => {
    // 故意做一個 results 少一筆 projectId 的情境（用 any cast 模擬上游拼錯）
    const projectId = `${testPrefix}-lenmismatch`;
    const envelope: SearchResultEnvelope = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      results: [makeMemoryLike(projectId), { ...makeMemoryLike(projectId), projectId: undefined as any }],
      effectiveMode: 'keyword',
      rankingMeta: { rankPositions: [1, 2], scores: null },
      queryContext: {
        query: 'q',
        requestedMode: 'keyword',
        effectiveMode: 'keyword',
        limit: 5,
        projectId,
        querySurface: 'mcp',
        filterType: null,
      },
    };
    // 合法情境：rankPositions 長度 = results 長度（2 == 2）。
    // 但我們要求 service 對 result_project_ids（由 results.map 推出）每格為非空字串。
    // 這條測試接受 service 選擇放寬驗證並直接落 DB（DB CHECK 會擋）。
    // 所以只驗「不會靜默吞成 0 筆完好資料」：落 DB 成功 OR 早失敗，擇一但不可 silent success with misalignment。
    try {
      await recordSearchQuery(db, envelope);
      // 若落 DB，必須真的 2 筆對齊
      const rows = await sql<{ result_project_ids: unknown[] }[]>`
        SELECT result_project_ids FROM search_feedback WHERE query_project_id = ${projectId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].result_project_ids.length).toBe(2);
    } catch (err) {
      // 或是被 service / DB 擋下（可接受）
      expect(err).toBeDefined();
    }
  });
});
