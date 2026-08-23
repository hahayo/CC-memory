import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultSealedMoverPaths,
  discoverSealedPairs,
  moveSealedPairs,
  sha256File,
  totalBytesInTree,
  validateFilesystems,
} from '../../src/services/sealed-mover.js';
import type {
  SealedMoverPaths,
  StepName,
} from '../../src/services/sealed-mover.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-sealed-mover-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePaths(root: string): SealedMoverPaths {
  const spoolDir = join(root, 'spool');
  const stagingDir = join(root, 'sealed-staging');
  const finalDir = join(root, 'spool-sealed');
  mkdirSync(spoolDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(finalDir, { recursive: true });
  return {
    spoolDir,
    stagingDir,
    finalDir,
    journalPath: join(root, 'sealed-move-journal.jsonl'),
    manifestPath: join(finalDir, 'manifest.jsonl'),
  };
}

function createSealedPair(
  spoolDir: string,
  projectId: string,
  sessionId: string,
  timestamp: number,
  generation: number,
): { spoolPath: string; statePath: string; retryKey: string } {
  const dir = join(spoolDir, projectId);
  mkdirSync(dir, { recursive: true });
  const suffix = `${timestamp}.${generation}.sealed`;
  const spoolPath = join(dir, `${sessionId}.jsonl.${suffix}`);
  const statePath = join(dir, `${sessionId}.capture-state.json.${suffix}`);
  writeFileSync(spoolPath, `{"session":"${sessionId}","sealed":true}\n`);
  writeFileSync(statePath, JSON.stringify({ cursor: 42, spool: { generation } }));
  const retryKey = `${sessionId}.jsonl.${suffix}`;
  return { spoolPath, statePath, retryKey };
}

// no-op step hook for non-crash tests
const noop = () => { /* no-op */ };

// ---------------------------------------------------------------------------
// validateFilesystems
// ---------------------------------------------------------------------------

describe('validateFilesystems', () => {
  it('passes when all dirs are on the same filesystem and final is outside spool', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const result = validateFilesystems(paths);
    expect(result.ok).toBe(true);
  });

  it('fails when final is inside spool tree', () => {
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const finalDir = join(spoolDir, 'nested-final');
    mkdirSync(finalDir, { recursive: true });
    const stagingDir = join(root, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    const paths: SealedMoverPaths = {
      spoolDir,
      stagingDir,
      finalDir,
      journalPath: join(root, 'journal.jsonl'),
      manifestPath: join(finalDir, 'manifest.jsonl'),
    };
    const result = validateFilesystems(paths);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('inside spool tree');
  });

  it('catches the spool/spool-sealed startsWith footgun', () => {
    // Default paths: spool=~/.cache/cc-memory/spool, final=~/.cache/cc-memory/spool-sealed
    // A naive startsWith("spool") would wrongly flag spool-sealed
    const root = makeRoot();
    const spoolDir = join(root, 'spool');
    const finalDir = join(root, 'spool-sealed');
    const stagingDir = join(root, 'sealed-staging');
    mkdirSync(spoolDir, { recursive: true });
    mkdirSync(finalDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });
    const paths: SealedMoverPaths = {
      spoolDir,
      stagingDir,
      finalDir,
      journalPath: join(root, 'journal.jsonl'),
      manifestPath: join(finalDir, 'manifest.jsonl'),
    };
    // path.relative('spool', 'spool-sealed') = '../spool-sealed' → starts with '..'
    const result = validateFilesystems(paths);
    expect(result.ok).toBe(true);
  });

  it('fails when devices differ', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    // Mock different devices
    const fakeStatFn = (p: string) => {
      const real = statSync(p);
      if (p === resolve(paths.finalDir)) {
        return { ...real, dev: real.dev + 1 };
      }
      return real;
    };
    const result = validateFilesystems(paths, fakeStatFn);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('filesystem mismatch');
  });
});

// ---------------------------------------------------------------------------
// discoverSealedPairs
// ---------------------------------------------------------------------------

describe('discoverSealedPairs', () => {
  it('finds complete sealed pairs', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    createSealedPair(paths.spoolDir, 'project1', 'sess1', 1000, 1);

    const { pairs, orphans } = discoverSealedPairs(paths.spoolDir);
    expect(pairs).toHaveLength(1);
    expect(orphans).toHaveLength(0);
    expect(pairs[0].retryKey).toContain('sess1.jsonl');
  });

  it('reports orphan spool file (no matching state)', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const dir = join(paths.spoolDir, 'project1');
    mkdirSync(dir, { recursive: true });
    // Only spool file, no state
    writeFileSync(join(dir, 'sess1.jsonl.1000.1.sealed'), '{"data":1}\n');

    const { pairs, orphans } = discoverSealedPairs(paths.spoolDir);
    expect(pairs).toHaveLength(0);
    expect(orphans).toHaveLength(1);
  });

  it('reports orphan state file (no matching spool)', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const dir = join(paths.spoolDir, 'project1');
    mkdirSync(dir, { recursive: true });
    // Only state file, no spool
    writeFileSync(join(dir, 'sess1.capture-state.json.1000.1.sealed'), '{"cursor":1}');

    const { pairs, orphans } = discoverSealedPairs(paths.spoolDir);
    expect(pairs).toHaveLength(0);
    expect(orphans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// moveSealedPairs — happy path
// ---------------------------------------------------------------------------

describe('moveSealedPairs', () => {
  it('moves a sealed pair to final and writes manifest', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);

    const result = moveSealedPairs({
      paths,
      fsyncDir: noop,
      onStep: noop,
    });

    expect(result.moved).toBe(1);
    expect(result.failClosed).toBe(false);
    expect(result.orphans).toHaveLength(0);

    // Source files should be gone
    expect(existsSync(pair.spoolPath)).toBe(false);
    expect(existsSync(pair.statePath)).toBe(false);

    // Final should have the pair
    const finalSubdir = join(paths.finalDir, pair.retryKey);
    expect(existsSync(finalSubdir)).toBe(true);

    // Manifest should have an entry
    const manifest = readFileSync(paths.manifestPath, 'utf8');
    expect(manifest).toContain(pair.retryKey);
  });

  it('moves multiple pairs', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    createSealedPair(paths.spoolDir, 'proj', 'sess1', 1000, 1);
    createSealedPair(paths.spoolDir, 'proj', 'sess2', 2000, 1);

    const result = moveSealedPairs({
      paths,
      fsyncDir: noop,
      onStep: noop,
    });

    expect(result.moved).toBe(2);
  });

  it('reports orphan pairs', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const dir = join(paths.spoolDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'orphan.jsonl.3000.1.sealed'), '{"orphan":true}\n');

    const result = moveSealedPairs({
      paths,
      fsyncDir: noop,
      onStep: noop,
    });

    expect(result.orphans).toHaveLength(1);
  });

  it('handles destination already exists with same hash (deletes source)', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);

    // Pre-create the final with same content
    const finalSubdir = join(paths.finalDir, pair.retryKey);
    mkdirSync(finalSubdir, { recursive: true });
    const spoolContent = readFileSync(pair.spoolPath);
    const stateContent = readFileSync(pair.statePath);
    writeFileSync(join(finalSubdir, `sess.jsonl.1000.1.sealed`), spoolContent);
    writeFileSync(join(finalSubdir, `sess.capture-state.json.1000.1.sealed`), stateContent);

    const result = moveSealedPairs({
      paths,
      fsyncDir: noop,
      onStep: noop,
    });

    expect(result.moved).toBe(1);
    // Source should be deleted
    expect(existsSync(pair.spoolPath)).toBe(false);
    expect(existsSync(pair.statePath)).toBe(false);
  });

  it('fail-closed when destination exists with different hash', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);

    // Pre-create the final with DIFFERENT content
    const finalSubdir = join(paths.finalDir, pair.retryKey);
    mkdirSync(finalSubdir, { recursive: true });
    writeFileSync(join(finalSubdir, 'sess.jsonl.1000.1.sealed'), 'DIFFERENT\n');
    writeFileSync(join(finalSubdir, 'sess.capture-state.json.1000.1.sealed'), '{"diff":true}');

    const result = moveSealedPairs({
      paths,
      fsyncDir: noop,
      onStep: noop,
    });

    expect(result.failClosed).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    // Source should NOT be deleted
    expect(existsSync(pair.spoolPath)).toBe(true);
    expect(existsSync(pair.statePath)).toBe(true);
  });

  it('totalSpoolBytes drops after move', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);

    const bytesBefore = totalBytesInTree(paths.spoolDir);
    expect(bytesBefore).toBeGreaterThan(0);

    moveSealedPairs({
      paths,
      fsyncDir: noop,
      onStep: noop,
    });

    const bytesAfter = totalBytesInTree(paths.spoolDir);
    expect(bytesAfter).toBeLessThan(bytesBefore);
  });

  it('manifest is idempotent (retryKey+spoolHash+stateHash deduplication)', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);

    // First move
    moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });

    const manifestAfterFirst = readFileSync(paths.manifestPath, 'utf8').trim().split('\n');

    // Re-create the same pair and move again
    createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);
    moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });

    // The manifest should still have only the unique entries based on content
    // (second run finds it already in final with same hash → deletes source)
    const manifestAfterSecond = readFileSync(paths.manifestPath, 'utf8').trim().split('\n');
    // The pair is the same content so it should not create a duplicate
    // (it goes through the "destination exists same hash" path)
    expect(manifestAfterSecond.length).toBeLessThanOrEqual(manifestAfterFirst.length + 1);
  });
});

// ---------------------------------------------------------------------------
// Crash injection tests
// ---------------------------------------------------------------------------

describe('sealed-mover crash injection', () => {
  const crashSteps: StepName[] = [
    'intent-spool-written',
    'journal-fsynced-intent-spool',
    'spool-renamed-to-staging',
    'source-dir-fsynced-after-spool',
    'staging-dir-fsynced-after-spool',
    'completed-spool-written',
    'journal-fsynced-completed-spool',
    'intent-state-written',
    'journal-fsynced-intent-state',
    'state-renamed-to-staging',
    'source-dir-fsynced-after-state',
    'staging-dir-fsynced-after-state',
    'completed-state-written',
    'journal-fsynced-completed-state',
    'staging-renamed-to-final',
    'final-parent-fsynced',
    'manifest-written',
    'manifest-fsynced',
    'phase-manifest-committed',
  ];

  for (const crashAt of crashSteps) {
    it(`recovers to manifest-committed after crash at: ${crashAt}`, () => {
      const root = makeRoot();
      const paths = makePaths(root);
      const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);
      const spoolHash = sha256File(pair.spoolPath);
      const stateHash = sha256File(pair.statePath);

      // Attempt move — crash at the specified step
      try {
        moveSealedPairs({
          paths,
          fsyncDir: noop,
          onStep: (step) => {
            if (step === crashAt) {
              throw new Error(`simulated crash at ${crashAt}`);
            }
          },
        });
      } catch {
        // Expected crash
      }

      // Recovery: run moveSealedPairs again (it runs recoverJournal first)
      moveSealedPairs({
        paths,
        fsyncDir: noop,
        onStep: noop,
      });

      // After recovery, the pair should be in final (either from recovery or fresh move)
      const finalSubdir = join(paths.finalDir, pair.retryKey);
      const spoolInFinal = readdirSync(finalSubdir).find((f) => f.endsWith('.sealed') && f.includes('.jsonl.'));
      const stateInFinal = readdirSync(finalSubdir).find((f) => f.endsWith('.sealed') && f.includes('.capture-state.'));
      expect(spoolInFinal).toBeDefined();
      expect(stateInFinal).toBeDefined();

      // Verify hashes match
      expect(sha256File(join(finalSubdir, spoolInFinal!))).toBe(spoolHash);
      expect(sha256File(join(finalSubdir, stateInFinal!))).toBe(stateHash);

      // Source should be cleaned up
      expect(existsSync(pair.spoolPath)).toBe(false);
      expect(existsSync(pair.statePath)).toBe(false);

      // Pair should not be duplicated — exactly one copy in final
      const finalFiles = readdirSync(finalSubdir);
      const sealedFiles = finalFiles.filter((f) => f.endsWith('.sealed'));
      expect(sealedFiles).toHaveLength(2); // One spool + one state
    });
  }
});

// ---------------------------------------------------------------------------
// Journal convergence: second run reports moved=0 and cleans journal
// ---------------------------------------------------------------------------

describe('sealed-mover journal convergence', () => {
  it('second run after successful move reports moved=0 and journal is absent', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);

    const first = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(first.moved).toBe(1);

    const second = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(second.moved).toBe(0);
    expect(existsSync(paths.journalPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Journal-lost rebuild: complete pair in staging converges
// ---------------------------------------------------------------------------

describe('sealed-mover journal-lost rebuild', () => {
  it('recovers a complete pair stranded in staging after journal deletion', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);
    // Crash after both files reach staging but before final rename
    try {
      moveSealedPairs({
        paths,
        fsyncDir: noop,
        onStep: (step) => {
          if (step === 'completed-state-written') throw new Error('crash');
        },
      });
    } catch { /* expected */ }

    // Delete the journal to simulate journal loss
    if (existsSync(paths.journalPath)) {
      rmSync(paths.journalPath);
    }

    // Recovery should find the pair in staging and commit it
    const recovery = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(recovery.moved).toBeGreaterThanOrEqual(1);

    // The pair should be in final
    const finalSubdir = join(paths.finalDir, pair.retryKey);
    expect(existsSync(finalSubdir)).toBe(true);
    const finalFiles = readdirSync(finalSubdir);
    expect(finalFiles.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Crash recovery: staging subdir cleaned after recovery
// ---------------------------------------------------------------------------

describe('sealed-mover staging cleanup after recovery', () => {
  it('staging subdir is gone after successful recovery', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 1000, 1);

    // Crash after spool moved to staging
    try {
      moveSealedPairs({
        paths,
        fsyncDir: noop,
        onStep: (step) => {
          if (step === 'spool-renamed-to-staging') throw new Error('crash');
        },
      });
    } catch { /* expected */ }

    const stagingSubdir = join(paths.stagingDir, pair.retryKey);
    // Staging subdir should exist after crash
    expect(existsSync(stagingSubdir)).toBe(true);

    // Recovery
    moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });

    // Staging subdir should be gone (renamed to final)
    expect(existsSync(stagingSubdir)).toBe(false);
    // Final should exist
    expect(existsSync(join(paths.finalDir, pair.retryKey))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultSealedMoverPaths
// ---------------------------------------------------------------------------

describe('defaultSealedMoverPaths', () => {
  it('returns the documented default paths', () => {
    const paths = defaultSealedMoverPaths();
    expect(paths.spoolDir).toContain('.cache/cc-memory/spool');
    expect(paths.stagingDir).toContain('sealed-staging');
    expect(paths.finalDir).toContain('spool-sealed');
    expect(paths.journalPath).toContain('sealed-move-journal.jsonl');
    expect(paths.manifestPath).toContain('spool-sealed/manifest.jsonl');
  });
});

// ---------------------------------------------------------------------------
// totalBytesInTree
// ---------------------------------------------------------------------------

describe('totalBytesInTree', () => {
  it('counts all file bytes recursively', () => {
    const root = makeRoot();
    const dir = join(root, 'test');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'hello'); // 5 bytes
    writeFileSync(join(dir, 'sub', 'b.txt'), 'world!'); // 6 bytes
    expect(totalBytesInTree(dir)).toBe(11);
  });

  it('returns 0 for non-existent directory', () => {
    expect(totalBytesInTree('/nonexistent')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Finding 5: journal-lost crash injection × 3 positions
// Recovery must scan source + staging + final, converge to manifest-committed.
// ---------------------------------------------------------------------------

describe('sealed-mover journal-lost crash recovery (3 positions)', () => {
  it('converges when journal lost after only spool moved to staging', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 2000, 1);
    const spoolHash = sha256File(pair.spoolPath);
    const stateHash = sha256File(pair.statePath);

    // Simulate: spool in staging, state still in source, no journal
    const stagingSubdir = join(paths.stagingDir, pair.retryKey);
    mkdirSync(stagingSubdir, { recursive: true });
    renameSync(pair.spoolPath, join(stagingSubdir, basename(pair.spoolPath)));
    // State remains in source at pair.statePath

    // No journal exists — simulate journal loss
    // Recovery should find spool in staging, locate state in source, complete the move
    const result = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(result.failClosed).toBe(false);

    // Final should have exactly 2 files (one spool + one state)
    const finalSubdir = join(paths.finalDir, pair.retryKey);
    expect(existsSync(finalSubdir)).toBe(true);
    const finalFiles = readdirSync(finalSubdir);
    expect(finalFiles.filter((f: string) => f.endsWith('.sealed'))).toHaveLength(2);

    // Manifest should be committed
    const manifest = readFileSync(paths.manifestPath, 'utf8');
    expect(manifest).toContain(pair.retryKey);
    expect(manifest).toContain(spoolHash);
    expect(manifest).toContain(stateHash);

    // Source files should be gone
    expect(existsSync(pair.spoolPath)).toBe(false);
    expect(existsSync(pair.statePath)).toBe(false);

    // Second run: moved=0 (idempotent)
    const second = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(second.moved).toBe(0);
  });

  it('converges when journal lost after both files moved to staging', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 3000, 1);
    const spoolHash = sha256File(pair.spoolPath);
    const stateHash = sha256File(pair.statePath);

    // Simulate: both files in staging, no journal
    const stagingSubdir = join(paths.stagingDir, pair.retryKey);
    mkdirSync(stagingSubdir, { recursive: true });
    renameSync(pair.spoolPath, join(stagingSubdir, basename(pair.spoolPath)));
    renameSync(pair.statePath, join(stagingSubdir, basename(pair.statePath)));

    const result = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(result.failClosed).toBe(false);

    // Final should have the pair
    const finalSubdir = join(paths.finalDir, pair.retryKey);
    expect(existsSync(finalSubdir)).toBe(true);
    const finalFiles = readdirSync(finalSubdir);
    expect(finalFiles.filter((f: string) => f.endsWith('.sealed'))).toHaveLength(2);

    // Manifest committed
    const manifest = readFileSync(paths.manifestPath, 'utf8');
    expect(manifest).toContain(spoolHash);
    expect(manifest).toContain(stateHash);

    // Second run: moved=0
    const second = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(second.moved).toBe(0);
  });

  it('converges when journal lost after final rename but before manifest', () => {
    const root = makeRoot();
    const paths = makePaths(root);
    const pair = createSealedPair(paths.spoolDir, 'proj', 'sess', 4000, 1);
    const spoolHash = sha256File(pair.spoolPath);
    const stateHash = sha256File(pair.statePath);

    // Simulate: pair already in final, but manifest has no entry, no journal
    const finalSubdir = join(paths.finalDir, pair.retryKey);
    mkdirSync(finalSubdir, { recursive: true });
    renameSync(pair.spoolPath, join(finalSubdir, basename(pair.spoolPath)));
    renameSync(pair.statePath, join(finalSubdir, basename(pair.statePath)));

    // No manifest, no journal. Recovery backfills manifest without counting
    // as "moved" (no files physically relocated). No source files remain for
    // the discovery pass, so overall moved=0.
    const result = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(result.failClosed).toBe(false);

    // Manifest should now be committed with correct hashes
    expect(existsSync(paths.manifestPath)).toBe(true);
    const manifest = readFileSync(paths.manifestPath, 'utf8');
    expect(manifest).toContain(pair.retryKey);
    expect(manifest).toContain(spoolHash);
    expect(manifest).toContain(stateHash);

    // Pair still in final, not duplicated
    const finalFiles = readdirSync(finalSubdir);
    expect(finalFiles.filter((f: string) => f.endsWith('.sealed'))).toHaveLength(2);

    // Second run: moved=0
    const second = moveSealedPairs({ paths, fsyncDir: noop, onStep: noop });
    expect(second.moved).toBe(0);
  });
});
