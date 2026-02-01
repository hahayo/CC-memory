// tests/tools/delete.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteMemory } from '../../src/tools/delete.js';

describe('deleteMemory', () => {
  const mockUpdate = vi.fn();
  const mockSet = vi.fn();
  const mockWhere = vi.fn();

  const mockDb = {
    update: mockUpdate,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockResolvedValue(undefined);
  });

  it('should archive a memory (soft delete)', async () => {
    const result = await deleteMemory(mockDb as any, 'test-uuid');

    expect(result).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({ status: 'archived' });
    expect(mockWhere).toHaveBeenCalled();
  });
});
