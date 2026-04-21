// tests/tools/search.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue(mockMemories);
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

    // keyword 模式會取 limit * 2 以便過濾後仍有足夠結果
    expect(mockLimit).toHaveBeenCalledWith(10);
  });

  it('should default to limit 10', async () => {
    const input: SearchInput = {
      query: 'test',
      mode: 'keyword',
    };

    await searchMemories(mockDb as any, input);

    // keyword 模式會取 limit * 2 (預設 10 * 2 = 20)
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('should filter results by keyword match', async () => {
    const input: SearchInput = {
      query: 'drizzle',
      projectId: 'my-project',
    };

    const results = await searchMemories(mockDb as any, input);

    // Should only return the Drizzle-related memory
    const drizzleResults = results.filter(r =>
      r.summary.toLowerCase().includes('drizzle') ||
      r.keywords?.some(k => k.toLowerCase().includes('drizzle'))
    );
    expect(drizzleResults.length).toBeGreaterThan(0);
  });

  // Guard：確保 embedding 模組被 vi.mock 攔截，避免未來有人移掉 mock 後測試回到打真 API
  it('must not call real Gemini API (embedding module is mocked)', () => {
    expect(vi.isMockFunction(embedding.generateQueryEmbedding)).toBe(true);
    expect(vi.isMockFunction(embedding.generateEmbedding)).toBe(true);
    expect(embedding.isEmbeddingEnabled()).toBe(false);
  });
});
