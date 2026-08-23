#!/usr/bin/env npx tsx
/** One-shot, foreground recovery for the hook-driven capture spool. */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createCaptureLlmAdapter,
  isCaptureLlmDisabled,
} from '../src/services/capture-llm.js';
import type { CaptureWorkerResult } from '../src/services/capture-worker.js';
import { checkProductionApproval } from './run-auto-capture-supervisor.js';

const DEFAULT_SPOOL_DIR = path.join(homedir(), '.cache', 'cc-memory', 'spool');
const DEFAULT_PROJECT_URL_FILE = path.join(homedir(), '.ccm-project-url');
const DEFAULT_GEMINI_KEY_FILE = path.join(homedir(), '.gemini-api-key');
const DEFAULT_BACKUP_DIR = path.join(homedir(), 'backups', 'cc-memory');
const DEFAULT_LOCK_FILE = path.join(homedir(), '.cache', 'cc-memory', 'auto-capture-run.lock');
const DEFAULT_BUDGET_MS = 240_000;
const DEFAULT_MAX_WINDOW_BYTES = 32 * 1024;

export type DrainTickClass = 'YIELDED' | 'PROGRESS' | 'FAILING' | 'RATE_LIMITED' | 'IDLE';

export interface DrainLoopOptions {
  maxMinutes: number;
  maxTicks: number;
  sleepMs: number;
  budgetMs: number;
}

export interface DrainLoopDeps {
  runTick: () => Promise<CaptureWorkerResult>;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isInterrupted?: () => boolean;
}

export interface DrainLoopResult {
  exitCode: 0 | 2 | 5 | 6 | 130;
  ticks: number;
  held: number;
  totals: CaptureWorkerResult;
}

export interface BacklogInspection {
  jsonlFiles: number;
  spoolBytes: number;
  complete: number;
  pathlessTerminal: number;
  pendingLlm: number;
  pendingBytes: number;
  estimatedLlmCalls: number;
  transcriptFileMissing: number;
  parkedDead: number;
  malformedSuspect: number;
  noBoundary: number;
  baselineOnly: number;
  locked: number;
  sealedLegacy: number;
}

export interface BackupValidationInput {
  createStatus: number | null;
  createStderr: string;
  listStatus: number | null;
  listOutput?: string;
  archiveJsonlCount?: number;
  beforeJsonlCount: number;
  archiveBytes: number;
}

export interface BackupValidationResult {
  ok: boolean;
  archiveJsonlCount: number;
  reason?: string;
}

interface DrainCliOptions extends DrainLoopOptions {
  execute: boolean;
  json: boolean;
  spoolDir: string;
  backupDir: string;
  projectUrlFile: string;
  geminiKeyFile: string;
  lockFile: string;
  transcriptSnapshotDir?: string;
}

export interface DrainExecuteDeps {
  checkProductionApproval?: typeof checkProductionApproval;
  now?: () => Date;
}

function emptyWorkerResult(): CaptureWorkerResult {
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
    primaryProvider: '',
    primarySuccess: 0,
    fallbackSuccess: 0,
    fallbackFailed: 0,
    fatalError: null,
    spoolBytes: 0,
    spoolCapPct: 0,
    windows: 0,
  };
}

const NUMERIC_RESULT_KEYS: ReadonlyArray<keyof CaptureWorkerResult> = [
  'processed', 'skipped', 'failed', 'deadLettered', 'rateLimited',
  'malformed', 'blocked', 'parked', 'yielded', 'held', 'embeddingFailed',
  'transcriptMissing', 'llmRetries', 'observationsWritten', 'rollupsWritten',
  'primarySuccess', 'fallbackSuccess', 'fallbackFailed',
  'spoolBytes', 'spoolCapPct', 'windows',
];

function addWorkerResult(target: CaptureWorkerResult, value: CaptureWorkerResult): void {
  for (const key of NUMERIC_RESULT_KEYS) {
    (target[key] as number) += value[key] as number;
  }
  // Non-numeric fields: take last non-empty value
  if (value.primaryProvider) target.primaryProvider = value.primaryProvider;
  if (value.fatalError) target.fatalError = value.fatalError;
}

export function classifyDrainTick(
  result: CaptureWorkerResult,
  tickDurationMs: number,
  budgetMs: number
): DrainTickClass {
  if (result.yielded > 0 || (budgetMs > 0 && tickDurationMs >= budgetMs * 0.9)) {
    return 'YIELDED';
  }
  const progress =
    result.processed + result.parked + result.malformed + result.transcriptMissing +
    result.observationsWritten;
  if (progress > 0) return 'PROGRESS';
  if (result.failed > 0) return 'FAILING';
  if (result.rateLimited > 0) return 'RATE_LIMITED';
  return 'IDLE';
}

export async function runCaptureBacklogDrainLoop(
  options: DrainLoopOptions,
  deps: DrainLoopDeps
): Promise<DrainLoopResult> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = nowMs();
  const totals = emptyWorkerResult();
  let ticks = 0;
  let failureStreak = 0;
  let rateLimitStreak = 0;
  let idleStreak = 0;

  while (options.maxTicks === 0 || ticks < options.maxTicks) {
    const tickStartedAt = nowMs();
    const result = await deps.runTick();
    const tickFinishedAt = nowMs();
    ticks += 1;
    addWorkerResult(totals, result);
    const classification = classifyDrainTick(
      result,
      tickFinishedAt - tickStartedAt,
      options.budgetMs
    );

    if (classification === 'FAILING') {
      failureStreak += 1;
      rateLimitStreak = 0;
      idleStreak = 0;
      if (failureStreak >= 3) return { exitCode: 2, ticks, held: totals.held, totals };
    } else if (classification === 'RATE_LIMITED') {
      failureStreak = 0;
      rateLimitStreak += 1;
      idleStreak = 0;
      if (rateLimitStreak >= 2) return { exitCode: 6, ticks, held: totals.held, totals };
    } else if (classification === 'IDLE') {
      failureStreak = 0;
      rateLimitStreak = 0;
      idleStreak += 1;
      if (idleStreak >= 2) {
        return { exitCode: totals.held > 0 ? 5 : 0, ticks, held: totals.held, totals };
      }
    } else {
      failureStreak = 0;
      rateLimitStreak = 0;
      idleStreak = 0;
    }

    if (deps.isInterrupted?.()) return { exitCode: 130, ticks, held: totals.held, totals };
    if (tickFinishedAt - startedAt >= options.maxMinutes * 60_000) {
      return { exitCode: 5, ticks, held: totals.held, totals };
    }
    await sleep(options.sleepMs);
  }

  return { exitCode: 5, ticks, held: totals.held, totals };
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function numericBoundary(record: Record<string, unknown>): number | null {
  if (Number.isInteger(record.hwm_offset) && Number(record.hwm_offset) >= 0) {
    return Number(record.hwm_offset);
  }
  if (Number.isInteger(record.transcript_offset) && Number(record.transcript_offset) >= 0) {
    return Number(record.transcript_offset);
  }
  return null;
}

export async function inspectCaptureBacklog(
  spoolDir: string,
  options: { maxWindowBytes: number; transcriptSnapshotDir?: string }
): Promise<BacklogInspection> {
  const report: BacklogInspection = {
    jsonlFiles: 0,
    spoolBytes: 0,
    complete: 0,
    pathlessTerminal: 0,
    pendingLlm: 0,
    pendingBytes: 0,
    estimatedLlmCalls: 0,
    transcriptFileMissing: 0,
    parkedDead: 0,
    malformedSuspect: 0,
    noBoundary: 0,
    baselineOnly: 0,
    locked: 0,
    sealedLegacy: 0,
  };
  const files = walkFiles(spoolDir);
  report.spoolBytes = files.reduce((total, file) => total + statSync(file).size, 0);
  report.parkedDead = files.filter(
    (file) => file.includes(`${path.sep}.dead${path.sep}`) && file.endsWith('.json')
  ).length;
  report.sealedLegacy = files.filter(
    (file) => file.includes('.sealed.') || file.endsWith('.legacy')
  ).length;

  for (const file of files.filter((candidate) => candidate.endsWith('.jsonl'))) {
    if (file.includes(`${path.sep}.dead${path.sep}`) || file.includes('.sealed.')) continue;
    report.jsonlFiles += 1;
    if (existsSync(`${file}.lock`)) report.locked += 1;
    const buffer = readFileSync(file);
    const statePath = file.replace(/\.jsonl$/, '.capture-state.json');
    let cursor = 0;
    let checkpoints: Record<string, { checkpoint: number }> = {};
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
          spool?: { cursor?: unknown };
          transcripts?: Record<string, { checkpoint: number }>;
        };
        if (Number.isInteger(state.spool?.cursor) && Number(state.spool?.cursor) >= 0) {
          cursor = Number(state.spool?.cursor);
        }
        checkpoints = state.transcripts ?? {};
      } catch {
        report.malformedSuspect += 1;
      }
    }
    if (cursor >= buffer.length) {
      report.complete += 1;
      continue;
    }

    const source = buffer.subarray(cursor).toString('utf8');
    const completeSource = source.endsWith('\n') ? source : source.slice(0, source.lastIndexOf('\n') + 1);
    const records: Array<Record<string, unknown>> = [];
    let malformed = false;
    for (const line of completeSource.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>);
        } else {
          malformed = true;
        }
      } catch {
        malformed = true;
      }
    }
    if (malformed) report.malformedSuspect += 1;
    const boundaryRecords = records.filter((record) => numericBoundary(record) !== null);
    if (boundaryRecords.length === 0) {
      report.noBoundary += 1;
      continue;
    }
    const withPath = boundaryRecords.filter(
      (record) => typeof record.transcript_path === 'string' && record.transcript_path.length > 0
    );
    if (withPath.length === 0) {
      report.pathlessTerminal += 1;
      continue;
    }

    let sessionPendingBytes = 0;
    let hasMissingTranscript = false;
    const grouped = new Map<string, number[]>();
    for (const record of withPath) {
      const transcriptPath = String(record.transcript_path);
      const boundary = numericBoundary(record)!;
      grouped.set(transcriptPath, [...(grouped.get(transcriptPath) ?? []), boundary]);
    }
    for (const [transcriptPath, boundaries] of grouped) {
      const sorted = boundaries.sort((left, right) => left - right);
      const requiredBoundary = sorted.at(-1)!;
      const sources = [
        transcriptPath,
        options.transcriptSnapshotDir
          ? path.join(options.transcriptSnapshotDir, `${sha256(transcriptPath)}.jsonl`)
          : null,
      ].filter((candidate): candidate is string => candidate !== null);
      const readable = sources.some((candidate) => {
        try {
          return statSync(candidate).size >= requiredBoundary;
        } catch {
          return false;
        }
      });
      if (!readable) {
        hasMissingTranscript = true;
        continue;
      }
      const checkpoint = checkpoints[sha256(transcriptPath)]?.checkpoint ?? sorted[0];
      sessionPendingBytes += Math.max(0, requiredBoundary - checkpoint);
    }
    if (hasMissingTranscript) report.transcriptFileMissing += 1;
    if (sessionPendingBytes > 0) {
      report.pendingLlm += 1;
      report.pendingBytes += sessionPendingBytes;
      report.estimatedLlmCalls += Math.ceil(sessionPendingBytes / options.maxWindowBytes);
    } else if (!hasMissingTranscript) {
      report.baselineOnly += 1;
    }
  }
  return report;
}

function allowedTarWarning(stderr: string): boolean {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(
    (line) => line.includes('file changed as we read it') ||
      line.includes('Exiting with failure status due to previous errors')
  );
}

export function validateSpoolBackup(input: BackupValidationInput): BackupValidationResult {
  const archiveJsonlCount = input.archiveJsonlCount ?? (input.listOutput ?? '')
    .split(/\r?\n/)
    .filter((line) => line.endsWith('.jsonl')).length;
  if (input.createStatus !== 0 && !(input.createStatus === 1 && allowedTarWarning(input.createStderr))) {
    return { ok: false, archiveJsonlCount, reason: `tar create exited ${input.createStatus}` };
  }
  if (input.listStatus !== 0) {
    return { ok: false, archiveJsonlCount, reason: `tar list exited ${input.listStatus}` };
  }
  if (input.archiveBytes <= 0) {
    return { ok: false, archiveJsonlCount, reason: 'archive is empty' };
  }
  if (archiveJsonlCount < input.beforeJsonlCount) {
    return {
      ok: false,
      archiveJsonlCount,
      reason: `archive has ${archiveJsonlCount} jsonl files; expected at least ${input.beforeJsonlCount}`,
    };
  }
  return { ok: true, archiveJsonlCount };
}

function countJsonlListing(filePath: string): number {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new TextDecoder();
  let carry = '';
  let count = 0;
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      const text = carry + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      count += lines.filter((line) => line.replace(/\r$/, '').endsWith('.jsonl')).length;
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
    carry += decoder.decode();
    if (carry.replace(/\r$/, '').endsWith('.jsonl')) count += 1;
    return count;
  } finally {
    closeSync(fd);
  }
}

export function listArchiveJsonlEntries(archivePath: string): {
  status: number | null;
  archiveJsonlCount: number;
  stderr: string;
} {
  const scratch = mkdtempSync(path.join(tmpdir(), 'cc-memory-tar-list-'));
  const listingPath = path.join(scratch, 'entries.txt');
  const listingFd = openSync(listingPath, 'w', 0o600);
  try {
    const listed = spawnSync('tar', ['-tzf', archivePath], {
      encoding: 'utf8',
      stdio: ['ignore', listingFd, 'pipe'],
    });
    closeSync(listingFd);
    return {
      status: listed.status,
      archiveJsonlCount: countJsonlListing(listingPath),
      stderr: listed.stderr ?? '',
    };
  } finally {
    try {
      closeSync(listingFd);
    } catch {
      // Already closed after the tar process completed.
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function parseDrainArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): DrainCliOptions {
  return {
    execute: args.includes('--execute'),
    json: args.includes('--json'),
    maxMinutes: positiveNumber(optionValue(args, '--max-minutes'), 120, '--max-minutes'),
    maxTicks: nonNegativeInteger(optionValue(args, '--max-ticks'), 0, '--max-ticks'),
    sleepMs: nonNegativeInteger(optionValue(args, '--sleep-ms'), 1000, '--sleep-ms'),
    budgetMs: nonNegativeInteger(
      env.CC_CAPTURE_TICK_BUDGET_MS?.trim() || undefined,
      DEFAULT_BUDGET_MS,
      'CC_CAPTURE_TICK_BUDGET_MS'
    ),
    spoolDir: optionValue(args, '--spool-dir') ?? env.CC_MEMORY_SPOOL_DIR ?? DEFAULT_SPOOL_DIR,
    backupDir: optionValue(args, '--backup-dir') ?? DEFAULT_BACKUP_DIR,
    projectUrlFile: optionValue(args, '--project-url-file') ?? DEFAULT_PROJECT_URL_FILE,
    geminiKeyFile: optionValue(args, '--gemini-key-file') ?? DEFAULT_GEMINI_KEY_FILE,
    lockFile: optionValue(args, '--lock-file') ?? DEFAULT_LOCK_FILE,
    transcriptSnapshotDir: optionValue(args, '--transcript-snapshot-dir'),
  };
}

export function assertDrainRuntimeConfig(expectedDatabaseUrl: string, actualDatabaseUrl: string): void {
  if (actualDatabaseUrl !== expectedDatabaseUrl) {
    throw new Error(
      'drain runtime loaded database config before DATABASE_URL injection or resolved a different scope'
    );
  }
}

function countJsonl(root: string): number {
  return walkFiles(root).filter((file) => file.endsWith('.jsonl')).length;
}

function totalBytes(root: string): number {
  return walkFiles(root).reduce((total, file) => total + statSync(file).size, 0);
}

function existingAncestor(target: string): string | null {
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export function createVerifiedBackup(spoolDir: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const spoolBytes = totalBytes(spoolDir);
  const fs = statfsSync(backupDir);
  const freeBytes = Number(fs.bavail) * Number(fs.bsize);
  if (freeBytes < spoolBytes * 1.2) {
    throw new Error(`insufficient backup space: free=${freeBytes} required=${Math.ceil(spoolBytes * 1.2)}`);
  }
  const timestamp = new Date().toISOString().replace(/[:]/g, '-');
  const target = path.join(backupDir, `spool-${timestamp}.tar.gz`);
  const beforeJsonlCount = countJsonl(spoolDir);
  const parent = path.dirname(spoolDir);
  const base = path.basename(spoolDir);
  closeSync(openSync(target, 'wx', 0o600));
  const created = spawnSync('tar', ['-C', parent, '-czf', target, base], { encoding: 'utf8' });
  if (existsSync(target)) chmodSync(target, 0o600);
  const listed = listArchiveJsonlEntries(target);
  const validation = validateSpoolBackup({
    createStatus: created.status,
    createStderr: created.stderr ?? '',
    listStatus: listed.status,
    archiveJsonlCount: listed.archiveJsonlCount,
    beforeJsonlCount,
    archiveBytes: existsSync(target) ? statSync(target).size : 0,
  });
  if (!validation.ok) {
    if (existsSync(target)) unlinkSync(target);
    throw new Error(validation.reason ?? 'backup validation failed');
  }
  process.stdout.write(
    `[cc-memory] backlog backup: path=${target} jsonl=${validation.archiveJsonlCount} bytes=${statSync(target).size}\n`
  );
  return target;
}

function reexecUnderFlock(options: DrainCliOptions): number | null {
  if (process.env.CC_MEMORY_DRAIN_FLOCKED === '1') return null;
  mkdirSync(path.dirname(options.lockFile), { recursive: true, mode: 0o700 });
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawnSync(
    '/usr/bin/flock',
    ['-n', '-E', '73', options.lockFile, process.execPath, tsxCli, process.argv[1], ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, CC_MEMORY_DRAIN_FLOCKED: '1' },
    }
  );
  const mappedStatus = mapFlockChildStatus(child.status);
  if (mappedStatus === 3) {
    process.stderr.write(`[cc-memory] backlog drain lock busy: ${options.lockFile}\n`);
    return 3;
  }
  return mappedStatus;
}

export function mapFlockChildStatus(status: number | null): number {
  return status === 73 ? 3 : status ?? 1;
}

async function loadGeminiKey(file: string): Promise<string | undefined> {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  try {
    const key = (await readFile(file, 'utf8')).trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

export async function executeDrain(
  options: DrainCliOptions,
  deps: DrainExecuteDeps = {},
): Promise<number> {
  let databaseUrl: string;
  try {
    databaseUrl = (await readFile(options.projectUrlFile, 'utf8')).trim();
    if (!databaseUrl) throw new Error('project URL file is empty');
    await (deps.checkProductionApproval ?? checkProductionApproval)({
      databaseUrl,
      now: deps.now?.() ?? new Date(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cc-memory] backlog drain preflight failed: ${message}\n`);
    return 1;
  }
  process.env.DATABASE_URL = databaseUrl;
  process.env.CC_MEMORY_SPOOL_DIR = options.spoolDir;
  if (options.transcriptSnapshotDir) {
    process.env.CC_MEMORY_TRANSCRIPT_SNAPSHOT_DIR = options.transcriptSnapshotDir;
  } else {
    delete process.env.CC_MEMORY_TRANSCRIPT_SNAPSHOT_DIR;
  }
  process.env.CC_CAPTURE_LLM = process.env.CC_CAPTURE_LLM ?? 'claude-cli';
  process.env.CC_CAPTURE_CLAUDE_MODEL = process.env.CC_CAPTURE_CLAUDE_MODEL ?? 'haiku';
  process.env.CC_CAPTURE_CLAUDE_TIMEOUT_MS = process.env.CC_CAPTURE_CLAUDE_TIMEOUT_MS ?? '75000';
  process.env.CC_CAPTURE_TICK_BUDGET_MS = process.env.CC_CAPTURE_TICK_BUDGET_MS ?? String(options.budgetMs);
  delete process.env.CC_CAPTURE_MAX_SESSIONS_PER_TICK;
  const geminiKey = await loadGeminiKey(options.geminiKeyFile);
  if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;
  const provider = process.env.CC_CAPTURE_LLM;
  if (provider === 'gemini-flash' && !process.env.GEMINI_API_KEY?.trim()) {
    process.stderr.write('[cc-memory] backlog drain preflight failed: gemini-flash requires GEMINI_API_KEY\n');
    return 1;
  }
  const llm = createCaptureLlmAdapter({ env: process.env, emitDisabledWarning: false });
  if (isCaptureLlmDisabled(llm)) {
    process.stderr.write(`[cc-memory] backlog drain preflight failed: ${llm.disabledReason}\n`);
    return 1;
  }
  if (!geminiKey) {
    process.stderr.write('[cc-memory] backlog drain warning: embeddings-disabled; rows will use NULL embedding\n');
  }
  try {
    createVerifiedBackup(options.spoolDir, options.backupDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cc-memory] backlog drain backup failed: ${message}\n`);
    return 4;
  }

  // Keep both imports dynamic: src/config.ts resolves and caches the database URL at module load.
  const [{ runAutoCaptureTick }, { config }] = await Promise.all([
    import('./run-auto-capture.js'),
    import('../src/config.js'),
  ]);
  assertDrainRuntimeConfig(databaseUrl, config.databaseUrl);
  let interrupted = false;
  const onSignal = (): void => { interrupted = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await runCaptureBacklogDrainLoop(options, {
      runTick: runAutoCaptureTick,
      isInterrupted: () => interrupted,
    });
    let exitCode = result.exitCode;
    if (exitCode === 0) {
      const remaining = await inspectCaptureBacklog(options.spoolDir, {
        maxWindowBytes: DEFAULT_MAX_WINDOW_BYTES,
        transcriptSnapshotDir: options.transcriptSnapshotDir,
      });
      const remainingWork =
        remaining.pathlessTerminal + remaining.pendingLlm + remaining.transcriptFileMissing +
        remaining.baselineOnly + remaining.locked;
      if (remainingWork > 0) {
        exitCode = 5;
        process.stderr.write(
          `[cc-memory] backlog drain incomplete after idle verification: remaining=${remainingWork}\n`
        );
      }
    }
    process.stdout.write(
      `[cc-memory] backlog drain summary: exit=${exitCode} ticks=${result.ticks} ` +
      `processed=${result.totals.processed} failed=${result.totals.failed} ` +
      `rate-limited=${result.totals.rateLimited} parked=${result.totals.parked} ` +
      `transcript-missing=${result.totals.transcriptMissing} held=${result.totals.held} ` +
      `embedding-failed=${result.totals.embeddingFailed}\n`
    );
    if (!geminiKey) {
      process.stdout.write(
        '[cc-memory] embeddings backfill: npm run backfill:embeddings -- --table all --execute --key-file ~/.gemini-api-key --batch-size 10 --rpm 60\n'
      );
    }
    return exitCode;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function main(): Promise<number> {
  const options = parseDrainArgs(process.argv.slice(2));
  if (!options.execute) {
    const report = await inspectCaptureBacklog(options.spoolDir, {
      maxWindowBytes: DEFAULT_MAX_WINDOW_BYTES,
      transcriptSnapshotDir: options.transcriptSnapshotDir,
    });
    const output = {
      dryRun: true,
      spoolDir: options.spoolDir,
      projectUrlFileExists: existsSync(options.projectUrlFile),
      embeddingsEnabled: Boolean(await loadGeminiKey(options.geminiKeyFile)),
      backupDir: options.backupDir,
      transcriptSnapshotDir: options.transcriptSnapshotDir,
      backupFreeBytes: (() => {
        try {
          const ancestor = existingAncestor(options.backupDir);
          if (!ancestor) return 0;
          const fs = statfsSync(ancestor);
          return Number(fs.bavail) * Number(fs.bsize);
        } catch {
          return 0;
        }
      })(),
      estimatedNewNullEmbeddingRowsUpperBound: report.estimatedLlmCalls * 9,
      ...report,
    };
    const finalOutput = {
      ...output,
      backupSpaceSufficient: output.backupFreeBytes >= report.spoolBytes * 1.2,
    };
    process.stdout.write(
      options.json ? `${JSON.stringify(finalOutput)}\n` : `${JSON.stringify(finalOutput, null, 2)}\n`
    );
    return 0;
  }
  const reexecStatus = reexecUnderFlock(options);
  if (reexecStatus !== null) return reexecStatus;
  return executeDrain(options);
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'drain-capture-backlog';

if (isMain) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[cc-memory] backlog drain failed: ${message}\n`);
      process.exitCode = 1;
    });
}
