// tests/tools/stats.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getProjectStats, ProjectStats } from '../../src/tools/stats.js';

describe('getProjectStats', () => {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();

  const mockDb = {
    select: mockSelect,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
  });

  it('should return project stats', async () => {
    // Setup mock responses for different queries
    let callCount = 0;
    mockWhere.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Total stats
        return Promise.resolve([{
          total: 5,
          first: new Date('2026-01-01'),
          last: new Date('2026-01-31'),
        }]);
      } else if (callCount === 2) {
        // Session count
        return Promise.resolve([{ count: 3 }]);
      } else {
        // Decision count
        return Promise.resolve([{ count: 2 }]);
      }
    });

    const stats = await getProjectStats(mockDb as any, 'my-project');

    expect(stats).toEqual({
      totalMemories: 5,
      sessionCount: 3,
      decisionCount: 2,
      firstMemory: new Date('2026-01-01'),
      lastMemory: new Date('2026-01-31'),
    });
  });

  it('should handle empty project', async () => {
    mockWhere.mockResolvedValue([{ total: 0, first: null, last: null, count: 0 }]);

    const stats = await getProjectStats(mockDb as any, 'empty-project');

    expect(stats.totalMemories).toBe(0);
    expect(stats.firstMemory).toBeNull();
    expect(stats.lastMemory).toBeNull();
  });
});
