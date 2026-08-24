#!/usr/bin/env npx tsx
/**
 * CLI entry point for sealed spool pair mover.
 *
 * Moves completed sealed spool+state pairs out of the spool tree so that
 * totalSpoolBytes() drops. Uses a journaled state machine with single
 * directory rename for atomic commit.
 *
 * Must run under the worker flock (auto-capture-run.lock) to avoid
 * concurrent mutation with maybeRotateCaptureSpool.
 */

import {
  fstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  defaultSealedMoverPaths,
  moveSealedPairs,
  totalBytesInTree,
} from '../src/services/sealed-mover.js';

// ---------------------------------------------------------------------------
// CLI option parsing
// ---------------------------------------------------------------------------

export interface MoveSeaeldSpoolOptions {
  spoolDir: string;
  lockFile: string;
  dryRun: boolean;
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseMoveArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): MoveSeaeldSpoolOptions {
  return {
    spoolDir: optionValue(args, '--spool-dir') ??
      env.CC_MEMORY_SPOOL_DIR ?? join(homedir(), '.cache', 'cc-memory', 'spool'),
    lockFile: optionValue(args, '--lock-file') ??
      join(homedir(), '.cache', 'cc-memory', 'auto-capture-run.lock'),
    dryRun: args.includes('--dry-run'),
  };
}

// ---------------------------------------------------------------------------
// Flock re-exec (same pattern as archive-capture-backlog.ts)
// ---------------------------------------------------------------------------

function reexecUnderFlock(options: MoveSeaeldSpoolOptions): number | null {
  mkdirSync(join(homedir(), '.cache', 'cc-memory'), { recursive: true, mode: 0o700 });
  if (process.env.CC_MEMORY_SEALED_MOVE_LOCK_PATH !== undefined) {
    // We are the re-exec'd child — verify the lock
    const lockInfo = statSync(options.lockFile);
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
      throw new Error('inherited sealed-move lock fd does not match the lock file');
    }
    const fdInfo = readFileSync(`/proc/self/fdinfo/${matchingFd}`, 'utf8');
    const lockPattern = new RegExp(
      `^lock:\\s+\\d+: FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s+[^:]+:[^:]+:${lockInfo.ino}\\s`,
      'm',
    );
    if (!lockPattern.test(fdInfo)) {
      throw new Error('inherited sealed-move lock fd is not exclusively locked');
    }
    return null;
  }

  const child = spawnSync(
    '/usr/bin/flock',
    [
      '-F', '-n', '-E', '73', options.lockFile,
      process.execPath, '--import', 'tsx', process.argv[1], ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, CC_MEMORY_SEALED_MOVE_LOCK_PATH: options.lockFile },
    },
  );
  if (child.error) throw new Error(`failed to start sealed-move flock: ${child.error.message}`);
  if (child.status === 73) {
    process.stderr.write(`[cc-memory] sealed-move lock busy: ${options.lockFile}\n`);
    return 3;
  }
  return child.status ?? 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseMoveArgs(process.argv.slice(2));
  const paths = defaultSealedMoverPaths(options.spoolDir);

  if (options.dryRun) {
    const { pairs, orphans } = await import('../src/services/sealed-mover.js')
      .then((m) => m.discoverSealedPairs(paths.spoolDir));
    const spoolBytes = totalBytesInTree(paths.spoolDir);
    process.stdout.write(JSON.stringify({
      dryRun: true,
      spoolDir: paths.spoolDir,
      spoolBytes,
      sealedPairs: pairs.length,
      orphans: orphans.length,
      stagingDir: paths.stagingDir,
      finalDir: paths.finalDir,
    }, null, 2) + '\n');
    return 0;
  }

  // Acquire the worker flock
  const flockStatus = reexecUnderFlock(options);
  if (flockStatus !== null) return flockStatus;

  const bytesBefore = totalBytesInTree(paths.spoolDir);

  const result = moveSealedPairs({ paths });

  const bytesAfter = totalBytesInTree(paths.spoolDir);

  const output = {
    ok: !result.failClosed,
    moved: result.moved,
    skipped: result.skipped,
    orphans: result.orphans,
    errors: result.errors,
    failClosed: result.failClosed,
    spoolBytesBefore: bytesBefore,
    spoolBytesAfter: bytesAfter,
    bytesFreed: bytesBefore - bytesAfter,
  };
  process.stdout.write(JSON.stringify(output) + '\n');

  if (result.orphans.length > 0) {
    process.stderr.write(
      `[cc-memory] sealed-move: ${result.orphans.length} orphan file(s) found (not moved)\n`,
    );
  }

  return result.failClosed ? 1 : 0;
}

const isMain = process.argv[1] !== undefined &&
  basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'move-sealed-spool';

if (isMain) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(
        `[cc-memory] sealed-move failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
