// tests/config.test.ts
//
// config.ts 啟動期讀 env 的契約：
//   1. todoistApiToken 反映 TODOIST_API_TOKEN（optional，同 geminiApiKey）。
//   2. Phase 3 v0.4 fail-fast 矩陣（獨立 personal DB，見 ADR-001）：
//      - forced-mode personal（CC_FORCE_PROJECT_ID=__personal__）缺 DATABASE_URL_PERSONAL → 啟動 throw
//      - project-mode 偵測到 DATABASE_URL_PERSONAL → warn + 不載入該 URL
//      - 一 process 一 scope 一 DB：databaseUrl 由 resolveDatabaseUrl() 啟動期決策
//
// config.ts import 時讀一次 process.env → 用 vi.resetModules() + 動態 import 測各情境。

import { afterEach, describe, expect, it, vi } from 'vitest';

const TRACKED_ENV = [
  'TODOIST_API_TOKEN',
  'DATABASE_URL',
  'DATABASE_URL_PERSONAL',
  'CC_FORCE_PROJECT_ID',
] as const;

const ORIGINAL: Record<string, string | undefined> = {};
for (const k of TRACKED_ENV) ORIGINAL[k] = process.env[k];

afterEach(() => {
  for (const k of TRACKED_ENV) {
    const v = ORIGINAL[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

function setEnv(updates: Partial<Record<(typeof TRACKED_ENV)[number], string | undefined>>) {
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('config.todoistApiToken', () => {
  it('reflects TODOIST_API_TOKEN when set', async () => {
    setEnv({ TODOIST_API_TOKEN: 'tok-abc-123', DATABASE_URL: 'postgresql://test' });
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.todoistApiToken).toBe('tok-abc-123');
  });

  it('is undefined when TODOIST_API_TOKEN is unset', async () => {
    setEnv({ TODOIST_API_TOKEN: undefined, DATABASE_URL: 'postgresql://test' });
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.todoistApiToken).toBeUndefined();
  });
});

describe('resolveDatabaseUrl + fail-fast 矩陣（Phase 3 v0.4，獨立 personal DB）', () => {
  it('forced-mode personal: 缺 DATABASE_URL_PERSONAL → 啟動 throw', async () => {
    setEnv({
      DATABASE_URL: 'postgresql://project',
      DATABASE_URL_PERSONAL: undefined,
      CC_FORCE_PROJECT_ID: '__personal__',
    });
    vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow(/DATABASE_URL_PERSONAL/);
  });

  it('forced-mode personal: 有 DATABASE_URL_PERSONAL → databaseUrl = personal URL', async () => {
    setEnv({
      DATABASE_URL: 'postgresql://project',
      DATABASE_URL_PERSONAL: 'postgresql://personal',
      CC_FORCE_PROJECT_ID: '__personal__',
    });
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.databaseUrl).toBe('postgresql://personal');
  });

  it('project-mode 偵測到 DATABASE_URL_PERSONAL → console.warn + 仍回 DATABASE_URL', async () => {
    setEnv({
      DATABASE_URL: 'postgresql://project',
      DATABASE_URL_PERSONAL: 'postgresql://personal',
      CC_FORCE_PROJECT_ID: undefined,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.databaseUrl).toBe('postgresql://project');
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ');
    // warn 文案不綁特定 mode 字樣（涵蓋 forced 非 personal 的情境，Phase 3 review）
    expect(msg).toMatch(/DATABASE_URL_PERSONAL/);
  });

  it('project-mode 只有 DATABASE_URL → 不 warn、databaseUrl = project URL', async () => {
    setEnv({
      DATABASE_URL: 'postgresql://project',
      DATABASE_URL_PERSONAL: undefined,
      CC_FORCE_PROJECT_ID: undefined,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.databaseUrl).toBe('postgresql://project');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('forced-mode 非 __personal__ namespace（legacy 用法）: 無 personal URL → 用 DATABASE_URL', async () => {
    setEnv({
      DATABASE_URL: 'postgresql://project',
      DATABASE_URL_PERSONAL: undefined,
      CC_FORCE_PROJECT_ID: 'some-other-project',
    });
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.databaseUrl).toBe('postgresql://project');
  });

  it('trim 空白：DATABASE_URL_PERSONAL=" " 視為未設（不觸發 warn / 不滿足 forced 必填）', async () => {
    setEnv({
      DATABASE_URL: 'postgresql://project',
      DATABASE_URL_PERSONAL: '   ',
      CC_FORCE_PROJECT_ID: '__personal__',
    });
    vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow(/DATABASE_URL_PERSONAL/);
  });
});
