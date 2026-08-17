import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveCaptureEpoch } from '../../scripts/archive-capture-backlog.js';

const REPO_ROOT = process.cwd();
const UPLOAD_SCRIPT = join(REPO_ROOT, 'scripts', 'upload-capture-backlog.ts');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

describe('encrypted R2 backlog archive upload CLI', () => {
  let root: string;
  let binDir: string;
  let workDir: string;
  let remoteDir: string;
  let archiveDir: string;
  let commandLog: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-memory-backlog-upload-'));
    binDir = join(root, 'bin');
    workDir = join(root, 'work');
    remoteDir = join(root, 'remote');
    commandLog = join(root, 'commands.log');
    const epochDir = join(root, 'epoch');
    archiveDir = join(root, 'backlog-cutoff-20260817T100000Z');
    mkdirSync(binDir);
    mkdirSync(workDir);
    mkdirSync(remoteDir);
    mkdirSync(join(epochDir, 'project'), { recursive: true });
    writeFileSync(join(epochDir, 'project', 'session.jsonl'), '{}\n', 'utf8');
    archiveCaptureEpoch({
      epochDir,
      archiveDir,
      cutoffId: '20260817T100000Z',
      cutoffAt: '2026-08-17T10:00:00.000Z',
      approval: { approvedBy: 'haha', approvalSha256: 'approval-hash' },
    });

    writeExecutable(join(binDir, 'fake-findmnt'), `#!/usr/bin/env bash
set -euo pipefail
printf 'findmnt %s\\n' "$*" >> "$COMMAND_LOG"
printf 'tmpfs\\n'
`);
    writeExecutable(join(binDir, 'fake-df'), `#!/usr/bin/env bash
set -euo pipefail
printf 'df %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'
printf '%s\\n' 'tmpfs 4194304 0 4194304 0% /work'
`);
    writeExecutable(join(binDir, 'fake-age'), `#!/usr/bin/env bash
set -euo pipefail
printf 'age %s\\n' "$*" >> "$COMMAND_LOG"
output=''
input=''
while (($#)); do
  case "$1" in
    -r) shift 2 ;;
    -o) output="$2"; shift 2 ;;
    *) input="$1"; shift ;;
  esac
done
test -n "$output" && test -n "$input"
if [[ "${'${AGE_MUTATE_ARCHIVE_MANIFEST:-0}'}" == 1 ]]; then
  printf 'mutated after package verification\n' > "$MUTATE_ARCHIVE_DIR/manifest.json"
fi
printf 'age-encryption.org/v1\\n' > "$output"
cat "$input" >> "$output"
`);
    writeExecutable(join(binDir, 'fake-rclone'), `#!/usr/bin/env bash
set -euo pipefail
printf 'rclone %s\\n' "$*" >> "$COMMAND_LOG"
command="$1"
shift
case "$command" in
  copyto)
    source="$1"
    destination="$2"
    relative="${'${destination#ccmr2:}'}"
    target="$FAKE_REMOTE_DIR/$relative"
    mkdir -p "$(dirname "$target")"
    if [[ -e "$target" && " $* " == *' --immutable '* ]]; then
      printf 'immutable object already exists\\n' >&2
      exit 9
    fi
    cp "$source" "$target"
    ;;
  cat)
    source="$1"
    relative="${'${source#ccmr2:}'}"
    if [[ "${'${RCLONE_TAMPER_READBACK:-0}'}" == 1 && "$source" == *.tar.gz.age ]]; then
      printf 'tampered'
    elif [[ "${'${RCLONE_TAMPER_MANIFEST_READBACK:-0}'}" == 1 && "$source" == *.manifest.*.json ]]; then
      printf 'tampered'
    else
      cat "$FAKE_REMOTE_DIR/$relative"
    fi
    ;;
  *) exit 64 ;;
esac
`);
    writeExecutable(join(binDir, 'fake-date'), `#!/usr/bin/env bash
set -euo pipefail
case "${'${*: -1}'}" in
  +%Y%m%dT%H%M%SZ) printf '20260817T101500Z\\n' ;;
  +%Y-%m-%dT%H:%M:%SZ) printf '2026-08-17T10:15:00Z\\n' ;;
  *) exit 64 ;;
esac
`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(overrides: NodeJS.ProcessEnv = {}, inheritedFd?: number) {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      COMMAND_LOG: commandLog,
      FAKE_REMOTE_DIR: remoteDir,
      CC_BACKLOG_UPLOAD_TMP_DIR: workDir,
      CC_BACKLOG_UPLOAD_RUN_SUFFIX: 'abcdef0123456789',
      CC_MEMORY_AGE_RECIPIENT:
        'age1t84j9vcpj2es3tnhrqmye945kjj9swqfaqyhdt5ulslnrcly0vrqhetl7f',
      CC_MEMORY_R2_BUCKET: 'cc-memory-backups',
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com',
      AWS_DEFAULT_REGION: 'auto',
      FINDMNT_BIN: join(binDir, 'fake-findmnt'),
      DF_BIN: join(binDir, 'fake-df'),
      AGE_BIN: join(binDir, 'fake-age'),
      RCLONE_BIN: join(binDir, 'fake-rclone'),
      DATE_BIN: join(binDir, 'fake-date'),
      ...overrides,
    };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[key];
    }
    const stdio: Array<'ignore' | 'pipe' | number> | undefined = inheritedFd === undefined
      ? undefined
      : [
        'ignore', 'pipe', 'pipe',
        'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', inheritedFd,
      ];
    return spawnSync(
      process.execPath,
      [
        ...(inheritedFd === undefined ? [TSX_CLI] : ['--import', 'tsx']),
        UPLOAD_SCRIPT, '--archive-dir', archiveDir, '--json',
      ],
      {
        env: childEnv,
        encoding: 'utf8',
        stdio,
      },
    );
  }

  it('verifies, encrypts, fully reads back, and commits the manifest last', () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      objectKey: string;
      manifestKey: string;
    };
    expect(output).toMatchObject({
      ok: true,
      objectKey: expect.stringMatching(
        /^backups\/v1\/backlog\/2026\/08\/20260817T100000Z-abcdef0123456789\.tar\.gz\.age$/,
      ),
      manifestKey: expect.stringMatching(/\.manifest\.[0-9a-f]{64}\.json$/),
    });

    const log = readFileSync(commandLog, 'utf8');
    expect(log).toContain('findmnt ');
    expect(log).toContain('df ');
    const ageAt = log.indexOf('age ');
    const cipherUploadAt = log.indexOf('rclone copyto', ageAt);
    const cipherReadbackAt = log.indexOf('rclone cat', cipherUploadAt);
    const manifestUploadAt = log.lastIndexOf('rclone copyto');
    expect(ageAt).toBeGreaterThanOrEqual(0);
    expect(cipherUploadAt).toBeGreaterThan(ageAt);
    expect(cipherReadbackAt).toBeGreaterThan(cipherUploadAt);
    expect(manifestUploadAt).toBeGreaterThan(cipherReadbackAt);

    const files = readdirSync(remoteDir, { recursive: true, withFileTypes: false })
      .map(String);
    const manifestPath = files.find((name) => name.includes('.manifest.'));
    expect(manifestPath).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(remoteDir, manifestPath!), 'utf8')) as {
      schema_version: number;
      target: string;
      source_cutoff_id: string;
      cipher: { bytes: number; sha256: string };
      remote_verification: { bytes: number; sha256: string; method: string };
    };
    expect(manifest).toMatchObject({
      schema_version: 1,
      target: 'backlog',
      source_cutoff_id: '20260817T100000Z',
    });
    expect(manifest.remote_verification).toMatchObject({
      ...manifest.cipher,
      method: 'full-readback',
    });
    const embeddedHash = manifestPath!.match(/\.manifest\.([0-9a-f]{64})\.json$/)?.[1];
    expect(embeddedHash).toBe(
      createHash('sha256').update(readFileSync(join(remoteDir, manifestPath!))).digest('hex'),
    );
    expect(readdirSync(workDir)).toEqual(['.cc-memory-backlog-upload.lock']);
    expect(existsSync(archiveDir)).toBe(true);
  });

  it('rejects a symlink inside the verified archive before encryption or upload', () => {
    const outside = join(root, 'outside-secret');
    writeFileSync(outside, 'must not be archived', 'utf8');
    symlinkSync(outside, join(archiveDir, 'unexpected-link'));

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink|regular file/i);
    const log = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
    expect(log).not.toContain('age ');
    expect(log).not.toContain('rclone ');
  });

  it('rejects archive and tmp directories that overlap', () => {
    const result = run({ CC_BACKLOG_UPLOAD_TMP_DIR: root });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must not overlap/i);
    const log = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
    expect(log).not.toContain('age ');
    expect(log).not.toContain('rclone ');
  });

  it('rejects the reverse overlap where the archive contains the tmp directory', () => {
    const nestedTmp = join(archiveDir, 'nested-tmp');
    mkdirSync(nestedTmp);

    const result = run({ CC_BACKLOG_UPLOAD_TMP_DIR: nestedTmp });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must not overlap/i);
  });

  it('uses the validated tmpfs root instead of the process TMPDIR for verification', () => {
    const result = run({ TMPDIR: join(root, 'missing-process-tmpdir') });

    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a non-tmpfs upload workspace before taking the lock', () => {
    const nonTmpfs = join(binDir, 'non-tmpfs-findmnt');
    writeExecutable(nonTmpfs, '#!/usr/bin/env bash\nprintf "ext4\\n"\n');

    const result = run({ FINDMNT_BIN: nonTmpfs });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must be mounted as tmpfs/i);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('removes orphaned run directories only after acquiring the upload lock', () => {
    const orphan = join(workDir, 'cc-memory-backlog-stale-run');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'plaintext.tar.gz'), 'sensitive', { mode: 0o600 });

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
  });

  it('removes orphaned archive verifier directories after acquiring the upload lock', () => {
    const orphan = join(workDir, 'cc-memory-archive-verify-stale-run');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'plaintext.jsonl'), 'sensitive', { mode: 0o600 });

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
  });

  it('does not sweep orphaned run directories when the upload lock is busy', () => {
    const orphan = join(workDir, 'cc-memory-backlog-stale-run');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'plaintext.tar.gz'), 'sensitive', { mode: 0o600 });
    const busyFlock = join(binDir, 'busy-flock');
    writeExecutable(busyFlock, '#!/usr/bin/env bash\nexit 73\n');

    const result = run({ FLOCK_BIN: busyFlock });

    expect(result.status).toBe(3);
    expect(existsSync(join(orphan, 'plaintext.tar.gz'))).toBe(true);
  });

  it('does not allow a forged legacy lock marker to bypass a busy lock', () => {
    const orphan = join(workDir, 'cc-memory-backlog-forged-marker');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'plaintext.tar.gz'), 'sensitive', { mode: 0o600 });
    const busyFlock = join(binDir, 'busy-flock-forged-marker');
    writeExecutable(busyFlock, '#!/usr/bin/env bash\nexit 73\n');

    const result = run({
      FLOCK_BIN: busyFlock,
      CC_MEMORY_BACKLOG_UPLOAD_FLOCKED: '1',
    });

    expect(result.status).toBe(3);
    expect(existsSync(join(orphan, 'plaintext.tar.gz'))).toBe(true);
  });

  it('rejects the active lock marker when no matching fd is inherited', () => {
    const lockFile = join(workDir, '.cc-memory-backlog-upload.lock');
    writeFileSync(lockFile, '', { mode: 0o600 });

    const result = run({ CC_MEMORY_BACKLOG_UPLOAD_LOCK_PATH: lockFile });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lock fd does not match the lock file/i);
  });

  it('rejects a matching inherited fd that is not exclusively locked', () => {
    const lockFile = join(workDir, '.cc-memory-backlog-upload.lock');
    writeFileSync(lockFile, '', { mode: 0o600 });
    const fd = openSync(lockFile, 'r');
    try {
      const result = run({ CC_MEMORY_BACKLOG_UPLOAD_LOCK_PATH: lockFile }, fd);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/lock fd is not exclusively locked/i);
    } finally {
      closeSync(fd);
    }
  });

  it('does not follow or remove an orphan symlink during cleanup', () => {
    const outside = join(root, 'outside-orphan-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'plaintext.tar.gz'), 'sensitive', { mode: 0o600 });
    const orphanLink = join(workDir, 'cc-memory-backlog-symlink');
    symlinkSync(outside, orphanLink);

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(orphanLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'plaintext.tar.gz'), 'utf8')).toBe('sensitive');
  });

  it('rejects a symlinked R2 credential file without reading its target', () => {
    const credentialTarget = join(root, 'r2-target.env');
    const credentialLink = join(root, 'r2-link.env');
    writeFileSync(credentialTarget, [
      'CC_MEMORY_R2_BUCKET=cc-memory-backups',
      'AWS_ACCESS_KEY_ID=target-access',
      'AWS_SECRET_ACCESS_KEY=target-secret',
      'AWS_ENDPOINT_URL=https://example.r2.cloudflarestorage.com',
      'AWS_DEFAULT_REGION=auto',
      '',
    ].join('\n'), { mode: 0o600 });
    symlinkSync(credentialTarget, credentialLink);

    const result = run({
      CC_MEMORY_R2_ENV_FILE: credentialLink,
      CC_MEMORY_R2_BUCKET: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_ENDPOINT_URL: undefined,
      AWS_DEFAULT_REGION: undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/R2 credential file.*regular file/i);
    const log = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
    expect(log).not.toContain('age ');
    expect(log).not.toContain('rclone ');
  });

  it('does not commit a manifest when ciphertext full-readback is corrupt', () => {
    const result = run({ RCLONE_TAMPER_READBACK: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/full-readback mismatch/i);
    const files = readdirSync(remoteDir, { recursive: true, withFileTypes: false })
      .map(String);
    expect(files.some((name) => name.endsWith('.tar.gz.age'))).toBe(true);
    expect(files.some((name) => name.includes('.manifest.'))).toBe(false);
    expect(readdirSync(workDir)).toEqual(['.cc-memory-backlog-upload.lock']);
  });

  it('fails closed when a content-addressed manifest readback is corrupt', () => {
    const result = run({ RCLONE_TAMPER_MANIFEST_READBACK: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/manifest full-readback mismatch/i);
    const files = readdirSync(remoteDir, { recursive: true, withFileTypes: false })
      .map(String);
    const manifestPath = files.find((name) => name.includes('.manifest.'));
    expect(manifestPath).toBeDefined();
    const embeddedHash = manifestPath!.match(/\.manifest\.([0-9a-f]{64})\.json$/)?.[1];
    expect(embeddedHash).not.toBe(
      createHash('sha256').update('tampered').digest('hex'),
    );
  });

  it('rejects an archive mutation that occurs between source verification and packaging', () => {
    const mutatingTar = join(binDir, 'mutating-tar');
    writeExecutable(mutatingTar, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *' -czf '* ]]; then
  printf 'late secret' > "$MUTATE_ARCHIVE_DIR/late-secret.txt"
  chmod 600 "$MUTATE_ARCHIVE_DIR/late-secret.txt"
fi
exec /usr/bin/tar "$@"
`);

    const result = run({
      TAR_BIN: mutatingTar,
      MUTATE_ARCHIVE_DIR: archiveDir,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/packaged archive verification failed|unexpected archive entry/i);
    const log = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
    expect(log).not.toContain('age ');
    expect(log).not.toContain('rclone ');
  });

  it('cleans the tmpfs run directory when age encryption fails', () => {
    const failingAge = join(binDir, 'failing-age');
    writeExecutable(failingAge, '#!/usr/bin/env bash\nprintf "age failed\\n" >&2\nexit 42\n');

    const result = run({ AGE_BIN: failingAge });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/age failed with exit 42/i);
    expect(readdirSync(workDir)).toEqual(['.cc-memory-backlog-upload.lock']);
  });

  it('binds the remote manifest to packaged evidence instead of rereading the live archive', () => {
    const originalManifest = readFileSync(join(archiveDir, 'manifest.json'));
    const originalHash = createHash('sha256').update(originalManifest).digest('hex');

    const result = run({
      AGE_MUTATE_ARCHIVE_MANIFEST: '1',
      MUTATE_ARCHIVE_DIR: archiveDir,
    });

    expect(result.status, result.stderr).toBe(0);
    const files = readdirSync(remoteDir, { recursive: true, withFileTypes: false }).map(String);
    const manifestPath = files.find((name) => name.includes('.manifest.'));
    expect(manifestPath).toBeDefined();
    const remoteManifest = JSON.parse(
      readFileSync(join(remoteDir, manifestPath!), 'utf8'),
    ) as { source_manifest_sha256: string };
    expect(remoteManifest.source_manifest_sha256).toBe(originalHash);
    expect(remoteManifest.source_manifest_sha256).not.toBe(
      createHash('sha256').update(readFileSync(join(archiveDir, 'manifest.json'))).digest('hex'),
    );
  });

  it('fails closed instead of overwriting an existing immutable run', () => {
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const filesBefore = readdirSync(remoteDir, { recursive: true, withFileTypes: false })
      .map(String)
      .filter((name) => statSync(join(remoteDir, name)).isFile())
      .sort();
    const contentsBefore = new Map(
      filesBefore.map((name) => [name, readFileSync(join(remoteDir, name))]),
    );

    const retry = run();

    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toMatch(/immutable object already exists/i);
    const filesAfter = readdirSync(remoteDir, { recursive: true, withFileTypes: false })
      .map(String)
      .filter((name) => statSync(join(remoteDir, name)).isFile())
      .sort();
    expect(filesAfter).toEqual(filesBefore);
    for (const name of filesAfter) {
      expect(readFileSync(join(remoteDir, name))).toEqual(contentsBefore.get(name));
    }
    expect(readdirSync(workDir)).toEqual(['.cc-memory-backlog-upload.lock']);
  });
});
