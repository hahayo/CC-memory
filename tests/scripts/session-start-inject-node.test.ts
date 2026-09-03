// tests/scripts/session-start-inject-node.test.ts
//
// 2026-09-03 inject-fix — runSessionStartInject 的 Node seam（依賴注入邊界）。
// 證明「有接線」而不是只驗空 stdout：
//   - payload 的 cwd 以 { cwd, cwdIsExplicit: true } 餵給 resolver；
//   - resolver 命中 cwd-basename（非 git、無 marker）→ 不讀 URL 檔、不開 DB、不輸出；
//   - DSN 只來自 readProjectUrl（~/.ccm-project-url），不看 env.DATABASE_URL；
//   - URL 檔讀失敗 → 不開 DB（錯誤往上丟，由 main 的 best-effort catch 吞）；
//   - flag off / 遞迴斷路器 → 連 payload 都不讀。
// readSecureProjectUrl：0600 → trim 後內容；空檔 / 0644 / symlink → throw。
// （測試 DSN 刻意不帶帳密段，避免 secret-scan hook 誤判。）

import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isInjectableProjectSource,
  readSecureProjectUrl,
  runSessionStartInject,
  type InjectDeps,
} from '../../scripts/run-session-start-inject.js';
import type { RecentActivityResult } from '../../src/services/recent-activity.js';
import type { DbClient } from '../../src/services/types.js';

const REAL_URL = 'postgres://127.0.0.1:15432/cc_memory';
const STALE_URL = 'postgres://127.0.0.1:1/stale';

function makeResult(projectId: string): RecentActivityResult {
  return {
    source: 'cc-memory-inject',
    projectId,
    rows: [
      {
        id: 'mem-1',
        updatedAt: '2026-09-03T00:00:00.000Z',
        summaryExcerpt: 'recent work',
        observationIds: ['obs-1'],
        observationCount: 1,
        discoveryTokens: 10,
      },
    ],
  };
}

interface Harness {
  deps: Partial<InjectDeps>;
  resolveProject: ReturnType<typeof vi.fn>;
  readProjectUrl: ReturnType<typeof vi.fn>;
  openDb: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  fetchRecentActivity: ReturnType<typeof vi.fn>;
  output: string[];
}

function makeHarness(overrides: Partial<InjectDeps> = {}): Harness {
  const output: string[] = [];
  const end = vi.fn(async () => undefined);
  const fakeDb = { __fake: true } as unknown as DbClient;
  const resolveProject = vi.fn(() => ({ projectId: 'demo-repo', source: 'git-root' as const }));
  const readProjectUrl = vi.fn(async () => REAL_URL);
  const openDb = vi.fn(async () => ({ db: fakeDb, end }));
  const fetchRecentActivity = vi.fn(async (_db: DbClient, input: { projectId: string }) =>
    makeResult(input.projectId)
  );
  const deps: Partial<InjectDeps> = {
    env: { CC_MEMORY_INJECT_RECENT: 'on', DATABASE_URL: STALE_URL },
    readPayload: async () => JSON.stringify({ cwd: '/work/demo-repo/src/deep' }),
    resolveProject,
    readProjectUrl,
    openDb,
    fetchRecentActivity,
    writeOutput: (line) => {
      output.push(line);
    },
    ...overrides,
  };
  return { deps, resolveProject, readProjectUrl, openDb, end, fetchRecentActivity, output };
}

describe('runSessionStartInject (Node seam)', () => {
  it('feeds the payload cwd to the resolver with cwdIsExplicit:true and injects for git-root', async () => {
    const h = makeHarness();
    await runSessionStartInject(h.deps);

    expect(h.resolveProject).toHaveBeenCalledTimes(1);
    expect(h.resolveProject).toHaveBeenCalledWith({ cwd: '/work/demo-repo/src/deep', cwdIsExplicit: true });
    expect(h.fetchRecentActivity).toHaveBeenCalledTimes(1);
    expect(h.fetchRecentActivity.mock.calls[0][1]).toMatchObject({ projectId: 'demo-repo' });
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.output).toHaveLength(1);
    const parsed = JSON.parse(h.output[0]) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain('project=demo-repo');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('source=cc-memory-inject');
  });

  it('uses the DSN from readProjectUrl, never env.DATABASE_URL', async () => {
    const h = makeHarness();
    await runSessionStartInject(h.deps);

    expect(h.readProjectUrl).toHaveBeenCalledTimes(1);
    expect(h.openDb).toHaveBeenCalledTimes(1);
    expect(h.openDb).toHaveBeenCalledWith(REAL_URL);
    expect(h.openDb).not.toHaveBeenCalledWith(STALE_URL);
  });

  it('injects when the resolver hits a CLAUDE.md marker', async () => {
    const h = makeHarness({
      resolveProject: () => ({ projectId: 'marked-project', source: 'marker' }),
    });
    await runSessionStartInject(h.deps);
    expect(h.openDb).toHaveBeenCalledTimes(1);
    expect(h.output[0]).toContain('project=marked-project');
  });

  it('does not read the URL file, open the DB, or emit anything when the cwd is not inside a repo (cwd-basename)', async () => {
    const h = makeHarness({
      resolveProject: () => ({ projectId: 'CC-memory', source: 'cwd-basename' }),
    });
    await runSessionStartInject(h.deps);

    expect(h.readProjectUrl).not.toHaveBeenCalled();
    expect(h.openDb).not.toHaveBeenCalled();
    expect(h.fetchRecentActivity).not.toHaveBeenCalled();
    expect(h.output).toEqual([]);
  });

  it('does not open the DB when the URL file cannot be read securely', async () => {
    const h = makeHarness({
      readProjectUrl: async () => {
        throw new Error('project database url file must have mode 0600 (actual: 0644)');
      },
    });
    await expect(runSessionStartInject(h.deps)).rejects.toThrow(/0600/);
    expect(h.openDb).not.toHaveBeenCalled();
    expect(h.output).toEqual([]);
  });

  it('closes the DB handle even when the builder throws', async () => {
    const h = makeHarness({
      fetchRecentActivity: async () => {
        throw new Error('boom');
      },
    });
    await expect(runSessionStartInject(h.deps)).rejects.toThrow(/boom/);
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.output).toEqual([]);
  });

  it('emits nothing when the builder returns no rows', async () => {
    const h = makeHarness({
      fetchRecentActivity: async () => ({ source: 'cc-memory-inject', projectId: 'demo-repo', rows: [] }),
    });
    await runSessionStartInject(h.deps);
    expect(h.output).toEqual([]);
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it('does not even read the payload when the flag is off', async () => {
    const readPayload = vi.fn(async () => JSON.stringify({ cwd: '/work/demo-repo' }));
    const h = makeHarness({ env: { CC_MEMORY_INJECT_RECENT: 'off' }, readPayload });
    await runSessionStartInject(h.deps);
    expect(readPayload).not.toHaveBeenCalled();
    expect(h.resolveProject).not.toHaveBeenCalled();
    expect(h.openDb).not.toHaveBeenCalled();
  });

  it('does not even read the payload when CC_MEMORY_CAPTURE_CHILD is set', async () => {
    const readPayload = vi.fn(async () => JSON.stringify({ cwd: '/work/demo-repo' }));
    const h = makeHarness({
      env: { CC_MEMORY_INJECT_RECENT: 'on', CC_MEMORY_CAPTURE_CHILD: '1' },
      readPayload,
    });
    await runSessionStartInject(h.deps);
    expect(readPayload).not.toHaveBeenCalled();
    expect(h.openDb).not.toHaveBeenCalled();
  });

  it('returns quietly on malformed payload or missing cwd without touching the resolver', async () => {
    for (const payload of ['not json', '{}', '{"cwd":""}', '{"cwd":12}']) {
      const h = makeHarness({ readPayload: async () => payload });
      await runSessionStartInject(h.deps);
      expect(h.resolveProject).not.toHaveBeenCalled();
      expect(h.openDb).not.toHaveBeenCalled();
    }
  });
});

describe('isInjectableProjectSource', () => {
  it('accepts only marker and git-root', () => {
    expect(isInjectableProjectSource({ projectId: 'x', source: 'marker' })).toBe(true);
    expect(isInjectableProjectSource({ projectId: 'x', source: 'git-root' })).toBe(true);
    expect(isInjectableProjectSource({ projectId: 'x', source: 'cwd-basename' })).toBe(false);
    expect(isInjectableProjectSource({ projectId: 'x', source: 'env' })).toBe(false);
    expect(isInjectableProjectSource({ projectId: 'x', source: 'explicit' })).toBe(false);
  });
});

describe('readSecureProjectUrl', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-memory-inject-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the trimmed content of a 0600 ~/.ccm-project-url', async () => {
    writeFileSync(join(home, '.ccm-project-url'), `  ${REAL_URL}\n`, { mode: 0o600 });
    await expect(readSecureProjectUrl(home)).resolves.toBe(REAL_URL);
  });

  it('rejects an empty or whitespace-only file', async () => {
    writeFileSync(join(home, '.ccm-project-url'), ' \n', { mode: 0o600 });
    await expect(readSecureProjectUrl(home)).rejects.toThrow(/empty/);
  });

  it('rejects mode 0644', async () => {
    const file = join(home, '.ccm-project-url');
    writeFileSync(file, REAL_URL, { mode: 0o600 });
    chmodSync(file, 0o644);
    await expect(readSecureProjectUrl(home)).rejects.toThrow(/0600/);
  });

  it('rejects a symlink', async () => {
    const target = join(home, 'real-url');
    writeFileSync(target, REAL_URL, { mode: 0o600 });
    symlinkSync(target, join(home, '.ccm-project-url'));
    await expect(readSecureProjectUrl(home)).rejects.toThrow(/regular file/);
  });

  it('rejects a missing file', async () => {
    await expect(readSecureProjectUrl(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
