// tests/utils/writer-host.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWriterHost } from '../../src/utils/writer-host.js';

describe('resolveWriterHost', () => {
  const originalEnv = process.env.CC_MEMORY_WRITER;

  beforeEach(() => {
    delete process.env.CC_MEMORY_WRITER;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CC_MEMORY_WRITER;
    else process.env.CC_MEMORY_WRITER = originalEnv;
  });

  it('prefers CC_MEMORY_WRITER env var when set', () => {
    process.env.CC_MEMORY_WRITER = 'custom-writer';
    expect(resolveWriterHost(() => 'ignored')).toBe('custom-writer');
  });

  it('trims whitespace from env var', () => {
    process.env.CC_MEMORY_WRITER = '  custom-writer  ';
    expect(resolveWriterHost(() => 'ignored')).toBe('custom-writer');
  });

  it('falls back to hostname fn when env unset', () => {
    expect(resolveWriterHost(() => 'laptop-A')).toBe('laptop-A');
  });

  it('falls back to hostname fn when env is empty string', () => {
    process.env.CC_MEMORY_WRITER = '';
    expect(resolveWriterHost(() => 'laptop-B')).toBe('laptop-B');
  });

  it('falls back to hostname fn when env is whitespace only', () => {
    process.env.CC_MEMORY_WRITER = '   ';
    expect(resolveWriterHost(() => 'laptop-C')).toBe('laptop-C');
  });

  it('default (no injected fn) returns non-empty string', () => {
    // 不 mock，實跑 os.hostname()，只驗結果型別/非空
    const result = resolveWriterHost();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
