// tests/utils/project-id.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getProjectId } from '../../src/utils/project-id.js';

describe('getProjectId', () => {
  it('should extract project id from CLAUDE.md marker', async () => {
    const mockReadFile = vi.fn().mockResolvedValue(
      '# CLAUDE.md\n\n<!-- cc-memory: project="my-project" -->\n\nContent...'
    );

    const result = await getProjectId('/some/path', mockReadFile);
    expect(result).toBe('my-project');
  });

  it('should handle marker with extra whitespace', async () => {
    const mockReadFile = vi.fn().mockResolvedValue(
      '<!--  cc-memory:  project="test-project"  -->'
    );

    const result = await getProjectId('/some/path', mockReadFile);
    expect(result).toBe('test-project');
  });

  it('should fallback to directory name if no marker', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('# CLAUDE.md\n\nNo marker');

    const result = await getProjectId('/workspaces/AI_Project/CC-memory', mockReadFile);
    expect(result).toBe('CC-memory');
  });

  it('should fallback to directory name if no CLAUDE.md', async () => {
    const mockReadFile = vi.fn().mockRejectedValue(new Error('File not found'));

    const result = await getProjectId('/workspaces/my-project', mockReadFile);
    expect(result).toBe('my-project');
  });

  it('should handle Windows-style paths', async () => {
    const mockReadFile = vi.fn().mockRejectedValue(new Error('File not found'));

    const result = await getProjectId('C:\\Users\\dev\\my-app', mockReadFile);
    expect(result).toBe('my-app');
  });
});
