// tests/tools/save.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 隔離 embedding 模組，避免測試打真 Gemini API（不依賴 GEMINI_API_KEY 環境變數）
vi.mock('../../src/utils/embedding.js', () => ({
  isEmbeddingEnabled: vi.fn(() => false),
  generateEmbedding: vi.fn(async () => null),
  generateQueryEmbedding: vi.fn(async () => null),
  composeEmbeddingText: vi.fn((summary: string) => summary),
}));

import { saveMemory, SaveMemoryInput } from '../../src/tools/save.js';
import * as embedding from '../../src/utils/embedding.js';

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

  // Guard：確保 embedding 模組被 vi.mock 攔截，避免未來有人移掉 mock 後測試回到打真 API
  it('must not call real Gemini API (embedding module is mocked)', () => {
    expect(vi.isMockFunction(embedding.generateEmbedding)).toBe(true);
    expect(vi.isMockFunction(embedding.generateQueryEmbedding)).toBe(true);
    expect(embedding.isEmbeddingEnabled()).toBe(false);
  });
});
