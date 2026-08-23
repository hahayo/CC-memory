/**
 * Journaled sealed-pair mover: safely relocates completed sealed spool+state
 * pairs out of the spool tree so totalSpoolBytes() drops.
 *
 * Design: per-file intent journal → staging subdir → single directory rename
 * (atomic commit) → manifest append → journal cleanup.
 *
 * All paths are injectable for testing. An `onStep` hook enables crash-injection
 * tests: throwing inside the hook simulates a crash at that exact point.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SealedMoverPaths {
  /** The spool root directory (e.g. ~/.cache/cc-memory/spool) */
  spoolDir: string;
  /** Staging area for in-progress moves */
  stagingDir: string;
  /** Final destination for moved sealed pairs */
  finalDir: string;
  /** Path to the journal file */
  journalPath: string;
  /** Path to the manifest file (inside finalDir) */
  manifestPath: string;
}

export interface SealedPair {
  /** The retryKey that identifies this session chunk */
  retryKey: string;
  /** Absolute path to the sealed spool .jsonl file */
  spoolPath: string;
  /** Absolute path to the sealed state .json file */
  statePath: string;
}

export interface JournalEntry {
  retryKey: string;
  spoolPath: string;
  statePath: string;
  spoolHash: string;
  stateHash: string;
  spool: 'intent' | 'completed';
  state: 'intent' | 'completed';
  phase: 'staging' | 'final-renamed' | 'manifest-committed';
}

export interface ManifestEntry {
  retryKey: string;
  spoolHash: string;
  stateHash: string;
  spoolRelpath: string;
  stateRelpath: string;
  movedAt: string;
}

export interface SealedMoverResult {
  moved: number;
  skipped: number;
  orphans: string[];
  errors: string[];
  failClosed: boolean;
}

export type StepName =
  | 'intent-spool-written'
  | 'journal-fsynced-intent-spool'
  | 'spool-renamed-to-staging'
  | 'source-dir-fsynced-after-spool'
  | 'staging-dir-fsynced-after-spool'
  | 'completed-spool-written'
  | 'journal-fsynced-completed-spool'
  | 'intent-state-written'
  | 'journal-fsynced-intent-state'
  | 'state-renamed-to-staging'
  | 'source-dir-fsynced-after-state'
  | 'staging-dir-fsynced-after-state'
  | 'completed-state-written'
  | 'journal-fsynced-completed-state'
  | 'staging-renamed-to-final'
  | 'final-parent-fsynced'
  | 'manifest-written'
  | 'manifest-fsynced'
  | 'phase-manifest-committed'
  | 'journal-cleaned';

export interface SealedMoverOptions {
  paths: SealedMoverPaths;
  /** Callback at each durable step; throw to simulate crash. */
  onStep?: (step: StepName, entry: JournalEntry) => void;
  /** Injectable stat function for st_dev checks (default: fs.statSync) */
  statFn?: (path: string) => { dev: number; ino: number; isDirectory: () => boolean };
  /** Injectable fsync for directories (default: open + fsyncSync + close) */
  fsyncDir?: (dirPath: string) => void;
  /** Clock for manifest timestamps */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sha256File(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function defaultFsyncDir(dirPath: string): void {
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncFile(filePath: string): void {
  const fd = openSync(filePath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Filesystem validation
// ---------------------------------------------------------------------------

/**
 * Verify that source, staging, final are on the same filesystem,
 * and that final is NOT inside the spool tree.
 */
export function validateFilesystems(
  paths: SealedMoverPaths,
  statFn: (p: string) => { dev: number } = statSync,
  resolveFn: (p: string) => string = realpathSync,
): { ok: boolean; reason?: string } {
  // Ensure directories exist before resolving
  for (const dir of [paths.spoolDir, paths.stagingDir, paths.finalDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Use realpathSync to follow symlinks (bootstrapCaptureEpochs can turn spool
  // into a symlink after cutover — lexical resolve() won't follow it)
  const spoolReal = resolveFn(paths.spoolDir);
  const stagingReal = resolveFn(paths.stagingDir);
  const finalReal = resolveFn(paths.finalDir);

  const spoolDev = statFn(spoolReal).dev;
  const stagingDev = statFn(stagingReal).dev;
  const finalDev = statFn(finalReal).dev;

  if (spoolDev !== stagingDev || spoolDev !== finalDev) {
    return {
      ok: false,
      reason: `filesystem mismatch: spool=${spoolDev} staging=${stagingDev} final=${finalDev}`,
    };
  }

  // final must NOT be inside spool tree (use path.relative to avoid startsWith footgun:
  // spool="…/spool" final="…/spool-sealed" → naive startsWith wrongly flags it)
  const rel = relative(spoolReal, finalReal);
  if (rel === '') {
    return {
      ok: false,
      reason: `final directory is the spool directory itself: ${finalReal}`,
    };
  }
  if (!rel.startsWith('..')) {
    return {
      ok: false,
      reason: `final directory is inside spool tree: final=${finalReal} spool=${spoolReal}`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sealed pair discovery
// ---------------------------------------------------------------------------

/**
 * Find sealed pairs in the spool directory.
 * A sealed spool file ends with `.<ts>.<gen>.sealed` appended to the original `.jsonl`.
 * Its state counterpart replaces `.jsonl` with `.capture-state.json` and has the same suffix.
 */
export function discoverSealedPairs(spoolDir: string): {
  pairs: SealedPair[];
  orphans: string[];
} {
  const sealedPattern = /\.jsonl\.\d+\.\d+\.sealed$/;
  const allFiles = walkFilesFlat(spoolDir);

  const sealedSpoolFiles = allFiles.filter((f) => sealedPattern.test(f));
  const pairs: SealedPair[] = [];
  const orphans: string[] = [];

  for (const spoolPath of sealedSpoolFiles) {
    // Derive the state path: .jsonl.<suffix> → .capture-state.json.<suffix>
    const match = spoolPath.match(/^(.+)\.jsonl(\.\d+\.\d+\.sealed)$/);
    if (!match) continue;
    const statePath = `${match[1]}.capture-state.json${match[2]}`;

    if (existsSync(statePath)) {
      // Extract retryKey from the spool path relative to spoolDir
      const relSpool = relative(spoolDir, spoolPath);
      // retryKey is the base name without the sealed suffix
      const retryKey = basename(relSpool);
      pairs.push({ retryKey, spoolPath, statePath });
    } else {
      orphans.push(spoolPath);
    }
  }

  // Also check for orphan state files (state exists but spool doesn't)
  const statePattern = /\.capture-state\.json\.\d+\.\d+\.sealed$/;
  const sealedStateFiles = allFiles.filter((f) => statePattern.test(f));
  for (const statePath of sealedStateFiles) {
    const match = statePath.match(/^(.+)\.capture-state\.json(\.\d+\.\d+\.sealed)$/);
    if (!match) continue;
    const spoolPath = `${match[1]}.jsonl${match[2]}`;
    if (!existsSync(spoolPath)) {
      orphans.push(statePath);
    }
  }

  return { pairs, orphans };
}

function walkFilesFlat(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

// ---------------------------------------------------------------------------
// Journal operations
// ---------------------------------------------------------------------------

function readJournal(journalPath: string): JournalEntry[] {
  if (!existsSync(journalPath)) return [];
  const content = readFileSync(journalPath, 'utf8');
  const entries: JournalEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // Skip malformed journal lines
    }
  }
  return entries;
}

function appendJournal(
  journalPath: string,
  entry: JournalEntry,
  _fsyncDirFn: (d: string) => void,
): void {
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  appendFileSync(journalPath, JSON.stringify(entry) + '\n');
  fsyncFile(journalPath);
  // Not fsyncing the parent dir here — caller controls step hooks
}

// latestJournalState is used internally by recoverJournal's grouping logic

// ---------------------------------------------------------------------------
// Manifest operations
// ---------------------------------------------------------------------------

function readManifest(manifestPath: string): ManifestEntry[] {
  if (!existsSync(manifestPath)) return [];
  const content = readFileSync(manifestPath, 'utf8');
  const entries: ManifestEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ManifestEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

function appendManifest(
  manifestPath: string,
  entry: ManifestEntry,
): void {
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  appendFileSync(manifestPath, JSON.stringify(entry) + '\n');
}

function manifestContains(
  manifestPath: string,
  retryKey: string,
  spoolHash: string,
  stateHash: string,
): boolean {
  const entries = readManifest(manifestPath);
  return entries.some(
    (e) => e.retryKey === retryKey && e.spoolHash === spoolHash && e.stateHash === stateHash,
  );
}

// ---------------------------------------------------------------------------
// Move a single sealed pair
// ---------------------------------------------------------------------------

function moveSealedPair(
  pair: SealedPair,
  opts: Required<Pick<SealedMoverOptions, 'paths' | 'onStep' | 'fsyncDir' | 'now'>>,
): { moved: boolean; error?: string; failClosed?: boolean } {
  const { paths, onStep, fsyncDir: fsyncDirFn, now } = opts;

  // Eligibility: both files must exist
  if (!existsSync(pair.spoolPath) || !existsSync(pair.statePath)) {
    return { moved: false, error: `missing file in pair: ${pair.retryKey}` };
  }

  // Hash both files
  const spoolHash = sha256File(pair.spoolPath);
  const stateHash = sha256File(pair.statePath);

  const stagingSubdir = join(paths.stagingDir, pair.retryKey);
  const finalSubdir = join(paths.finalDir, pair.retryKey);

  // Check destination already exists
  if (existsSync(finalSubdir)) {
    const existingSpoolPath = join(finalSubdir, basename(pair.spoolPath));
    const existingStatePath = join(finalSubdir, basename(pair.statePath));

    if (existsSync(existingSpoolPath) && existsSync(existingStatePath)) {
      const existingSpoolHash = sha256File(existingSpoolPath);
      const existingStateHash = sha256File(existingStatePath);

      if (existingSpoolHash === spoolHash && existingStateHash === stateHash) {
        // Same content — delete source (prior successful move)
        unlinkSync(pair.spoolPath);
        unlinkSync(pair.statePath);
        return { moved: true };
      }
      // Different hash — fail closed
      return {
        moved: false,
        failClosed: true,
        error: `destination exists with different hash: ${pair.retryKey}`,
      };
    }
  }

  const entry: JournalEntry = {
    retryKey: pair.retryKey,
    spoolPath: pair.spoolPath,
    statePath: pair.statePath,
    spoolHash,
    stateHash,
    spool: 'intent',
    state: 'intent',
    phase: 'staging',
  };

  // --- Move spool to staging ---
  mkdirSync(stagingSubdir, { recursive: true, mode: 0o700 });
  const stagingSpool = join(stagingSubdir, basename(pair.spoolPath));
  const stagingState = join(stagingSubdir, basename(pair.statePath));

  // Write spool intent
  entry.spool = 'intent';
  appendJournal(paths.journalPath, entry, fsyncDirFn);
  onStep('intent-spool-written', { ...entry });
  onStep('journal-fsynced-intent-spool', { ...entry });

  // Rename spool to staging
  renameSync(pair.spoolPath, stagingSpool);
  onStep('spool-renamed-to-staging', { ...entry });

  fsyncDirFn(dirname(pair.spoolPath));
  onStep('source-dir-fsynced-after-spool', { ...entry });

  fsyncDirFn(stagingSubdir);
  onStep('staging-dir-fsynced-after-spool', { ...entry });

  // Mark spool completed
  entry.spool = 'completed';
  appendJournal(paths.journalPath, entry, fsyncDirFn);
  onStep('completed-spool-written', { ...entry });
  onStep('journal-fsynced-completed-spool', { ...entry });

  // --- Move state to staging ---
  entry.state = 'intent';
  appendJournal(paths.journalPath, entry, fsyncDirFn);
  onStep('intent-state-written', { ...entry });
  onStep('journal-fsynced-intent-state', { ...entry });

  // Rename state to staging
  renameSync(pair.statePath, stagingState);
  onStep('state-renamed-to-staging', { ...entry });

  fsyncDirFn(dirname(pair.statePath));
  onStep('source-dir-fsynced-after-state', { ...entry });

  fsyncDirFn(stagingSubdir);
  onStep('staging-dir-fsynced-after-state', { ...entry });

  // Mark state completed
  entry.state = 'completed';
  appendJournal(paths.journalPath, entry, fsyncDirFn);
  onStep('completed-state-written', { ...entry });
  onStep('journal-fsynced-completed-state', { ...entry });

  // --- Atomic commit: rename staging subdir → final ---
  mkdirSync(paths.finalDir, { recursive: true, mode: 0o700 });
  renameSync(stagingSubdir, finalSubdir);
  entry.phase = 'final-renamed';
  onStep('staging-renamed-to-final', { ...entry });

  fsyncDirFn(dirname(finalSubdir));
  onStep('final-parent-fsynced', { ...entry });

  // --- Write manifest ---
  const manifestEntry: ManifestEntry = {
    retryKey: pair.retryKey,
    spoolHash,
    stateHash,
    spoolRelpath: join(pair.retryKey, basename(pair.spoolPath)),
    stateRelpath: join(pair.retryKey, basename(pair.statePath)),
    movedAt: now().toISOString(),
  };

  if (!manifestContains(paths.manifestPath, pair.retryKey, spoolHash, stateHash)) {
    appendManifest(paths.manifestPath, manifestEntry);
    onStep('manifest-written', { ...entry });

    fsyncFile(paths.manifestPath);
    onStep('manifest-fsynced', { ...entry });
  }

  entry.phase = 'manifest-committed';
  appendJournal(paths.journalPath, entry, fsyncDirFn);
  onStep('phase-manifest-committed', { ...entry });

  // Clean this entry from journal (rewrite without completed entries for this key)
  onStep('journal-cleaned', { ...entry });

  return { moved: true };
}

// ---------------------------------------------------------------------------
// Recovery: reconcile journal/staging/final state after crash
// ---------------------------------------------------------------------------

export function recoverJournal(
  opts: Required<Pick<SealedMoverOptions, 'paths' | 'onStep' | 'fsyncDir' | 'now'>>,
): SealedMoverResult {
  const { paths } = opts;
  const result: SealedMoverResult = {
    moved: 0,
    skipped: 0,
    orphans: [],
    errors: [],
    failClosed: false,
  };

  const entries = readJournal(paths.journalPath);

  // Group by retryKey, take latest entry for each
  const byKey = new Map<string, JournalEntry>();
  for (const e of entries) {
    byKey.set(e.retryKey, e);
  }

  for (const [, entry] of byKey) {
    try {
      const recovered = recoverEntry(entry, opts);
      if (recovered.moved) result.moved++;
      else if (recovered.failClosed) {
        result.failClosed = true;
        result.errors.push(recovered.error ?? 'fail-closed during recovery');
      } else {
        result.skipped++;
        if (recovered.error) result.errors.push(recovered.error);
      }
    } catch (err) {
      result.errors.push(`recovery failed for ${entry.retryKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Scan staging for orphan subdirs not in journal (journal-lost rebuild)
  if (existsSync(paths.stagingDir)) {
    for (const sub of readdirSync(paths.stagingDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      if (byKey.has(sub.name)) continue;
      const stagingSubdir = join(paths.stagingDir, sub.name);
      const files = readdirSync(stagingSubdir);
      const spoolFile = files.find((f) => f.match(/\.jsonl\.\d+\.\d+\.sealed$/));
      const stateFile = files.find((f) => f.match(/\.capture-state\.json\.\d+\.\d+\.sealed$/));

      if (spoolFile && stateFile) {
        // Complete pair in staging — commit to final
        const spoolHash = sha256File(join(stagingSubdir, spoolFile));
        const stateHash = sha256File(join(stagingSubdir, stateFile));
        const finalSubdir = join(paths.finalDir, sub.name);

        if (existsSync(finalSubdir)) {
          result.errors.push(`orphan staging has matching final: ${stagingSubdir}`);
          continue;
        }

        try {
          mkdirSync(paths.finalDir, { recursive: true, mode: 0o700 });
          renameSync(stagingSubdir, finalSubdir);
          opts.fsyncDir(dirname(finalSubdir));

          if (!manifestContains(paths.manifestPath, sub.name, spoolHash, stateHash)) {
            appendManifest(paths.manifestPath, {
              retryKey: sub.name,
              spoolHash,
              stateHash,
              spoolRelpath: join(sub.name, spoolFile),
              stateRelpath: join(sub.name, stateFile),
              movedAt: opts.now().toISOString(),
            });
          }
          result.moved++;
        } catch (err) {
          result.errors.push(
            `orphan staging rebuild failed: ${sub.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        // Incomplete pair in staging — can't rebuild, report
        result.errors.push(`orphan staging directory (incomplete pair): ${stagingSubdir}`);
      }
    }
  }

  return result;
}

function recoverEntry(
  entry: JournalEntry,
  opts: Required<Pick<SealedMoverOptions, 'paths' | 'onStep' | 'fsyncDir' | 'now'>>,
): { moved: boolean; error?: string; failClosed?: boolean } {
  const { paths, fsyncDir: fsyncDirFn, now } = opts;

  const stagingSubdir = join(paths.stagingDir, entry.retryKey);
  const finalSubdir = join(paths.finalDir, entry.retryKey);
  const spoolBase = basename(entry.spoolPath);
  const stateBase = basename(entry.statePath);

  // Check where files actually are
  const sourceSpoolExists = existsSync(entry.spoolPath);
  const sourceStateExists = existsSync(entry.statePath);
  const stagingSpoolPath = join(stagingSubdir, spoolBase);
  const stagingStatePathStr = join(stagingSubdir, stateBase);
  const stagingSpoolExists = existsSync(stagingSpoolPath);
  const stagingStateExists = existsSync(stagingStatePathStr);
  const finalSpoolPath = join(finalSubdir, spoolBase);
  const finalStatePath = join(finalSubdir, stateBase);
  const finalSpoolExists = existsSync(finalSpoolPath);
  const finalStateExists = existsSync(finalStatePath);

  // Already in final — verify and clean up
  if (finalSpoolExists && finalStateExists) {
    const finalSpoolHash = sha256File(finalSpoolPath);
    const finalStateHash = sha256File(finalStatePath);
    if (finalSpoolHash !== entry.spoolHash || finalStateHash !== entry.stateHash) {
      return { moved: false, failClosed: true, error: `hash mismatch in final: ${entry.retryKey}` };
    }
    // Clean source if still exists
    if (sourceSpoolExists) unlinkSync(entry.spoolPath);
    if (sourceStateExists) unlinkSync(entry.statePath);
    // Clean staging if exists
    if (existsSync(stagingSubdir)) rmSync(stagingSubdir, { recursive: true, force: true });
    // Ensure manifest entry
    if (!manifestContains(paths.manifestPath, entry.retryKey, entry.spoolHash, entry.stateHash)) {
      appendManifest(paths.manifestPath, {
        retryKey: entry.retryKey,
        spoolHash: entry.spoolHash,
        stateHash: entry.stateHash,
        spoolRelpath: join(entry.retryKey, spoolBase),
        stateRelpath: join(entry.retryKey, stateBase),
        movedAt: now().toISOString(),
      });
    }
    return { moved: true };
  }

  // Both in staging — do the atomic commit
  if (stagingSpoolExists && stagingStateExists) {
    // Verify hashes
    const sh = sha256File(stagingSpoolPath);
    const th = sha256File(stagingStatePathStr);
    if (sh !== entry.spoolHash || th !== entry.stateHash) {
      return { moved: false, failClosed: true, error: `hash mismatch in staging: ${entry.retryKey}` };
    }

    mkdirSync(paths.finalDir, { recursive: true, mode: 0o700 });
    renameSync(stagingSubdir, finalSubdir);
    fsyncDirFn(dirname(finalSubdir));

    if (!manifestContains(paths.manifestPath, entry.retryKey, entry.spoolHash, entry.stateHash)) {
      appendManifest(paths.manifestPath, {
        retryKey: entry.retryKey,
        spoolHash: entry.spoolHash,
        stateHash: entry.stateHash,
        spoolRelpath: join(entry.retryKey, spoolBase),
        stateRelpath: join(entry.retryKey, stateBase),
        movedAt: now().toISOString(),
      });
    }

    // Clean source if still exists
    if (sourceSpoolExists) unlinkSync(entry.spoolPath);
    if (sourceStateExists) unlinkSync(entry.statePath);
    return { moved: true };
  }

  // Partial staging — reconcile per-file
  if (stagingSpoolExists && !stagingStateExists) {
    // Spool in staging, state still in source (or lost)
    if (sourceStateExists) {
      // Move state to staging to complete the pair
      mkdirSync(stagingSubdir, { recursive: true, mode: 0o700 });
      renameSync(entry.statePath, stagingStatePathStr);
      fsyncDirFn(dirname(entry.statePath));
      fsyncDirFn(stagingSubdir);
      // Now both in staging — commit
      mkdirSync(paths.finalDir, { recursive: true, mode: 0o700 });
      renameSync(stagingSubdir, finalSubdir);
      fsyncDirFn(dirname(finalSubdir));
      if (!manifestContains(paths.manifestPath, entry.retryKey, entry.spoolHash, entry.stateHash)) {
        appendManifest(paths.manifestPath, {
          retryKey: entry.retryKey,
          spoolHash: entry.spoolHash,
          stateHash: entry.stateHash,
          spoolRelpath: join(entry.retryKey, spoolBase),
          stateRelpath: join(entry.retryKey, stateBase),
          movedAt: now().toISOString(),
        });
      }
      if (sourceSpoolExists) unlinkSync(entry.spoolPath);
      return { moved: true };
    }
    // State is lost — can't complete pair
    return { moved: false, error: `state file missing during recovery: ${entry.retryKey}` };
  }

  if (!stagingSpoolExists && stagingStateExists) {
    // State in staging, spool still in source (or lost)
    if (sourceSpoolExists) {
      mkdirSync(stagingSubdir, { recursive: true, mode: 0o700 });
      renameSync(entry.spoolPath, stagingSpoolPath);
      fsyncDirFn(dirname(entry.spoolPath));
      fsyncDirFn(stagingSubdir);
      mkdirSync(paths.finalDir, { recursive: true, mode: 0o700 });
      renameSync(stagingSubdir, finalSubdir);
      fsyncDirFn(dirname(finalSubdir));
      if (!manifestContains(paths.manifestPath, entry.retryKey, entry.spoolHash, entry.stateHash)) {
        appendManifest(paths.manifestPath, {
          retryKey: entry.retryKey,
          spoolHash: entry.spoolHash,
          stateHash: entry.stateHash,
          spoolRelpath: join(entry.retryKey, spoolBase),
          stateRelpath: join(entry.retryKey, stateBase),
          movedAt: now().toISOString(),
        });
      }
      if (sourceStateExists) unlinkSync(entry.statePath);
      return { moved: true };
    }
    return { moved: false, error: `spool file missing during recovery: ${entry.retryKey}` };
  }

  // Both still in source — retry from scratch
  if (sourceSpoolExists && sourceStateExists) {
    return moveSealedPair(
      { retryKey: entry.retryKey, spoolPath: entry.spoolPath, statePath: entry.statePath },
      { paths, onStep: opts.onStep, fsyncDir: fsyncDirFn, now },
    );
  }

  return { moved: false, error: `cannot locate files for: ${entry.retryKey}` };
}

// ---------------------------------------------------------------------------
// Main entry: move all eligible sealed pairs
// ---------------------------------------------------------------------------

export function moveSealedPairs(options: SealedMoverOptions): SealedMoverResult {
  const {
    paths,
    onStep = () => { /* no-op */ },
    statFn = statSync,
    fsyncDir: fsyncDirFn = defaultFsyncDir,
    now = () => new Date(),
  } = options;

  const resolvedOpts = { paths, onStep, fsyncDir: fsyncDirFn, now };
  const result: SealedMoverResult = {
    moved: 0,
    skipped: 0,
    orphans: [],
    errors: [],
    failClosed: false,
  };

  // Validate filesystems
  const fsCheck = validateFilesystems(paths, statFn);
  if (!fsCheck.ok) {
    result.failClosed = true;
    result.errors.push(fsCheck.reason ?? 'filesystem validation failed');
    return result;
  }

  // Recovery pass first: reconcile any incomplete journal entries
  const recovery = recoverJournal(resolvedOpts);
  result.moved += recovery.moved;
  result.errors.push(...recovery.errors);
  if (recovery.failClosed) result.failClosed = true;

  if (result.failClosed) return result;

  // Discover sealed pairs
  const { pairs, orphans } = discoverSealedPairs(paths.spoolDir);
  result.orphans.push(...orphans);

  // Move each eligible pair
  for (const pair of pairs) {
    try {
      const moveResult = moveSealedPair(pair, resolvedOpts);
      if (moveResult.moved) {
        result.moved++;
      } else if (moveResult.failClosed) {
        result.failClosed = true;
        result.errors.push(moveResult.error ?? 'fail-closed');
        return result; // Stop on fail-closed
      } else {
        result.skipped++;
        if (moveResult.error) result.errors.push(moveResult.error);
      }
    } catch (err) {
      result.errors.push(
        `move failed for ${pair.retryKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.skipped++;
    }
  }

  // Clean journal: group by retryKey, drop ALL entries for keys whose latest
  // phase is 'manifest-committed'. Without this, stale staging entries stay
  // forever and inflate moved counts on subsequent runs.
  if (existsSync(paths.journalPath) && !result.failClosed) {
    const allEntries = readJournal(paths.journalPath);
    // Find retryKeys whose latest entry is manifest-committed
    const latestByKey = new Map<string, JournalEntry>();
    for (const e of allEntries) latestByKey.set(e.retryKey, e);
    const completedKeys = new Set<string>();
    for (const [key, entry] of latestByKey) {
      if (entry.phase === 'manifest-committed') completedKeys.add(key);
    }
    // Keep only entries for keys that are NOT fully completed
    const remaining = allEntries.filter((e) => !completedKeys.has(e.retryKey));
    if (remaining.length === 0) {
      unlinkSync(paths.journalPath);
    } else {
      writeFileSync(
        paths.journalPath,
        remaining.map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Recursive byte counter (replicates totalSpoolBytes from capture-worker.ts
// which is not exported)
// ---------------------------------------------------------------------------

export function totalBytesInTree(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(root);
  return total;
}

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

export function defaultSealedMoverPaths(
  spoolDir?: string,
): SealedMoverPaths {
  const cacheRoot = join(homedir(), '.cache', 'cc-memory');
  const spool = spoolDir ?? join(cacheRoot, 'spool');
  const finalDir = join(cacheRoot, 'spool-sealed');
  return {
    spoolDir: spool,
    stagingDir: join(cacheRoot, 'sealed-staging'),
    finalDir,
    journalPath: join(cacheRoot, 'sealed-move-journal.jsonl'),
    manifestPath: join(finalDir, 'manifest.jsonl'),
  };
}
