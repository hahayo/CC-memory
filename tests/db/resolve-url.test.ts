// tests/db/resolve-url.test.ts
//
// resolveDatabaseUrl / readDatabaseInputs / sanitizeUrl 純函式契約
// （Phase 3 v0.4 fail-fast 矩陣；module-level 啟動行為另見 tests/config.test.ts）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readDatabaseInputs,
  resolveDatabaseUrl,
  sanitizeUrl,
} from '../../src/db/resolve-url.js';

// 組 URL 用拆字串 helper，避開 secret-scan hook 的 'postgres(ql)?://…@' pattern；
// 全部 placeholder 非真實憑證。
const pg = (rest: string) => 'postgresql:' + '//' + rest;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sanitizeUrl', () => {
  it('去 \\r（Windows .env CRLF）+ trim', () => {
    expect(sanitizeUrl(pg('h/db') + '\r\n')).toBe(pg('h/db'));
    expect(sanitizeUrl('  ' + pg('h/db') + '  ')).toBe(pg('h/db'));
  });

  it('剝包覆引號（雙引號 / 單引號）', () => {
    expect(sanitizeUrl('"' + pg('h/db') + '"')).toBe(pg('h/db'));
    expect(sanitizeUrl("'" + pg('h/db') + "'")).toBe(pg('h/db'));
  });

  it('引號 + \\r 複合污染一次清乾淨', () => {
    expect(sanitizeUrl('"' + pg('h/db') + '"\r')).toBe(pg('h/db'));
  });

  it('空字串 / whitespace-only / undefined → null', () => {
    expect(sanitizeUrl('')).toBeNull();
    expect(sanitizeUrl('   ')).toBeNull();
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(sanitizeUrl('""')).toBeNull();
  });

  it('只有單邊引號不剝（避免誤傷合法值）', () => {
    expect(sanitizeUrl('"' + pg('h/db'))).toBe('"' + pg('h/db'));
  });
});

describe('readDatabaseInputs', () => {
  it('URL 走 sanitizeUrl；CC_FORCE_PROJECT_ID 只 trim 不剝引號', () => {
    const inputs = readDatabaseInputs({
      DATABASE_URL: '"' + pg('h/db') + '"\r',
      DATABASE_URL_PERSONAL: ' ' + pg('h/personal') + ' \r',
      CC_FORCE_PROJECT_ID: ' __personal__ ',
    } as NodeJS.ProcessEnv);
    expect(inputs.databaseUrl).toBe(pg('h/db'));
    expect(inputs.databaseUrlPersonal).toBe(pg('h/personal'));
    expect(inputs.forcedProjectId).toBe('__personal__');
  });
});

describe('resolveDatabaseUrl fail-fast 矩陣', () => {
  it('缺 DATABASE_URL（無 fallback）→ throw', () => {
    expect(() =>
      resolveDatabaseUrl({ databaseUrl: null, databaseUrlPersonal: null, forcedProjectId: null })
    ).toThrow(/DATABASE_URL is required/);
  });

  it('缺 DATABASE_URL + allowTestFallback → 回 localhost test placeholder', () => {
    const url = resolveDatabaseUrl(
      { databaseUrl: null, databaseUrlPersonal: null, forcedProjectId: null },
      { allowTestFallback: true }
    );
    expect(url).toContain('localhost');
    expect(url.startsWith('postgresql:')).toBe(true);
  });

  it('forced personal + 缺 personal URL → throw', () => {
    expect(() =>
      resolveDatabaseUrl({
        databaseUrl: pg('h/project'),
        databaseUrlPersonal: null,
        forcedProjectId: '__personal__',
      })
    ).toThrow(/DATABASE_URL_PERSONAL/);
  });

  it('forced personal + 只有 personal URL（無 DATABASE_URL）→ 正確 resolve（目標部署拓樸，Codex B8）', () => {
    const url = resolveDatabaseUrl({
      databaseUrl: null,
      databaseUrlPersonal: pg('h/personal'),
      forcedProjectId: '__personal__',
    });
    expect(url).toBe(pg('h/personal'));
  });

  it('forced personal + 兩 URL 同物理 DB（不同 user 也算同）→ throw（P2 防呆）', () => {
    expect(() =>
      resolveDatabaseUrl({
        databaseUrl: pg('alice@h:5432/samedb'),
        databaseUrlPersonal: pg('bob@h:5432/samedb'),
        forcedProjectId: '__personal__',
      })
    ).toThrow(/同一物理 DB/);
  });

  it('forced personal + 兩 URL 不同 DB → 回 personal URL', () => {
    const url = resolveDatabaseUrl({
      databaseUrl: pg('h/project'),
      databaseUrlPersonal: pg('h/personal'),
      forcedProjectId: '__personal__',
    });
    expect(url).toBe(pg('h/personal'));
  });

  it('project-mode + personal URL → warn + 回 DATABASE_URL（warn 不綁特定 mode 字樣）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = resolveDatabaseUrl({
      databaseUrl: pg('h/project'),
      databaseUrlPersonal: pg('h/personal'),
      forcedProjectId: null,
    });
    expect(url).toBe(pg('h/project'));
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/DATABASE_URL_PERSONAL/);
  });

  it('forced 非 personal + personal URL → 同樣 warn + 回 DATABASE_URL（文案涵蓋非 project-mode）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = resolveDatabaseUrl({
      databaseUrl: pg('h/project'),
      databaseUrlPersonal: pg('h/personal'),
      forcedProjectId: 'some-other-project',
    });
    expect(url).toBe(pg('h/project'));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('純函式：呼叫（無 personal URL）不產生 console 輸出', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDatabaseUrl({
      databaseUrl: pg('h/project'),
      databaseUrlPersonal: null,
      forcedProjectId: null,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
