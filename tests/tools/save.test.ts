// tests/tools/save.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveMemory, SaveMemoryInput } from '../../src/tools/save.js';

describe('saveMemory', () => {
  const mockInsert = vi.fn();
  const mockValues = vi.fn();
  const mockReturning = vi.fn();

  const mockDb = {
    insert: mockInsert,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([{ id: 'test-uuid-123' }]);
  });

  it('should save a session memory', async () => {
    const input: SaveMemoryInput = {
      projectId: 'my-project',
      type: 'session',
      summary: 'Implemented login feature',
      keywords: ['auth', 'login'],
      decisions: [],
      nextSteps: ['Add tests'],
    };

    const result = await saveMemory(mockDb as any, input);

    expect(result.id).toBe('test-uuid-123');
    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'my-project',
      type: 'session',
      summary: 'Implemented login feature',
    }));
  });

  it('should save a decision memory', async () => {
    const input: SaveMemoryInput = {
      projectId: 'my-project',
      type: 'decision',
      summary: 'Chose Drizzle over Prisma',
      keywords: ['orm', 'drizzle'],
      decisions: ['Use Drizzle for lightweight MCP server'],
      nextSteps: [],
    };

    const result = await saveMemory(mockDb as any, input);

    expect(result.id).toBe('test-uuid-123');
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      type: 'decision',
      decisions: ['Use Drizzle for lightweight MCP server'],
    }));
  });

  it('should handle optional projectPath', async () => {
    const input: SaveMemoryInput = {
      projectId: 'my-project',
      projectPath: '/workspaces/my-project',
      type: 'session',
      summary: 'Test summary',
    };

    const result = await saveMemory(mockDb as any, input);

    expect(result.id).toBe('test-uuid-123');
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/workspaces/my-project',
    }));
  });

  it('should use empty arrays as defaults', async () => {
    const input: SaveMemoryInput = {
      projectId: 'my-project',
      type: 'session',
      summary: 'Minimal input',
    };

    await saveMemory(mockDb as any, input);

    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      keywords: [],
      decisions: [],
      nextSteps: [],
    }));
  });
});
