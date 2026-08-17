import {
  closeSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveCaptureEpoch,
  assertApprovedEpochBaseline,
  assertStableEpoch,
  bootstrapCaptureEpochs,
  captureEpochFingerprint,
  captureEpochBaseline,
  parseArchiveBacklogArgs,
  validateBacklogCutoffApproval,
  verifyCaptureEpochArchive,
} from '../../scripts/archive-capture-backlog.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-backlog-archive-'));
  roots.push(root);
  return root;
}

function refreshSpoolArchiveHashes(archive: string): void {
  const manifestPath = join(archive, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const spoolSource = readFileSync(join(archive, 'spool.tar.gz'));
  manifest.spoolArchive.bytes = spoolSource.length;
  manifest.spoolArchive.sha256 = createHash('sha256').update(spoolSource).digest('hex');
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestSource);
  writeFileSync(
    join(archive, 'manifest.sha256'),
    `${createHash('sha256').update(manifestSource).digest('hex')}  manifest.json\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backlog cutoff approval', () => {
  it('binds a short-lived approval to the dry-run fingerprint', () => {
    const source = [
      'scope=capture-backlog-cutoff',
      'approved_by=haha',
      'approved_at=2026-08-12T00:00:00.000Z',
      'expires_at=2026-08-12T02:00:00.000Z',
      'spool_fingerprint=abc123',
    ].join('\n');

    expect(() => validateBacklogCutoffApproval(
      source,
      'abc123',
      new Date('2026-08-12T01:00:00.000Z'),
    )).not.toThrow();
    expect(() => validateBacklogCutoffApproval(
      source,
      'changed',
      new Date('2026-08-12T01:00:00.000Z'),
    )).toThrow(/fingerprint/i);
  });

  it('rejects empty, wrong-scope, non-canonical, and expired approvals', () => {
    const cases = [
      '',
      'scope=auto-capture-prod',
      [
        'scope=capture-backlog-cutoff',
        'approved_by=haha',
        'approved_at=2026-08-12 00:00:00 UTC',
        'expires_at=2026-08-12T02:00:00.000Z',
        'spool_fingerprint=abc123',
      ].join('\n'),
      [
        'scope=capture-backlog-cutoff',
        'approved_by=haha',
        'approved_at=2026-08-12T00:00:00.000Z',
        'expires_at=2026-08-14T00:00:00.000Z',
        'spool_fingerprint=abc123',
      ].join('\n'),
      [
        'scope=capture-backlog-cutoff',
        'approved_by=haha',
        'approved_at=2026-08-12T00:00:00.000Z',
        'expires_at=2026-08-12T00:30:00.000Z',
        'spool_fingerprint=abc123',
      ].join('\n'),
    ];

    for (const source of cases) {
      expect(() => validateBacklogCutoffApproval(
        source,
        'abc123',
        new Date('2026-08-12T01:00:00.000Z'),
      )).toThrow(/backlog cutoff approval/i);
    }
  });

  it('parses a dry-run by default and keeps execute explicit', () => {
    expect(parseArchiveBacklogArgs([], {})).toMatchObject({ execute: false, settleMs: 600_000 });
    expect(() => parseArchiveBacklogArgs(['--execute', '--settle-ms', '0'], {}))
      .toThrow(/short settle/i);
    expect(parseArchiveBacklogArgs([
      '--execute',
      '--settle-ms', '0',
      '--allow-short-settle',
      '--resume-epoch-dir', '/safe/historical',
    ], {})).toMatchObject({
      execute: true,
      settleMs: 0,
      allowShortSettle: true,
      resumeEpochDir: '/safe/historical',
    });
  });
});

describe('capture epoch cutoff', () => {
  it('moves the legacy spool into an old epoch and atomically points new writes at a new epoch', () => {
    const root = makeRoot();
    const spool = join(root, 'spool');
    const epochs = join(root, 'spool-epochs');
    mkdirSync(join(spool, 'project'), { recursive: true });
    writeFileSync(join(spool, 'project', 'old.jsonl'), '{"old":true}\n');

    const result = bootstrapCaptureEpochs({
      spoolDir: spool,
      epochsDir: epochs,
      cutoffId: '20260812T010000Z',
    });

    expect(lstatSync(spool).isSymbolicLink()).toBe(true);
    expect(readlinkSync(spool)).toBe(result.newEpochDir);
    expect(readFileSync(join(result.oldEpochDir, 'project', 'old.jsonl'), 'utf8'))
      .toBe('{"old":true}\n');
    mkdirSync(join(spool, 'project'), { recursive: true });
    writeFileSync(join(spool, 'project', 'new.jsonl'), '{"new":true}\n');
    expect(readFileSync(join(result.newEpochDir, 'project', 'new.jsonl'), 'utf8'))
      .toBe('{"new":true}\n');
    expect(() => statSync(join(result.oldEpochDir, 'project', 'new.jsonl'))).toThrow();
  });

  it('preserves a hook-created stray spool during the bootstrap race', () => {
    const root = makeRoot();
    const spool = join(root, 'spool');
    const epochs = join(root, 'spool-epochs');
    mkdirSync(join(spool, 'project'), { recursive: true });
    writeFileSync(join(spool, 'project', 'session.jsonl'), '{"old":true}\n');
    let injected = false;

    const result = bootstrapCaptureEpochs({
      spoolDir: spool,
      epochsDir: epochs,
      cutoffId: '20260812T010000Z',
      beforeSwapAttempt: () => {
        if (injected) return;
        injected = true;
        mkdirSync(join(spool, 'project'), { recursive: true });
        writeFileSync(join(spool, 'project', 'session.jsonl'), '{"stray":true}\n');
      },
    });

    const historicalJsonl = readdirSync(join(result.oldEpochDir, 'project'))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => readFileSync(join(result.oldEpochDir, 'project', name), 'utf8'));
    expect(historicalJsonl).toContain('{"old":true}\n');
    expect(historicalJsonl).toContain('{"stray":true}\n');
    expect(lstatSync(spool).isSymbolicLink()).toBe(true);
  });

  it('rejects the archive lock marker when no matching fd is inherited', () => {
    const root = makeRoot();
    const spool = join(root, 'spool');
    const lock = join(root, 'cutoff.lock');
    mkdirSync(spool);
    writeFileSync(join(spool, 'session.jsonl'), '{}\n');
    writeFileSync(lock, '', { mode: 0o600 });
    const script = join(process.cwd(), 'scripts', 'archive-capture-backlog.ts');

    const result = spawnSync(process.execPath, [
      '--import', 'tsx', script,
      '--execute',
      '--spool-dir', spool,
      '--lock-file', lock,
      '--settle-ms', '0',
      '--allow-short-settle',
    ], {
      env: { ...process.env, CC_MEMORY_ARCHIVE_LOCK_PATH: lock },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lock fd does not match the lock file/i);
  });

  it('rejects a matching archive lock fd that is not exclusively locked', () => {
    const root = makeRoot();
    const spool = join(root, 'spool');
    const lock = join(root, 'cutoff.lock');
    mkdirSync(spool);
    writeFileSync(join(spool, 'session.jsonl'), '{}\n');
    writeFileSync(lock, '', { mode: 0o600 });
    const script = join(process.cwd(), 'scripts', 'archive-capture-backlog.ts');
    const fd = openSync(lock, 'r');
    try {
      const stdio: Array<'ignore' | 'pipe' | number> = [
        'ignore', 'pipe', 'pipe',
        'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', fd,
      ];
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', script,
        '--execute',
        '--spool-dir', spool,
        '--lock-file', lock,
        '--settle-ms', '0',
        '--allow-short-settle',
      ], {
        env: { ...process.env, CC_MEMORY_ARCHIVE_LOCK_PATH: lock },
        encoding: 'utf8',
        stdio,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/lock fd is not exclusively locked/i);
    } finally {
      closeSync(fd);
    }
  });
});

describe('capture epoch archive', () => {
  it('snapshots the referenced transcript prefix and emits verifiable hashes without full paths', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    const transcript = join(root, 'secret-transcript.jsonl');
    mkdirSync(join(epoch, 'project'), { recursive: true });
    writeFileSync(transcript, 'first-line\nsecond-line\ntrailing-line\n');
    writeFileSync(join(epoch, 'project', 'session.jsonl'), [
      JSON.stringify({ transcript_path: transcript, transcript_offset: 0 }),
      JSON.stringify({ transcript_path: transcript, hwm_offset: 23 }),
      '',
    ].join('\n'));
    writeFileSync(join(epoch, 'project', 'missing.jsonl'), [
      JSON.stringify({ transcript_path: join(root, 'missing.jsonl'), transcript_offset: 0 }),
      JSON.stringify({ transcript_path: join(root, 'missing.jsonl'), hwm_offset: 10 }),
      '',
    ].join('\n'));

    const manifest = archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    expect(manifest.spoolFiles).toHaveLength(2);
    expect(manifest.transcripts).toHaveLength(2);
    const available = manifest.transcripts.find((entry) => entry.status === 'snapshotted');
    const missing = manifest.transcripts.find((entry) => entry.status === 'missing');
    expect(available).toMatchObject({ bytes: 23, maxBoundary: 23 });
    expect(available?.sourcePathHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(transcript);
    expect(readFileSync(join(archive, available!.snapshotRelpath!), 'utf8'))
      .toBe('first-line\nsecond-line\n');
    expect(missing).toMatchObject({ status: 'missing', unrecoverableReason: 'source-missing' });
    expect(statSync(join(archive, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(archive, 'spool.tar.gz')).mode & 0o777).toBe(0o600);
    expect(statSync(join(archive, 'manifest.sha256')).mode & 0o777).toBe(0o600);
    expect(verifyCaptureEpochArchive(archive)).toMatchObject({ ok: true });

    const manifestPath = join(archive, 'manifest.json');
    const inconsistent = JSON.parse(readFileSync(manifestPath, 'utf8'));
    inconsistent.spoolFiles[0].sha256 = '0'.repeat(64);
    const inconsistentSource = `${JSON.stringify(inconsistent, null, 2)}\n`;
    writeFileSync(manifestPath, inconsistentSource);
    writeFileSync(
      join(archive, 'manifest.sha256'),
      `${createHash('sha256').update(inconsistentSource).digest('hex')}  manifest.json\n`,
    );
    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: 'spool archive contents do not match the manifest',
    });
  });

  it('rejects regular files outside the manifest allowlist', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(epoch);
    writeFileSync(join(epoch, 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });
    writeFileSync(join(archive, 'unexpected-secret.txt'), 'not in manifest', { mode: 0o600 });

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unexpected archive entry/i),
    });
  });

  it('accepts safe empty directories inside the spool archive', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(join(epoch, 'project', 'empty'), { recursive: true });
    writeFileSync(join(epoch, 'project', 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({ ok: true });
  });

  it('rejects regular files inside the spool archive that are absent from the manifest', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(epoch);
    writeFileSync(join(epoch, 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    const maliciousParent = join(root, 'malicious-extra-file');
    const maliciousEpoch = join(maliciousParent, 'epoch');
    mkdirSync(maliciousEpoch, { recursive: true });
    writeFileSync(join(maliciousEpoch, 'session.jsonl'), '{}\n');
    writeFileSync(join(maliciousEpoch, 'extra.jsonl'), '{"extra":true}\n');
    const spoolArchive = join(archive, 'spool.tar.gz');
    const created = spawnSync('tar', [
      '-C', maliciousParent,
      '-czf', spoolArchive,
      'epoch',
    ], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    const manifestPath = join(archive, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const spoolSource = readFileSync(spoolArchive);
    manifest.spoolArchive.bytes = spoolSource.length;
    manifest.spoolArchive.sha256 = createHash('sha256').update(spoolSource).digest('hex');
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestSource);
    writeFileSync(
      join(archive, 'manifest.sha256'),
      `${createHash('sha256').update(manifestSource).digest('hex')}  manifest.json\n`,
    );

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/files do not match the manifest allowlist/i),
    });
  });

  it('rejects duplicate entries inside the spool archive', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(epoch);
    writeFileSync(join(epoch, 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    const spoolArchive = join(archive, 'spool.tar.gz');
    const created = spawnSync('tar', [
      '-C', root,
      '-czf', spoolArchive,
      '--hard-dereference',
      'epoch/session.jsonl',
      'epoch/session.jsonl',
    ], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    refreshSpoolArchiveHashes(archive);

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/duplicate entries/i),
    });
  });

  it('rejects parent traversal entries inside the spool archive', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(epoch);
    writeFileSync(join(epoch, 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    const source = join(root, 'unsafe-source.jsonl');
    writeFileSync(source, '{}\n');
    const spoolArchive = join(archive, 'spool.tar.gz');
    const created = spawnSync('tar', [
      '-C', root,
      '-czf', spoolArchive,
      '--transform=s#^unsafe-source.jsonl#../escape.jsonl#',
      'unsafe-source.jsonl',
    ], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    refreshSpoolArchiveHashes(archive);

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unsafe path/i),
    });
  });

  it('rejects links inside the spool archive before extraction', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(epoch);
    writeFileSync(join(epoch, 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    const maliciousParent = join(root, 'malicious');
    const maliciousEpoch = join(maliciousParent, 'epoch');
    mkdirSync(maliciousEpoch, { recursive: true });
    writeFileSync(join(maliciousEpoch, 'session.jsonl'), '{}\n');
    symlinkSync('/etc/passwd', join(maliciousEpoch, 'link'));
    const spoolArchive = join(archive, 'spool.tar.gz');
    const created = spawnSync('tar', [
      '-C', maliciousParent,
      '-czf', spoolArchive,
      'epoch',
    ], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    const manifestPath = join(archive, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const spoolSource = readFileSync(spoolArchive);
    manifest.spoolArchive.bytes = spoolSource.length;
    manifest.spoolArchive.sha256 = createHash('sha256').update(spoolSource).digest('hex');
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestSource);
    writeFileSync(
      join(archive, 'manifest.sha256'),
      `${createHash('sha256').update(manifestSource).digest('hex')}  manifest.json\n`,
    );

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unexpected spool archive entry type/i),
    });
  });

  it('rejects hardlinks inside the spool archive before extraction', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(epoch);
    writeFileSync(join(epoch, 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    const maliciousParent = join(root, 'malicious-hardlink');
    const maliciousEpoch = join(maliciousParent, 'epoch');
    mkdirSync(maliciousEpoch, { recursive: true });
    const original = join(maliciousEpoch, 'session.jsonl');
    writeFileSync(original, '{}\n');
    linkSync(original, join(maliciousEpoch, 'hardlink.jsonl'));
    const spoolArchive = join(archive, 'spool.tar.gz');
    const created = spawnSync('tar', [
      '-C', maliciousParent,
      '-czf', spoolArchive,
      'epoch',
    ], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    const manifestPath = join(archive, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const spoolSource = readFileSync(spoolArchive);
    manifest.spoolArchive.bytes = spoolSource.length;
    manifest.spoolArchive.sha256 = createHash('sha256').update(spoolSource).digest('hex');
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestSource);
    writeFileSync(
      join(archive, 'manifest.sha256'),
      `${createHash('sha256').update(manifestSource).digest('hex')}  manifest.json\n`,
    );

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unexpected spool archive entry type/i),
    });
  });

  it('rejects special entries inside the spool archive before extraction', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    const archive = join(root, 'archive');
    mkdirSync(epoch);
    writeFileSync(join(epoch, 'session.jsonl'), '{}\n');
    archiveCaptureEpoch({
      epochDir: epoch,
      archiveDir: archive,
      cutoffId: '20260812T010000Z',
      cutoffAt: '2026-08-12T01:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    const maliciousParent = join(root, 'malicious-special');
    const maliciousEpoch = join(maliciousParent, 'epoch');
    mkdirSync(maliciousEpoch, { recursive: true });
    writeFileSync(join(maliciousEpoch, 'session.jsonl'), '{}\n');
    const fifo = spawnSync('mkfifo', [join(maliciousEpoch, 'special-fifo')], { encoding: 'utf8' });
    expect(fifo.status, fifo.stderr).toBe(0);
    const spoolArchive = join(archive, 'spool.tar.gz');
    const created = spawnSync('tar', [
      '-C', maliciousParent,
      '-czf', spoolArchive,
      'epoch',
    ], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    const manifestPath = join(archive, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const spoolSource = readFileSync(spoolArchive);
    manifest.spoolArchive.bytes = spoolSource.length;
    manifest.spoolArchive.sha256 = createHash('sha256').update(spoolSource).digest('hex');
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestSource);
    writeFileSync(
      join(archive, 'manifest.sha256'),
      `${createHash('sha256').update(manifestSource).digest('hex')}  manifest.json\n`,
    );

    expect(verifyCaptureEpochArchive(archive)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unexpected spool archive entry type/i),
    });
  });

  it('rejects an epoch that changes between settle scans', async () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    mkdirSync(epoch);
    const spool = join(epoch, 'session.jsonl');
    writeFileSync(spool, '{}\n');

    await expect(assertStableEpoch(epoch, {
      settleMs: 0,
      sleep: async () => { writeFileSync(spool, '{}\n{}\n'); },
    })).rejects.toThrow(/changed during settle/i);
  });

  it('uses content metadata to produce a stable dry-run fingerprint', () => {
    const root = makeRoot();
    const spool = join(root, 'spool');
    mkdirSync(spool);
    writeFileSync(join(spool, 'a.jsonl'), '{}\n');
    const first = captureEpochFingerprint(spool);
    const second = captureEpochFingerprint(spool);
    expect(first).toBe(second);
    writeFileSync(join(spool, 'a.jsonl'), '{}\n{}\n');
    expect(captureEpochFingerprint(spool)).not.toBe(first);
  });

  it('allows append-only cutoff stragglers but rejects mutation of the approved prefix', () => {
    const root = makeRoot();
    const epoch = join(root, 'epoch');
    mkdirSync(epoch);
    const spool = join(epoch, 'session.jsonl');
    writeFileSync(spool, '{"approved":true}\n');
    const baseline = captureEpochBaseline(epoch);

    writeFileSync(spool, '{"approved":true}\n{"straggler":true}\n');
    expect(() => assertApprovedEpochBaseline(epoch, baseline)).not.toThrow();

    writeFileSync(spool, '{"mutated":true}\n{"straggler":true}\n');
    expect(() => assertApprovedEpochBaseline(epoch, baseline)).toThrow(/approved prefix/i);
  });

  it('runs the CLI cutoff end to end only after a fingerprint-bound approval', () => {
    const root = makeRoot();
    const spool = join(root, 'spool');
    const epochs = join(root, 'epochs');
    const archives = join(root, 'archives');
    const approval = join(root, 'approval');
    const lock = join(root, 'cutoff.lock');
    mkdirSync(join(spool, 'project'), { recursive: true });
    writeFileSync(join(spool, 'project', 'session.jsonl'), '{}\n');
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const script = join(process.cwd(), 'scripts', 'archive-capture-backlog.ts');
    const commonArgs = [
      '--spool-dir', spool,
      '--epochs-dir', epochs,
      '--archive-root', archives,
      '--approval-file', approval,
      '--lock-file', lock,
      '--settle-ms', '0',
      '--allow-short-settle',
    ];
    const dryRun = spawnSync(process.execPath, [tsxCli, script, '--json', ...commonArgs], {
      encoding: 'utf8',
    });
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const fingerprint = JSON.parse(dryRun.stdout).spoolFingerprint as string;
    const now = Date.now();
    writeFileSync(approval, [
      'scope=capture-backlog-cutoff',
      'approved_by=vitest',
      `approved_at=${new Date(now - 1_000).toISOString()}`,
      `expires_at=${new Date(now + 60_000).toISOString()}`,
      `spool_fingerprint=${fingerprint}`,
      '',
    ].join('\n'), { mode: 0o600 });

    const executed = spawnSync(process.execPath, [tsxCli, script, '--execute', ...commonArgs], {
      encoding: 'utf8',
    });

    expect(executed.status, executed.stderr).toBe(0);
    const output = JSON.parse(executed.stdout) as { archiveDir: string; oldEpochDir: string };
    expect(lstatSync(spool).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(output.oldEpochDir, 'project', 'session.jsonl'), 'utf8')).toBe('{}\n');
    expect(verifyCaptureEpochArchive(output.archiveDir)).toMatchObject({ ok: true });

    const activeTarget = readlinkSync(spool);
    const resumeArchiveRoot = join(root, 'resume-archives');
    const resumeArgs = [
      '--resume-epoch-dir', output.oldEpochDir,
      '--archive-root', resumeArchiveRoot,
      '--approval-file', approval,
      '--lock-file', lock,
      '--settle-ms', '0',
      '--allow-short-settle',
    ];
    const resumeDryRun = spawnSync(
      process.execPath,
      [tsxCli, script, '--json', ...resumeArgs],
      { encoding: 'utf8' },
    );
    expect(resumeDryRun.status, resumeDryRun.stderr).toBe(0);
    const resumeFingerprint = JSON.parse(resumeDryRun.stdout).spoolFingerprint as string;
    writeFileSync(approval, [
      'scope=capture-backlog-cutoff',
      'approved_by=vitest',
      `approved_at=${new Date(now - 1_000).toISOString()}`,
      `expires_at=${new Date(now + 60_000).toISOString()}`,
      `spool_fingerprint=${resumeFingerprint}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const resumed = spawnSync(
      process.execPath,
      [tsxCli, script, '--execute', ...resumeArgs],
      { encoding: 'utf8' },
    );
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ mode: 'resume-epoch' });
    expect(readlinkSync(spool)).toBe(activeTarget);
  });
});
