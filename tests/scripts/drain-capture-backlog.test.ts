import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureWorkerResult } from '../../src/services/capture-worker.js';
import {
  assertDrainRuntimeConfig,
  classifyDrainTick,
  createVerifiedBackup,
  executeDrain,
  inspectCaptureBacklog,
  listArchiveJsonlEntries,
  mapFlockChildStatus,
  parseDrainArgs,
  runCaptureBacklogDrainLoop,
  validateSpoolBackup,
} from '../../scripts/drain-capture-backlog.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function result(overrides: Partial<CaptureWorkerResult> = {}): CaptureWorkerResult {
  return {
    processed: 0,
    skipped: 0,
    failed: 0,
    deadLettered: 0,
    rateLimited: 0,
    malformed: 0,
    blocked: 0,
    parked: 0,
    yielded: 0,
    held: 0,
    embeddingFailed: 0,
    transcriptMissing: 0,
    llmRetries: 0,
    observationsWritten: 0,
    rollupsWritten: 0,
    ...overrides,
  };
}

describe('drain tick classification', () => {
  it('refuses execute before side effects when production approval is denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-drain-approval-'));
    roots.push(root);
    const projectUrlFile = join(root, 'project-url');
    const spoolDir = join(root, 'spool');
    const backupDir = join(root, 'backup');
    const databaseUrl = 'postgres://writer:secret@localhost:5432/cc_memory';
    writeFileSync(projectUrlFile, `${databaseUrl}\n`, { mode: 0o600 });
    mkdirSync(spoolDir);
    const approvalCheck = vi.fn(async () => {
      throw new Error('production approval marker is unavailable');
    });

    const exitCode = await executeDrain(parseDrainArgs([
      '--execute',
      '--project-url-file', projectUrlFile,
      '--spool-dir', spoolDir,
      '--backup-dir', backupDir,
    ], {}), {
      checkProductionApproval: approvalCheck,
      now: () => new Date('2026-08-12T01:00:00.000Z'),
    });

    expect(exitCode).toBe(1);
    expect(approvalCheck).toHaveBeenCalledWith({
      databaseUrl,
      now: new Date('2026-08-12T01:00:00.000Z'),
    });
    expect(() => statSync(backupDir)).toThrow();
  });

  it('accepts the worker contract where a zero tick budget disables the budget', () => {
    expect(parseDrainArgs([], { CC_CAPTURE_TICK_BUDGET_MS: '0' }).budgetMs).toBe(0);
    expect(parseDrainArgs([], { CC_CAPTURE_TICK_BUDGET_MS: '' }).budgetMs).toBe(240_000);
  });

  it('accepts an explicit transcript snapshot directory for archived replay', () => {
    expect(parseDrainArgs([
      '--transcript-snapshot-dir',
      '/safe/archive/transcripts',
    ], {}).transcriptSnapshotDir).toBe('/safe/archive/transcripts');
    expect(parseDrainArgs([], {}).transcriptSnapshotDir).toBeUndefined();
  });

  it('rejects a database config cached before execute-mode environment injection', () => {
    expect(() => assertDrainRuntimeConfig('postgres://expected/db', 'postgres://stale/db'))
      .toThrow('loaded database config before DATABASE_URL injection');
    expect(() => assertDrainRuntimeConfig('postgres://expected/db', 'postgres://expected/db'))
      .not.toThrow();
  });

  it('uses yielded, progress, failing, rate-limited, and idle precedence', () => {
    expect(classifyDrainTick(result({ yielded: 1, processed: 2 }), 1, 100)).toBe('YIELDED');
    expect(classifyDrainTick(result({ processed: 1, failed: 1 }), 1, 100)).toBe('PROGRESS');
    expect(classifyDrainTick(result({ failed: 1 }), 1, 100)).toBe('FAILING');
    expect(classifyDrainTick(result({ rateLimited: 1 }), 1, 100)).toBe('RATE_LIMITED');
    expect(classifyDrainTick(result({ held: 1, skipped: 9 }), 1, 100)).toBe('IDLE');
    expect(classifyDrainTick(result(), 90, 100)).toBe('YIELDED');
    expect(classifyDrainTick(result(), 90, 0)).toBe('IDLE');
  });

  it('maps flock conflict status to the public exit code', () => {
    expect(mapFlockChildStatus(73)).toBe(3);
    expect(mapFlockChildStatus(0)).toBe(0);
    expect(mapFlockChildStatus(null)).toBe(1);
  });

  it('trips failure, rate-limit, idle-held, and wall-clock exits deterministically', async () => {
    const noSleep = async () => {};
    const failures = await runCaptureBacklogDrainLoop(
      { maxMinutes: 120, maxTicks: 0, sleepMs: 1, budgetMs: 100 },
      { runTick: async () => result({ failed: 1 }), nowMs: (() => { let n = 0; return () => n++; })(), sleep: noSleep }
    );
    expect(failures.exitCode).toBe(2);
    expect(failures.ticks).toBe(3);

    const rateLimited = await runCaptureBacklogDrainLoop(
      { maxMinutes: 120, maxTicks: 0, sleepMs: 1, budgetMs: 100 },
      { runTick: async () => result({ rateLimited: 1 }), nowMs: (() => { let n = 0; return () => n++; })(), sleep: noSleep }
    );
    expect(rateLimited.exitCode).toBe(6);

    const held = await runCaptureBacklogDrainLoop(
      { maxMinutes: 120, maxTicks: 0, sleepMs: 1, budgetMs: 100 },
      { runTick: async () => result({ held: 1 }), nowMs: (() => { let n = 0; return () => n++; })(), sleep: noSleep }
    );
    expect(held.exitCode).toBe(5);

    const budgetDisabled = await runCaptureBacklogDrainLoop(
      { maxMinutes: 120, maxTicks: 0, sleepMs: 1, budgetMs: 0 },
      { runTick: async () => result(), nowMs: (() => { let n = 0; return () => n++; })(), sleep: noSleep }
    );
    expect(budgetDisabled).toMatchObject({ exitCode: 0, ticks: 2 });

    const wallClock = await runCaptureBacklogDrainLoop(
      { maxMinutes: 0.00001, maxTicks: 0, sleepMs: 1, budgetMs: 100 },
      { runTick: async () => result({ processed: 1 }), nowMs: (() => { let n = 0; return () => (n += 1000); })(), sleep: noSleep }
    );
    expect(wallClock.exitCode).toBe(5);
  });
});

describe('spool backup validation', () => {
  it('lists and counts an archive whose entry output exceeds the child-process buffer', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-large-tar-list-'));
    roots.push(root);
    const fileName = `${'long-entry-'.repeat(12)}.jsonl`;
    const source = join(root, fileName);
    const archive = join(root, 'large-list.tar.gz');
    const fileList = join(root, 'files.txt');
    const expectedCount = 15_000;
    writeFileSync(source, '{}\n');
    writeFileSync(fileList, `${Array(expectedCount).fill(fileName).join('\n')}\n`);
    const created = spawnSync(
      'tar',
      ['-C', root, '-czf', archive, '-T', fileList],
      { encoding: 'utf8' },
    );
    expect(created.status).toBe(0);
    expect(expectedCount * (fileName.length + 1)).toBeGreaterThan(1024 * 1024);

    expect(listArchiveJsonlEntries(archive)).toEqual({
      status: 0,
      archiveJsonlCount: expectedCount,
      stderr: '',
    });
  });

  it('accepts tar code 1 only for file-changed warnings and verifies the full archive', () => {
    expect(validateSpoolBackup({
      createStatus: 1,
      createStderr: 'tar: spool/a.jsonl: file changed as we read it\n',
      listStatus: 0,
      listOutput: 'spool/a.jsonl\nspool/b.jsonl\n',
      beforeJsonlCount: 2,
      archiveBytes: 10,
    })).toEqual({ ok: true, archiveJsonlCount: 2 });

    expect(validateSpoolBackup({
      createStatus: 1,
      createStderr: 'tar: permission denied\n',
      listStatus: 0,
      listOutput: 'spool/a.jsonl\n',
      beforeJsonlCount: 1,
      archiveBytes: 10,
    }).ok).toBe(false);
    expect(validateSpoolBackup({
      createStatus: 0,
      createStderr: '',
      listStatus: 0,
      listOutput: 'spool/a.jsonl\n',
      beforeJsonlCount: 2,
      archiveBytes: 10,
    }).ok).toBe(false);
  });

  it('creates and verifies a restorable archive for a temporary spool', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-backup-'));
    roots.push(root);
    const spool = join(root, 'spool');
    const backup = join(root, 'backup');
    mkdirSync(join(spool, 'project'), { recursive: true });
    mkdirSync(backup, { mode: 0o755 });
    chmodSync(backup, 0o755);
    writeFileSync(join(spool, 'project', 'session.jsonl'), '{}\n');

    const archive = createVerifiedBackup(spool, backup);

    expect(statSync(archive).size).toBeGreaterThan(0);
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('spool/project/session.jsonl');
  });
});

describe('capture backlog dry-run inspection', () => {
  it('counts a missing original as replayable when its explicit snapshot reaches the boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-drain-snapshot-inspect-'));
    roots.push(root);
    const spool = join(root, 'spool');
    const snapshots = join(root, 'snapshots');
    const missing = join(root, 'gone-transcript.jsonl');
    mkdirSync(join(spool, 'project'), { recursive: true });
    mkdirSync(snapshots);
    writeFileSync(join(spool, 'project', 'session.jsonl'), [
      JSON.stringify({ transcript_path: missing, transcript_offset: 0 }),
      JSON.stringify({ transcript_path: missing, hwm_offset: 20 }),
      '',
    ].join('\n'));
    const hash = createHash('sha256').update(missing).digest('hex');
    writeFileSync(join(snapshots, `${hash}.jsonl`), 'x'.repeat(20));

    const replayable = await inspectCaptureBacklog(spool, {
      maxWindowBytes: 32 * 1024,
      transcriptSnapshotDir: snapshots,
    });
    const tooShort = await inspectCaptureBacklog(spool, {
      maxWindowBytes: 32 * 1024,
      transcriptSnapshotDir: join(root, 'missing-snapshots'),
    });

    expect(replayable).toMatchObject({ pendingLlm: 1, transcriptFileMissing: 0 });
    expect(tooShort).toMatchObject({ pendingLlm: 0, transcriptFileMissing: 1 });
  });

  it('classifies without writing and returns the same report twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-drain-inspect-'));
    roots.push(root);
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, '{"message":"hello"}\n');
    const session = join(project, 'session.jsonl');
    writeFileSync(session, [
      JSON.stringify({ transcript_path: transcript, transcript_offset: 0 }),
      JSON.stringify({ transcript_path: transcript, hwm_offset: 20 }),
      '',
    ].join('\n'));
    const pathless = join(project, 'pathless.jsonl');
    writeFileSync(pathless, `${JSON.stringify({ transcript_path: '', hwm_offset: 0 })}\n`);
    writeFileSync(join(project, 'complete.jsonl'), '{}\n');
    writeFileSync(join(project, 'complete.capture-state.json'), JSON.stringify({
      version: 2,
      spool: { generation: 'x', cursor: 3 },
      transcripts: {},
      retries: {},
      splitHints: {},
    }));
    writeFileSync(join(project, 'missing.jsonl'), [
      JSON.stringify({ transcript_path: join(root, 'gone.jsonl'), transcript_offset: 0 }),
      JSON.stringify({ transcript_path: join(root, 'gone.jsonl'), hwm_offset: 20 }),
      '',
    ].join('\n'));
    writeFileSync(join(project, 'baseline.jsonl'), [
      JSON.stringify({ transcript_path: transcript, transcript_offset: 0 }),
      '',
    ].join('\n'));
    mkdirSync(join(root, '.dead'));
    writeFileSync(join(root, '.dead', 'one.json'), '{}');

    const before = readFileSync(session, 'utf8');
    const first = await inspectCaptureBacklog(root, { maxWindowBytes: 32 * 1024 });
    const second = await inspectCaptureBacklog(root, { maxWindowBytes: 32 * 1024 });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      complete: 1,
      pathlessTerminal: 1,
      pendingLlm: 1,
      transcriptFileMissing: 1,
      baselineOnly: 1,
      parkedDead: 1,
    });
    expect(readFileSync(session, 'utf8')).toBe(before);
  });

  it('does not create the requested backup directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-drain-cli-'));
    roots.push(root);
    const spool = join(root, 'spool');
    const backup = join(root, 'missing', 'backup');
    mkdirSync(spool);
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const script = join(process.cwd(), 'scripts', 'drain-capture-backlog.ts');

    const child = spawnSync(
      process.execPath,
      [tsxCli, script, '--json', '--spool-dir', spool, '--backup-dir', backup],
      { encoding: 'utf8' }
    );

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ dryRun: true, spoolDir: spool });
    expect(() => statSync(backup)).toThrow();
  });

  it('returns exit 3 when the shared flock is already held', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-drain-lock-'));
    roots.push(root);
    const lock = join(root, 'auto-capture-run.lock');
    const holder = spawn(
      '/usr/bin/flock',
      [lock, process.execPath, '-e', 'setTimeout(() => {}, 3000)'],
      { stdio: 'ignore' }
    );
    try {
      let locked = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const probe = spawnSync('/usr/bin/flock', ['-n', '-E', '73', lock, 'true']);
        if (probe.status === 73) {
          locked = true;
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      expect(locked).toBe(true);
      const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const script = join(process.cwd(), 'scripts', 'drain-capture-backlog.ts');
      const child = spawnSync(
        process.execPath,
        [tsxCli, script, '--execute', '--lock-file', lock],
        { encoding: 'utf8' }
      );
      expect(child.status).toBe(3);
      expect(child.stderr).toContain('backlog drain lock busy');
    } finally {
      holder.kill('SIGTERM');
    }
  });
});
