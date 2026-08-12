import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectRemoteManifestEvidence,
  runBackupFreshnessCheck,
} from '../../scripts/check-backup-freshness.js';

const RECIPIENT = 'age1t84j9vcpj2es3tnhrqmye945kjj9swqfaqyhdt5ulslnrcly0vrqhetl7f';

function source(target: 'project' | 'personal', completedAt: string): string {
  const runId = target === 'project'
    ? '20260813T150000Z-aaaaaaaaaaaaaaaa'
    : '20260813T151000Z-bbbbbbbbbbbbbbbb';
  const base = `backups/v1/${target}/2026/08/${runId}`;
  return JSON.stringify({
    schema_version: 1,
    run_id: runId,
    target,
    created_at: completedAt,
    completed_at: completedAt,
    object_key: `${base}.dump.age`,
    manifest_key: `${base}.manifest.json`,
    postgres_server_version_num: 180004,
    dump_format: 'custom',
    plain: { bytes: 1024, sha256: 'a'.repeat(64) },
    cipher: { bytes: 1100, sha256: 'b'.repeat(64) },
    age_recipient: RECIPIENT,
    remote_verification: {
      bytes: 1100,
      sha256: 'b'.repeat(64),
      method: 'full-readback',
    },
  });
}

describe('backup freshness CLI orchestration', () => {
  let root: string;
  let stateFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-memory-backup-freshness-'));
    stateFile = join(root, 'state', 'freshness.json');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function env(): NodeJS.ProcessEnv {
    return {
      CC_MEMORY_R2_BUCKET: 'cc-memory-backups',
      CC_MEMORY_AGE_RECIPIENT: RECIPIENT,
      CC_BACKUP_FRESHNESS_STATE_FILE: stateFile,
      AWS_ACCESS_KEY_ID: 'test-access',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      AWS_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com',
      AWS_DEFAULT_REGION: 'auto',
      CC_MEMORY_ALERT_BOT_TOKEN: 'test-bot',
      CC_MEMORY_ALERT_CHAT_ID: '123',
    };
  }

  it('lists recursively, selects the newest canonical key, and reads only that manifest', () => {
    const calls: string[][] = [];
    const evidence = collectRemoteManifestEvidence(
      'project',
      { bucket: 'cc-memory-backups', rcloneEnv: env() },
      (args) => {
        calls.push(args);
        if (args[0] === 'lsf') {
          return {
            status: 0,
            stdout: [
              '2026/08/20260812T150000Z-cccccccccccccccc.manifest.json',
              '2026/08/20260813T150000Z-aaaaaaaaaaaaaaaa.manifest.json',
            ].join('\n'),
          };
        }
        return { status: 0, stdout: source('project', '2026-08-13T15:00:00Z') };
      },
    );

    expect(evidence?.key).toBe(
      'backups/v1/project/2026/08/20260813T150000Z-aaaaaaaaaaaaaaaa.manifest.json',
    );
    expect(calls[0]).toContain('--recursive');
    expect(calls[1]).toEqual([
      'cat',
      'ccmr2:cc-memory-backups/backups/v1/project/2026/08/20260813T150000Z-aaaaaaaaaaaaaaaa.manifest.json',
      '--config',
      '/dev/null',
    ]);
  });

  it('persists dedup state atomically and sends only failure then recovery transitions', async () => {
    const messages: string[] = [];
    let projectMissing = true;
    const runRclone = (args: string[]) => {
      const remote = args[1] ?? '';
      const target = remote.includes('/project/') ? 'project' : 'personal';
      if (args[0] === 'lsf') {
        if (target === 'project' && projectMissing) return { status: 0, stdout: '' };
        const runId = target === 'project'
          ? '20260813T150000Z-aaaaaaaaaaaaaaaa'
          : '20260813T151000Z-bbbbbbbbbbbbbbbb';
        return { status: 0, stdout: `2026/08/${runId}.manifest.json\n` };
      }
      return {
        status: 0,
        stdout: source(
          target,
          target === 'project' ? '2026-08-13T15:00:00Z' : '2026-08-13T15:10:00Z',
        ),
      };
    };
    const options = {
      env: env(),
      now: new Date('2026-08-13T15:30:00Z'),
      runRclone,
      sendMessage: async (message: string) => { messages.push(message); },
    };

    expect((await runBackupFreshnessCheck(options)).exitCode).toBe(1);
    expect((await runBackupFreshnessCheck(options)).exitCode).toBe(1);
    projectMissing = false;
    expect((await runBackupFreshnessCheck(options)).exitCode).toBe(0);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('freshness alert');
    expect(messages[1]).toContain('freshness recovered');
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      activeFingerprint: string | null;
      lastSuccessAt: string | null;
    };
    expect(state.activeFingerprint).toBeNull();
    expect(state.lastSuccessAt).toBe('2026-08-13T15:30:00.000Z');
  });
});
