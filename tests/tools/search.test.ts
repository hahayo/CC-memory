// tests/tools/search.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';

// 隔離 embedding 模組，避免測試打真 Gemini API（不依賴 GEMINI_API_KEY 環境變數）
// isEmbeddingEnabled=false 強制走 keyword 路徑，跟既有測試的 mockDb 鏈對齊
vi.mock('../../src/utils/embedding.js', () => ({
  isEmbeddingEnabled: vi.fn(() => false),
  generateEmbedding: vi.fn(async () => null),
  generateQueryEmbedding: vi.fn(async () => null),
  composeEmbeddingText: vi.fn((summary: string) => summary),
}));

import { searchMemories, SearchInput } from '../../src/tools/search.js';
import * as embedding from '../../src/utils/embedding.js';

describe('searchMemories', () => {
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
      status: 'active',
      createdAt: new Date('2026-01-01'),
    },
    {
      id: 'uuid-2',
      projectId: 'my-project',
      type: 'decision',
      summary: 'Chose Drizzle ORM',
      keywords: ['drizzle', 'orm'],
      status: 'active',
      createdAt: new Date('2026-01-02'),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-10-23 起 keyword 路徑是「子查詢排序 id → join 回原表」：鏈上多了 offset／as／innerJoin，
    // 子查詢別名的欄位用 Proxy 回 sql.raw，讓 drizzle 的 sql 模板能嵌進去；最後一段沒有 limit，靠 then 收。
    const subAlias = new Proxy({}, { get: (_t, k) => sql.raw(String(k)) });
    const tail = { limit: mockLimit, then: (res: (v: unknown) => void) => res(mockMemories) };
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere, innerJoin: () => ({ orderBy: mockOrderBy }) });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy, offset: () => ({ as: () => subAlias }) });
    mockOrderBy.mockReturnValue(tail);
    mockLimit.mockReturnValue({ as: () => subAlias, then: (res: (v: unknown) => void) => res(mockMemories) });
  });

  it('should search by query keywords', async () => {
    const input: SearchInput = {
      query: 'auth login',
      projectId: 'my-project',
    };

    const results = await searchMemories(mockDb as any, input);

    expect(results.length).toBeGreaterThan(0);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by projectId', async () => {
    const input: SearchInput = {
      query: 'test',
      projectId: 'my-project',
    };

    await searchMemories(mockDb as any, input);

    expect(mockWhere).toHaveBeenCalled();
  });

  it('should filter by type', async () => {
    const input: SearchInput = {
      query: 'test',
      type: 'decision',
    };

    await searchMemories(mockDb as any, input);

    expect(mockWhere).toHaveBeenCalled();
  });

  it('should respect limit parameter', async () => {
    const input: SearchInput = {
      query: 'test',
      limit: 5,
      mode: 'keyword',
    };

    await searchMemories(mockDb as any, input);

    // 2026-10-23 起 keyword 過濾在 SQL 端做，DB limit 就是呼叫端的 limit
    expect(mockLimit).toHaveBeenCalledWith(5);
  });

  it('should default to limit 10', async () => {
    const input: SearchInput = {
      query: 'test',
      mode: 'keyword',
    };

    await searchMemories(mockDb as any, input);

    // 預設 limit 10，不再 ×2
    expect(mockLimit).toHaveBeenCalledWith(10);
  });

  it('should push the keyword filter into the SQL where clause (2026-10-23)', async () => {
    const input: SearchInput = {
      query: 'drizzle',
      projectId: 'my-project',
    };

    await searchMemories(mockDb as any, input);

    // 過濾已移到 DB 端：where 條件必須含 LIKE lower(；真實比對行為由 tests/services/memories.test.ts 的 PG 整合測試覆蓋
    expect(mockWhere).toHaveBeenCalled();
    const flatten = (node: unknown, out: string[] = []): string[] => {
      if (node == null) return out;
      if (typeof node === 'string') out.push(node);
      else if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
      else if (typeof node === 'object') {
        const o = node as { queryChunks?: unknown; value?: unknown };
        if ('queryChunks' in o) flatten(o.queryChunks, out);
        else if ('value' in o) flatten(o.value, out);
      }
      return out;
    };
    const chunks = mockWhere.mock.calls.map((call) => flatten(call[0]).join(' ')).join(' | ');
    expect(chunks).toContain('LIKE lower(');
    expect(chunks).toContain('%drizzle%');
  });

  // Guard：確保 embedding 模組被 vi.mock 攔截，避免未來有人移掉 mock 後測試回到打真 API
  it('must not call real Gemini API (embedding module is mocked)', () => {
    expect(vi.isMockFunction(embedding.generateQueryEmbedding)).toBe(true);
    expect(vi.isMockFunction(embedding.generateEmbedding)).toBe(true);
    expect(embedding.isEmbeddingEnabled()).toBe(false);
  });
});
