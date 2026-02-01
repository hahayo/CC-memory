// tests/tools/list.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listMemories, ListInput } from '../../src/tools/list.js';

describe('listMemories', () => {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockOrderBy = vi.fn();
  const mockLimit = vi.fn();
  const mockOffset = vi.fn();

  const mockDb = {
    select: mockSelect,
  };

  const mockMemories = [
    { id: 'uuid-1', projectId: 'my-project', type: 'session', summary: 'Test 1' },
    { id: 'uuid-2', projectId: 'my-project', type: 'decision', summary: 'Test 2' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ offset: mockOffset });
    mockOffset.mockResolvedValue(mockMemories);
  });

  it('should list memories for a project', async () => {
    const input: ListInput = {
      projectId: 'my-project',
    };

    const results = await listMemories(mockDb as any, input);

    expect(results).toEqual(mockMemories);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by type', async () => {
    const input: ListInput = {
      projectId: 'my-project',
      type: 'decision',
    };

    await listMemories(mockDb as any, input);

    expect(mockWhere).toHaveBeenCalled();
  });

  it('should apply limit and offset', async () => {
    const input: ListInput = {
      projectId: 'my-project',
      limit: 10,
      offset: 5,
    };

    await listMemories(mockDb as any, input);

    expect(mockLimit).toHaveBeenCalledWith(10);
    expect(mockOffset).toHaveBeenCalledWith(5);
  });

  it('should use default limit 20 and offset 0', async () => {
    const input: ListInput = {
      projectId: 'my-project',
    };

    await listMemories(mockDb as any, input);

    expect(mockLimit).toHaveBeenCalledWith(20);
    expect(mockOffset).toHaveBeenCalledWith(0);
  });
});
