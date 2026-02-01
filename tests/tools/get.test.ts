// tests/tools/get.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMemory } from '../../src/tools/get.js';

describe('getMemory', () => {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockLimit = vi.fn();

  const mockDb = {
    select: mockSelect,
  };

  const mockMemory = {
    id: 'test-uuid',
    projectId: 'my-project',
    type: 'session',
    summary: 'Test memory',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it('should return a memory by id', async () => {
    mockLimit.mockResolvedValue([mockMemory]);

    const result = await getMemory(mockDb as any, 'test-uuid');

    expect(result).toEqual(mockMemory);
    expect(mockSelect).toHaveBeenCalled();
    expect(mockLimit).toHaveBeenCalledWith(1);
  });

  it('should return null if not found', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await getMemory(mockDb as any, 'non-existent');

    expect(result).toBeNull();
  });
});
