import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseDotenv } from 'dotenv';
import { verifyCaptureEpochArchive } from './archive-capture-backlog.js';

interface UploadOptions {
  archiveDir: string;
  json: boolean;
}

interface SourceArchiveManifest {
  version: number;
  cutoffId: string;
  cutoffAt: string;
  counts: {
    spoolFiles: number;
    transcriptsReferenced: number;
    transcriptsSnapshotted: number;
    transcriptsUnrecoverable: number;
  };
}

interface SourceArchiveEvidence extends SourceArchiveManifest {
  manifestSha256: string;
}

const CUTOFF_ID = /^\d{8}T\d{6}Z$/;

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]): UploadOptions {
  const archiveDir = optionValue(args, '--archive-dir');
  if (!archiveDir) throw new Error('--archive-dir is required');
  const known = new Set(['--archive-dir', '--json']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--archive-dir') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--archive-dir=')) continue;
    if (!known.has(arg)) throw new Error(`unknown argument: ${arg}`);
  }
  return { archiveDir: resolve(archiveDir), json: args.includes('--json') };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readSecureFile(path: string, label: string, privateFile: boolean): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${label} must be a regular file (symlinks are not accepted)`);
    const forbiddenMode = privateFile ? 0o077 : 0o022;
    if ((info.mode & forbiddenMode) !== 0) {
      throw new Error(
        privateFile
          ? `${label} must not be accessible by group or others`
          : `${label} must not be writable by group or others`,
      );
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must be a regular file (symlinks are not accepted)`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function loadCredentialFiles(): void {
  const r2Keys = [
    'CC_MEMORY_R2_BUCKET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ENDPOINT_URL',
    'AWS_DEFAULT_REGION',
  ] as const;
  if (r2Keys.some((name) => !process.env[name]?.trim())) {
    const path = resolve(
      process.env.CC_MEMORY_R2_ENV_FILE ?? join(homedir(), '.ccm-r2.env'),
    );
    const parsed = parseDotenv(readSecureFile(path, 'R2 credential file', true));
    for (const name of r2Keys) {
      if (!process.env[name]?.trim() && parsed[name]?.trim()) process.env[name] = parsed[name]!.trim();
    }
  }
  if (!process.env.CC_MEMORY_AGE_RECIPIENT?.trim()) {
    const path = resolve(
      process.env.CC_MEMORY_AGE_RECIPIENT_FILE ??
        join(homedir(), '.config', 'cc-memory', 'age-recipient.txt'),
    );
    process.env.CC_MEMORY_AGE_RECIPIENT = readSecureFile(
      path,
      'age recipient file',
      false,
    ).trim();
  }
}

function sha256File(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function firstLine(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const buffer = Buffer.alloc(128);
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  } finally {
    closeSync(fd);
  }
}

function runCommand(command: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  stdoutFile?: string;
} = {}): void {
  const outputFd = options.stdoutFile === undefined
    ? undefined
    : openSync(options.stdoutFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    const result = spawnSync(command, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', outputFd ?? 'ignore', 'pipe'],
      encoding: outputFd === undefined ? 'utf8' : undefined,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const stderr = typeof result.stderr === 'string'
        ? result.stderr.trim()
        : Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
      throw new Error(`${basename(command)} failed with exit ${result.status ?? 1}${stderr ? `: ${stderr}` : ''}`);
    }
  } finally {
    if (outputFd !== undefined) {
      try {
        closeSync(outputFd);
      } catch {
        // The child result remains authoritative; cleanup handles a partial file.
      }
    }
  }
}

function assertPrivateRegularTree(root: string): void {
  const visit = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw new Error(`capture archive must not contain symlinks: ${path}`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`capture archive entry must not be accessible by group or others: ${path}`);
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`capture archive entry must be a regular single-link file: ${path}`);
    }
  };
  visit(root);
}

function directoryBytes(root: string): number {
  let total = 0;
  const visit = (path: string): void => {
    const info = statSync(path);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    total += info.size;
  };
  visit(root);
  return total;
}

function assertTmpfsCapacity(tmpDir: string, archiveDir: string): void {
  const df = process.env.DF_BIN ?? 'df';
  const result = spawnSync(df, ['-Pk', tmpDir], { encoding: 'utf8' });
  const lines = result.stdout.trim().split(/\r?\n/);
  const fields = lines.at(-1)?.trim().split(/\s+/) ?? [];
  const availableBytes = Number(fields[3]) * 1024;
  if (result.status !== 0 || !Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error('could not determine tmpfs free bytes');
  }
  const requiredBytes = directoryBytes(archiveDir) * 3 + 64 * 1024 * 1024;
  if (availableBytes < requiredBytes) {
    throw new Error(`insufficient tmpfs capacity: available=${availableBytes} required=${requiredBytes}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const relpath = relative(parent, child);
  return relpath === '' || (
    relpath !== '..' &&
    !relpath.startsWith(`..${sep}`) &&
    !isAbsolute(relpath)
  );
}

function assertNonOverlappingDirectories(archiveDir: string, tmpDir: string): void {
  const archiveReal = realpathSync(archiveDir);
  const tmpReal = realpathSync(tmpDir);
  if (containsPath(archiveReal, tmpReal) || containsPath(tmpReal, archiveReal)) {
    throw new Error('capture archive and CC_BACKLOG_UPLOAD_TMP_DIR must not overlap');
  }
}

function parseSourceManifest(archiveDir: string): SourceArchiveEvidence {
  const manifestSource = readFileSync(join(archiveDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestSource) as SourceArchiveManifest;
  if (manifest.version !== 1 || !CUTOFF_ID.test(manifest.cutoffId)) {
    throw new Error('capture archive manifest has an invalid version or cutoffId');
  }
  return {
    ...manifest,
    manifestSha256: createHash('sha256').update(manifestSource).digest('hex'),
  };
}

function readSourceManifest(archiveDir: string, tempRoot: string): SourceArchiveEvidence {
  const info = lstatSync(archiveDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('capture archive must be a real directory');
  }
  assertPrivateRegularTree(archiveDir);
  const verification = verifyCaptureEpochArchive(archiveDir, { tempRoot });
  if (!verification.ok) {
    throw new Error(`capture archive verification failed: ${verification.reason ?? 'unknown'}`);
  }
  return parseSourceManifest(archiveDir);
}

function verifyPackagedArchive(
  plainPath: string,
  tempRoot: string,
  tar: string,
): SourceArchiveEvidence {
  const listed = spawnSync(tar, ['--quoting-style=literal', '-tzf', plainPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error('packaged archive listing failed');
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => {
    const normalized = entry.split('\\').join('/');
    const canonical = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
    return (
      /\p{Cc}/u.test(normalized) ||
      isAbsolute(normalized) ||
      canonical === '..' ||
      canonical.startsWith('../') ||
      canonical.includes('/../')
    );
  })) {
    throw new Error('packaged archive contains an unsafe path');
  }
  const verbose = spawnSync(tar, ['--quoting-style=literal', '-tvzf', plainPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const verboseEntries = verbose.stdout.split(/\r?\n/).filter(Boolean);
  if (
    verbose.status !== 0 ||
    verboseEntries.length !== entries.length ||
    verboseEntries.some((entry) => entry[0] !== 'd' && entry[0] !== '-')
  ) {
    throw new Error('packaged archive contains an unexpected entry type');
  }
  const extractionRoot = mkdtempSync(join(tempRoot, 'package-verify-'));
  try {
    runCommand(tar, ['-xzf', plainPath, '-C', extractionRoot]);
    const topLevel = readdirSync(extractionRoot, { withFileTypes: true });
    if (topLevel.length !== 1 || !topLevel[0].isDirectory()) {
      throw new Error('packaged archive must contain exactly one archive root');
    }
    const packagedArchive = join(extractionRoot, topLevel[0].name);
    const verification = verifyCaptureEpochArchive(packagedArchive, { tempRoot });
    if (!verification.ok) {
      throw new Error(`packaged archive verification failed: ${verification.reason ?? 'unknown'}`);
    }
    return parseSourceManifest(packagedArchive);
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function rcloneEnv(): NodeJS.ProcessEnv {
  const bucket = required('CC_MEMORY_R2_BUCKET');
  const endpoint = required('AWS_ENDPOINT_URL');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    throw new Error('CC_MEMORY_R2_BUCKET is invalid');
  }
  if (!/^https:\/\/\S+$/.test(endpoint)) {
    throw new Error('AWS_ENDPOINT_URL must be an https URL without whitespace');
  }
  return {
    ...process.env,
    RCLONE_CONFIG_CCMR2_TYPE: 's3',
    RCLONE_CONFIG_CCMR2_PROVIDER: 'Cloudflare',
    RCLONE_CONFIG_CCMR2_ACCESS_KEY_ID: required('AWS_ACCESS_KEY_ID'),
    RCLONE_CONFIG_CCMR2_SECRET_ACCESS_KEY: required('AWS_SECRET_ACCESS_KEY'),
    RCLONE_CONFIG_CCMR2_ENDPOINT: endpoint,
    RCLONE_CONFIG_CCMR2_REGION: required('AWS_DEFAULT_REGION'),
    RCLONE_CONFIG_CCMR2_NO_CHECK_BUCKET: 'true',
  };
}

function reexecUnderFlock(options: UploadOptions, tmpDir: string): number | null {
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  chmodSync(tmpDir, 0o700);
  const lockFile = join(tmpDir, '.cc-memory-backlog-upload.lock');
  const flock = process.env.FLOCK_BIN ?? '/usr/bin/flock';
  if (process.env.CC_MEMORY_BACKLOG_UPLOAD_LOCK_PATH !== undefined) {
    const lockInfo = statSync(lockFile);
    const matchingFd = readdirSync('/proc/self/fd').find((rawFd) => {
      const fd = Number(rawFd);
      if (!Number.isSafeInteger(fd) || fd < 3) return false;
      try {
        const info = fstatSync(fd);
        return info.isFile() && info.dev === lockInfo.dev && info.ino === lockInfo.ino;
      } catch {
        return false;
      }
    });
    if (matchingFd === undefined) {
      throw new Error('inherited upload lock fd does not match the lock file');
    }
    const fdInfo = readFileSync(`/proc/self/fdinfo/${matchingFd}`, 'utf8');
    const lockPattern = new RegExp(
      `^lock:\\s+\\d+: FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s+[^:]+:[^:]+:${lockInfo.ino}\\s`,
      'm',
    );
    if (!lockPattern.test(fdInfo)) {
      throw new Error('inherited upload lock fd is not exclusively locked');
    }
    return null;
  }
  const child = spawnSync(
    flock,
    [
      '-F', '-n', '-E', '73', lockFile,
      process.execPath, '--import', 'tsx', process.argv[1]!,
      '--archive-dir', options.archiveDir,
      ...(options.json ? ['--json'] : []),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CC_MEMORY_BACKLOG_UPLOAD_LOCK_PATH: lockFile,
      },
    },
  );
  if (child.error) throw new Error(`failed to start upload flock: ${child.error.message}`);
  if (child.status === 73) {
    process.stderr.write(`[upload-capture-backlog] lock busy: ${lockFile}\n`);
    return 3;
  }
  return child.status ?? 1;
}

function sweepOrphanRunDirectories(tmpDir: string): void {
  const prefixes = ['cc-memory-backlog-', 'cc-memory-archive-verify-'];
  for (const name of readdirSync(tmpDir)) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const candidate = join(tmpDir, name);
    const info = lstatSync(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    rmSync(candidate, { recursive: true, force: true });
  }
}

function execute(options: UploadOptions): number {
  process.umask(0o077);
  loadCredentialFiles();
  const tmpDir = resolve(required('CC_BACKLOG_UPLOAD_TMP_DIR'));
  const tmpInfo = lstatSync(tmpDir);
  if (!tmpInfo.isDirectory() || tmpInfo.isSymbolicLink()) {
    throw new Error('CC_BACKLOG_UPLOAD_TMP_DIR must be a real directory');
  }
  const findmnt = process.env.FINDMNT_BIN ?? 'findmnt';
  const fsType = spawnSync(findmnt, ['-n', '-o', 'FSTYPE', '--target', tmpDir], {
    encoding: 'utf8',
  });
  if (fsType.status !== 0 || fsType.stdout.trim() !== 'tmpfs') {
    throw new Error('CC_BACKLOG_UPLOAD_TMP_DIR must be mounted as tmpfs');
  }
  assertNonOverlappingDirectories(options.archiveDir, tmpDir);

  const flockStatus = reexecUnderFlock(options, tmpDir);
  if (flockStatus !== null) return flockStatus;
  sweepOrphanRunDirectories(tmpDir);

  const recipient = required('CC_MEMORY_AGE_RECIPIENT');
  if (!/^age1[0-9a-z]+$/.test(recipient)) {
    throw new Error('CC_MEMORY_AGE_RECIPIENT is not a valid age X25519 recipient');
  }
  const source = readSourceManifest(options.archiveDir, tmpDir);
  assertTmpfsCapacity(tmpDir, options.archiveDir);
  const remoteEnv = rcloneEnv();
  const suffix = process.env.CC_BACKLOG_UPLOAD_RUN_SUFFIX?.trim() || randomBytes(8).toString('hex');
  if (!/^[0-9a-f]{16}$/.test(suffix)) {
    throw new Error('CC_BACKLOG_UPLOAD_RUN_SUFFIX must be 16 lowercase hex characters');
  }
  const year = source.cutoffId.slice(0, 4);
  const month = source.cutoffId.slice(4, 6);
  const runId = `${source.cutoffId}-${suffix}`;
  const objectKey = `backups/v1/backlog/${year}/${month}/${runId}.tar.gz.age`;
  const bucket = required('CC_MEMORY_R2_BUCKET');
  const remoteCipher = `ccmr2:${bucket}/${objectKey}`;
  const runDir = mkdtempSync(join(tmpDir, `cc-memory-backlog-${runId}-`));
  chmodSync(runDir, 0o700);
  try {
    const plainPath = join(runDir, `${runId}.tar.gz`);
    const cipherPath = `${plainPath}.age`;
    const readbackPath = join(runDir, `${runId}.remote.age`);
    const manifestPath = join(runDir, `${runId}.manifest.json`);
    const manifestReadbackPath = join(runDir, `${runId}.remote.manifest.json`);
    const tar = process.env.TAR_BIN ?? 'tar';
    runCommand(tar, [
      '-C', dirname(options.archiveDir),
      '-czf', plainPath,
      '--', basename(options.archiveDir),
    ]);
    const packagedSource = verifyPackagedArchive(plainPath, runDir, tar);
    if (packagedSource.manifestSha256 !== source.manifestSha256) {
      throw new Error('packaged archive source manifest changed after initial verification');
    }
    const plainBytes = statSync(plainPath).size;
    const plainSha256 = sha256File(plainPath);

    const age = process.env.AGE_BIN ?? 'age';
    runCommand(age, ['-r', recipient, '-o', cipherPath, plainPath]);
    const ageHeader = firstLine(cipherPath);
    if (ageHeader !== 'age-encryption.org/v1') {
      throw new Error('ciphertext does not have an age v1 header');
    }
    rmSync(plainPath);
    const cipherBytes = statSync(cipherPath).size;
    const cipherSha256 = sha256File(cipherPath);

    const rclone = process.env.RCLONE_BIN ?? 'rclone';
    runCommand(rclone, ['copyto', cipherPath, remoteCipher, '--config', '/dev/null', '--no-traverse', '--immutable'], { env: remoteEnv });
    runCommand(rclone, ['cat', remoteCipher, '--config', '/dev/null'], { env: remoteEnv, stdoutFile: readbackPath });
    const remoteBytes = statSync(readbackPath).size;
    const remoteSha256 = sha256File(readbackPath);
    if (remoteBytes !== cipherBytes || remoteSha256 !== cipherSha256) {
      throw new Error('remote ciphertext full-readback mismatch');
    }
    rmSync(readbackPath);

    const date = process.env.DATE_BIN ?? 'date';
    const completed = spawnSync(date, ['-u', '+%Y-%m-%dT%H:%M:%SZ'], { encoding: 'utf8' });
    if (completed.status !== 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(completed.stdout.trim())) {
      throw new Error('date command returned an invalid UTC timestamp');
    }
    const manifest = {
      schema_version: 1,
      target: 'backlog',
      run_id: runId,
      source_cutoff_id: packagedSource.cutoffId,
      source_cutoff_at: packagedSource.cutoffAt,
      source_manifest_sha256: packagedSource.manifestSha256,
      completed_at: completed.stdout.trim(),
      object_key: objectKey,
      archive_counts: packagedSource.counts,
      plain: { bytes: plainBytes, sha256: plainSha256, format: 'tar.gz' },
      cipher: { bytes: cipherBytes, sha256: cipherSha256 },
      age_recipient: recipient,
      remote_verification: {
        bytes: remoteBytes,
        sha256: remoteSha256,
        method: 'full-readback',
      },
    };
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestSource, { mode: 0o600, flag: 'wx' });
    const manifestSha256 = sha256File(manifestPath);
    const manifestKey = `backups/v1/backlog/${year}/${month}/${runId}.manifest.${manifestSha256}.json`;
    const remoteManifest = `ccmr2:${bucket}/${manifestKey}`;
    runCommand(rclone, ['copyto', manifestPath, remoteManifest, '--config', '/dev/null', '--no-traverse', '--immutable'], { env: remoteEnv });
    runCommand(rclone, ['cat', remoteManifest, '--config', '/dev/null'], { env: remoteEnv, stdoutFile: manifestReadbackPath });
    if (sha256File(manifestReadbackPath) !== manifestSha256) {
      throw new Error('remote manifest full-readback mismatch');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, runId, objectKey, manifestKey }, null, options.json ? 0 : 2)}\n`);
    return 0;
  } finally {
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  }
}

function main(): number {
  return execute(parseArgs(process.argv.slice(2)));
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `[upload-capture-backlog] failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
