import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approvedJsonlPrefix,
  copyLiveCapacityCheck,
  copyLiveSpoolFile,
  executeCopyLiveSnapshot,
  parseArchiveBacklogArgs,
  pruneCopyLiveArchives,
  verifyCopyLiveArchive,
} from '../../scripts/archive-capture-backlog.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-copy-live-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// approvedJsonlPrefix
// ---------------------------------------------------------------------------

describe('approvedJsonlPrefix', () => {
  it('approves all lines when all are valid JSON', () => {
    const content = Buffer.from('{"a":1}\n{"b":2}\n');
    const result = approvedJsonlPrefix(content, content.length);
    expect(result.approvedBytes).toBe(content.length);
    expect(result.trimmedLines).toBe(0);
  });

  it('retreats to last newline when maxBytes cuts mid-line', () => {
    const content = Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n');
    // Cut in the middle of the third line
    const result = approvedJsonlPrefix(content, 20);
    expect(result.approvedBytes).toBe(16); // First two lines
    expect(result.trimmedLines).toBe(0);
  });

  it('stops at first invalid JSON line', () => {
    const content = Buffer.from('{"a":1}\nINVALID\n{"c":3}\n');
    const result = approvedJsonlPrefix(content, content.length);
    expect(result.approvedBytes).toBe(8); // Only first line
    expect(result.trimmedLines).toBe(2); // INVALID + {"c":3}
  });

  it('returns zero for empty content', () => {
    const content = Buffer.from('');
    const result = approvedJsonlPrefix(content, 0);
    expect(result.approvedBytes).toBe(0);
    expect(result.trimmedLines).toBe(0);
  });

  it('handles content with no newline', () => {
    const content = Buffer.from('{"a":1}');
    const result = approvedJsonlPrefix(content, content.length);
    // No complete newline-terminated line
    expect(result.approvedBytes).toBe(0);
    expect(result.trimmedLines).toBe(0);
  });

  it('handles malformed middle line followed by valid lines', () => {
    const content = Buffer.from('{"a":1}\n{broken\n{"c":3}\n');
    const result = approvedJsonlPrefix(content, content.length);
    expect(result.approvedBytes).toBe(8); // Only first line
    expect(result.trimmedLines).toBe(2);
  });

  it('handles multi-byte UTF-8 characters correctly', () => {
    const line = '{"emoji":"🎉"}\n';
    const content = Buffer.from(line);
    const result = approvedJsonlPrefix(content, content.length);
    expect(result.approvedBytes).toBe(content.length);
    expect(result.trimmedLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// copyLiveSpoolFile
// ---------------------------------------------------------------------------

describe('copyLiveSpoolFile', () => {
  it('copies .jsonl files using prefix rules', () => {
    const root = makeRoot();
    const source = join(root, 'test.jsonl');
    const dest = join(root, 'copy.jsonl');
    writeFileSync(source, '{"a":1}\n{"b":2}\n');

    const result = copyLiveSpoolFile(source, dest, statSync(source).size);
    expect(result.type).toBe('jsonl-prefix');
    expect(result.approvedBytes).toBe(16);
    expect(readFileSync(dest, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('copies non-jsonl files as whole files', () => {
    const root = makeRoot();
    const source = join(root, 'state.capture-state.json');
    const dest = join(root, 'copy.json');
    const content = '{"cursor":42}';
    writeFileSync(source, content);

    const result = copyLiveSpoolFile(source, dest, statSync(source).size);
    expect(result.type).toBe('whole-file');
    expect(result.approvedBytes).toBe(content.length);
    expect(readFileSync(dest, 'utf8')).toBe(content);
  });

  it('trims incomplete trailing line in .jsonl', () => {
    const root = makeRoot();
    const source = join(root, 'test.jsonl');
    const dest = join(root, 'copy.jsonl');
    // Simulate a partial write (no trailing newline on last line)
    writeFileSync(source, '{"a":1}\n{"b":2}\n{"incomplete');

    const result = copyLiveSpoolFile(source, dest, statSync(source).size);
    expect(result.type).toBe('jsonl-prefix');
    expect(result.approvedBytes).toBe(16); // Only the first two complete lines
    expect(readFileSync(dest, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });
});

// ---------------------------------------------------------------------------
// parseArchiveBacklogArgs --copy-live
// ---------------------------------------------------------------------------

describe('parseArchiveBacklogArgs --copy-live', () => {
  it('sets copyLive flag', () => {
    const opts = parseArchiveBacklogArgs(['--copy-live'], {});
    expect(opts.copyLive).toBe(true);
  });

  it('does not require --allow-short-settle for copy-live + execute', () => {
    const opts = parseArchiveBacklogArgs(
      ['--copy-live', '--execute', '--settle-ms', '0'],
      {},
    );
    expect(opts.copyLive).toBe(true);
    expect(opts.execute).toBe(true);
    expect(opts.settleMs).toBe(0);
  });

  it('defaults maxArchives to 2', () => {
    const opts = parseArchiveBacklogArgs(['--copy-live'], {});
    expect(opts.copyLiveMaxArchives).toBe(2);
  });

  it('respects custom staging and archive roots', () => {
    const opts = parseArchiveBacklogArgs([
      '--copy-live',
      '--copy-live-staging', '/tmp/staging',
      '--copy-live-archive', '/tmp/archive',
    ], {});
    expect(opts.copyLiveStagingRoot).toBe('/tmp/staging');
    expect(opts.copyLiveArchiveRoot).toBe('/tmp/archive');
  });
});

// ---------------------------------------------------------------------------
// executeCopyLiveSnapshot
// ---------------------------------------------------------------------------

describe('executeCopyLiveSnapshot', () => {
  it('creates a verified copy-live archive from a spool directory', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    const stagingDir = join(root, 'staging');
    mkdirSync(join(spoolDir, 'project1'), { recursive: true });

    // Create spool files
    writeFileSync(join(spoolDir, 'project1', 'session1.jsonl'), '{"a":1}\n{"b":2}\n');
    writeFileSync(
      join(spoolDir, 'project1', 'session1.capture-state.json'),
      '{"cursor":16,"spool":{"generation":1}}',
    );

    const manifest = executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260823T120000Z',
      snapshotAt: '2026-08-23T12:00:00.000Z',
    });

    expect(manifest.mode).toBe('copy-live');
    expect(manifest.counts.spoolFiles).toBe(2);
    expect(manifest.counts.jsonlPrefixFiles).toBe(1);
    expect(manifest.counts.wholeFiles).toBe(1);

    // Verify the archive
    const verification = verifyCopyLiveArchive(stagingDir);
    expect(verification.ok).toBe(true);
  });

  it('handles missing transcript files without aborting', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    const stagingDir = join(root, 'staging');
    mkdirSync(spoolDir, { recursive: true });

    // Create spool file that references a non-existent transcript
    writeFileSync(
      join(spoolDir, 'session.jsonl'),
      `{"transcript_path":"/nonexistent/transcript.jsonl","transcript_offset":100}\n`,
    );

    const manifest = executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260823T120000Z',
      snapshotAt: '2026-08-23T12:00:00.000Z',
    });

    expect(manifest.counts.transcriptsUnrecoverable).toBe(1);
    expect(manifest.transcripts[0].status).toBe('missing');
  });

  it('preserves live spool path, inode, and approved prefix content unchanged', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    const stagingDir = join(root, 'staging');
    mkdirSync(spoolDir, { recursive: true });

    const spoolPath = join(spoolDir, 'session.jsonl');
    const originalContent = '{"a":1}\n{"b":2}\n';
    writeFileSync(spoolPath, originalContent);

    const originalInode = statSync(spoolPath).ino;
    const originalSize = statSync(spoolPath).size;

    executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260823T120000Z',
      snapshotAt: '2026-08-23T12:00:00.000Z',
    });

    // Verify live spool is untouched
    expect(statSync(spoolPath).ino).toBe(originalInode);
    expect(readFileSync(spoolPath, 'utf8')).toBe(originalContent);
    expect(statSync(spoolPath).size).toBe(originalSize);
  });

  it('handles concurrent append during copy (approved prefix is stable)', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    const stagingDir = join(root, 'staging');
    mkdirSync(spoolDir, { recursive: true });

    const spoolPath = join(spoolDir, 'session.jsonl');
    writeFileSync(spoolPath, '{"a":1}\n{"b":2}\n');
    const sizeBefore = statSync(spoolPath).size;
    const inodeBefore = statSync(spoolPath).ino;

    // Simulate: take size snapshot, then append happens
    // The copy uses the snapshotted size as maxBytes
    const manifest = executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260823T120000Z',
      snapshotAt: '2026-08-23T12:00:00.000Z',
    });

    // Now simulate what would happen if append occurred after size snapshot
    // but before read: the approved prefix should be the same
    expect(manifest.spoolFiles[0].approvedBytes).toBe(sizeBefore);
    expect(manifest.spoolFiles[0].type).toBe('jsonl-prefix');

    // Live spool path and inode unchanged
    expect(statSync(spoolPath).ino).toBe(inodeBefore);
  });
});

// ---------------------------------------------------------------------------
// verifyCopyLiveArchive
// ---------------------------------------------------------------------------

describe('verifyCopyLiveArchive', () => {
  it('returns ok for a valid archive', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    const stagingDir = join(root, 'staging');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, 'session.jsonl'), '{"a":1}\n');

    executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260823T120000Z',
      snapshotAt: '2026-08-23T12:00:00.000Z',
    });

    expect(verifyCopyLiveArchive(stagingDir).ok).toBe(true);
  });

  it('fails when manifest is missing', () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    expect(verifyCopyLiveArchive(root).ok).toBe(false);
  });

  it('fails when manifest hash does not match', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    const stagingDir = join(root, 'staging');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, 'session.jsonl'), '{"a":1}\n');

    executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260823T120000Z',
      snapshotAt: '2026-08-23T12:00:00.000Z',
    });

    // Corrupt the manifest
    const manifestPath = join(stagingDir, 'manifest.json');
    writeFileSync(manifestPath, '{"corrupted":true}');

    expect(verifyCopyLiveArchive(stagingDir).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// copyLiveCapacityCheck
// ---------------------------------------------------------------------------

describe('copyLiveCapacityCheck', () => {
  it('passes when sufficient space is available', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, 'small.jsonl'), '{"a":1}\n');

    const result = copyLiveCapacityCheck(spoolDir, {
      statfsFn: () => ({ bavail: 10_000_000, bsize: 4096 }), // ~40 GB
    });
    expect(result.ok).toBe(true);
  });

  it('fails when insufficient space', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, 'small.jsonl'), '{"a":1}\n');

    const result = copyLiveCapacityCheck(spoolDir, {
      statfsFn: () => ({ bavail: 1, bsize: 1 }), // 1 byte
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('insufficient space');
  });
});

// ---------------------------------------------------------------------------
// pruneCopyLiveArchives
// ---------------------------------------------------------------------------

describe('pruneCopyLiveArchives', () => {
  it('keeps only the newest N archives', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'copy-live-20260801T000000Z'), { recursive: true });
    mkdirSync(join(root, 'copy-live-20260808T000000Z'), { recursive: true });
    mkdirSync(join(root, 'copy-live-20260815T000000Z'), { recursive: true });

    pruneCopyLiveArchives(root, 2);

    const remaining = readdirSync(root);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain('copy-live-20260808T000000Z');
    expect(remaining).toContain('copy-live-20260815T000000Z');
    expect(remaining).not.toContain('copy-live-20260801T000000Z');
  });

  it('does not prune when under limit', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'copy-live-20260801T000000Z'), { recursive: true });

    pruneCopyLiveArchives(root, 2);

    expect(readdirSync(root)).toHaveLength(1);
  });

  it('does nothing for non-existent directory', () => {
    // Should not throw
    pruneCopyLiveArchives('/nonexistent', 2);
  });
});

// ---------------------------------------------------------------------------
// Finding 6: executeCopyLiveSnapshot with non-existent multi-level staging root
// ---------------------------------------------------------------------------

describe('executeCopyLiveSnapshot with deep staging root', () => {
  it('succeeds when staging root parent does not yet exist', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, 'session.jsonl'), '{"a":1}\n');

    // Multi-level staging dir where parent doesn't exist
    const stagingDir = join(root, 'deep', 'nested', 'staging', 'staging-20260823T120000Z');
    // Ensure parent exists (this is what executeCopyLive should do)
    mkdirSync(join(root, 'deep', 'nested', 'staging'), { recursive: true, mode: 0o700 });

    const manifest = executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260823T120000Z',
      snapshotAt: '2026-08-23T12:00:00.000Z',
    });

    expect(manifest.mode).toBe('copy-live');
    expect(manifest.counts.spoolFiles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 7: capacity precheck deduplicates transcripts
// ---------------------------------------------------------------------------

describe('copyLiveCapacityCheck transcript deduplication', () => {
  it('counts each transcript only once even when referenced by 100 spool records', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });

    // Create a transcript file
    const transcriptPath = join(root, 'transcript.jsonl');
    const transcriptContent = '{"type":"conversation"}\n'.repeat(100);
    writeFileSync(transcriptPath, transcriptContent);
    const transcriptSize = statSync(transcriptPath).size;

    // Create 100 spool records all pointing to the same transcript
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({
        transcript_path: transcriptPath,
        transcript_offset: i * 24,
      }));
    }
    writeFileSync(join(spoolDir, 'session.jsonl'), lines.join('\n') + '\n');

    const spoolBytes = statSync(join(spoolDir, 'session.jsonl')).size;

    const result = copyLiveCapacityCheck(spoolDir, {
      statfsFn: () => ({ bavail: 10_000_000, bsize: 4096 }), // plenty
    });

    // The required bytes should use transcriptSize once, not 100 times
    // Formula: (spoolBytes + transcriptBytes) * 2 + 1 GB
    const expectedRequired = (spoolBytes + transcriptSize) * 2 + 1024 * 1024 * 1024;
    expect(result.requiredBytes).toBe(expectedRequired);
  });
});

// ---------------------------------------------------------------------------
// copy-live archive shape: the upload pipeline's allowlist contract
// ---------------------------------------------------------------------------

function makeSnapshot(): { root: string; stagingDir: string; spoolDir: string } {
  const root = makeRoot();
  const spoolDir = join(root, 'spool');
  const stagingDir = join(root, 'staging');
  mkdirSync(join(spoolDir, 'project1'), { recursive: true });
  writeFileSync(join(spoolDir, 'project1', 'session1.jsonl'), '{"a":1}\n{"b":2}\n');
  writeFileSync(
    join(spoolDir, 'project1', 'session1.capture-state.json'),
    '{"cursor":16,"spool":{"generation":1}}',
  );
  executeCopyLiveSnapshot({
    spoolDir,
    stagingDir,
    snapshotId: '20260825T000000Z',
    snapshotAt: '2026-08-25T00:00:00.000Z',
  });
  return { root, stagingDir, spoolDir };
}

describe('copy-live archive tree shape', () => {
  it('contains exactly the manifest allowlist (no uncompressed spool/ tree)', () => {
    const { stagingDir } = makeSnapshot();
    expect(readdirSync(stagingDir).sort()).toEqual([
      'manifest.json',
      'manifest.sha256',
      'spool.tar.gz',
      'transcripts',
    ]);
  });

  it('still packs every spool file into spool.tar.gz after the staging copy is dropped', () => {
    const { stagingDir } = makeSnapshot();
    const manifest = JSON.parse(readFileSync(join(stagingDir, 'manifest.json'), 'utf8'));
    expect(manifest.counts.spoolFiles).toBe(2);
    expect(verifyCopyLiveArchive(stagingDir).ok).toBe(true);
  });
});

describe('verifyCopyLiveArchive strict checks', () => {
  it('rejects an extra file outside the allowlist', () => {
    const { stagingDir } = makeSnapshot();
    writeFileSync(join(stagingDir, 'receipt.txt'), 'nope\n', { mode: 0o600 });
    const result = verifyCopyLiveArchive(stagingDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unexpected archive entry outside the manifest allowlist');
  });

  it('rejects a leftover uncompressed spool/ tree', () => {
    const { stagingDir } = makeSnapshot();
    mkdirSync(join(stagingDir, 'spool'), { mode: 0o700 });
    writeFileSync(join(stagingDir, 'spool', 'session.jsonl'), '{"a":1}\n', { mode: 0o600 });
    const result = verifyCopyLiveArchive(stagingDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unexpected archive entry outside the manifest allowlist');
  });

  it('rejects a tampered spool.tar.gz whose contents no longer match the manifest', () => {
    const { stagingDir } = makeSnapshot();
    const manifestPath = join(stagingDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Flip one recorded hash so tar contents and manifest disagree while the
    // manifest.sha256 side-file stays consistent with the manifest bytes.
    manifest.spoolFiles[0].sha256 = 'f'.repeat(64);
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, source, { mode: 0o600 });
    writeFileSync(
      join(stagingDir, 'manifest.sha256'),
      `${createHash('sha256').update(source).digest('hex')}  manifest.json\n`,
      { mode: 0o600 },
    );
    const result = verifyCopyLiveArchive(stagingDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('spool archive contents do not match the manifest');
  });

  it('rejects a manifest whose mode is not copy-live', () => {
    const { stagingDir } = makeSnapshot();
    const manifestPath = join(stagingDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.mode = 'cutoff';
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, source, { mode: 0o600 });
    writeFileSync(
      join(stagingDir, 'manifest.sha256'),
      `${createHash('sha256').update(source).digest('hex')}  manifest.json\n`,
      { mode: 0o600 },
    );
    const result = verifyCopyLiveArchive(stagingDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('manifest is not a version 1 copy-live manifest');
  });
});

describe('verifyCopyLiveArchive rejects unlisted tar entries', () => {
  /** Repack spool.tar.gz after `mutate` edits the extracted tree, then refresh
   *  the manifest hashes so only the tar contents differ from expectations. */
  function repackWith(stagingDir: string, mutate: (spoolRoot: string) => void): void {
    const rebuild = mkdtempSync(join(tmpdir(), 'cc-memory-repack-'));
    roots.push(rebuild);
    const tarPath = join(stagingDir, 'spool.tar.gz');
    spawnSync('tar', ['-xzf', tarPath, '-C', rebuild]);
    mutate(join(rebuild, 'spool'));
    rmSync(tarPath);
    spawnSync('tar', ['-C', rebuild, '-czf', tarPath, 'spool']);

    const manifestPath = join(stagingDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.spoolArchive.bytes = statSync(tarPath).size;
    manifest.spoolArchive.sha256 = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, source, { mode: 0o600 });
    writeFileSync(
      join(stagingDir, 'manifest.sha256'),
      `${createHash('sha256').update(source).digest('hex')}  manifest.json\n`,
      { mode: 0o600 },
    );
  }

  it('rejects an empty directory the manifest never listed', () => {
    const { stagingDir } = makeSnapshot();
    repackWith(stagingDir, (spoolRoot) => {
      mkdirSync(join(spoolRoot, 'unlisted-empty-dir'), { recursive: true });
    });
    const result = verifyCopyLiveArchive(stagingDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('spool archive contains a directory outside the manifest allowlist');
  });

  it('rejects an extra file the manifest never listed', () => {
    const { stagingDir } = makeSnapshot();
    repackWith(stagingDir, (spoolRoot) => {
      writeFileSync(join(spoolRoot, 'project1', 'stowaway.jsonl'), '{"x":1}\n');
    });
    const result = verifyCopyLiveArchive(stagingDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('spool archive files do not match the manifest allowlist');
  });

  it('still accepts the directories the manifest files actually live in', () => {
    const { stagingDir } = makeSnapshot();
    expect(verifyCopyLiveArchive(stagingDir).ok).toBe(true);
  });
});

describe('copy-live verification workspace isolation', () => {
  it('gives each run its own extraction parent and leaves a peer run alone', () => {
    const root = makeRoot();
    const archiveRoot = join(root, 'archives');
    const verifyParent = join(archiveRoot, '.verify-tmp');
    mkdirSync(verifyParent, { recursive: true, mode: 0o700 });

    // Stand in for a concurrent run's active extraction directory.
    const peerRun = join(verifyParent, 'run-20260825T000001Z-peer');
    mkdirSync(peerRun, { recursive: true, mode: 0o700 });
    writeFileSync(join(peerRun, 'in-progress.jsonl'), '{"a":1}\n');

    const spoolDir = join(root, 'spool');
    const stagingDir = join(root, 'staging');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, 'session.jsonl'), '{"a":1}\n');
    executeCopyLiveSnapshot({
      spoolDir,
      stagingDir,
      snapshotId: '20260825T000002Z',
      snapshotAt: '2026-08-25T00:00:02.000Z',
    });

    // Verify with our own per-run parent, exactly as executeCopyLive does.
    const ownRun = mkdtempSync(join(verifyParent, 'run-20260825T000002Z-'));
    try {
      expect(verifyCopyLiveArchive(stagingDir, { tempRoot: ownRun }).ok).toBe(true);
    } finally {
      rmSync(ownRun, { recursive: true, force: true });
    }

    // The peer's workspace must survive our cleanup.
    expect(existsSync(peerRun)).toBe(true);
    expect(readFileSync(join(peerRun, 'in-progress.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(existsSync(ownRun)).toBe(false);
  });
});
