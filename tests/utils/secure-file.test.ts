// tests/utils/secure-file.test.ts
//
// readSecureMode0600RegularFile：憑證檔安全讀法（supervisor 與 SessionStart injector 共用）。
// 鎖住：0600 一般檔 → 原文（不 trim）；0644 → 拒；symlink → 拒（ELOOP，不跟隨）；
// 目錄 → 拒；不存在 → ENOENT 原樣往上丟。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSecureMode0600RegularFile } from '../../src/utils/secure-file.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-memory-secure-file-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readSecureMode0600RegularFile', () => {
  it('returns the raw content of a mode-0600 regular file', async () => {
    const file = join(root, 'secret');
    writeFileSync(file, '  postgres://127.0.0.1:15432/db\n', { mode: 0o600 });
    await expect(readSecureMode0600RegularFile(file, 'secret')).resolves.toBe(
      '  postgres://127.0.0.1:15432/db\n'
    );
  });

  it('rejects a file whose mode is not exactly 0600', async () => {
    const file = join(root, 'secret');
    writeFileSync(file, 'x', { mode: 0o600 });
    chmodSync(file, 0o644);
    await expect(readSecureMode0600RegularFile(file, 'secret')).rejects.toThrow(/0600/);
    chmodSync(file, 0o400);
    await expect(readSecureMode0600RegularFile(file, 'secret')).rejects.toThrow(/0600/);
  });

  it('rejects a symlink even when its target is a valid 0600 file', async () => {
    const target = join(root, 'target');
    const link = join(root, 'link');
    writeFileSync(target, 'x', { mode: 0o600 });
    symlinkSync(target, link);
    await expect(readSecureMode0600RegularFile(link, 'secret')).rejects.toThrow(/regular file/);
  });

  it('rejects a directory', async () => {
    const dir = join(root, 'dir');
    mkdirSync(dir, { mode: 0o600 });
    await expect(readSecureMode0600RegularFile(dir, 'secret')).rejects.toThrow();
  });

  it('propagates ENOENT for a missing file', async () => {
    await expect(readSecureMode0600RegularFile(join(root, 'missing'), 'secret')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
