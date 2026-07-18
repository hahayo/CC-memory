import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const REMINDERS_WRAPPER = join(REPO_ROOT, 'ops', 'systemd', 'run-reminders.sh');
const TODOIST_WRAPPER = join(REPO_ROOT, 'ops', 'systemd', 'run-todoist-sync.sh');

describe('systemd runtime wrappers', () => {
  let fixtureDir: string;
  let fakeBinDir: string;
  let captureFile: string;
  let personalUrlFile: string;
  let todoistTokenFile: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'cc-memory-systemd-wrapper-'));
    fakeBinDir = join(fixtureDir, 'bin');
    captureFile = join(fixtureDir, 'captured-env.txt');
    personalUrlFile = join(fixtureDir, 'personal-url');
    todoistTokenFile = join(fixtureDir, 'todoist-token');

    spawnSync('mkdir', ['-p', fakeBinDir], { encoding: 'utf8' });
    const fakeNode = join(fakeBinDir, 'node');
    writeFileSync(
      fakeNode,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '{',
        "  printf 'database=%s\\n' \"${DATABASE_URL_PERSONAL:-}\"",
        "  printf 'scope=%s\\n' \"${CC_FORCE_PROJECT_ID:-}\"",
        "  printf 'telegram_token=%s\\n' \"${TELEGRAM_BOT_TOKEN:-}\"",
        "  printf 'telegram_chat=%s\\n' \"${TELEGRAM_CHAT_ID:-}\"",
        "  printf 'todoist_token=%s\\n' \"${TODOIST_API_TOKEN:-}\"",
        "  printf 'argv=%s\\n' \"$*\"",
        '} > "$CAPTURE_FILE"',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeNode, 0o755);
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  function baseEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: fixtureDir,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      CAPTURE_FILE: captureFile,
      CC_MEMORY_PERSONAL_URL_FILE: personalUrlFile,
      CC_MEMORY_TODOIST_TOKEN_FILE: todoistTokenFile,
    };
  }

  it('passes independent personal DB and Telegram settings to the reminder poller', () => {
    writeFileSync(personalUrlFile, 'postgres://personal-db\n', 'utf8');

    const result = spawnSync('bash', [REMINDERS_WRAPPER], {
      env: {
        ...baseEnv(),
        TELEGRAM_BOT_TOKEN: 'telegram-token',
        TELEGRAM_CHAT_ID: 'telegram-chat',
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const captured = readFileSync(captureFile, 'utf8');
    expect(captured).toContain('database=postgres://personal-db');
    expect(captured).toContain('scope=__personal__');
    expect(captured).toContain('telegram_token=telegram-token');
    expect(captured).toContain('telegram_chat=telegram-chat');
    expect(captured).toContain('/scripts/hermes-reminder-poll.ts');
  });

  it('rejects an empty personal DB URL before launching the reminder poller', () => {
    writeFileSync(personalUrlFile, '\n', 'utf8');

    const result = spawnSync('bash', [REMINDERS_WRAPPER], {
      env: {
        ...baseEnv(),
        TELEGRAM_BOT_TOKEN: 'telegram-token',
        TELEGRAM_CHAT_ID: 'telegram-chat',
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('personal DB URL file is empty');
  });

  it('passes independent personal DB and Todoist token settings to the sync poller', () => {
    writeFileSync(personalUrlFile, 'postgres://personal-db\n', 'utf8');
    writeFileSync(todoistTokenFile, 'todoist-token\n', 'utf8');

    const result = spawnSync('bash', [TODOIST_WRAPPER], {
      env: baseEnv(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const captured = readFileSync(captureFile, 'utf8');
    expect(captured).toContain('database=postgres://personal-db');
    expect(captured).toContain('scope=__personal__');
    expect(captured).toContain('todoist_token=todoist-token');
    expect(captured).toContain('/scripts/todoist-sync-poll.ts');
  });

  it('rejects an empty Todoist token before launching the sync poller', () => {
    writeFileSync(personalUrlFile, 'postgres://personal-db\n', 'utf8');
    writeFileSync(todoistTokenFile, '\n', 'utf8');

    const result = spawnSync('bash', [TODOIST_WRAPPER], {
      env: baseEnv(),
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Todoist token file is empty');
  });
});
