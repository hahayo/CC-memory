import { describe, expect, it } from 'vitest';
import {
  assessBackupFreshness,
  createEmptyBackupFreshnessState,
  decideBackupFreshnessAlert,
  selectLatestManifestKey,
  type RemoteBackupManifestEvidence,
} from '../../scripts/lib/backup-freshness.js';

const RECIPIENT = 'age1t84j9vcpj2es3tnhrqmye945kjj9swqfaqyhdt5ulslnrcly0vrqhetl7f';

function manifest(
  target: 'project' | 'personal',
  completedAt: string,
  overrides: Record<string, unknown> = {},
): string {
  const stamp = target === 'project' ? '20260812T150000Z-aaaaaaaaaaaaaaaa' : '20260812T151000Z-bbbbbbbbbbbbbbbb';
  const objectKey = `backups/v1/${target}/2026/08/${stamp}.dump.age`;
  const manifestKey = `backups/v1/${target}/2026/08/${stamp}.manifest.json`;
  return `${JSON.stringify({
    schema_version: 1,
    run_id: stamp,
    target,
    created_at: completedAt,
    completed_at: completedAt,
    object_key: objectKey,
    manifest_key: manifestKey,
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
    ...overrides,
  })}\n`;
}

function evidence(
  target: 'project' | 'personal',
  completedAt: string,
  overrides: Record<string, unknown> = {},
): RemoteBackupManifestEvidence {
  const source = manifest(target, completedAt, overrides);
  const parsed = JSON.parse(source) as { manifest_key: string };
  return { key: parsed.manifest_key, source };
}

describe('backup freshness evidence', () => {
  it('selects only the newest canonical manifest key for the requested target', () => {
    expect(selectLatestManifestKey('project', [
      'backups/v1/project/2026/08/20260811T150000Z-aaaaaaaaaaaaaaaa.manifest.json',
      'backups/v1/project/2026/08/not-a-manifest.json',
      'backups/v1/personal/2026/08/20260813T150000Z-cccccccccccccccc.manifest.json',
      'backups/v1/project/2026/08/20260812T150000Z-bbbbbbbbbbbbbbbb.manifest.json',
    ])).toBe(
      'backups/v1/project/2026/08/20260812T150000Z-bbbbbbbbbbbbbbbb.manifest.json',
    );
  });

  it('passes only when both project and personal manifests are fresh and internally consistent', () => {
    const report = assessBackupFreshness({
      evidence: {
        project: evidence('project', '2026-08-12T15:00:00Z'),
        personal: evidence('personal', '2026-08-12T15:10:00Z'),
      },
      expectedRecipient: RECIPIENT,
      maxAgeMs: 26 * 60 * 60 * 1000,
      now: new Date('2026-08-13T15:30:00Z'),
    });

    expect(report.overall).toBe('PASS');
    expect(report.targets).toEqual([
      expect.objectContaining({ target: 'project', status: 'PASS' }),
      expect.objectContaining({ target: 'personal', status: 'PASS' }),
    ]);
  });

  it('fails a stale target without exposing hashes or the recipient in the report', () => {
    const report = assessBackupFreshness({
      evidence: {
        project: evidence('project', '2026-08-12T10:00:00Z'),
        personal: evidence('personal', '2026-08-13T15:10:00Z'),
      },
      expectedRecipient: RECIPIENT,
      maxAgeMs: 26 * 60 * 60 * 1000,
      now: new Date('2026-08-13T15:30:00Z'),
    });
    const serialized = JSON.stringify(report);

    expect(report.overall).toBe('FAIL');
    expect(report.targets.find((target) => target.target === 'project')).toMatchObject({
      status: 'FAIL',
      reason: expect.stringContaining('stale'),
    });
    expect(serialized).not.toContain('a'.repeat(64));
    expect(serialized).not.toContain('b'.repeat(64));
    expect(serialized).not.toContain(RECIPIENT);
  });

  it.each([
    {
      name: 'missing manifest',
      project: null,
      reason: 'missing',
    },
    {
      name: 'future completion timestamp',
      project: evidence('project', '2026-08-13T16:00:00Z'),
      reason: 'future',
    },
    {
      name: 'cipher readback mismatch',
      project: evidence('project', '2026-08-13T15:00:00Z', {
        remote_verification: {
          bytes: 1099,
          sha256: 'c'.repeat(64),
          method: 'full-readback',
        },
      }),
      reason: 'remote verification',
    },
  ])('fails closed on $name', ({ project, reason }) => {
    const report = assessBackupFreshness({
      evidence: {
        project,
        personal: evidence('personal', '2026-08-13T15:10:00Z'),
      },
      expectedRecipient: RECIPIENT,
      maxAgeMs: 26 * 60 * 60 * 1000,
      now: new Date('2026-08-13T15:30:00Z'),
    });

    expect(report.overall).toBe('FAIL');
    expect(report.targets.find((target) => target.target === 'project')?.reason).toContain(reason);
  });

  it('deduplicates the same failure and emits one recovery transition', () => {
    const failed = assessBackupFreshness({
      evidence: {
        project: null,
        personal: evidence('personal', '2026-08-13T15:10:00Z'),
      },
      expectedRecipient: RECIPIENT,
      maxAgeMs: 26 * 60 * 60 * 1000,
      now: new Date('2026-08-13T15:30:00Z'),
    });
    const first = decideBackupFreshnessAlert(
      createEmptyBackupFreshnessState(),
      failed,
      new Date('2026-08-13T15:30:00Z'),
    );
    const repeated = decideBackupFreshnessAlert(
      first.alertedState,
      failed,
      new Date('2026-08-13T16:30:00Z'),
    );
    const recoveredReport = assessBackupFreshness({
      evidence: {
        project: evidence('project', '2026-08-13T15:00:00Z'),
        personal: evidence('personal', '2026-08-13T15:10:00Z'),
      },
      expectedRecipient: RECIPIENT,
      maxAgeMs: 26 * 60 * 60 * 1000,
      now: new Date('2026-08-13T16:30:00Z'),
    });
    const recovery = decideBackupFreshnessAlert(
      first.alertedState,
      recoveredReport,
      new Date('2026-08-13T16:30:00Z'),
    );

    expect(first.action).toBe('failure');
    expect(repeated.action).toBe('suppressed');
    expect(recovery.action).toBe('recovery');
    expect(recovery.alertedState.activeFingerprint).toBeNull();
  });
});
