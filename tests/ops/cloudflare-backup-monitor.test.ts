import { describe, expect, it, vi } from 'vitest';
import {
  default as worker,
  inspectR2BackupFreshness,
  runScheduledBackupMonitor,
  type MonitorEnv,
  type R2BucketLike,
} from '../../ops/cloudflare-backup-monitor/src/worker.js';

const RECIPIENT = 'age1t84j9vcpj2es3tnhrqmye945kjj9swqfaqyhdt5ulslnrcly0vrqhetl7f';

function manifest(target: 'project' | 'personal', completedAt: string): string {
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

function bucket(input: {
  project?: string;
  personal?: string;
  listFailure?: boolean;
}): R2BucketLike {
  const objects = new Map<string, string>();
  for (const target of ['project', 'personal'] as const) {
    const source = input[target];
    if (!source) continue;
    const key = (JSON.parse(source) as { manifest_key: string }).manifest_key;
    objects.set(key, source);
  }
  return {
    list: vi.fn(async ({ prefix }) => {
      if (input.listFailure) throw new Error('R2 unavailable');
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    }),
    get: vi.fn(async (key) => {
      const source = objects.get(key);
      return source ? { text: async () => source } : null;
    }),
  };
}

function env(value: R2BucketLike): MonitorEnv {
  return {
    BACKUPS: value,
    CC_MEMORY_AGE_RECIPIENT: RECIPIENT,
    CC_BACKUP_MAX_AGE_HOURS: '26',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_CHAT_ID: '12345',
  };
}

describe('Cloudflare backup monitor', () => {
  it('passes when both committed manifests are fresh', async () => {
    const report = await inspectR2BackupFreshness(
      env(bucket({
        project: manifest('project', '2026-08-13T15:00:00Z'),
        personal: manifest('personal', '2026-08-13T15:10:00Z'),
      })),
      new Date('2026-08-13T15:30:00Z'),
    );

    expect(report.overall).toBe('PASS');
  });

  it.each([
    ['missing manifest', bucket({ personal: manifest('personal', '2026-08-13T15:10:00Z') })],
    ['stale manifest', bucket({
      project: manifest('project', '2026-08-12T10:00:00Z'),
      personal: manifest('personal', '2026-08-13T15:10:00Z'),
    })],
    ['R2 exception', bucket({ listFailure: true })],
  ])('sends a Telegram alert and rejects the scheduled event for %s', async (_name, value) => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response('{"ok":true}', { status: 200 }));

    await expect(runScheduledBackupMonitor(
      env(value),
      new Date('2026-08-13T15:30:00Z'),
      fetchImpl,
    )).rejects.toThrow('backup freshness');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/sendMessage');
    expect(String(init?.body)).not.toContain('test-bot-token');
  });

  it('fails the event when Telegram rejects an alert', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response('denied', { status: 403 }));

    await expect(runScheduledBackupMonitor(
      env(bucket({})),
      new Date('2026-08-13T15:30:00Z'),
      fetchImpl,
    )).rejects.toThrow('Telegram');
  });

  it('propagates scheduled handler rejection instead of hiding it in waitUntil', async () => {
    const waitUntil = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    try {
      await expect(worker.scheduled(
        {},
        env(bucket({})),
        { waitUntil },
      )).rejects.toThrow('backup freshness');
      expect(waitUntil).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
