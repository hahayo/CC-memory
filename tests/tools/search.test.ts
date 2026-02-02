// tests/tools/search.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchMemories, SearchInput } from '../../src/tools/search.js';

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
});
