// tests/scripts/evidence-guards.test.ts
//
// 檢索證據評測的安全檢查：輸出路徑、向量端點、錯誤訊息遮蔽。內容全為虛構。

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeLocalEndpoint,
  findProtectedRoot,
  isLoopbackHostname,
  isPathInside,
  mainWorktreeFromCommonDir,
  parseWorktreeList,
  realpathNearestExisting,
  safeErrorLabel,
} from '../../scripts/lib/evidence-guards.js';

describe('isPathInside', () => {
  it('repo 本身與子目錄算在裡面，含 `..bench` 這種以兩點開頭的名字', () => {
    expect(isPathInside('/repo', '/repo')).toBe(true);
    expect(isPathInside('/repo/out/run1', '/repo')).toBe(true);
    expect(isPathInside('/repo/..bench', '/repo')).toBe(true);
    expect(isPathInside('/repo/..bench/run', '/repo')).toBe(true);
  });
  it('repo 外、名字相近的兄弟目錄不算', () => {
    expect(isPathInside('/repo-other/out', '/repo')).toBe(false);
    expect(isPathInside('/home/u/.cache/runs', '/repo')).toBe(false);
    expect(isPathInside('/', '/repo')).toBe(false);
  });
});

describe('findProtectedRoot（符號連結與尚未存在的路徑）', () => {
  let base = '';
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'evb-guard-'));
    await mkdir(join(base, 'repo', 'sub'), { recursive: true });
    await mkdir(join(base, 'outside'), { recursive: true });
    await symlink(join(base, 'repo', 'sub'), join(base, 'outside', 'link-into-repo'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('repo 外的符號連結指回 repo 內要擋（含底下還不存在的目錄）', async () => {
    const out = join(base, 'outside', 'link-into-repo', 'not-yet', 'run1');
    expect(await realpathNearestExisting(out)).toBe(join(base, 'repo', 'sub', 'not-yet', 'run1'));
    expect(await findProtectedRoot(out, [join(base, 'repo')])).toBe(join(base, 'repo'));
  });
  it('真的在 repo 外就放行；多個 root 任一命中就擋', async () => {
    expect(await findProtectedRoot(join(base, 'outside', 'runs'), [join(base, 'repo')])).toBeNull();
    expect(await findProtectedRoot(join(base, 'outside', 'runs'), [join(base, 'repo'), join(base, 'outside')])).toBe(
      join(base, 'outside')
    );
  });
});

describe('git 輸出解析', () => {
  it('--git-common-dir：相對路徑以 cwd 解析；.git 結尾取上層', () => {
    expect(mainWorktreeFromCommonDir('/main/repo/.git', '/wt/a')).toBe('/main/repo');
    expect(mainWorktreeFromCommonDir('.git', '/main/repo')).toBe('/main/repo');
    expect(mainWorktreeFromCommonDir('/srv/bare.git', '/wt/a')).toBe('/srv/bare.git');
  });
  it('worktree list --porcelain', () => {
    const porcelain = 'worktree /main/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/a b\nHEAD def\ndetached\n';
    expect(parseWorktreeList(porcelain)).toEqual(['/main/repo', '/wt/a b']);
  });
});

describe('向量端點是否本機', () => {
  it('只有 loopback 算本機', () => {
    for (const host of ['127.0.0.1', '127.8.9.10', 'localhost', 'LOCALHOST', 'localhost.', '[::1]', '::1']) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
    for (const host of ['example.invalid', '10.0.0.1', '128.0.0.1', '127.0.0.1.example.com', '[::2]', '0.0.0.0', '']) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
  it('describeLocalEndpoint：只回主機與連接埠，不帶帳密與路徑', () => {
    expect(describeLocalEndpoint('http://user:pw@127.0.0.1:8790/x')).toEqual({ host: '127.0.0.1:8790', loopback: true });
    expect(describeLocalEndpoint('http://example.invalid:8790')).toEqual({ host: 'example.invalid:8790', loopback: false });
    expect(describeLocalEndpoint('http://[::1]:8790')).toEqual({ host: '[::1]:8790', loopback: true });
    expect(describeLocalEndpoint('not a url')).toEqual({ host: '(無法解析)', loopback: false });
  });
});

describe('safeErrorLabel', () => {
  it('不轉存 message，只留類別與沿 cause 找到的 PostgreSQL 錯誤碼', () => {
    const pgError = Object.assign(new Error('relation x where secret=param'), { name: 'PostgresError', code: '42P01' });
    const wrapped = new Error('Failed query: select ... params: secret-value', { cause: pgError });
    wrapped.name = 'DrizzleQueryError';
    const label = safeErrorLabel(wrapped);
    expect(label).toBe('DrizzleQueryError (code=42P01)');
    expect(label).not.toContain('secret');
  });
  it('Node 系統錯誤碼照印，其他格式的 code 不印；奇怪的 name 換成 Error', () => {
    expect(safeErrorLabel(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('Error (code=ECONNREFUSED)');
    expect(safeErrorLabel(Object.assign(new Error('x'), { code: 'secret value' }))).toBe('Error');
    const weird = new Error('x');
    weird.name = 'name with secret text';
    expect(safeErrorLabel(weird)).toBe('Error');
    expect(safeErrorLabel('plain string')).toBe('string');
  });
});
