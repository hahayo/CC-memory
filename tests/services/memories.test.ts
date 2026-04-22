// tests/services/memories.test.ts
//
// Stage 1 Track M：services/memories.ts 測試
//
// 覆蓋範圍：
//   1. saveMemory 冪等三分支（同 key 同 payload / 同 key 不同 payload / 無 key）
//   2. saveMemory 自動填 writer_host（預設 & 明示覆蓋）
//   3. searchMemories envelope shape（四 mode × embedding enabled/disabled）
//   4. listMemories / getMemory 回傳含 writer_host 欄位
//   5. deleteByIdempotencyKey（存在未過期、不存在、空 key）
//
// 整合測試用真 PG（連 test DB），使用 project_id prefix `track-m-...` 避免跟其他 track 撞。
// Unit 測試 mock drizzle client（embedding 模組 vi.mock 避免打真 Gemini API）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { connectTestDb, type Sql } from '../helpers/db.js';

// 隔離 embedding 模組 — 避免打真 Gemini API；預設 isEmbeddingEnabled=false
vi.mock('../../src/utils/embedding.js', () => ({
  isEmbeddingEnabled: vi.fn(() => false),
  generateEmbedding: vi.fn(async () => null),
  generateQueryEmbedding: vi.fn(async () => null),
  composeEmbeddingText: vi.fn((summary: string) => summary),
}));

import * as embedding from '../../src/utils/embedding.js';
import {
  saveMemory,
  searchMemories,
  listMemories,
  getMemory,
  deleteMemory,
  getProjectStats,
  deleteByIdempotencyKey,
} from '../../src/services/memories.js';
import { IdempotencyConflictError, InvalidArgumentError } from '../../src/services/errors.js';

const TRACK_M_PREFIX = `track-m-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Integration — 連真 PG
// ---------------------------------------------------------------------------

describe('services/memories.ts integration (real PG)', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    sql = await connectTestDb();
    db = drizzle(
      postgres(
        process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test',
        { max: 1 }
      )
    );
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM project_memories WHERE project_id LIKE ${'track-m-%'}`;
  });

  // -------------------------------------------------------------------------
  // saveMemory 冪等三分支
  // -------------------------------------------------------------------------

  describe('saveMemory — idempotency three branches', () => {
    it('same key + same payload → second call returns idempotent=true and same id', async () => {
      const projectId = `${TRACK_M_PREFIX}-idem1`;
      const input = {
        projectId,
        type: 'session' as const,
        summary: 'hello idempotency',
        keywords: ['a', 'b'],
        idempotencyKey: `key-${randomUUID()}`,
      };
      const first = await saveMemory(db, input);
      const second = await saveMemory(db, input);

      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.id).toBe(first.id);

      // DB 層只應該有 1 row
      const rows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM project_memories WHERE project_id = ${projectId}
      `;
      expect(rows[0].c).toBe(1);
    });

    // --------- Codex review round 4 P3：冪等命中跳過 embedding ---------
    it('saveMemory empty idempotencyKey 視為 undefined（不污染 partial-unique index）', async () => {
      const proj = TRACK_M_PREFIX + '-emptyidem';
      const r1 = await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 'a',
        idempotencyKey: '',
      });
      const r2 = await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 'b',
        idempotencyKey: '',
      });
      expect(r1.id).not.toBe(r2.id);
      expect(r1.idempotent).toBe(false);
      expect(r2.idempotent).toBe(false);
    });

    it('saveMemory whitespace-only idempotencyKey 視為 undefined', async () => {
      const proj = TRACK_M_PREFIX + '-wsidem';
      const r1 = await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 'a',
        idempotencyKey: '   ',
      });
      const r2 = await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 'b',
        idempotencyKey: '\t\n',
      });
      expect(r1.id).not.toBe(r2.id);
    });

    it('idempotent hit does NOT call generateEmbedding (pre-check skips embedding)', async () => {
      vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(true);
      vi.mocked(embedding.generateEmbedding).mockClear();
      vi.mocked(embedding.generateEmbedding).mockResolvedValue(null);

      const key = `idem-skipembed-${randomUUID()}`;
      const proj = TRACK_M_PREFIX + '-skipembed';

      // 第一次 insert：會 call generateEmbedding
      await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 's',
        idempotencyKey: key,
      });
      const callsAfterFirst = vi.mocked(embedding.generateEmbedding).mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

      // 第二次 insert（同 key 同 payload）：pre-check 命中，不該再 call generateEmbedding
      const result = await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 's',
        idempotencyKey: key,
      });
      expect(result.idempotent).toBe(true);

      const callsAfterSecond = vi.mocked(embedding.generateEmbedding).mock.calls.length;
      expect(callsAfterSecond).toBe(callsAfterFirst); // 沒新增 call
    });

    it('same key + different decisions → IdempotencyConflictError (round 2 fix)', async () => {
      const key = `idem-dec-${randomUUID()}`;
      await saveMemory(db, {
        projectId: TRACK_M_PREFIX + '-dec',
        type: 'session',
        summary: 'same summary',
        decisions: ['decision A'],
        idempotencyKey: key,
      });
      await expect(
        saveMemory(db, {
          projectId: TRACK_M_PREFIX + '-dec',
          type: 'session',
          summary: 'same summary',
          decisions: ['decision B'], // 只改 decisions，其他同
          idempotencyKey: key,
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('same key + different nextSteps → IdempotencyConflictError (round 2 fix)', async () => {
      const key = `idem-ns-${randomUUID()}`;
      await saveMemory(db, {
        projectId: TRACK_M_PREFIX + '-ns',
        type: 'session',
        summary: 'same summary',
        nextSteps: ['step A'],
        idempotencyKey: key,
      });
      await expect(
        saveMemory(db, {
          projectId: TRACK_M_PREFIX + '-ns',
          type: 'session',
          summary: 'same summary',
          nextSteps: ['step B'], // 只改 nextSteps
          idempotencyKey: key,
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });

    // --------- Codex review round 15 P1：idempotency scope by project ---------
    it('same key + different projects → each project gets its own row (not idempotent hit)', async () => {
      const key = `idem-xproj-${randomUUID()}`;
      const projA = TRACK_M_PREFIX + '-xpA';
      const projB = TRACK_M_PREFIX + '-xpB';
      const a = await saveMemory(db, {
        projectId: projA,
        type: 'session',
        summary: 'same summary',
        idempotencyKey: key,
      });
      const b = await saveMemory(db, {
        projectId: projB,
        type: 'session',
        summary: 'same summary',
        idempotencyKey: key,
      });
      // 不同 project 可以重用 key；各自有獨立 row
      expect(a.id).not.toBe(b.id);
      expect(a.idempotent).toBe(false);
      expect(b.idempotent).toBe(false);
    });

    it('same key + same project + same payload → idempotent hit（與 cross-project 行為區別）', async () => {
      const key = `idem-sameproj-${randomUUID()}`;
      const proj = TRACK_M_PREFIX + '-sp';
      const a = await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 'same summary',
        idempotencyKey: key,
      });
      const b = await saveMemory(db, {
        projectId: proj,
        type: 'session',
        summary: 'same summary',
        idempotencyKey: key,
      });
      expect(b.id).toBe(a.id);
      expect(b.idempotent).toBe(true);
    });

    it('same key + different payload → second call throws IdempotencyConflictError', async () => {
      const projectId = `${TRACK_M_PREFIX}-idem2`;
      const key = `key-${randomUUID()}`;
      const baseInput = {
        projectId,
        type: 'session' as const,
        summary: 'original',
        keywords: ['a'],
        idempotencyKey: key,
      };
      const firstResult = await saveMemory(db, baseInput);
      expect(firstResult.idempotent).toBe(false);

      // payload 改 summary → content_hash 不一致
      const conflicting = { ...baseInput, summary: 'different' };
      await expect(saveMemory(db, conflicting)).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('no idempotency key → each call creates a new row with distinct id', async () => {
      const projectId = `${TRACK_M_PREFIX}-idem3`;
      const input = {
        projectId,
        type: 'session' as const,
        summary: 'no key',
      };
      const r1 = await saveMemory(db, input);
      const r2 = await saveMemory(db, input);

      expect(r1.idempotent).toBe(false);
      expect(r2.idempotent).toBe(false);
      expect(r1.id).not.toBe(r2.id);

      const rows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM project_memories WHERE project_id = ${projectId}
      `;
      expect(rows[0].c).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // saveMemory writer_host 自動填
  // -------------------------------------------------------------------------

  describe('saveMemory — writer_host auto-fill', () => {
    it('writer_host is auto-filled (non-null) when not passed', async () => {
      const projectId = `${TRACK_M_PREFIX}-wh1`;
      const result = await saveMemory(db, {
        projectId,
        type: 'session',
        summary: 'auto writer_host',
      });
      const rows = await sql<{ writer_host: string | null }[]>`
        SELECT writer_host FROM project_memories WHERE id = ${result.id}
      `;
      expect(rows[0].writer_host).not.toBeNull();
      expect(typeof rows[0].writer_host).toBe('string');
      expect((rows[0].writer_host as string).length).toBeGreaterThan(0);
    });

    it('writer_host override: explicit input.writerHost wins', async () => {
      const projectId = `${TRACK_M_PREFIX}-wh2`;
      const result = await saveMemory(db, {
        projectId,
        type: 'session',
        summary: 'explicit writer_host',
        writerHost: 'custom-host-xyz',
      });
      const rows = await sql<{ writer_host: string | null }[]>`
        SELECT writer_host FROM project_memories WHERE id = ${result.id}
      `;
      expect(rows[0].writer_host).toBe('custom-host-xyz');
    });
  });

  // -------------------------------------------------------------------------
  // listMemories / getMemory return writer_host field
  // -------------------------------------------------------------------------

  describe('listMemories / getMemory — Memory row includes writer_host', () => {
    it('listMemories result rows expose writerHost property', async () => {
      const projectId = `${TRACK_M_PREFIX}-list`;
      const saved = await saveMemory(db, {
        projectId,
        type: 'session',
        summary: 'list target',
        writerHost: 'host-list',
      });
      const rows = await listMemories(db, { projectId });
      expect(rows.length).toBeGreaterThan(0);
      const found = rows.find((r) => r.id === saved.id);
      expect(found).toBeDefined();
      expect(found!.writerHost).toBe('host-list');
    });

    it('getMemory result includes writerHost', async () => {
      const projectId = `${TRACK_M_PREFIX}-get`;
      const saved = await saveMemory(db, {
        projectId,
        type: 'decision',
        summary: 'get target',
        writerHost: 'host-get',
      });
      const got = await getMemory(db, saved.id);
      expect(got).not.toBeNull();
      expect(got!.writerHost).toBe('host-get');
    });
  });

  // -------------------------------------------------------------------------
  // deleteByIdempotencyKey
  // -------------------------------------------------------------------------

  describe('deleteByIdempotencyKey', () => {
    it('existing key within maxAgeSec → soft-deletes and returns true', async () => {
      const projectId = `${TRACK_M_PREFIX}-dk1`;
      const key = `key-${randomUUID()}`;
      const saved = await saveMemory(db, {
        projectId,
        type: 'session',
        summary: 'to be undone',
        idempotencyKey: key,
      });
      const ok = await deleteByIdempotencyKey(db, projectId, key, 300);
      expect(ok).toBe(true);

      const rows = await sql<{ status: string }[]>`
        SELECT status FROM project_memories WHERE id = ${saved.id}
      `;
      expect(rows[0].status).toBe('archived');
    });

    it('non-existent key returns false', async () => {
      const ok = await deleteByIdempotencyKey(
        db,
        `${TRACK_M_PREFIX}-dk-miss`,
        `never-used-${randomUUID()}`,
        300
      );
      expect(ok).toBe(false);
    });

    it('empty key throws InvalidArgumentError', async () => {
      await expect(
        deleteByIdempotencyKey(db, `${TRACK_M_PREFIX}-dk3`, '', 300)
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('empty projectId throws InvalidArgumentError', async () => {
      await expect(deleteByIdempotencyKey(db, '', 'some-key', 300)).rejects.toBeInstanceOf(
        InvalidArgumentError
      );
    });

    it('maxAgeSec <= 0 throws InvalidArgumentError', async () => {
      await expect(
        deleteByIdempotencyKey(db, `${TRACK_M_PREFIX}-dk4`, 'some-key', 0)
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(
        deleteByIdempotencyKey(db, `${TRACK_M_PREFIX}-dk4`, 'some-key', -1)
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    // --------- Codex review round 18 P2：不跨 project 刪除 ---------
    it('key matches but different project → 回 false（不刪跨 project row）', async () => {
      const projA = `${TRACK_M_PREFIX}-dkxpA`;
      const projB = `${TRACK_M_PREFIX}-dkxpB`;
      const key = `shared-${randomUUID()}`;
      await saveMemory(db, { projectId: projA, type: 'session', summary: 'in A', idempotencyKey: key });
      // 嘗試用 projB 刪 projA 的 row
      const ok = await deleteByIdempotencyKey(db, projB, key, 300);
      expect(ok).toBe(false);
      // projA 的 row 仍 active
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM project_memories WHERE idempotency_key = ${key} AND project_id = ${projA}
      `;
      expect(rows[0].status).toBe('active');
    });

    // --------- Codex review round 19 P2：archive 後同 key 可重新 save ---------
    it('archive 後同 key + 同 payload → 建立新 active row（非 idempotent 命中 archived）', async () => {
      const projectId = `${TRACK_M_PREFIX}-re1`;
      const key = `rekey-${randomUUID()}`;
      const input = {
        projectId,
        type: 'session' as const,
        summary: 'initial save',
        idempotencyKey: key,
      };
      const first = await saveMemory(db, input);
      expect(first.idempotent).toBe(false);

      // 軟刪除
      const deleted = await deleteByIdempotencyKey(db, projectId, key, 300);
      expect(deleted).toBe(true);

      // 再 save 同 key 同 payload → 應建新 active row，idempotent=false
      const second = await saveMemory(db, input);
      expect(second.idempotent).toBe(false);
      expect(second.id).not.toBe(first.id);

      // archived + new active 各 1 row
      const rows = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM project_memories
        WHERE project_id = ${projectId} AND idempotency_key = ${key}
        ORDER BY created_at ASC
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(first.id);
      expect(rows[0].status).toBe('archived');
      expect(rows[1].id).toBe(second.id);
      expect(rows[1].status).toBe('active');
    });

    it('archive 後同 key + 不同 payload → 建立新 active row（非 IdempotencyConflictError）', async () => {
      const projectId = `${TRACK_M_PREFIX}-re2`;
      const key = `rekey2-${randomUUID()}`;
      const first = await saveMemory(db, {
        projectId,
        type: 'session',
        summary: 'original payload',
        idempotencyKey: key,
      });
      await deleteByIdempotencyKey(db, projectId, key, 300);

      // 同 key 但不同 payload，archive 後應 ok（因為 archived row 已不佔 active 冪等槽位）
      const second = await saveMemory(db, {
        projectId,
        type: 'session',
        summary: 'new payload after undo',
        idempotencyKey: key,
      });
      expect(second.idempotent).toBe(false);
      expect(second.id).not.toBe(first.id);
    });
  });

  // -------------------------------------------------------------------------
  // deleteMemory / getProjectStats sanity
  // -------------------------------------------------------------------------

  describe('deleteMemory / getProjectStats sanity', () => {
    it('deleteMemory sets status=archived; getProjectStats then excludes it', async () => {
      const projectId = `${TRACK_M_PREFIX}-ds`;
      const saved = await saveMemory(db, {
        projectId,
        type: 'session',
        summary: 'to archive',
      });
      await deleteMemory(db, saved.id);

      const stats = await getProjectStats(db, projectId);
      expect(stats.totalMemories).toBe(0);
      expect(stats.sessionCount).toBe(0);
    });

    it('getProjectStats counts session vs decision', async () => {
      const projectId = `${TRACK_M_PREFIX}-stats`;
      await saveMemory(db, { projectId, type: 'session', summary: 's1' });
      await saveMemory(db, { projectId, type: 'session', summary: 's2' });
      await saveMemory(db, { projectId, type: 'decision', summary: 'd1' });

      const stats = await getProjectStats(db, projectId);
      expect(stats.totalMemories).toBe(3);
      expect(stats.sessionCount).toBe(2);
      expect(stats.decisionCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// searchMemories envelope shape — unit test (mocked drizzle chain)
// ---------------------------------------------------------------------------

describe('searchMemories envelope shape (unit)', () => {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockOrderBy = vi.fn();
  const mockLimit = vi.fn();

  const mockDb = {
    select: mockSelect,
  };

  const mockMemories = [
    {
      id: 'uuid-1',
      projectId: 'my-project',
      type: 'session',
      summary: 'Implemented auth login feature',
      keywords: ['auth', 'login'],
      decisions: [],
      nextSteps: [],
      embedding: null,
      status: 'active',
      mergedInto: null,
      idempotencyKey: null,
      contentHash: null,
      writerHost: 'host-A',
      metadata: {},
      projectPath: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    },
    {
      id: 'uuid-2',
      projectId: 'my-project',
      type: 'decision',
      summary: 'Chose Drizzle ORM',
      keywords: ['drizzle', 'orm'],
      decisions: [],
      nextSteps: [],
      embedding: null,
      status: 'active',
      mergedInto: null,
      idempotencyKey: null,
      contentHash: null,
      writerHost: 'host-A',
      metadata: {},
      projectPath: null,
      createdAt: new Date('2026-01-02'),
      updatedAt: new Date('2026-01-02'),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: embedding disabled
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(false);
    vi.mocked(embedding.generateQueryEmbedding).mockResolvedValue(null);

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue(mockMemories);
  });

  it('requested hybrid + embedding disabled → effectiveMode=keyword, scores=null', async () => {
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(false);

    const env = await searchMemories(mockDb as never, {
      query: 'auth',
      mode: 'hybrid',
      projectId: 'my-project',
    });

    expect(env.queryContext.requestedMode).toBe('hybrid');
    expect(env.effectiveMode).toBe('keyword');
    expect(env.rankingMeta.scores).toBeNull();
    expect(env.rankingMeta.rankPositions.length).toBe(env.results.length);
    // rankPositions 為 1-based
    if (env.results.length > 0) {
      expect(env.rankingMeta.rankPositions[0]).toBe(1);
    }
  });

  it('requested semantic + embedding disabled → effectiveMode=keyword', async () => {
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(false);

    const env = await searchMemories(mockDb as never, {
      query: 'drizzle',
      mode: 'semantic',
    });

    expect(env.queryContext.requestedMode).toBe('semantic');
    expect(env.effectiveMode).toBe('keyword');
    expect(env.rankingMeta.scores).toBeNull();
  });

  it('requested keyword → effectiveMode=keyword regardless of embedding', async () => {
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(true);

    const env = await searchMemories(mockDb as never, {
      query: 'drizzle',
      mode: 'keyword',
      projectId: 'my-project',
    });

    expect(env.queryContext.requestedMode).toBe('keyword');
    expect(env.effectiveMode).toBe('keyword');
    expect(env.rankingMeta.scores).toBeNull();
    expect(env.rankingMeta.rankPositions.length).toBe(env.results.length);
  });

  it('envelope contract: rankPositions length === results length (hard invariant)', async () => {
    const env = await searchMemories(mockDb as never, {
      query: 'anything',
      mode: 'keyword',
    });
    expect(env.rankingMeta.rankPositions.length).toBe(env.results.length);
  });

  it('queryContext carries query, limit, projectId, querySurface (default mcp)', async () => {
    const env = await searchMemories(mockDb as never, {
      query: 'hello',
      mode: 'keyword',
      limit: 5,
      projectId: 'my-project',
    });
    expect(env.queryContext.query).toBe('hello');
    expect(env.queryContext.limit).toBe(5);
    expect(env.queryContext.projectId).toBe('my-project');
    expect(env.queryContext.querySurface).toBe('mcp');
  });

  it('queryContext.projectId is null when not provided; limit defaults to 10', async () => {
    const env = await searchMemories(mockDb as never, {
      query: 'hello',
      mode: 'keyword',
    });
    expect(env.queryContext.projectId).toBeNull();
    expect(env.queryContext.limit).toBe(10);
  });

  it('respects querySurface override (telegram)', async () => {
    const env = await searchMemories(mockDb as never, {
      query: 'hello',
      mode: 'keyword',
      querySurface: 'telegram',
    });
    expect(env.queryContext.querySurface).toBe('telegram');
  });

  // Guard：embedding 模組必為 mock，不可打真 API
  it('must not call real Gemini API (embedding mocked)', () => {
    expect(vi.isMockFunction(embedding.generateEmbedding)).toBe(true);
    expect(vi.isMockFunction(embedding.generateQueryEmbedding)).toBe(true);
  });

  // --------- Codex review round 14 P2：hybrid scores 必為 null ---------
  it('hybrid mode scores 必為 null（不混 RRF weights 進 search_feedback.scores）', async () => {
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(true);
    // mock generateQueryEmbedding 回真 vector 讓 hybrid 真走到 RRF
    vi.mocked(embedding.generateQueryEmbedding).mockResolvedValue(
      new Array(1536).fill(0.1)
    );

    const env = await searchMemories(mockDb as never, {
      query: 'drizzle',
      mode: 'hybrid',
      projectId: 'my-project',
    });

    expect(env.effectiveMode).toBe('hybrid');
    expect(env.rankingMeta.scores).toBeNull();
    expect(env.rankingMeta.rankPositions.length).toBe(env.results.length);
  });

  it('semantic mode scores 非 null（保留 similarity 語意）', async () => {
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(true);
    vi.mocked(embedding.generateQueryEmbedding).mockResolvedValue(
      new Array(1536).fill(0.1)
    );

    const env = await searchMemories(mockDb as never, {
      query: 'drizzle',
      mode: 'semantic',
      projectId: 'my-project',
    });

    expect(env.effectiveMode).toBe('semantic');
    if (env.results.length > 0) {
      expect(env.rankingMeta.scores).not.toBeNull();
      expect(env.rankingMeta.scores!.length).toBe(env.results.length);
    }
  });

  // --------- Codex review round 1 finding #2：embedding enabled 但 API 失敗降級 ---------
  it('requested semantic + embedding enabled but generateQueryEmbedding fails → effectiveMode=keyword, scores=null', async () => {
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(true);
    vi.mocked(embedding.generateQueryEmbedding).mockResolvedValue(null);

    const env = await searchMemories(mockDb as never, {
      query: 'hello',
      mode: 'semantic',
      projectId: 'my-project',
    });

    expect(env.queryContext.requestedMode).toBe('semantic');
    // 關鍵：embedding 實際沒算出來，effectiveMode 不可謊報 'semantic'
    expect(env.effectiveMode).toBe('keyword');
    // scores 必為 null（若 semantic 失敗後仍有 scores，recordSearchQuery 會誤寫）
    expect(env.rankingMeta.scores).toBeNull();
  });

  it('requested hybrid + embedding enabled but API fails → effectiveMode=keyword, scores=null', async () => {
    vi.mocked(embedding.isEmbeddingEnabled).mockReturnValue(true);
    vi.mocked(embedding.generateQueryEmbedding).mockResolvedValue(null);

    const env = await searchMemories(mockDb as never, {
      query: 'hello',
      mode: 'hybrid',
      projectId: 'my-project',
    });

    expect(env.queryContext.requestedMode).toBe('hybrid');
    expect(env.effectiveMode).toBe('keyword');
    expect(env.rankingMeta.scores).toBeNull();
  });
});
