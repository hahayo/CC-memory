#!/usr/bin/env npx tsx
/** Reversible capture-spool cutoff with transcript snapshots and a hashed manifest. */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const APPROVAL_SCOPE = 'capture-backlog-cutoff';
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface BacklogCutoffApproval {
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  spoolFingerprint: string;
  approvalSha256: string;
}

export interface CaptureEpochFileManifest {
  relpath: string;
  bytes: number;
  lineCount: number;
  sha256: string;
  mtimeMs: number;
}

export interface CaptureTranscriptManifest {
  sourcePathHash: string;
  maxBoundary: number;
  status: 'snapshotted' | 'missing' | 'truncated';
  bytes: number;
  sha256?: string;
  snapshotRelpath?: string;
  unrecoverableReason?: 'source-missing' | 'source-shorter-than-boundary';
}

export interface CaptureEpochArchiveManifest {
  version: 1;
  cutoffId: string;
  cutoffAt: string;
  epochSha256: string;
  approval: { approvedBy: string; approvalSha256: string };
  spoolArchive: { relpath: string; bytes: number; sha256: string };
  spoolFiles: CaptureEpochFileManifest[];
  transcripts: CaptureTranscriptManifest[];
  counts: {
    spoolFiles: number;
    transcriptsReferenced: number;
    transcriptsSnapshotted: number;
    transcriptsUnrecoverable: number;
  };
}

export interface BootstrapCaptureEpochsInput {
  spoolDir: string;
  epochsDir: string;
  cutoffId: string;
  maxAttempts?: number;
  beforeSwapAttempt?: (attempt: number) => void;
}

export interface BootstrapCaptureEpochsResult {
  oldEpochDir: string;
  newEpochDir: string;
}

function sha256Buffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseKeyValueDocument(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function parseCanonicalIso(value: string | undefined): number {
  if (!CANONICAL_ISO.test(value ?? '')) return Number.NaN;
  const parsed = Date.parse(value!);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : Number.NaN;
}

export function validateBacklogCutoffApproval(
  source: string,
  expectedFingerprint: string,
  now: Date,
): BacklogCutoffApproval {
  const values = parseKeyValueDocument(source);
  if (values.scope !== APPROVAL_SCOPE) {
    throw new Error(`backlog cutoff approval scope must be ${APPROVAL_SCOPE}`);
  }
  if (!values.approved_by?.trim()) {
    throw new Error('backlog cutoff approval approved_by is required');
  }
  const approvedAt = parseCanonicalIso(values.approved_at);
  const expiresAt = parseCanonicalIso(values.expires_at);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) {
    throw new Error('backlog cutoff approval timestamps must be canonical UTC ISO timestamps');
  }
  if (approvedAt > now.getTime()) {
    throw new Error('backlog cutoff approval approved_at is in the future');
  }
  if (expiresAt <= now.getTime() || expiresAt <= approvedAt) {
    throw new Error('backlog cutoff approval is expired or has an invalid window');
  }
  if (expiresAt - approvedAt > 24 * 60 * 60 * 1000) {
    throw new Error('backlog cutoff approval window must not exceed 24 hours');
  }
  if (values.spool_fingerprint !== expectedFingerprint) {
    throw new Error('backlog cutoff approval spool fingerprint does not match the current spool');
  }
  return {
    approvedBy: values.approved_by,
    approvedAt: values.approved_at,
    expiresAt: values.expires_at,
    spoolFingerprint: values.spool_fingerprint,
    approvalSha256: sha256Buffer(source),
  };
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function countLines(buffer: Buffer): number {
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines += 1;
  return lines;
}

export function captureEpochBaseline(root: string): CaptureEpochFileManifest[] {
  return walkFiles(root).map((file) => {
    const content = readFileSync(file);
    const info = statSync(file);
    return {
      relpath: path.relative(root, file),
      bytes: content.length,
      lineCount: countLines(content),
      sha256: sha256Buffer(content),
      mtimeMs: info.mtimeMs,
    };
  });
}

export function captureEpochFingerprint(root: string): string {
  return sha256Buffer(JSON.stringify(captureEpochBaseline(root)));
}

function sha256FilePrefix(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let remaining = bytes;
  try {
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const bytesRead = readSync(fd, buffer, 0, requested, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return remaining === 0 ? hash.digest('hex') : '';
}

export function assertApprovedEpochBaseline(
  epochDir: string,
  baseline: CaptureEpochFileManifest[],
): void {
  for (const approved of baseline) {
    const current = path.join(epochDir, approved.relpath);
    if (!existsSync(current) || statSync(current).size < approved.bytes) {
      throw new Error(`approved prefix is missing or truncated: ${approved.relpath}`);
    }
    if (sha256FilePrefix(current, approved.bytes) !== approved.sha256) {
      throw new Error(`approved prefix changed: ${approved.relpath}`);
    }
  }
}

function uniqueCollisionPath(target: string, cutoffId: string): string {
  const parsed = path.parse(target);
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = path.join(
      parsed.dir,
      `${parsed.name}.cutoff-stray-${cutoffId}-${index}${parsed.ext}`,
    );
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`unable to allocate cutoff stray path for ${target}`);
}

function mergeStrayTree(source: string, target: string, cutoffId: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mergeStrayTree(from, to, cutoffId);
      continue;
    }
    renameSync(from, existsSync(to) ? uniqueCollisionPath(to, cutoffId) : to);
  }
  rmdirSync(source);
}

function swapSymlinkWithRetry(
  spoolDir: string,
  newEpochDir: string,
  oldEpochDir: string,
  cutoffId: string,
  maxAttempts: number,
  beforeSwapAttempt?: (attempt: number) => void,
): void {
  const temporaryLink = `${spoolDir}.cutoff-link-${cutoffId}`;
  if (existsSync(temporaryLink)) unlinkSync(temporaryLink);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    beforeSwapAttempt?.(attempt);
    symlinkSync(newEpochDir, temporaryLink, 'dir');
    try {
      renameSync(temporaryLink, spoolDir);
      return;
    } catch (error) {
      if (existsSync(temporaryLink)) unlinkSync(temporaryLink);
      if (!existsSync(spoolDir) || lstatSync(spoolDir).isSymbolicLink()) throw error;
      const stray = `${spoolDir}.cutoff-stray-${cutoffId}-${attempt}`;
      renameSync(spoolDir, stray);
      mergeStrayTree(stray, oldEpochDir, cutoffId);
    }
  }
  throw new Error(`capture spool cutoff did not converge after ${maxAttempts} attempts`);
}

export function bootstrapCaptureEpochs(
  input: BootstrapCaptureEpochsInput,
): BootstrapCaptureEpochsResult {
  const spoolDir = path.resolve(input.spoolDir);
  const epochsDir = path.resolve(input.epochsDir);
  const maxAttempts = input.maxAttempts ?? 8;
  mkdirSync(epochsDir, { recursive: true, mode: 0o700 });
  chmodSync(epochsDir, 0o700);
  const newEpochDir = path.join(epochsDir, `ep-${input.cutoffId}-active`);
  mkdirSync(newEpochDir, { recursive: false, mode: 0o700 });

  let oldEpochDir: string;
  if (lstatSync(spoolDir).isSymbolicLink()) {
    oldEpochDir = path.resolve(path.dirname(spoolDir), readlinkSync(spoolDir));
    const temporaryLink = `${spoolDir}.cutoff-link-${input.cutoffId}`;
    symlinkSync(newEpochDir, temporaryLink, 'dir');
    renameSync(temporaryLink, spoolDir);
  } else {
    oldEpochDir = path.join(epochsDir, `ep-${input.cutoffId}-historical`);
    if (existsSync(oldEpochDir)) throw new Error(`historical epoch already exists: ${oldEpochDir}`);
    renameSync(spoolDir, oldEpochDir);
    swapSymlinkWithRetry(
      spoolDir,
      newEpochDir,
      oldEpochDir,
      input.cutoffId,
      maxAttempts,
      input.beforeSwapAttempt,
    );
  }
  return { oldEpochDir, newEpochDir };
}

export async function assertStableEpoch(
  epochDir: string,
  options: { settleMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<string> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const before = captureEpochFingerprint(epochDir);
  await sleep(options.settleMs);
  const after = captureEpochFingerprint(epochDir);
  if (before !== after) throw new Error('capture epoch changed during settle window');
  return after;
}

function transcriptBoundaries(epochDir: string): Map<string, number> {
  const boundaries = new Map<string, number>();
  for (const spoolFile of walkFiles(epochDir).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of readFileSync(spoolFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const source = typeof record.transcript_path === 'string' ? record.transcript_path : '';
        const boundary = Number.isInteger(record.transcript_offset)
          ? Number(record.transcript_offset)
          : Number.isInteger(record.hwm_offset)
            ? Number(record.hwm_offset)
            : -1;
        if (source && boundary >= 0) {
          boundaries.set(source, Math.max(boundaries.get(source) ?? 0, boundary));
        }
      } catch {
        // Malformed spool lines remain represented and hashed in spoolFiles.
      }
    }
  }
  return boundaries;
}

function snapshotTranscriptPrefix(
  source: string,
  maxBoundary: number,
  archiveDir: string,
): CaptureTranscriptManifest {
  const sourcePathHash = sha256Buffer(source);
  if (!existsSync(source)) {
    return {
      sourcePathHash,
      maxBoundary,
      status: 'missing',
      bytes: 0,
      unrecoverableReason: 'source-missing',
    };
  }
  const sourceSize = statSync(source).size;
  if (sourceSize < maxBoundary) {
    return {
      sourcePathHash,
      maxBoundary,
      status: 'truncated',
      bytes: sourceSize,
      unrecoverableReason: 'source-shorter-than-boundary',
    };
  }

  const snapshotRelpath = path.join('transcripts', `${sourcePathHash}.jsonl`);
  const target = path.join(archiveDir, snapshotRelpath);
  const sourceFd = openSync(source, 'r');
  const targetFd = openSync(target, 'wx', 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let remaining = maxBoundary;
  try {
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const bytesRead = readSync(sourceFd, buffer, 0, requested, null);
      if (bytesRead <= 0) throw new Error(`transcript became shorter during snapshot: ${sourcePathHash}`);
      writeSync(targetFd, buffer, 0, bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
  } finally {
    closeSync(sourceFd);
    closeSync(targetFd);
  }
  chmodSync(target, 0o600);
  return {
    sourcePathHash,
    maxBoundary,
    status: 'snapshotted',
    bytes: maxBoundary,
    sha256: hash.digest('hex'),
    snapshotRelpath,
  };
}

function sha256File(file: string): string {
  const fd = openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function createStrictSpoolArchive(epochDir: string, archiveDir: string): {
  relpath: string;
  bytes: number;
  sha256: string;
} {
  const relpath = 'spool.tar.gz';
  const target = path.join(archiveDir, relpath);
  closeSync(openSync(target, 'wx', 0o600));
  const created = spawnSync(
    'tar',
    ['-C', path.dirname(epochDir), '-czf', target, path.basename(epochDir)],
    { encoding: 'utf8' },
  );
  if (created.status !== 0) {
    if (existsSync(target)) unlinkSync(target);
    throw new Error(
      `strict spool archive failed with exit ${created.status}: ${(created.stderr ?? '').trim()}`,
    );
  }
  chmodSync(target, 0o600);
  return { relpath, bytes: statSync(target).size, sha256: sha256File(target) };
}

export function archiveCaptureEpoch(input: {
  epochDir: string;
  archiveDir: string;
  cutoffId: string;
  cutoffAt: string;
  approval: { approvedBy: string; approvalSha256: string };
}): CaptureEpochArchiveManifest {
  const epochDir = path.resolve(input.epochDir);
  const archiveDir = path.resolve(input.archiveDir);
  mkdirSync(archiveDir, { recursive: false, mode: 0o700 });
  mkdirSync(path.join(archiveDir, 'transcripts'), { mode: 0o700 });
  chmodSync(archiveDir, 0o700);
  const spoolFiles = captureEpochBaseline(epochDir);
  const transcripts = [...transcriptBoundaries(epochDir).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, maxBoundary]) => snapshotTranscriptPrefix(source, maxBoundary, archiveDir));
  const spoolArchive = createStrictSpoolArchive(epochDir, archiveDir);
  const manifest: CaptureEpochArchiveManifest = {
    version: 1,
    cutoffId: input.cutoffId,
    cutoffAt: input.cutoffAt,
    epochSha256: sha256Buffer(JSON.stringify(spoolFiles)),
    approval: input.approval,
    spoolArchive,
    spoolFiles,
    transcripts,
    counts: {
      spoolFiles: spoolFiles.length,
      transcriptsReferenced: transcripts.length,
      transcriptsSnapshotted: transcripts.filter((entry) => entry.status === 'snapshotted').length,
      transcriptsUnrecoverable: transcripts.filter((entry) => entry.status !== 'snapshotted').length,
    },
  };
  const manifestPath = path.join(archiveDir, 'manifest.json');
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(
    manifestPath,
    manifestSource,
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(
    path.join(archiveDir, 'manifest.sha256'),
    `${sha256Buffer(manifestSource)}  manifest.json\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return manifest;
}

export function verifyCaptureEpochArchive(archiveDir: string): {
  ok: boolean;
  reason?: string;
} {
  try {
    const manifestPath = path.join(archiveDir, 'manifest.json');
    const manifestSource = readFileSync(manifestPath, 'utf8');
    const recordedManifestHash = readFileSync(
      path.join(archiveDir, 'manifest.sha256'),
      'utf8',
    ).trim().split(/\s+/)[0];
    if (recordedManifestHash !== sha256Buffer(manifestSource)) {
      return { ok: false, reason: 'manifest sha256 mismatch' };
    }
    const manifest = JSON.parse(manifestSource) as CaptureEpochArchiveManifest;
    const spoolArchive = path.join(archiveDir, manifest.spoolArchive.relpath);
    if (
      statSync(spoolArchive).size !== manifest.spoolArchive.bytes ||
      sha256File(spoolArchive) !== manifest.spoolArchive.sha256
    ) {
      return { ok: false, reason: 'spool archive verification failed' };
    }
    const listed = spawnSync('tar', ['-tzf', spoolArchive], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (listed.status !== 0) return { ok: false, reason: 'spool archive listing failed' };
    const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
    const unsafeEntry = entries.find((entry) => {
      const normalized = path.posix.normalize(entry);
      return path.posix.isAbsolute(entry) || normalized === '..' || normalized.startsWith('../');
    });
    if (unsafeEntry) return { ok: false, reason: 'spool archive contains an unsafe path' };
    const extractionRoot = mkdtempSync(path.join(tmpdir(), 'cc-memory-archive-verify-'));
    try {
      const extracted = spawnSync('tar', ['-xzf', spoolArchive, '-C', extractionRoot], {
        encoding: 'utf8',
      });
      if (extracted.status !== 0) return { ok: false, reason: 'spool archive extraction failed' };
      const topLevel = readdirSync(extractionRoot, { withFileTypes: true });
      if (topLevel.length !== 1 || !topLevel[0].isDirectory()) {
        return { ok: false, reason: 'spool archive must contain exactly one epoch root' };
      }
      const archivedFiles = captureEpochBaseline(path.join(extractionRoot, topLevel[0].name))
        .map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
      const manifestFiles = manifest.spoolFiles.map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
      if (JSON.stringify(archivedFiles) !== JSON.stringify(manifestFiles)) {
        return { ok: false, reason: 'spool archive contents do not match the manifest' };
      }
    } finally {
      rmSync(extractionRoot, { recursive: true, force: true });
    }
    for (const transcript of manifest.transcripts) {
      if (transcript.status !== 'snapshotted') continue;
      const snapshot = path.join(archiveDir, transcript.snapshotRelpath!);
      if (
        statSync(snapshot).size !== transcript.bytes ||
        sha256File(snapshot) !== transcript.sha256
      ) {
        return { ok: false, reason: `transcript snapshot verification failed: ${transcript.sourcePathHash}` };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

interface ArchiveBacklogCliOptions {
  execute: boolean;
  json: boolean;
  spoolDir: string;
  epochsDir: string;
  archiveRoot: string;
  approvalFile: string;
  lockFile: string;
  settleMs: number;
  allowShortSettle: boolean;
  resumeEpochDir?: string;
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseArchiveBacklogArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): ArchiveBacklogCliOptions {
  const spoolDir = optionValue(args, '--spool-dir') ??
    env.CC_MEMORY_SPOOL_DIR ?? path.join(homedir(), '.cache', 'cc-memory', 'spool');
  const execute = args.includes('--execute');
  const settleMs = nonNegativeInteger(optionValue(args, '--settle-ms'), 600_000, '--settle-ms');
  const allowShortSettle = args.includes('--allow-short-settle');
  if (execute && settleMs < 600_000 && !allowShortSettle) {
    throw new Error('short settle requires the explicit --allow-short-settle acknowledgement');
  }
  return {
    execute,
    json: args.includes('--json'),
    spoolDir,
    epochsDir: optionValue(args, '--epochs-dir') ??
      path.join(path.dirname(spoolDir), 'spool-epochs'),
    archiveRoot: optionValue(args, '--archive-root') ??
      path.join(homedir(), 'backups', 'cc-memory'),
    approvalFile: optionValue(args, '--approval-file') ??
      path.join(homedir(), '.ccm-backlog-cutoff-approved'),
    lockFile: optionValue(args, '--lock-file') ??
      path.join(homedir(), '.cache', 'cc-memory', 'auto-capture-run.lock'),
    settleMs,
    allowShortSettle,
    resumeEpochDir: optionValue(args, '--resume-epoch-dir'),
  };
}

function cutoffId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function reexecUnderFlock(options: ArchiveBacklogCliOptions): number | null {
  if (process.env.CC_MEMORY_ARCHIVE_FLOCKED === '1') return null;
  mkdirSync(path.dirname(options.lockFile), { recursive: true, mode: 0o700 });
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawnSync(
    '/usr/bin/flock',
    ['-n', '-E', '73', options.lockFile, process.execPath, tsxCli, process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, CC_MEMORY_ARCHIVE_FLOCKED: '1' } },
  );
  if (child.status === 73) {
    process.stderr.write(`[cc-memory] backlog cutoff lock busy: ${options.lockFile}\n`);
    return 3;
  }
  return child.status ?? 1;
}

async function executeCutoff(options: ArchiveBacklogCliOptions): Promise<number> {
  const now = new Date();
  const sourceDir = path.resolve(options.resumeEpochDir ?? options.spoolDir);
  const approvedBaseline = captureEpochBaseline(sourceDir);
  const fingerprint = sha256Buffer(JSON.stringify(approvedBaseline));
  const approvalInfo = lstatSync(options.approvalFile);
  if (!approvalInfo.isFile() || approvalInfo.isSymbolicLink()) {
    throw new Error('backlog cutoff approval must be a regular file');
  }
  if ((approvalInfo.mode & 0o077) !== 0) {
    throw new Error('backlog cutoff approval must not be accessible by group or others');
  }
  const approvalSource = readFileSync(options.approvalFile, 'utf8');
  const approval = validateBacklogCutoffApproval(approvalSource, fingerprint, now);
  mkdirSync(options.archiveRoot, { recursive: true, mode: 0o700 });
  chmodSync(options.archiveRoot, 0o700);
  const id = cutoffId(now);
  if (options.resumeEpochDir) {
    await assertStableEpoch(sourceDir, { settleMs: options.settleMs });
    assertApprovedEpochBaseline(sourceDir, approvedBaseline);
    const archiveDir = path.join(options.archiveRoot, `backlog-resume-${id}`);
    const manifest = archiveCaptureEpoch({
      epochDir: sourceDir,
      archiveDir,
      cutoffId: id,
      cutoffAt: now.toISOString(),
      approval,
    });
    const verification = verifyCaptureEpochArchive(archiveDir);
    if (!verification.ok) throw new Error(verification.reason ?? 'archive verification failed');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: 'resume-epoch',
      cutoffId: id,
      oldEpochDir: sourceDir,
      archiveDir,
      counts: manifest.counts,
    })}\n`);
    return 0;
  }
  const epochs = bootstrapCaptureEpochs({
    spoolDir: options.spoolDir,
    epochsDir: options.epochsDir,
    cutoffId: id,
  });
  await assertStableEpoch(epochs.oldEpochDir, {
    settleMs: options.settleMs,
  });
  assertApprovedEpochBaseline(epochs.oldEpochDir, approvedBaseline);
  const archiveDir = path.join(options.archiveRoot, `backlog-cutoff-${id}`);
  const manifest = archiveCaptureEpoch({
    epochDir: epochs.oldEpochDir,
    archiveDir,
    cutoffId: id,
    cutoffAt: now.toISOString(),
    approval,
  });
  const verification = verifyCaptureEpochArchive(archiveDir);
  if (!verification.ok) throw new Error(verification.reason ?? 'archive verification failed');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'cutoff',
    cutoffId: id,
    oldEpochDir: epochs.oldEpochDir,
    newEpochDir: epochs.newEpochDir,
    archiveDir,
    counts: manifest.counts,
  })}\n`);
  return 0;
}

async function main(): Promise<number> {
  const options = parseArchiveBacklogArgs(process.argv.slice(2));
  const sourceDir = path.resolve(options.resumeEpochDir ?? options.spoolDir);
  const fingerprint = captureEpochFingerprint(sourceDir);
  if (!options.execute) {
    const files = captureEpochBaseline(sourceDir);
    const output = {
      dryRun: true,
      mode: options.resumeEpochDir ? 'resume-epoch' : 'cutoff',
      spoolDir: sourceDir,
      spoolFingerprint: fingerprint,
      spoolFiles: files.length,
      spoolBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      approvalFile: options.approvalFile,
      settleMs: options.settleMs,
    };
    process.stdout.write(`${JSON.stringify(output, null, options.json ? 0 : 2)}\n`);
    return 0;
  }
  const flockStatus = reexecUnderFlock(options);
  if (flockStatus !== null) return flockStatus;
  return executeCutoff(options);
}

const isMain = process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'archive-capture-backlog';

if (isMain) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(
        `[cc-memory] backlog cutoff failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
