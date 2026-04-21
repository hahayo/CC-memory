// tests/db/schema-v03.test.ts
//
// Stage 0.1 Schema unit test（不連 DB，純驗 Drizzle schema 物件）
//
// 目的：確保 projectMemories / tasks schema 物件本身就帶新欄位，
// 搭配 v03-writer-idempotency.test.ts 的 DB integration 形成兩層 gate，
// 避免 drizzle-kit push 漏掉欄位或 migration 不完整時測試仍綠的退化。

import { describe, it, expect } from 'vitest';
import { projectMemories, tasks, searchFeedback } from '../../src/db/schema.js';

describe('v0.3 schema: projectMemories new columns', () => {
  it('has idempotencyKey column (text, nullable)', () => {
    const cols = Object.keys(projectMemories);
    expect(cols).toContain('idempotencyKey');
    const col = (projectMemories as Record<string, unknown>).idempotencyKey as {
      dataType: string;
      notNull?: boolean;
      name?: string;
    };
    expect(col).toBeDefined();
    expect(col.dataType).toBe('string');
    expect(col.notNull).toBeFalsy();
  });

  it('has writerHost column (text, nullable)', () => {
    const cols = Object.keys(projectMemories);
    expect(cols).toContain('writerHost');
    const col = (projectMemories as Record<string, unknown>).writerHost as {
      dataType: string;
      notNull?: boolean;
    };
    expect(col).toBeDefined();
    expect(col.dataType).toBe('string');
    expect(col.notNull).toBeFalsy();
  });

  it('has contentHash column (text, nullable) for idempotency payload verification', () => {
    const cols = Object.keys(projectMemories);
    expect(cols).toContain('contentHash');
    const col = (projectMemories as Record<string, unknown>).contentHash as {
      dataType: string;
      notNull?: boolean;
    };
    expect(col).toBeDefined();
    expect(col.dataType).toBe('string');
    expect(col.notNull).toBeFalsy();
  });
});

describe('v0.3 schema: tasks new columns', () => {
  it('has writerHost column (text, nullable)', () => {
    const cols = Object.keys(tasks);
    expect(cols).toContain('writerHost');
    const col = (tasks as Record<string, unknown>).writerHost as {
      dataType: string;
      notNull?: boolean;
    };
    expect(col).toBeDefined();
    expect(col.dataType).toBe('string');
    expect(col.notNull).toBeFalsy();
  });
});

describe('v0.3 schema: searchFeedback still exports', () => {
  it('has existing columns (regression guard)', () => {
    const cols = Object.keys(searchFeedback);
    expect(cols).toContain('resultIds');
    expect(cols).toContain('resultProjectIds');
    expect(cols).toContain('rankPositions');
    expect(cols).toContain('scores');
    expect(cols).toContain('mode');
  });
});
