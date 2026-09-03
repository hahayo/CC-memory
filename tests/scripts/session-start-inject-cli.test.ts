// tests/scripts/session-start-inject-cli.test.ts
//
// hooks/session-start-inject.sh 的 shell seam（殼層邊界）契約。
// 隔離：fake PATH 放假 systemctl（不碰真 user service）與假 npx（把收到的 argv / env / stdin
// dump 到檔案，證明「有接線」而不是只驗空 stdout）；HOME 指到臨時目錄；cwd 指到臨時 git repo。
//
// 2026-09-03 inject-fix 鎖住：
//   - flag off / unset / 遞迴斷路器 → 不 spawn npx；
//   - flag on + repo 子目錄 + 0600 URL 檔 → 子程序 DATABASE_URL 等於 URL 檔內容（trim 後），
//     CC_FORCE_PROJECT_ID / DATABASE_URL_PERSONAL / CC_MEMORY_PROJECT_ID 三者不在子程序環境，
//     payload 原樣 pipe 給 Node；
//   - URL 檔 symlink / 0644 / 目錄 / 空檔 / 不存在 → 不 spawn npx；
//   - 非 git 且無 marker 的目錄、壞 JSON、缺 cwd → 不 spawn npx；
//   - 真 npx + 連不上的 DSN → 空 stdout、exit 0（best-effort e2e，不連真 DB）。
// （測試 DSN 刻意不帶帳密段，避免 secret-scan hook 誤判。）

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK_PATH = join(process.cwd(), 'hooks', 'session-start-inject.sh');
const FILE_URL = 'postgres://127.0.0.1:15432/cc_memory';
const UNREACHABLE_URL = 'postgres://127.0.0.1:1/cc_memory';

let testRoot: string;
let fakeBin: string;
let homeDir: string;
let repoDir: string;
let repoSubdir: string;
let plainDir: string;
let systemctlLog: string;
let npxLog: string;
let npxEnvDump: string;
let npxStdinDump: string;

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeUrlFile(content: string, mode = 0o600): string {
  const file = join(homeDir, '.ccm-project-url');
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cc-memory-inject-cli-'));
  fakeBin = join(testRoot, 'bin');
  homeDir = join(testRoot, 'home');
  repoDir = join(testRoot, 'work', 'demo-repo');
  repoSubdir = join(repoDir, 'src', 'deep');
  plainDir = join(testRoot, 'work', 'CC-memory');
  systemctlLog = join(testRoot, 'systemctl.log');
  npxLog = join(testRoot, 'npx.log');
  npxEnvDump = join(testRoot, 'npx.env');
  npxStdinDump = join(testRoot, 'npx.stdin');

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(repoDir, '.git'), { recursive: true });
  writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(repoSubdir, { recursive: true });
  mkdirSync(plainDir, { recursive: true });

  writeExecutable(join(fakeBin, 'systemctl'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >>"$CC_MEMORY_SYSTEMCTL_LOG"',
    'exit 0',
  ]);
  writeExecutable(join(fakeBin, 'npx'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >>"$CC_MEMORY_FAKE_NPX_LOG"',
    'env -0 >"$CC_MEMORY_FAKE_NPX_ENV"',
    'cat >"$CC_MEMORY_FAKE_NPX_STDIN"',
    'exit 0',
  ]);
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

interface ShellRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(
  input: string,
  overrides: Record<string, string | undefined> = {},
  options: { realNpx?: boolean } = {}
): ShellRun {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: homeDir,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    CC_MEMORY_SYSTEMCTL_LOG: systemctlLog,
    CC_MEMORY_FAKE_NPX_LOG: npxLog,
    CC_MEMORY_FAKE_NPX_ENV: npxEnvDump,
    CC_MEMORY_FAKE_NPX_STDIN: npxStdinDump,
  };
  if (options.realNpx) {
    // 只留假 systemctl；把假 npx 拿掉讓真 npx tsx 跑。
    rmSync(join(fakeBin, 'npx'), { force: true });
  }
  // 清乾淨受控旗標與會被殼層清洗的變數，再依 overrides 設定，避免 ambient shell 干擾。
  delete env.CC_MEMORY_INJECT_RECENT;
  delete env.CC_MEMORY_CAPTURE_CHILD;
  delete env.CC_FORCE_PROJECT_ID;
  delete env.DATABASE_URL_PERSONAL;
  delete env.CC_MEMORY_PROJECT_ID;
  delete env.DATABASE_URL;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const inputPath = join(testRoot, 'hook-input.json');
  writeFileSync(inputPath, input);
  const inputFd = openSync(inputPath, 'r');
  try {
    const result = spawnSync('bash', [HOOK_PATH], {
      env,
      encoding: 'utf8',
      stdio: [inputFd, 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    closeSync(inputFd);
  }
}

function payloadFor(cwd: string): string {
  return JSON.stringify({ cwd, session_id: 'session-1', hook_event_name: 'SessionStart' });
}

function readNpxEnv(): Map<string, string> {
  const raw = readFileSync(npxEnvDump, 'utf8');
  const map = new Map<string, string>();
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const idx = entry.indexOf('=');
    map.set(entry.slice(0, idx), entry.slice(idx + 1));
  }
  return map;
}

function expectQuietNoNpx(run: ShellRun): void {
  expect(run.status).toBe(0);
  expect(run.stdout).toBe('');
  expect(existsSync(npxLog)).toBe(false);
}

describe('session-start-inject hook wrapper (shell seam)', () => {
  it('kicks backlog but does not spawn npx when CC_MEMORY_INJECT_RECENT is unset', () => {
    writeUrlFile(`${FILE_URL}\n`);
    const run = runHook(payloadFor(repoSubdir), {});
    expectQuietNoNpx(run);
    expect(readFileSync(systemctlLog, 'utf8').trim()).toBe(
      '--user start --no-block cc-memory-auto-capture.service'
    );
  });

  it('does not spawn npx when CC_MEMORY_INJECT_RECENT=off', () => {
    writeUrlFile(`${FILE_URL}\n`);
    expectQuietNoNpx(runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'off' }));
  });

  it('recursion breaker precedes flag: neither kick nor npx when CC_MEMORY_CAPTURE_CHILD=1', () => {
    writeUrlFile(`${FILE_URL}\n`);
    const run = runHook(payloadFor(repoSubdir), {
      CC_MEMORY_CAPTURE_CHILD: '1',
      CC_MEMORY_INJECT_RECENT: 'on',
    });
    expectQuietNoNpx(run);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it('overrides DATABASE_URL from ~/.ccm-project-url and scrubs personal/env overrides before spawning Node', () => {
    writeUrlFile(`  ${FILE_URL}\n\n`);
    const payload = payloadFor(repoSubdir);
    const run = runHook(payload, {
      CC_MEMORY_INJECT_RECENT: 'on',
      DATABASE_URL: UNREACHABLE_URL,
      CC_FORCE_PROJECT_ID: '__personal__',
      DATABASE_URL_PERSONAL: UNREACHABLE_URL,
      CC_MEMORY_PROJECT_ID: 'wrong-project',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(readFileSync(npxLog, 'utf8').trim()).toBe('tsx scripts/run-session-start-inject.ts');

    const childEnv = readNpxEnv();
    expect(childEnv.get('DATABASE_URL')).toBe(FILE_URL);
    expect(childEnv.has('CC_FORCE_PROJECT_ID')).toBe(false);
    expect(childEnv.has('DATABASE_URL_PERSONAL')).toBe(false);
    expect(childEnv.has('CC_MEMORY_PROJECT_ID')).toBe(false);
    expect(childEnv.get('CC_MEMORY_INJECT_RECENT')).toBe('on');
    expect(readFileSync(npxStdinDump, 'utf8')).toBe(payload);
  });

  it('accepts a worktree-style .git pointer file as a repo', () => {
    writeUrlFile(FILE_URL);
    const wt = join(testRoot, 'work', 'wt');
    mkdirSync(join(wt, 'pkg'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');
    const run = runHook(payloadFor(join(wt, 'pkg')), { CC_MEMORY_INJECT_RECENT: 'on' });
    expect(run.status).toBe(0);
    expect(existsSync(npxLog)).toBe(true);
  });

  it('does not spawn npx when cwd is not inside a git repo (basename collision guard)', () => {
    writeUrlFile(FILE_URL);
    expectQuietNoNpx(runHook(payloadFor(plainDir), { CC_MEMORY_INJECT_RECENT: 'on' }));
  });

  it('does not spawn npx when payload is malformed JSON or lacks cwd', () => {
    writeUrlFile(FILE_URL);
    expectQuietNoNpx(runHook('not json at all', { CC_MEMORY_INJECT_RECENT: 'on' }));
    expectQuietNoNpx(runHook('{"session_id":"s"}', { CC_MEMORY_INJECT_RECENT: 'on' }));
    expectQuietNoNpx(runHook('{"cwd":""}', { CC_MEMORY_INJECT_RECENT: 'on' }));
  });

  it('does not spawn npx when ~/.ccm-project-url is missing', () => {
    expectQuietNoNpx(runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'on' }));
  });

  it('does not spawn npx when ~/.ccm-project-url is a symlink', () => {
    const target = join(homeDir, 'real-url');
    writeFileSync(target, FILE_URL, { mode: 0o600 });
    symlinkSync(target, join(homeDir, '.ccm-project-url'));
    expectQuietNoNpx(runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'on' }));
  });

  it('does not spawn npx when ~/.ccm-project-url is mode 0644', () => {
    writeUrlFile(FILE_URL, 0o644);
    expectQuietNoNpx(runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'on' }));
  });

  it('does not spawn npx when ~/.ccm-project-url is a directory', () => {
    mkdirSync(join(homeDir, '.ccm-project-url'), { mode: 0o600 });
    expectQuietNoNpx(runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'on' }));
  });

  it('does not spawn npx when ~/.ccm-project-url is empty or whitespace-only', () => {
    writeUrlFile('');
    expectQuietNoNpx(runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'on' }));
    writeUrlFile(' \n\n');
    expectQuietNoNpx(runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'on' }));
  });

  it('real npx + unreachable DSN stays best-effort: empty stdout, exit 0 (no real DB)', () => {
    writeUrlFile(UNREACHABLE_URL);
    const run = runHook(payloadFor(repoSubdir), { CC_MEMORY_INJECT_RECENT: 'on' }, { realNpx: true });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  }, 60_000);
});
