// tests/db/schema.test.ts
import { describe, it, expect } from 'vitest';
import { projectMemories } from '../../src/db/schema.js';

describe('projectMemories schema', () => {
  it('should have required columns', () => {
    const columns = Object.keys(projectMemories);
    expect(columns).toContain('id');
    expect(columns).toContain('projectId');
    expect(columns).toContain('type');
    expect(columns).toContain('summary');
    expect(columns).toContain('keywords');
    expect(columns).toContain('decisions');
    expect(columns).toContain('nextSteps');
    expect(columns).toContain('status');
    expect(columns).toContain('createdAt');
  });

  it('should have optional columns', () => {
    const columns = Object.keys(projectMemories);
    expect(columns).toContain('projectPath');
    expect(columns).toContain('mergedInto');
    expect(columns).toContain('metadata');
    expect(columns).toContain('updatedAt');
  });
});
