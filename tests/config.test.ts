// tests/config.test.ts
//
// config.ts 讀取 env 的契約：todoistApiToken 反映 TODOIST_API_TOKEN（optional，同 geminiApiKey）。
// config.ts 在 import 時讀一次 process.env → 用 vi.resetModules() + 動態 import 測「有/無」兩態。

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = process.env.TODOIST_API_TOKEN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TODOIST_API_TOKEN;
  else process.env.TODOIST_API_TOKEN = ORIGINAL;
  vi.resetModules();
});

describe('config.todoistApiToken', () => {
  it('reflects TODOIST_API_TOKEN when set', async () => {
    process.env.TODOIST_API_TOKEN = 'tok-abc-123';
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.todoistApiToken).toBe('tok-abc-123');
  });

  it('is undefined when TODOIST_API_TOKEN is unset', async () => {
    delete process.env.TODOIST_API_TOKEN;
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.todoistApiToken).toBeUndefined();
  });
});
