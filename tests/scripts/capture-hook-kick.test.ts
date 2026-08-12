import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const POST_TOOL_USE_HOOK = join(REPO_ROOT, 'hooks', 'post-tool-use-capture.sh');
const STOP_HOOK = join(REPO_ROOT, 'hooks', 'stop-capture-sentinel.sh');
const SESSION_START_HOOK = join(REPO_ROOT, 'hooks', 'session-start-inject.sh');

let testRoot: string;
let fakeBin: string;
let systemctlLog: string;
let spoolRoot: string;
let homeDir: string;

function resetFixture(): void {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(spoolRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const fakeSystemctl = join(fakeBin, 'systemctl');
  writeFileSync(
    fakeSystemctl,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >>"$CC_MEMORY_SYSTEMCTL_LOG"',
      'if [[ -n "${CC_MEMORY_EXPECT_SPOOL:-}" ]]; then',
      '  if [[ -s "$CC_MEMORY_EXPECT_SPOOL" ]]; then',
      '    printf "sentinel=present\\n" >>"$CC_MEMORY_SYSTEMCTL_LOG"',
      '  else',
      '    printf "sentinel=missing\\n" >>"$CC_MEMORY_SYSTEMCTL_LOG"',
      '  fi',
      'fi',
      'exit "${CC_MEMORY_SYSTEMCTL_EXIT:-0}"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(fakeSystemctl, 0o755);
}

function runHook(
  hookPath: string,
  payload: Record<string, unknown>,
  overrides: Record<string, string | undefined> = {},
): ReturnType<typeof spawnSync> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: homeDir,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    CC_MEMORY_SPOOL_DIR: spoolRoot,
    CC_MEMORY_SYSTEMCTL_LOG: systemctlLog,
  };
  delete env.CC_MEMORY_CAPTURE_CHILD;
  delete env.CC_MEMORY_INJECT_RECENT;
  delete env.CC_MEMORY_EXPECT_SPOOL;
  delete env.CC_MEMORY_SYSTEMCTL_EXIT;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const inputPath = join(testRoot, 'hook-input.json');
  writeFileSync(inputPath, JSON.stringify(payload));
  const inputFd = openSync(inputPath, 'r');
  try {
    return spawnSync('bash', [hookPath], {
      env,
      encoding: 'utf8',
      stdio: [inputFd, 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } finally {
    closeSync(inputFd);
  }
}

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cc-memory-hook-kick-'));
  fakeBin = join(testRoot, 'bin');
  systemctlLog = join(testRoot, 'systemctl.log');
  spoolRoot = join(testRoot, 'spool');
  homeDir = join(testRoot, 'home');
});

afterEach(() => {
  resetFixture();
});

describe('capture hooks kick the systemd oneshot service', () => {
  it('Stop writes its sentinel before starting the service without blocking', () => {
    resetFixture();
    const transcriptPath = join(testRoot, 'transcript.jsonl');
    writeFileSync(transcriptPath, '{"event":"done"}\n');
    const expectedSpool = join(spoolRoot, 'demo-project', 'session-stop.jsonl');

    const result = runHook(
      STOP_HOOK,
      {
        cwd: '/work/demo-project',
        session_id: 'session-stop',
        transcript_path: transcriptPath,
      },
      { CC_MEMORY_EXPECT_SPOOL: expectedSpool },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(expectedSpool, 'utf8')).toContain('"hwm_offset":17');
    expect(readFileSync(systemctlLog, 'utf8').trim().split('\n')).toEqual([
      '--user start --no-block cc-memory-auto-capture.service',
      'sentinel=present',
    ]);
  });

  it('Stop ignores events without a transcript path and does not kick the worker', () => {
    resetFixture();
    const unexpectedSpool = join(spoolRoot, 'demo-project', 'session-stop-no-transcript.jsonl');

    const result = runHook(STOP_HOOK, {
      cwd: '/work/demo-project',
      session_id: 'session-stop-no-transcript',
    });

    expect(result.status).toBe(0);
    expect(existsSync(unexpectedSpool)).toBe(false);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it('Stop ignores a JSON null transcript path and does not kick the worker', () => {
    resetFixture();
    const unexpectedSpool = join(spoolRoot, 'demo-project', 'session-stop-null-transcript.jsonl');

    const result = runHook(STOP_HOOK, {
      cwd: '/work/demo-project',
      session_id: 'session-stop-null-transcript',
      transcript_path: null,
    });

    expect(result.status).toBe(0);
    expect(existsSync(unexpectedSpool)).toBe(false);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it('SessionStart kicks backlog even when recent-activity injection is disabled', () => {
    resetFixture();

    const result = runHook(SESSION_START_HOOK, { cwd: '/work/demo-project' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(systemctlLog, 'utf8').trim()).toBe(
      '--user start --no-block cc-memory-auto-capture.service',
    );
  });

  it('recursion breaker prevents SessionStart from kicking or injecting', () => {
    resetFixture();

    const result = runHook(
      SESSION_START_HOOK,
      { cwd: '/work/demo-project' },
      {
        CC_MEMORY_CAPTURE_CHILD: '1',
        CC_MEMORY_INJECT_RECENT: 'on',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it('PostToolUse remains append-only and never kicks systemd', () => {
    resetFixture();
    const transcriptPath = join(testRoot, 'transcript.jsonl');
    writeFileSync(transcriptPath, '{"event":"tool"}\n');

    const result = runHook(POST_TOOL_USE_HOOK, {
      cwd: '/work/demo-project',
      session_id: 'session-tool',
      tool_name: 'Bash',
      transcript_path: transcriptPath,
    });

    expect(result.status).toBe(0);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it('PostToolUse ignores events without a transcript path', () => {
    resetFixture();
    const unexpectedSpool = join(spoolRoot, 'demo-project', 'session-no-transcript.jsonl');

    const result = runHook(POST_TOOL_USE_HOOK, {
      cwd: '/work/demo-project',
      session_id: 'session-no-transcript',
      tool_name: 'Bash',
    });

    expect(result.status).toBe(0);
    expect(existsSync(unexpectedSpool)).toBe(false);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it('PostToolUse ignores a JSON null transcript path', () => {
    resetFixture();
    const unexpectedSpool = join(spoolRoot, 'demo-project', 'session-null-transcript.jsonl');

    const result = runHook(POST_TOOL_USE_HOOK, {
      cwd: '/work/demo-project',
      session_id: 'session-null-transcript',
      tool_name: 'Bash',
      transcript_path: null,
    });

    expect(result.status).toBe(0);
    expect(existsSync(unexpectedSpool)).toBe(false);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it.each([
    ['PostToolUse missing', POST_TOOL_USE_HOOK, { tool_name: 'Bash' }, {}],
    ['Stop missing', STOP_HOOK, {}, {}],
    ['PostToolUse null', POST_TOOL_USE_HOOK, { tool_name: 'Bash' }, { session_id: null }],
    ['Stop null', STOP_HOOK, {}, { session_id: null }],
  ])('%s session id is ignored instead of writing unknown.jsonl', (
    _label,
    hookPath,
    payloadExtra,
    sessionExtra,
  ) => {
    resetFixture();
    const transcriptPath = join(testRoot, 'transcript.jsonl');
    writeFileSync(transcriptPath, '{"event":"missing-session"}\n');
    const unexpectedSpool = join(spoolRoot, 'demo-project', 'unknown.jsonl');

    const result = runHook(hookPath, {
      cwd: '/work/demo-project',
      transcript_path: transcriptPath,
      ...payloadExtra,
      ...sessionExtra,
    });

    expect(result.status).toBe(0);
    expect(existsSync(unexpectedSpool)).toBe(false);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it('fails open when systemctl cannot start the service', () => {
    resetFixture();
    const transcriptPath = join(testRoot, 'transcript.jsonl');
    writeFileSync(transcriptPath, '{"event":"done"}\n');

    const result = runHook(
      STOP_HOOK,
      {
        cwd: '/work/demo-project',
        session_id: 'session-fail-open',
        transcript_path: transcriptPath,
      },
      { CC_MEMORY_SYSTEMCTL_EXIT: '42' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(systemctlLog, 'utf8')).toContain(
      '--user start --no-block cc-memory-auto-capture.service',
    );
  });
});
