// tests/scripts/session-start-inject-cli.test.ts
//
// v0.5 M4 4c — SessionStart 注入殼的 best-effort 契約（spawn bash / Node，不連真 DB）。
// 覆蓋：flag off（unset 與 =off）→ 空 stdout exit 0（bash 層就擋，不 spawn Node）；
//   CC_MEMORY_CAPTURE_CHILD=1 → 空 stdout exit 0（遞迴斷路器先於 flag）；
//   payload 壞 JSON（flag on）→ 空 stdout exit 0（Node 讀 stdin parse 失敗即返回，不連 DB）。
// flag on + 真 DB 的 e2e 由監督者整合驗，本檔不涵蓋。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = join(process.cwd(), 'hooks', 'session-start-inject.sh');
const VALID_PAYLOAD = JSON.stringify({ cwd: '/home/haha/CC_project/demo-project' });

interface ShellRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(
  input: string,
  overrides: Record<string, string | undefined>
): ShellRun {
  const env: Record<string, string | undefined> = { ...process.env };
  // 清乾淨兩個受控旗標，再依 overrides 設定，避免 ambient shell 干擾。
  delete env.CC_MEMORY_INJECT_RECENT;
  delete env.CC_MEMORY_CAPTURE_CHILD;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const result = spawnSync('bash', [HOOK_PATH], {
    input,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('session-start-inject hook wrapper (best-effort contracts)', () => {
  it('emits nothing and exits 0 when CC_MEMORY_INJECT_RECENT is unset', () => {
    const run = runHook(VALID_PAYLOAD, {});
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('emits nothing and exits 0 when CC_MEMORY_INJECT_RECENT=off', () => {
    const run = runHook(VALID_PAYLOAD, { CC_MEMORY_INJECT_RECENT: 'off' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('emits nothing and exits 0 when CC_MEMORY_CAPTURE_CHILD=1 (recursion breaker precedes flag)', () => {
    const run = runHook(VALID_PAYLOAD, {
      CC_MEMORY_CAPTURE_CHILD: '1',
      CC_MEMORY_INJECT_RECENT: 'on',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('emits nothing and exits 0 when payload is malformed JSON (flag on, Node tolerates without DB)', () => {
    const run = runHook('not json at all', { CC_MEMORY_INJECT_RECENT: 'on' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  }, 60_000);
});
