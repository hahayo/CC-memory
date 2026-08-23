// src/services/capture-worker.ts
//
// CC-memory v0.5 M2b capture worker.

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname as osHostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import {
  CLAUDE_CLI_PROVIDER_ID,
  CaptureLlmValidationError,
  estimateDiscoveryTokens,
  formatCaptureLlmDisabledWarning,
  isCaptureLlmDisabled,
  parseCaptureLlmExtraction,
  toFailureCategory,
  toWorkerAction,
  type CaptureLlmAdapter,
  type CaptureLlmExtraction,
  type CaptureLlmObservation,
  type CaptureLlmRawResponse,
  type FailureCategory,
} from './capture-llm.js';
import type { DbClient } from './types.js';
import {
  composeEmbeddingText,
  composeObservationEmbeddingText,
  generateEmbedding as defaultGenerateEmbedding,
  mergeEmbeddingPolicyMetadata,
  prepareEmbeddingText,
  type EmbeddingPolicyEvidence,
} from '../utils/embedding.js';
import { resolveWriterHost } from '../utils/writer-host.js';
import { sweepOrphanedSandboxStaging } from './codex-sandbox.js';

const DEFAULT_SPOOL_DIR = join(homedir(), '.cache', 'cc-memory', 'spool');
const DEFAULT_SPOOL_MAX_MB = 500;
const DEFAULT_CAPTURE_MAX_WINDOW_BYTES = 256 * 1024;
const DEFAULT_CLAUDE_CAPTURE_MAX_WINDOW_BYTES = 32 * 1024;
const PROMPT_TOO_LONG_RETRY_MIN_BYTES = 1024;
const LLM_CALL_SETTLE_RESERVE_MS = 15_000;
const SANDBOX_STAGING_SWEEP_AGE_MS = 60 * 60 * 1000;
// 注入污染防線 marker：SessionStart 注入內容帶 `source=cc-memory-inject`，
// 其字串子集為此常數；transcript 內含此字串的行整行排除，不送 LLM 抽取。
const INJECTION_MARKER = 'cc-memory-inject';
const RAW_LLM_OUTPUT_LIMIT = 2048;
const ROTATE_SIZE_BYTES = 10 * 1024 * 1024;
const ROTATE_IDLE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SPOOL_LOCK_STALE_MS = 10 * 60 * 1000;
const TRANSCRIPT_SOURCE_UNAVAILABLE_CODE = 'TRANSCRIPT_SOURCE_UNAVAILABLE';
const TRANSCRIPT_SOURCE_UNAVAILABLE_HASH = sha256(TRANSCRIPT_SOURCE_UNAVAILABLE_CODE);
const MALFORMED_JSON_RETRY_PROMPT_PREFIX =
  'Previous output was not valid JSON. Output JSON only; the first character must be `{` and the last character must be `}`. Do not include markdown, code fences, or commentary.';

class CaptureSourceUnavailableError extends Error {
  readonly code = TRANSCRIPT_SOURCE_UNAVAILABLE_CODE;

  constructor() {
    super('transcript source unavailable or shorter than captured boundary');
    this.name = 'CaptureSourceUnavailableError';
  }
}

export interface CaptureWorkerResult {
  processed: number;
  skipped: number;
  failed: number;
  deadLettered: number;
  rateLimited: number;
  malformed: number;
  blocked: number;
  parked: number;
  yielded: number;
  held: number;
  embeddingFailed: number;
  transcriptMissing: number;
  llmRetries: number;
  observationsWritten: number;
  rollupsWritten: number;
  // Telemetry fields (D1b)
  primaryProvider: string;
  primarySuccess: number;
  fallbackSuccess: number;
  fallbackFailed: number;
  fatalError: string | null;
  // Capacity fields (Phase 6)
  spoolBytes: number;
  spoolCapPct: number;
  windows: number;
}

export interface CaptureWorkerOptions {
  db: DbClient;
  env?: Record<string, string | undefined>;
  llm: CaptureLlmAdapter;
  dbHealthCheck?: (db: DbClient) => Promise<boolean>;
  now?: () => Date;
  nowMs?: () => number;
  writerHost?: string;
  generateEmbedding?: (text: string) => Promise<number[] | null>;
  stdout?: { write(chunk: string): unknown };
  stateWriter?: CaptureStateWriter;
}

interface SpoolSession {
  projectDir: string;
  projectIdFromPath: string;
  sessionIdFromPath: string;
  path: string;
}

interface SpoolRecord {
  session_id?: unknown;
  project_id?: unknown;
  tool_name?: unknown;
  timestamp?: unknown;
  transcript_path?: unknown;
  transcript_offset?: unknown;
  hwm_offset?: unknown;
}

interface CaptureWindow {
  spool: SpoolSession;
  records: SpoolRecord[];
  projectId: string;
  sessionId: string;
  transcriptPath: string | null;
  transcript: string;
  spoolOffsetStart: number;
  spoolOffsetEnd: number;
  hwmOffsetStart: number;
  hwmOffsetEnd: number;
  processingTime: Date;
  observedAtOffset?: number;
}

interface CaptureMetadata {
  version: '0.5';
  session_id: string;
  observation_ids: string[];
  model: string;
  spool_offsets: Array<{ start: number; end: number }>;
  transcript_sources: TranscriptSourceRange[];
  summarize_count: number;
  discovery_tokens: number;
  empty_observation_windows: Array<{
    start: number;
    end: number;
    reason: 'no_high_value_observations';
  }>;
}

interface RollupRow {
  id: string;
  metadata: unknown;
}

interface WriteWindowResult {
  observationsWritten: number;
  rollupsWritten: number;
  embeddingFailed: number;
  replayed?: boolean;
}

const DEFAULT_TICK_BUDGET_MS = 240_000;
const DEFAULT_RETRY_MIN_INTERVAL_MS = 1_800_000;
const RETRY_MAX_ATTEMPTS = 5;

export interface RetryEntry {
  attempts: number;
  lastErrorClass: string;
  firstSeenIso: string;
  lastAttemptIso: string;
}

export type RetryState = Record<string, RetryEntry>;

export interface TranscriptCheckpoint {
  checkpoint: number;
}

export interface CaptureRetryEntry extends RetryEntry {
  pathHash: string;
  start: number;
  end: number;
  contentHash: string;
  blockedAttempts?: number;
  lastBlockedAtIso?: string;
  blockedReason?: string;
  pendingRetryProvider?: string;
}

export interface CaptureSplitHint {
  pathHash: string;
  start: number;
  end: number;
  contentHash: string;
}

export interface CaptureStateV2 {
  version: 2;
  spool: {
    generation: string;
    cursor: number;
  };
  transcripts: Record<string, TranscriptCheckpoint>;
  retries: Record<string, CaptureRetryEntry>;
  splitHints: Record<string, CaptureSplitHint>;
}

export type CaptureStateWriter = (path: string, state: CaptureStateV2) => Promise<void>;

function clearCoveredEntries(
  state: CaptureStateV2,
  pathHash: string,
  checkpoint: number
): boolean {
  let changed = false;
  for (const [key, retry] of Object.entries(state.retries)) {
    if (retry.pathHash === pathHash && retry.end <= checkpoint) {
      delete state.retries[key];
      changed = true;
    }
  }
  for (const [key, hint] of Object.entries(state.splitHints)) {
    if (hint.pathHash === pathHash && hint.end <= checkpoint) {
      delete state.splitHints[key];
      changed = true;
    }
  }
  return changed;
}

function clearAllCoveredEntries(state: CaptureStateV2): boolean {
  let changed = false;
  for (const [pathHash, transcript] of Object.entries(state.transcripts)) {
    changed = clearCoveredEntries(state, pathHash, transcript.checkpoint) || changed;
  }
  return changed;
}

interface TranscriptSourceRange {
  path_hash: string;
  start: number;
  end: number;
}

interface TranscriptChunk {
  path: string;
  pathHash: string;
  start: number;
  end: number;
  raw: Buffer;
}

interface ParsedSpoolResult {
  records: SpoolRecord[];
  malformedCount: number;
  lineOffsets: Array<{ start: number; end: number }>;
}

function emptyResult(): CaptureWorkerResult {
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

function spoolRoot(env: Record<string, string | undefined>): string {
  const configured = env.CC_MEMORY_SPOOL_DIR?.trim();
  return resolve(configured && configured.length > 0 ? configured : DEFAULT_SPOOL_DIR);
}

function hwmPathFor(spoolPath: string): string {
  return spoolPath.replace(/\.jsonl$/, '.hwm');
}

function statePathFor(spoolPath: string): string {
  return spoolPath.replace(/\.jsonl$/, '.capture-state.json');
}

function lockPathFor(spoolPath: string): string {
  return `${spoolPath}.lock`;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function vectorLiteral(embedding: number[] | null): string | null {
  if (!embedding || embedding.length === 0) return null;
  return `[${embedding.join(',')}]`;
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function contentHash(parts: unknown[]): string {
  return sha256(JSON.stringify(parts));
}

async function executeRows<T>(db: DbClient, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function readHwm(path: string): Promise<number> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseCaptureState(raw: string, path: string): CaptureStateV2 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`CAPTURE_STATE_CORRUPT: invalid JSON at ${basename(path)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`CAPTURE_STATE_CORRUPT: invalid root at ${basename(path)}`);
  }
  const record = value as Partial<CaptureStateV2>;
  if (
    record.version !== 2 ||
    !record.spool ||
    typeof record.spool !== 'object' ||
    typeof record.spool.generation !== 'string' ||
    record.spool.generation.length === 0 ||
    !isNonNegativeInteger(record.spool.cursor) ||
    !record.transcripts ||
    typeof record.transcripts !== 'object' ||
    Array.isArray(record.transcripts) ||
    !record.retries ||
    typeof record.retries !== 'object' ||
    Array.isArray(record.retries)
  ) {
    throw new Error(`CAPTURE_STATE_CORRUPT: invalid shape at ${basename(path)}`);
  }

  const transcripts: Record<string, TranscriptCheckpoint> = {};
  for (const [pathHash, checkpoint] of Object.entries(record.transcripts)) {
    if (
      !/^[a-f0-9]{64}$/.test(pathHash) ||
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      !isNonNegativeInteger((checkpoint as TranscriptCheckpoint).checkpoint)
    ) {
      throw new Error(`CAPTURE_STATE_CORRUPT: invalid checkpoint at ${basename(path)}`);
    }
    transcripts[pathHash] = { checkpoint: (checkpoint as TranscriptCheckpoint).checkpoint };
  }

  const retries: Record<string, CaptureRetryEntry> = {};
  for (const [key, retry] of Object.entries(record.retries)) {
    if (
      !retry ||
      typeof retry !== 'object' ||
      !isNonNegativeInteger((retry as CaptureRetryEntry).attempts) ||
      typeof (retry as CaptureRetryEntry).lastErrorClass !== 'string' ||
      typeof (retry as CaptureRetryEntry).firstSeenIso !== 'string' ||
      typeof (retry as CaptureRetryEntry).lastAttemptIso !== 'string' ||
      !/^[a-f0-9]{64}$/.test((retry as CaptureRetryEntry).pathHash) ||
      !isNonNegativeInteger((retry as CaptureRetryEntry).start) ||
      !isNonNegativeInteger((retry as CaptureRetryEntry).end) ||
      (retry as CaptureRetryEntry).end < (retry as CaptureRetryEntry).start ||
      !/^[a-f0-9]{64}$/.test((retry as CaptureRetryEntry).contentHash)
    ) {
      throw new Error(`CAPTURE_STATE_CORRUPT: invalid retry entry at ${basename(path)}`);
    }
    const parsed: CaptureRetryEntry = { ...(retry as CaptureRetryEntry) };
    // Backward-compatible defaults for blocked fields (added in Phase 1)
    if (parsed.blockedAttempts === undefined) parsed.blockedAttempts = 0;
    if (parsed.lastBlockedAtIso === undefined) parsed.lastBlockedAtIso = '';
    if (parsed.blockedReason === undefined) parsed.blockedReason = '';
    retries[key] = parsed;
  }

  const splitHints: Record<string, CaptureSplitHint> = {};
  if (record.splitHints !== undefined) {
    if (typeof record.splitHints !== 'object' || Array.isArray(record.splitHints)) {
      throw new Error(`CAPTURE_STATE_CORRUPT: invalid split hints at ${basename(path)}`);
    }
    for (const [key, hint] of Object.entries(record.splitHints)) {
      if (
        !hint ||
        typeof hint !== 'object' ||
        !/^[a-f0-9]{64}$/.test((hint as CaptureSplitHint).pathHash) ||
        !isNonNegativeInteger((hint as CaptureSplitHint).start) ||
        !isNonNegativeInteger((hint as CaptureSplitHint).end) ||
        (hint as CaptureSplitHint).end < (hint as CaptureSplitHint).start ||
        !/^[a-f0-9]{64}$/.test((hint as CaptureSplitHint).contentHash)
      ) {
        throw new Error(`CAPTURE_STATE_CORRUPT: invalid split hint at ${basename(path)}`);
      }
      splitHints[key] = { ...(hint as CaptureSplitHint) };
    }
  }

  return {
    version: 2,
    spool: {
      generation: record.spool.generation,
      cursor: record.spool.cursor,
    },
    transcripts,
    retries,
    splitHints,
  };
}

export async function writeCaptureStateAtomically(
  path: string,
  state: CaptureStateV2
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

async function archiveLegacyFile(path: string, suffix: string): Promise<void> {
  let target = `${path}.${suffix}.legacy`;
  if (await stat(target).then(() => true).catch(() => false)) {
    target = `${target}.${randomUUID()}`;
  }
  try {
    await rename(path, target);
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function archiveLegacySidecars(root: string, nowMs: number): Promise<void> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory() || project.name === '.dead') continue;
    const projectDir = join(root, project.name);
    const files = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    const names = new Set(files.filter((file) => file.isFile()).map((file) => file.name));
    for (const file of files) {
      if (!file.isFile()) continue;
      if (file.name.endsWith('.retry.json')) {
        await archiveLegacyFile(join(projectDir, file.name), `v1-${nowMs}`);
      } else if (
        file.name.endsWith('.hwm') &&
        !names.has(file.name.replace(/\.hwm$/, '.jsonl'))
      ) {
        await archiveLegacyFile(join(projectDir, file.name), `orphan-v1-${nowMs}`);
      }
    }
  }
}

function transcriptBoundary(record: SpoolRecord): number | null {
  if (isNonNegativeInteger(record.transcript_offset)) return record.transcript_offset;
  if (isNonNegativeInteger(record.hwm_offset)) return record.hwm_offset;
  return null;
}

async function loadOrMigrateCaptureState(input: {
  spool: SpoolSession;
  buffer: Buffer;
  snapshotSize: number;
  nowMs: number;
  writer: CaptureStateWriter;
}): Promise<CaptureStateV2> {
  const statePath = statePathFor(input.spool.path);
  try {
    const state = parseCaptureState(await readFile(statePath, 'utf8'), statePath);
    const suffix = `v1-${input.nowMs}`;
    await archiveLegacyFile(hwmPathFor(input.spool.path), suffix);
    await archiveLegacyFile(retryPathFor(input.spool.path), suffix);
    return state;
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'ENOENT') {
      throw error;
    }
  }

  const legacyHwm = Math.min(await readHwm(hwmPathFor(input.spool.path)), input.snapshotSize);
  const transcripts: Record<string, TranscriptCheckpoint> = {};
  const consumed = readSpoolBuffer(input.buffer, 0, legacyHwm);
  if (consumed) {
    for (const record of consumed.records) {
      if (typeof record.transcript_path !== 'string' || record.transcript_path.length === 0) continue;
      const boundary = transcriptBoundary(record);
      if (boundary === null) continue;
      transcripts[sha256(record.transcript_path)] = { checkpoint: boundary };
    }
  }

  const state: CaptureStateV2 = {
    version: 2,
    spool: {
      generation: randomUUID(),
      cursor: consumed?.safeEnd ?? 0,
    },
    transcripts,
    retries: {},
    splitHints: {},
  };
  await input.writer(statePath, state);
  const suffix = `v1-${input.nowMs}`;
  await archiveLegacyFile(hwmPathFor(input.spool.path), suffix);
  await archiveLegacyFile(retryPathFor(input.spool.path), suffix);
  return state;
}

function spoolLockStaleMs(env: Record<string, string | undefined>): number {
  return parsePositiveIntegerEnv(env.CC_MEMORY_SPOOL_LOCK_STALE_MS, DEFAULT_SPOOL_LOCK_STALE_MS);
}

interface LockPayload {
  pid: number;
  host: string;
  token: string;
  acquiredAtIso: string;
}

async function acquireSpoolLock(
  spoolPath: string,
  input: { env: Record<string, string | undefined>; nowMs?: number }
): Promise<(() => Promise<void>) | null> {
  const lockP = lockPathFor(spoolPath);
  const token = createHash('sha256').update(`${process.pid}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16);
  const payload: LockPayload = {
    pid: process.pid,
    host: osHostname(),
    token,
    acquiredAtIso: new Date(input.nowMs ?? Date.now()).toISOString(),
  };
  const payloadStr = JSON.stringify(payload);

  const tryCreate = async (): Promise<(() => Promise<void>) | null> => {
    try {
      const handle = await open(lockP, 'wx', 0o600);
      await handle.writeFile(payloadStr, 'utf8');
      await handle.close();
      await chmod(lockP, 0o600);
      return async () => {
        try {
          const content = await readFile(lockP, 'utf8');
          const existing = JSON.parse(content) as LockPayload;
          if (existing.token === token) {
            await unlink(lockP).catch(() => undefined);
          }
        } catch {
          // lock file gone or unreadable — nothing to release
        }
      };
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST') {
        return null;
      }
      throw error;
    }
  };

  const acquired = await tryCreate();
  if (acquired) return acquired;

  // Stale lock recovery: only reclaim if mtime exceeds threshold.
  // Live-process mutual exclusion is guaranteed by the external process-level flock
  // (hermes wrapper / systemd ExecStart both use ~/.cache/cc-memory/auto-capture-run.lock).
  // This stale recovery only cleans up crash remnants.
  const info = await stat(lockP).catch(() => null);
  if (!info) return tryCreate();
  const ageMs = (input.nowMs ?? Date.now()) - info.mtimeMs;
  if (ageMs <= spoolLockStaleMs(input.env)) {
    return null;
  }

  await unlink(lockP).catch(() => undefined);
  return tryCreate();
}

async function totalSpoolBytes(root: string): Promise<number> {
  async function walk(path: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        total += await walk(full);
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
      }
    }
    return total;
  }
  return walk(root);
}

function spoolMaxBytes(env: Record<string, string | undefined>): number {
  const parsed = Number.parseFloat(env.CC_MEMORY_SPOOL_MAX_MB ?? '');
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPOOL_MAX_MB;
  return mb * 1024 * 1024;
}

function captureMaxWindowBytes(
  env: Record<string, string | undefined>,
  llm?: Pick<CaptureLlmAdapter, 'provider'>
): number {
  const parsed = Number.parseInt(env.CC_CAPTURE_MAX_WINDOW_BYTES ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 4) return parsed;
  if (llm?.provider === CLAUDE_CLI_PROVIDER_ID) {
    return DEFAULT_CLAUDE_CAPTURE_MAX_WINDOW_BYTES;
  }
  return DEFAULT_CAPTURE_MAX_WINDOW_BYTES;
}

function captureMaxSessionsPerTick(env: Record<string, string | undefined>): number {
  return parsePositiveIntegerEnv(env.CC_CAPTURE_MAX_SESSIONS_PER_TICK, Number.MAX_SAFE_INTEGER);
}

function captureRetryMinIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env.CC_CAPTURE_RETRY_MIN_INTERVAL_MS?.trim();
  if (raw === '0') return 0;
  return parsePositiveIntegerEnv(raw, DEFAULT_RETRY_MIN_INTERVAL_MS);
}

function captureMaxWindowsPerTick(env: Record<string, string | undefined>): number {
  return parsePositiveIntegerEnv(env.CC_CAPTURE_MAX_WINDOWS_PER_TICK, Number.MAX_SAFE_INTEGER);
}

export function isCaptureRetryHeld(
  entry: Pick<RetryEntry, 'attempts' | 'lastAttemptIso'> &
    Partial<Pick<CaptureRetryEntry, 'blockedAttempts' | 'lastBlockedAtIso'>> | undefined,
  nowMs: number,
  minIntervalMs: number
): boolean {
  if (!entry || minIntervalMs <= 0) return false;
  // Check terminal retry hold
  if (entry.attempts >= 1) {
    const lastAttemptMs = Date.parse(entry.lastAttemptIso);
    if (Number.isFinite(lastAttemptMs) && lastAttemptMs <= nowMs && nowMs - lastAttemptMs < minIntervalMs) {
      return true;
    }
  }
  // Check blocked hold
  const blockedAttempts = (entry as Partial<CaptureRetryEntry>).blockedAttempts ?? 0;
  const lastBlockedAtIso = (entry as Partial<CaptureRetryEntry>).lastBlockedAtIso;
  if (blockedAttempts >= 1 && typeof lastBlockedAtIso === 'string') {
    const lastBlockedMs = Date.parse(lastBlockedAtIso);
    if (Number.isFinite(lastBlockedMs) && lastBlockedMs <= nowMs && nowMs - lastBlockedMs < minIntervalMs) {
      return true;
    }
  }
  return false;
}

function llmCallBudgetReserveMs(
  llm: Pick<CaptureLlmAdapter, 'worstCaseCallBudgetMs' | 'worstCaseCallBudgetMsFor'>,
  forceProvider?: string,
): number {
  const budgetMs = forceProvider && llm.worstCaseCallBudgetMsFor
    ? llm.worstCaseCallBudgetMsFor(forceProvider)
    : llm.worstCaseCallBudgetMs;
  if (budgetMs <= 0) return 0;
  return budgetMs + LLM_CALL_SETTLE_RESERVE_MS;
}

async function listSpoolSessions(root: string): Promise<SpoolSession[]> {
  let projectDirs;
  try {
    projectDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SpoolSession[] = [];
  for (const projectEntry of projectDirs) {
    if (!projectEntry.isDirectory() || projectEntry.name === '.dead') continue;
    const projectDir = join(root, projectEntry.name);
    const files = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      sessions.push({
        projectDir,
        projectIdFromPath: projectEntry.name,
        sessionIdFromPath: basename(file.name, '.jsonl'),
        path: join(projectDir, file.name),
      });
    }
  }
  return sessions.sort((a, b) => a.path.localeCompare(b.path));
}

function parseSpoolRecords(buffer: Buffer): ParsedSpoolResult {
  const text = buffer.toString('utf8');
  const records: SpoolRecord[] = [];
  const lineOffsets: Array<{ start: number; end: number }> = [];
  let malformedCount = 0;
  let bytePos = 0;

  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const lineEnd = bytePos + lineBytes + 1;
    if (line.trim().length === 0) {
      bytePos = lineEnd;
      continue;
    }
    try {
      const parsed = JSON.parse(line) as SpoolRecord;
      records.push(parsed);
      lineOffsets.push({ start: bytePos, end: lineEnd });
    } catch {
      malformedCount += 1;
    }
    bytePos = lineEnd;
  }
  return { records, malformedCount, lineOffsets };
}

function firstString(records: SpoolRecord[], key: keyof SpoolRecord): string | null {
  for (const record of records) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// 注入污染防線：transcript 是 JSONL，逐行過濾——整行含 INJECTION_MARKER 即丟棄，
// 避免 SessionStart 注入的 Recent Activity 索引被 LLM 再抽成 observation
// （見 docs/auto-capture-v0.5/plan.md §Injection Pollution Defense）。
// 只影響送 LLM 的文字；HWM/spool offset 語義不變（offset 仍以原始 window 邊界計算，
// 全行被濾成空窗口時走既有空窗口 skip 路徑）。無 marker 時原字串原樣回傳（不擾動位元組邊界）。
function stripInjectionMarkerLines(transcript: string): string {
  if (transcript.length === 0 || !transcript.includes(INJECTION_MARKER)) {
    return transcript;
  }
  return transcript
    .split('\n')
    .filter((line) => !line.includes(INJECTION_MARKER))
    .join('\n');
}

async function readTranscriptBuffer(
  path: string,
  boundary: number,
  snapshotDir?: string,
): Promise<Buffer | null> {
  let original: Buffer | null = null;
  try {
    original = await readFile(path);
  } catch {
    // An explicitly configured archive snapshot may still contain the captured prefix.
  }
  if (original && original.length >= boundary) return original;
  const root = snapshotDir?.trim();
  if (!root) return original;
  try {
    const snapshot = await readFile(join(resolve(root), `${sha256(path)}.jsonl`));
    return snapshot.length >= boundary ? snapshot : original;
  } catch {
    return original;
  }
}

function utf8SafeEnd(buffer: Buffer, start: number, proposedEnd: number, hardEnd: number): number {
  let end = Math.max(start, Math.min(proposedEnd, hardEnd));
  if (end >= hardEnd) return hardEnd;
  while (end > start && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end > start) return end;
  end = Math.min(proposedEnd, hardEnd);
  while (end < hardEnd && (buffer[end] & 0xc0) === 0x80) {
    end += 1;
  }
  return Math.max(start + 1, Math.min(end, hardEnd));
}

function splitTranscriptRange(
  path: string,
  pathHash: string,
  buffer: Buffer,
  start: number,
  end: number,
  maxBytes: number
): TranscriptChunk[] {
  const safeStart = Math.max(0, Math.min(start, buffer.length));
  const safeEnd = Math.max(safeStart, Math.min(end, buffer.length));
  const chunks: TranscriptChunk[] = [];
  let cursor = safeStart;
  while (cursor < safeEnd) {
    const proposedEnd = Math.min(cursor + maxBytes, safeEnd);
    let chunkEnd = proposedEnd;
    if (proposedEnd < safeEnd) {
      const newline = buffer.lastIndexOf(0x0a, proposedEnd - 1);
      if (newline >= cursor) {
        chunkEnd = newline + 1;
      } else {
        chunkEnd = utf8SafeEnd(buffer, cursor, proposedEnd, safeEnd);
      }
    }
    if (chunkEnd <= cursor) {
      chunkEnd = utf8SafeEnd(buffer, cursor, proposedEnd + 1, safeEnd);
    }
    chunks.push({
      path,
      pathHash,
      start: cursor,
      end: chunkEnd,
      raw: buffer.subarray(cursor, chunkEnd),
    });
    cursor = chunkEnd;
  }
  return chunks;
}

function splitTranscriptChunk(chunk: TranscriptChunk): TranscriptChunk[] | null {
  if (chunk.raw.length <= PROMPT_TOO_LONG_RETRY_MIN_BYTES) return null;
  const maxBytes = Math.max(PROMPT_TOO_LONG_RETRY_MIN_BYTES, Math.floor(chunk.raw.length / 2));
  const chunks = splitTranscriptRange(
    chunk.path,
    chunk.pathHash,
    chunk.raw,
    0,
    chunk.raw.length,
    maxBytes
  ).map((part) => ({
    ...part,
    start: chunk.start + part.start,
    end: chunk.start + part.end,
  }));
  return chunks.length > 1 ? chunks : null;
}

function prioritizePersistedSplitBoundary(
  chunk: TranscriptChunk,
  splitHints: Record<string, CaptureSplitHint>,
  sourceBuffer: Buffer
): TranscriptChunk[] | null {
  const candidates = Object.values(splitHints)
    .filter(
      (hint) =>
        hint.pathHash === chunk.pathHash &&
        hint.start >= 0 &&
        hint.start <= chunk.start &&
        hint.end > chunk.start &&
        hint.end < chunk.end
    )
    .sort((left, right) => left.end - right.end);

  for (const hint of candidates) {
    const relativeEnd = hint.end - chunk.start;
    const hintedRaw = chunk.raw.subarray(0, relativeEnd);
    if (
      hint.end > sourceBuffer.length ||
      sha256(sourceBuffer.subarray(hint.start, hint.end)) !== hint.contentHash
    ) {
      continue;
    }
    return [
      {
        ...chunk,
        end: hint.end,
        raw: hintedRaw,
      },
      {
        ...chunk,
        start: hint.end,
        raw: chunk.raw.subarray(relativeEnd),
      },
    ];
  }
  return null;
}

interface ReadSpoolResult {
  records: SpoolRecord[];
  malformedCount: number;
  lineOffsets: Array<{ start: number; end: number }>;
  safeEnd: number;
}

function readSpoolBuffer(buffer: Buffer, start: number, end: number): ReadSpoolResult | null {
  const safeStart = Math.max(0, Math.min(start, buffer.length));
  let safeEnd = Math.max(safeStart, Math.min(end, buffer.length));
  if (safeStart >= safeEnd) return null;

  const lastNewline = buffer.lastIndexOf(0x0a, safeEnd - 1);
  if (lastNewline < safeStart) {
    return null;
  }
  safeEnd = lastNewline + 1;
  if (safeStart >= safeEnd) return null;

  const slice = buffer.subarray(safeStart, safeEnd);
  const { records, malformedCount, lineOffsets } = parseSpoolRecords(slice);
  return { records, malformedCount, lineOffsets, safeEnd };
}


function captureTextForTokenEstimate(extraction: CaptureLlmExtraction): string {
  return [
    extraction.session_summary.summary,
    extraction.session_summary.keywords.join(' '),
    extraction.session_summary.decisions.join(' '),
    extraction.session_summary.next_steps.join(' '),
    ...extraction.observations.flatMap((observation) => [
      observation.title,
      observation.subtitle ?? '',
      observation.facts.join(' '),
      observation.concepts.join(' '),
      observation.files.join(' '),
      observation.narrative,
    ]),
  ].join('\n');
}

function existingCaptureMetadata(metadata: unknown): CaptureMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const capture = (metadata as { capture?: unknown }).capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return null;
  const record = capture as Partial<CaptureMetadata>;
  return {
    version: '0.5',
    session_id: typeof record.session_id === 'string' ? record.session_id : '',
    observation_ids: Array.isArray(record.observation_ids)
      ? record.observation_ids.filter((id): id is string => typeof id === 'string')
      : [],
    model: typeof record.model === 'string' ? record.model : '',
    spool_offsets: Array.isArray(record.spool_offsets)
      ? record.spool_offsets.filter(
          (offset): offset is { start: number; end: number } =>
            Boolean(offset) &&
            typeof offset === 'object' &&
            typeof (offset as { start?: unknown }).start === 'number' &&
            typeof (offset as { end?: unknown }).end === 'number'
        )
      : [],
    transcript_sources: Array.isArray(record.transcript_sources)
      ? record.transcript_sources.filter(
          (source): source is TranscriptSourceRange =>
            Boolean(source) &&
            typeof source === 'object' &&
            typeof (source as { path_hash?: unknown }).path_hash === 'string' &&
            typeof (source as { start?: unknown }).start === 'number' &&
            typeof (source as { end?: unknown }).end === 'number'
        )
      : [],
    summarize_count:
      typeof record.summarize_count === 'number' && Number.isFinite(record.summarize_count)
        ? record.summarize_count
        : 0,
    discovery_tokens:
      typeof record.discovery_tokens === 'number' && Number.isFinite(record.discovery_tokens)
        ? record.discovery_tokens
        : 0,
    empty_observation_windows: Array.isArray(record.empty_observation_windows)
      ? record.empty_observation_windows.filter(
          (entry): entry is CaptureMetadata['empty_observation_windows'][number] =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            typeof (entry as { start?: unknown }).start === 'number' &&
            typeof (entry as { end?: unknown }).end === 'number' &&
            (entry as { reason?: unknown }).reason === 'no_high_value_observations'
        )
      : [],
  };
}

function normalizeTranscriptSources(sources: TranscriptSourceRange[]): TranscriptSourceRange[] {
  const sorted = [...sources]
    .filter((source) => source.end > source.start)
    .sort((a, b) =>
      a.path_hash.localeCompare(b.path_hash) || a.start - b.start || a.end - b.end
    );
  const merged: TranscriptSourceRange[] = [];
  for (const source of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.path_hash === source.path_hash &&
      source.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, source.end);
    } else {
      merged.push({ ...source });
    }
  }
  return merged;
}

function transcriptSourceCovered(
  sources: TranscriptSourceRange[],
  candidate: TranscriptSourceRange
): boolean {
  return normalizeTranscriptSources(sources).some(
    (source) =>
      source.path_hash === candidate.path_hash &&
      source.start <= candidate.start &&
      source.end >= candidate.end
  );
}

function mergeMetadata(metadata: unknown, capture: CaptureMetadata): Record<string, unknown> {
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  base.capture = capture;
  return base;
}

async function safeEmbedding(
  generateEmbedding: (text: string) => Promise<number[] | null>,
  text: string,
  embeddingExpected: boolean,
): Promise<{
  value: number[] | null;
  failed: boolean;
  policy?: EmbeddingPolicyEvidence;
}> {
  const prepared = prepareEmbeddingText(text);
  try {
    const value = await generateEmbedding(prepared.text);
    return {
      value,
      failed: embeddingExpected && value === null,
      policy: value === null ? undefined : prepared.evidence,
    };
  } catch {
    return { value: null, failed: embeddingExpected };
  }
}

async function selectRollup(tx: DbClient, projectId: string, idempotencyKey: string): Promise<RollupRow | null> {
  const rows = await executeRows<RollupRow>(
    tx,
    sql`
      SELECT id, metadata
      FROM project_memories
      WHERE project_id = ${projectId}
        AND idempotency_key = ${idempotencyKey}
        AND status = 'active'
      LIMIT 1
    `
  );
  return rows[0] ?? null;
}

async function insertRollup(
  tx: DbClient,
  input: {
    window: CaptureWindow;
    extraction: CaptureLlmExtraction;
    model: string;
    idempotencyKey: string;
    contentHash: string;
    writerHost: string;
    embedding: number[] | null;
    metadata: Record<string, unknown>;
  }
): Promise<string> {
  const summary = input.extraction.session_summary;
  const rows = await executeRows<{ id: string }>(
    tx,
    sql`
      INSERT INTO project_memories (
        project_id,
        type,
        summary,
        keywords,
        decisions,
        next_steps,
        embedding,
        status,
        idempotency_key,
        content_hash,
        writer_host,
        metadata
      )
      VALUES (
        ${input.window.projectId},
        'session',
        ${summary.summary},
        ${pgTextArrayLiteral(summary.keywords)}::text[],
        ${pgTextArrayLiteral(summary.decisions)}::text[],
        ${pgTextArrayLiteral(summary.next_steps)}::text[],
        ${vectorLiteral(input.embedding)}::vector,
        'active',
        ${input.idempotencyKey},
        ${input.contentHash},
        ${input.writerHost},
        ${JSON.stringify(input.metadata)}::jsonb
      )
      RETURNING id
    `
  );
  return rows[0].id;
}

async function updateRollup(
  tx: DbClient,
  input: {
    rollupId: string;
    window: CaptureWindow;
    extraction: CaptureLlmExtraction;
    contentHash: string;
    writerHost: string;
    embedding: number[] | null;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const summary = input.extraction.session_summary;
  await tx.execute(sql`
    UPDATE project_memories
    SET
      summary = ${summary.summary},
      keywords = ${pgTextArrayLiteral(summary.keywords)}::text[],
      decisions = ${pgTextArrayLiteral(summary.decisions)}::text[],
      next_steps = ${pgTextArrayLiteral(summary.next_steps)}::text[],
      embedding = ${vectorLiteral(input.embedding)}::vector,
      content_hash = ${input.contentHash},
      writer_host = ${input.writerHost},
      metadata = ${JSON.stringify(input.metadata)}::jsonb,
      updated_at = NOW()
    WHERE id = ${input.rollupId}
  `);
}

// drizzle raw sql template 對 JS array 參數會綁成 record（PG 報 cannot cast type
// record to text[]）——以 PG array literal 文字綁定再 ::text[] cast。
function pgTextArrayLiteral(values: string[]): string {
  const quoted = values.map(
    (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  );
  return `{${quoted.join(',')}}`;
}

function observationHash(window: CaptureWindow, observation: CaptureLlmObservation): string {
  return contentHash([
    window.projectId,
    window.sessionId,
    observation.type,
    observation.title,
    observation.subtitle ?? null,
    observation.facts,
    observation.concepts,
    observation.files,
    observation.narrative,
  ]);
}

async function insertObservation(
  tx: DbClient,
  input: {
    window: CaptureWindow;
    observation: CaptureLlmObservation;
    rollupId: string;
    model: string;
    writerHost: string;
    observedAt: Date;
    embedding: number[] | null;
    embeddingPolicy?: EmbeddingPolicyEvidence;
    source: TranscriptSourceRange;
  }
): Promise<string | null> {
  const hash = observationHash(input.window, input.observation);
  // spec 欄位契約：discovery_tokens 由 worker 寫入時計算（estimator ≥13，滿足 CHECK > 0），
  // 不採信 LLM 輸出
  const discoveryTokens = estimateDiscoveryTokens(
    [
      input.observation.title,
      input.observation.subtitle ?? '',
      ...input.observation.facts,
      ...input.observation.concepts,
      ...input.observation.files,
      input.observation.narrative,
    ].join('\n')
  );
  const captureMetadata = {
    capture: {
      version: '0.5',
      model: input.model,
      spool_offset: {
        start: input.window.spoolOffsetStart,
        end: input.window.spoolOffsetEnd,
      },
      hwm_offset: {
        start: input.window.hwmOffsetStart,
        end: input.window.hwmOffsetEnd,
      },
      transcript_source: input.source,
    },
  };
  const metadata = input.embeddingPolicy
    ? mergeEmbeddingPolicyMetadata(captureMetadata, input.embeddingPolicy)
    : captureMetadata;
  const rows = await executeRows<{ id: string }>(
    tx,
    sql`
      INSERT INTO observations (
        project_id,
        session_id,
        rollup_memory_id,
        type,
        title,
        subtitle,
        facts,
        concepts,
        files,
        narrative,
        embedding,
        discovery_tokens,
        source_hook,
        content_hash,
        writer_host,
        metadata,
        observed_at
      )
      VALUES (
        ${input.window.projectId},
        ${input.window.sessionId},
        ${input.rollupId},
        ${input.observation.type},
        ${input.observation.title},
        ${input.observation.subtitle ?? null},
        ${pgTextArrayLiteral(input.observation.facts)}::text[],
        ${pgTextArrayLiteral(input.observation.concepts)}::text[],
        ${pgTextArrayLiteral(input.observation.files)}::text[],
        ${input.observation.narrative},
        ${vectorLiteral(input.embedding)}::vector,
        ${discoveryTokens},
        'post-tool-use',
        ${hash},
        ${input.writerHost},
        ${JSON.stringify(metadata)}::jsonb,
        ${input.observedAt.toISOString()}::timestamptz
      )
      ON CONFLICT (project_id, session_id, content_hash) WHERE status = 'active'
      DO NOTHING
      RETURNING id
    `
  );
  return rows[0]?.id ?? null;
}

async function writeCaptureWindow(
  tx: DbClient,
  window: CaptureWindow,
  extraction: CaptureLlmExtraction,
  rawResponse: CaptureLlmRawResponse,
  source: TranscriptSourceRange,
  options: Required<Pick<CaptureWorkerOptions, 'writerHost' | 'generateEmbedding'>> & {
    embeddingExpected: boolean;
  }
): Promise<WriteWindowResult> {
  const summary = extraction.session_summary;
  const idempotencyKey = `capture:v05:${window.projectId}:${window.sessionId}`;
  const existing = await selectRollup(tx, window.projectId, idempotencyKey);
  const previousCapture = existingCaptureMetadata(existing?.metadata);
  if (transcriptSourceCovered(previousCapture?.transcript_sources ?? [], source)) {
    return { observationsWritten: 0, rollupsWritten: 0, embeddingFailed: 0, replayed: true };
  }
  const rollupContentHash = contentHash([
    window.projectId,
    'session',
    summary.summary,
    summary.keywords,
    summary.decisions,
    summary.next_steps,
  ]);
  const discoveryTokens = estimateDiscoveryTokens(captureTextForTokenEstimate(extraction));
  const rollupEmbedding = await safeEmbedding(
    options.generateEmbedding,
    composeEmbeddingText(summary.summary, summary.keywords, summary.decisions),
    options.embeddingExpected,
  );
  let embeddingFailed = rollupEmbedding.failed ? 1 : 0;

  // at-least-once 重放守衛：transaction commit 後 HWM 寫入若失敗，同 window 會重跑；
  // 已見過的 spool offset 區間不重複 append、summarize_count 不重複遞增。
  const previousOffsets = previousCapture?.spool_offsets ?? [];
  const isReplayedWindow = previousOffsets.some(
    (offset) => offset.start === window.spoolOffsetStart && offset.end === window.spoolOffsetEnd
  );
  const baseCapture: CaptureMetadata = {
    version: '0.5',
    session_id: window.sessionId,
    observation_ids: previousCapture?.observation_ids ?? [],
    model: rawResponse.model,
    spool_offsets: isReplayedWindow
      ? previousOffsets
      : [...previousOffsets, { start: window.spoolOffsetStart, end: window.spoolOffsetEnd }],
    transcript_sources: normalizeTranscriptSources([
      ...(previousCapture?.transcript_sources ?? []),
      source,
    ]),
    summarize_count: (previousCapture?.summarize_count ?? 0) + 1,
    discovery_tokens: discoveryTokens,
    empty_observation_windows:
      extraction.observations.length === 0 && !isReplayedWindow
        ? [
            ...(previousCapture?.empty_observation_windows ?? []),
            {
              start: window.spoolOffsetStart,
              end: window.spoolOffsetEnd,
              reason: 'no_high_value_observations',
            },
          ]
        : previousCapture?.empty_observation_windows ?? [],
  };

  let rollupId = existing?.id ?? null;
  if (!rollupId) {
    const captureMetadata = mergeMetadata(existing?.metadata, baseCapture);
    const initialMetadata = rollupEmbedding.policy
      ? mergeEmbeddingPolicyMetadata(captureMetadata, rollupEmbedding.policy)
      : captureMetadata;
    rollupId = await insertRollup(tx, {
      window,
      extraction,
      model: rawResponse.model,
      idempotencyKey,
      contentHash: rollupContentHash,
      writerHost: options.writerHost,
      embedding: rollupEmbedding.value,
      metadata: initialMetadata,
    });
  }

  const insertedObservationIds: string[] = [];
  const observedAtOffset = window.observedAtOffset ?? 0;
  for (let index = 0; index < extraction.observations.length; index += 1) {
    const observation = extraction.observations[index];
    const observedAt = new Date(window.processingTime.getTime() + observedAtOffset + index);
    const observationEmbedding = await safeEmbedding(
      options.generateEmbedding,
      composeObservationEmbeddingText(observation),
      options.embeddingExpected,
    );
    if (observationEmbedding.failed) embeddingFailed += 1;
    const insertedId = await insertObservation(tx, {
      window,
      observation,
      rollupId,
      model: rawResponse.model,
      writerHost: options.writerHost,
      observedAt,
      embedding: observationEmbedding.value,
      embeddingPolicy: observationEmbedding.policy,
      source,
    });
    if (insertedId) insertedObservationIds.push(insertedId);
  }

  const finalCapture: CaptureMetadata = {
    ...baseCapture,
    observation_ids: [...baseCapture.observation_ids, ...insertedObservationIds],
  };
  const captureMetadata = mergeMetadata(existing?.metadata, finalCapture);
  const finalMetadata = rollupEmbedding.policy
    ? mergeEmbeddingPolicyMetadata(captureMetadata, rollupEmbedding.policy)
    : captureMetadata;
  await updateRollup(tx, {
    rollupId,
    window,
    extraction,
    contentHash: rollupContentHash,
    writerHost: options.writerHost,
    embedding: rollupEmbedding.value,
    metadata: finalMetadata,
  });

  return {
    observationsWritten: insertedObservationIds.length,
    rollupsWritten: 1,
    embeddingFailed,
  };
}

function llmErrorCode(error: unknown): string {
  if (error instanceof CaptureSourceUnavailableError) return error.code;
  if (error instanceof CaptureLlmValidationError) return error.code;
  return 'LLM_EXTRACT_FAILED';
}

function llmErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function llmRawOutputFromError(error: unknown): string | undefined {
  if (
    error instanceof CaptureLlmValidationError &&
    typeof error.details.rawOutput === 'string'
  ) {
    return error.details.rawOutput;
  }
  if (error && typeof error === 'object' && typeof (error as { text?: unknown }).text === 'string') {
    return (error as { text: string }).text;
  }
  return undefined;
}

function truncateLlmRawOutput(rawOutput: string | null | undefined): string | null {
  if (typeof rawOutput !== 'string' || rawOutput.length === 0) return null;
  return rawOutput.slice(0, RAW_LLM_OUTPUT_LIMIT);
}

async function writeDeadLetter(
  root: string,
  window: CaptureWindow,
  input: {
    model: string;
    error: unknown;
    legacyRawText?: string;
    llmRawOutput?: string | null;
    pathHash?: string;
    sourceContentHash?: string;
  }
): Promise<boolean> {
  const llmRawOutput = truncateLlmRawOutput(input.llmRawOutput);
  const hash = contentHash([
    window.projectId,
    window.sessionId,
    window.spoolOffsetStart,
    window.spoolOffsetEnd,
    input.pathHash ?? null,
    input.sourceContentHash ?? null,
    llmErrorCode(input.error),
    input.model,
    llmRawOutput ?? input.legacyRawText ?? llmErrorMessage(input.error),
  ]);
  const deadRoot = join(root, '.dead');
  await mkdir(deadRoot, { recursive: true, mode: 0o700 });
  await chmod(deadRoot, 0o700);
  const payload = {
    metadata: {
      project_id: window.projectId,
      session_id: window.sessionId,
      offset: {
        start: window.spoolOffsetStart,
        end: window.spoolOffsetEnd,
      },
      hwm_offset: {
        start: window.hwmOffsetStart,
        end: window.hwmOffsetEnd,
      },
      source: input.pathHash
        ? {
            path_hash: input.pathHash,
            start: window.hwmOffsetStart,
            end: window.hwmOffsetEnd,
            content_hash: input.sourceContentHash ?? null,
          }
        : undefined,
      error_code: llmErrorCode(input.error),
      model: input.model,
      content_hash: hash,
    },
    error: {
      message: llmErrorMessage(input.error),
    },
    llm_output: input.legacyRawText,
    llm_raw_output: llmRawOutput,
  };
  const path = join(deadRoot, `${hash}.json`);
  try {
    await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function maybeRotateCaptureSpool(
  spool: SpoolSession,
  state: CaptureStateV2,
  hasStopSentinel: boolean,
  nowMs: number
): Promise<boolean> {
  const info = await stat(spool.path).catch(() => null);
  if (!info || state.spool.cursor < info.size) return false;
  const shouldRotateBySize = hasStopSentinel && info.size > ROTATE_SIZE_BYTES;
  const shouldRotateByAge = hasStopSentinel && nowMs - info.mtimeMs > ROTATE_IDLE_MS;
  if (!shouldRotateBySize && !shouldRotateByAge) return false;

  const suffix = `${nowMs}.${state.spool.generation}.sealed`;
  const statePath = statePathFor(spool.path);
  const sealedState = `${statePath}.${suffix}`;
  const sealedSpool = `${spool.path}.${suffix}`;
  await rename(statePath, sealedState);
  try {
    await archiveLegacyFile(hwmPathFor(spool.path), `rotation-${nowMs}`);
    await archiveLegacyFile(retryPathFor(spool.path), `rotation-${nowMs}`);
    await rename(spool.path, sealedSpool);
  } catch (error) {
    await rename(sealedState, statePath).catch(() => undefined);
    throw error;
  }
  return true;
}

function retryPathFor(spoolPath: string): string {
  return spoolPath.replace(/\.jsonl$/, '.retry.json');
}

function tickBudgetMs(env: Record<string, string | undefined>): number {
  const raw = env.CC_CAPTURE_TICK_BUDGET_MS?.trim();
  if (raw === '0') return 0;
  if (!raw) return DEFAULT_TICK_BUDGET_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TICK_BUDGET_MS;
}

function cursorPathFor(root: string): string {
  return join(root, '.tick-cursor.json');
}

async function loadTickCursor(root: string): Promise<string | null> {
  try {
    const raw = await readFile(cursorPathFor(root), 'utf8');
    const data = JSON.parse(raw) as { lastSessionPath?: string };
    return typeof data.lastSessionPath === 'string' ? data.lastSessionPath : null;
  } catch {
    return null;
  }
}

async function saveTickCursor(root: string, sessionPath: string): Promise<void> {
  const cPath = cursorPathFor(root);
  const tmp = `${cPath}.tmp`;
  await writeFile(tmp, JSON.stringify({ lastSessionPath: sessionPath }), { mode: 0o600 });
  await rename(tmp, cPath).catch(() => undefined);
}

function rotateSessionsAfterCursor(sessions: SpoolSession[], cursorPath: string | null): SpoolSession[] {
  if (!cursorPath || sessions.length <= 1) return sessions;
  const idx = sessions.findIndex((s) => s.path === cursorPath);
  if (idx < 0 || idx >= sessions.length - 1) return sessions;
  return [...sessions.slice(idx + 1), ...sessions.slice(0, idx + 1)];
}

async function spoolEndsWithStopSentinel(spoolPath: string): Promise<boolean> {
  try {
    const buffer = await readFile(spoolPath);
    const parsed = readSpoolBuffer(buffer, 0, buffer.length);
    const lastRecord = parsed?.records.at(-1);
    return isNonNegativeInteger(lastRecord?.hwm_offset);
  } catch {
    return false;
  }
}

function handleBlockedAction(
  state: CaptureStateV2,
  retryKey: string,
  chunk: TranscriptChunk,
  sourceContentHash: string,
  category: FailureCategory,
  options: CaptureWorkerOptions,
): void {
  const attemptTime = (options.now?.() ?? new Date()).toISOString();
  const entry = state.retries[retryKey] ?? {
    attempts: 0,
    lastErrorClass: '',
    firstSeenIso: attemptTime,
    lastAttemptIso: '',
    pathHash: chunk.pathHash,
    start: chunk.start,
    end: chunk.end,
    contentHash: sourceContentHash,
    blockedAttempts: 0,
    lastBlockedAtIso: '',
    blockedReason: '',
  };
  entry.blockedAttempts = (entry.blockedAttempts ?? 0) + 1;
  entry.lastBlockedAtIso = attemptTime;
  entry.blockedReason = category;
  entry.lastErrorClass = category;
  state.retries[retryKey] = entry;
}

export async function runCaptureWorkerOnce(
  options: CaptureWorkerOptions
): Promise<CaptureWorkerResult> {
  const env = options.env ?? process.env;
  const root = spoolRoot(env);
  const stdout = options.stdout ?? process.stdout;
  const result = emptyResult();
  const getNowMs = options.nowMs ?? (() => Date.now());
  const budget = tickBudgetMs(env);
  const tickStartMs = getNowMs();
  let windowsThisTick = 0;

  try {

  if (options.dbHealthCheck) {
    let healthy = false;
    try {
      healthy = await options.dbHealthCheck(options.db);
    } catch {
      healthy = false;
    }
    if (!healthy) return result;
  }

  const maxBytes = spoolMaxBytes(env);
  const maxWindowBytes = captureMaxWindowBytes(env, options.llm);
  const llmCallReserveMs = llmCallBudgetReserveMs(options.llm);
  // codex 沙箱的 auth.json 副本目錄若因 SIGKILL 未清，每 tick 掃一次（超過 1 小時即刪）；
  // 失敗不影響 tick。
  try {
    sweepOrphanedSandboxStaging(join(root, '..', 'codex-sandbox'), SANDBOX_STAGING_SWEEP_AGE_MS);
  } catch {
    // best-effort
  }
  const totalBytes = await totalSpoolBytes(root);
  result.spoolBytes = totalBytes;
  result.spoolCapPct = maxBytes > 0 ? Math.round((totalBytes / maxBytes) * 100) : 0;
  if (totalBytes > maxBytes) {
    stdout.write(
      `[cc-memory] auto-capture skipped: spool size ${totalBytes} exceeds cap ${maxBytes}\n`
    );
    result.skipped = 1;
    return result;
  }

  const rawSessions = await listSpoolSessions(root);
  if (rawSessions.length === 0) return result;
  await archiveLegacySidecars(root, getNowMs());
  const cursor = await loadTickCursor(root);
  const sessions = rotateSessionsAfterCursor(rawSessions, cursor);
  const writerHost = options.writerHost ?? resolveWriterHost();
  const generateEmbedding = options.generateEmbedding ?? defaultGenerateEmbedding;
  const maxSessionsPerTick = captureMaxSessionsPerTick(env);
  const retryMinIntervalMs = captureRetryMinIntervalMs(env);
  const embeddingExpected =
    env.CC_MEMORY_EMBEDDING_EXPECTED === '1' || Boolean(env.GEMINI_API_KEY?.trim());
  let handledSessions = 0;
  const stateWriter = options.stateWriter ?? writeCaptureStateAtomically;
  const maxWindowsPerTick = captureMaxWindowsPerTick(env);

  for (const spool of sessions) {
    if (budget > 0 && getNowMs() - tickStartMs >= budget) {
      if (result.yielded === 0) result.yielded = 1;
      break;
    }
    const nowMs = getNowMs();
    const release = await acquireSpoolLock(spool.path, { env, nowMs });
    if (!release) {
      result.skipped += 1;
      continue;
    }

    try {
      const spoolInfo = await stat(spool.path);
      const snapshotSize = spoolInfo.size;
      const buffer = await readFile(spool.path);
      const statePath = statePathFor(spool.path);
      const state = await loadOrMigrateCaptureState({
        spool,
        buffer,
        snapshotSize,
        nowMs,
        writer: stateWriter,
      });
      if (clearAllCoveredEntries(state)) {
        await stateWriter(statePath, state);
      }
      if (state.spool.cursor > snapshotSize) {
        throw new Error('CAPTURE_STATE_CORRUPT: spool cursor exceeds current generation size');
      }
      if (state.spool.cursor >= snapshotSize) {
        result.skipped += 1;
        const oldEnoughToRotate = getNowMs() - spoolInfo.mtimeMs >= ROTATE_IDLE_MS;
        const hasStopSentinel =
          snapshotSize >= ROTATE_SIZE_BYTES || oldEnoughToRotate
            ? await spoolEndsWithStopSentinel(spool.path)
            : false;
        await maybeRotateCaptureSpool(spool, state, hasStopSentinel, getNowMs());
        continue;
      }
      const snapshotCursor = state.spool.cursor;
      const snapshot = readSpoolBuffer(buffer, snapshotCursor, snapshotSize);
      if (!snapshot) {
        result.skipped += 1;
        continue;
      }
      if (snapshot.records.length === 0 && snapshot.malformedCount > 0) {
        result.malformed += snapshot.malformedCount;
        stdout.write(
          `[cc-memory] auto-capture warning: malformed-spool-lines=${snapshot.malformedCount} session=${spool.sessionIdFromPath}\n`
        );
        state.spool.cursor = snapshot.safeEnd;
        await stateWriter(statePath, state);
        continue;
      }

      const boundaryRecords = snapshot.records.filter(
        (record) => transcriptBoundary(record) !== null
      );
      const candidateCheckpoints = new Map(
        Object.entries(state.transcripts).map(([pathHash, checkpoint]) => [
          pathHash,
          checkpoint.checkpoint,
        ])
      );
      let hasMissingTranscriptPath = false;
      let hasProcessableRange = false;
      for (const record of boundaryRecords) {
        const path = typeof record.transcript_path === 'string' ? record.transcript_path : '';
        if (!path) {
          hasMissingTranscriptPath = true;
          continue;
        }
        const boundary = transcriptBoundary(record)!;
        const pathHash = sha256(path);
        const checkpoint = candidateCheckpoints.get(pathHash);
        if (checkpoint === undefined) {
          candidateCheckpoints.set(pathHash, boundary);
        } else if (boundary > checkpoint) {
          hasProcessableRange = true;
        }
      }
      if (hasMissingTranscriptPath && !hasProcessableRange) {
        for (const [pathHash, checkpoint] of candidateCheckpoints) {
          state.transcripts[pathHash] ??= { checkpoint };
        }
        if (snapshot.malformedCount > 0) {
          result.malformed += snapshot.malformedCount;
          stdout.write(
            `[cc-memory] auto-capture warning: malformed-spool-lines=${snapshot.malformedCount} session=${spool.sessionIdFromPath}\n`
          );
        }
        result.transcriptMissing += 1;
        result.skipped += 1;
        state.spool.cursor = snapshot.safeEnd;
        await stateWriter(statePath, state);
        await saveTickCursor(root, spool.path);
        await maybeRotateCaptureSpool(
          spool,
          state,
          isNonNegativeInteger(snapshot.records.at(-1)?.hwm_offset),
          getNowMs()
        );
        continue;
      }

      if (handledSessions >= maxSessionsPerTick) break;
      handledSessions += 1;
      await saveTickCursor(root, spool.path);

      const projectId = firstString(snapshot.records, 'project_id') ?? spool.projectIdFromPath;
      const sessionId = firstString(snapshot.records, 'session_id') ?? spool.sessionIdFromPath;
      const hasStopSentinel = isNonNegativeInteger(snapshot.records.at(-1)?.hwm_offset);
      const outcomeCountBefore =
        result.processed + result.skipped + result.failed + result.deadLettered +
        result.rateLimited + result.malformed + result.parked + result.yielded +
        result.transcriptMissing;

      if (projectId === '__personal__') {
        state.spool.cursor = snapshot.safeEnd;
        await stateWriter(statePath, state);
        result.skipped += 1;
        await maybeRotateCaptureSpool(spool, state, hasStopSentinel, getNowMs());
        continue;
      }

      if (isCaptureLlmDisabled(options.llm)) {
        result.skipped += 1;
        continue;
      }

      if (snapshot.malformedCount > 0) {
        result.malformed += snapshot.malformedCount;
        stdout.write(
          `[cc-memory] auto-capture warning: malformed-spool-lines=${snapshot.malformedCount} session=${sessionId}\n`
        );
      }

      let observedAtOffset = 0;
      let sessionStopped = false;
      let snapshotCompleted = true;
      const processingTime = options.now?.() ?? new Date();
      const spoolRangeStarts: Record<string, number> = {};
      let missingPathReported = false;

      for (let recordIndex = 0; recordIndex < snapshot.records.length; recordIndex += 1) {
        if (budget > 0 && getNowMs() - tickStartMs >= budget) {
          result.yielded += 1;
          sessionStopped = true;
          snapshotCompleted = false;
          break;
        }
        const record = snapshot.records[recordIndex];
        const path = typeof record.transcript_path === 'string' ? record.transcript_path : null;
        const boundary = transcriptBoundary(record);
        if (boundary === null) continue;
        if (!path) {
          if (!missingPathReported) {
            result.transcriptMissing += 1;
            result.skipped += 1;
            missingPathReported = true;
          }
          continue;
        }
        const pathHash = sha256(path);
        const lineOffset = snapshot.lineOffsets[recordIndex] ?? { start: 0, end: 0 };
        if (typeof record.transcript_offset === 'number') {
          spoolRangeStarts[pathHash] = snapshotCursor + lineOffset.start;
        }
        const checkpoint = state.transcripts[pathHash];
        if (!checkpoint) {
          state.transcripts[pathHash] = { checkpoint: boundary };
          if (spoolRangeStarts[pathHash] === undefined) {
            spoolRangeStarts[pathHash] = snapshotCursor + lineOffset.start;
          }
          await stateWriter(statePath, state);
          continue;
        }
        if (boundary <= checkpoint.checkpoint) continue;

        const transcriptBuffer = await readTranscriptBuffer(
          path,
          boundary,
          env.CC_MEMORY_TRANSCRIPT_SNAPSHOT_DIR,
        );
        const missingSourceRetryKey =
          `${pathHash}:${checkpoint.checkpoint}-${boundary}:${TRANSCRIPT_SOURCE_UNAVAILABLE_HASH}`;
        if (!transcriptBuffer || transcriptBuffer.length < boundary) {
          const attemptNow = options.now?.() ?? new Date();
          if (isCaptureRetryHeld(
            state.retries[missingSourceRetryKey],
            attemptNow.getTime(),
            retryMinIntervalMs
          )) {
            result.held += 1;
            const outcomesNow =
              result.processed + result.skipped + result.failed + result.deadLettered +
              result.rateLimited + result.malformed + result.parked + result.yielded +
              result.transcriptMissing;
            if (outcomesNow === outcomeCountBefore) handledSessions -= 1;
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }
          const attemptTime = attemptNow.toISOString();
          const entry = state.retries[missingSourceRetryKey] ?? {
            attempts: 0,
            lastErrorClass: TRANSCRIPT_SOURCE_UNAVAILABLE_CODE,
            firstSeenIso: attemptTime,
            lastAttemptIso: '',
            pathHash,
            start: checkpoint.checkpoint,
            end: boundary,
            contentHash: TRANSCRIPT_SOURCE_UNAVAILABLE_HASH,
          };
          entry.attempts += 1;
          entry.lastErrorClass = TRANSCRIPT_SOURCE_UNAVAILABLE_CODE;
          entry.lastAttemptIso = attemptTime;
          state.retries[missingSourceRetryKey] = entry;
          await stateWriter(statePath, state);
          result.transcriptMissing += 1;
          stdout.write(
            `[cc-memory] auto-capture warning: transcript-source-unavailable session=${sessionId} source=${pathHash.slice(0, 12)}:${checkpoint.checkpoint}-${boundary} attempts=${entry.attempts}/${RETRY_MAX_ATTEMPTS}\n`
          );
          if (entry.attempts >= RETRY_MAX_ATTEMPTS) {
            const sourceUnavailableError = new CaptureSourceUnavailableError();
            const missingWindow: CaptureWindow = {
              spool,
              records: [record],
              projectId,
              sessionId,
              transcriptPath: null,
              transcript: '',
              spoolOffsetStart: spoolRangeStarts[pathHash] ?? snapshotCursor,
              spoolOffsetEnd: snapshotCursor + lineOffset.end,
              hwmOffsetStart: checkpoint.checkpoint,
              hwmOffsetEnd: boundary,
              processingTime,
              observedAtOffset,
            };
            const created = await writeDeadLetter(root, missingWindow, {
              model: 'none',
              error: sourceUnavailableError,
              pathHash,
              sourceContentHash: TRANSCRIPT_SOURCE_UNAVAILABLE_HASH,
            });
            if (created) result.deadLettered += 1;
            result.parked += 1;
            checkpoint.checkpoint = boundary;
            clearCoveredEntries(state, pathHash, checkpoint.checkpoint);
            await stateWriter(statePath, state);
          }
          sessionStopped = true;
          snapshotCompleted = false;
          break;
        }
        if (state.retries[missingSourceRetryKey]) {
          delete state.retries[missingSourceRetryKey];
          await stateWriter(statePath, state);
        }

        let chunks = splitTranscriptRange(
          path,
          pathHash,
          transcriptBuffer,
          checkpoint.checkpoint,
          boundary,
          maxWindowBytes
        );
        while (chunks.length > 0) {
          if (budget > 0 && getNowMs() - tickStartMs >= budget) {
            result.yielded += 1;
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }
          const chunk = chunks.shift()!;
          const prioritizedChunks = prioritizePersistedSplitBoundary(
            chunk,
            state.splitHints,
            transcriptBuffer
          );
          if (prioritizedChunks) {
            chunks = [...prioritizedChunks, ...chunks];
            continue;
          }
          const transcript = stripInjectionMarkerLines(chunk.raw.toString('utf8'));
          const sourceContentHash = sha256(chunk.raw);
          const retryKey = `${chunk.pathHash}:${chunk.start}-${chunk.end}:${sourceContentHash}`;
          const existingSplitHint = state.splitHints[retryKey];
          if (existingSplitHint) {
            const smallerChunks = splitTranscriptChunk(chunk);
            if (smallerChunks) {
              chunks = [...smallerChunks, ...chunks];
              continue;
            }
            delete state.splitHints[retryKey];
            await stateWriter(statePath, state);
          }
          const chunkWindow: CaptureWindow = {
            spool,
            records: [record],
            projectId,
            sessionId,
            transcriptPath: chunk.path,
            transcript,
            spoolOffsetStart: spoolRangeStarts[pathHash] ?? snapshotCursor,
            spoolOffsetEnd: snapshotCursor + lineOffset.end,
            hwmOffsetStart: chunk.start,
            hwmOffsetEnd: chunk.end,
            processingTime,
            observedAtOffset,
          };

          if (transcript.trim().length === 0) {
            checkpoint.checkpoint = chunk.end;
            clearCoveredEntries(state, chunk.pathHash, checkpoint.checkpoint);
            await stateWriter(statePath, state);
            result.skipped += 1;
            continue;
          }

          const attemptNow = options.now?.() ?? new Date();
          if (isCaptureRetryHeld(
            state.retries[retryKey],
            attemptNow.getTime(),
            retryMinIntervalMs
          )) {
            result.held += 1;
            const outcomesNow =
              result.processed + result.skipped + result.failed + result.deadLettered +
              result.rateLimited + result.malformed + result.parked + result.yielded +
              result.transcriptMissing;
            if (outcomesNow === outcomeCountBefore) handledSessions -= 1;
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }

          // Window limit check (increment deferred until budget check passes)
          if (windowsThisTick >= maxWindowsPerTick) {
            result.yielded += 1;
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }

          let rawResponse: CaptureLlmRawResponse | null = null;
          let extraction: CaptureLlmExtraction | null = null;
          let terminalError: unknown = null;
          let terminalRawResponse: CaptureLlmRawResponse | null = null;
          let runtimeStopped = false;
          let promptSplit = false;
          let wasBlocked = false;
          // Load pendingRetryProvider from state for cross-tick continuation
          let retryProvider: string | undefined =
            state.retries[retryKey]?.pendingRetryProvider ?? undefined;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            // Use provider-specific budget when forcing a specific provider
            const effectiveReserveMs = retryProvider
              ? llmCallBudgetReserveMs(options.llm, retryProvider)
              : llmCallReserveMs;
            if (
              budget > 0 &&
              effectiveReserveMs > 0 &&
              getNowMs() - tickStartMs + effectiveReserveMs > budget
            ) {
              // If we have a pending retryProvider, persist it for the next tick
              if (retryProvider) {
                const entry = state.retries[retryKey] ?? {
                  attempts: 0,
                  lastErrorClass: '',
                  firstSeenIso: (options.now?.() ?? new Date()).toISOString(),
                  lastAttemptIso: '',
                  pathHash: chunk.pathHash,
                  start: chunk.start,
                  end: chunk.end,
                  contentHash: sourceContentHash,
                  blockedAttempts: 0,
                  lastBlockedAtIso: '',
                  blockedReason: '',
                };
                entry.pendingRetryProvider = retryProvider;
                state.retries[retryKey] = entry;
                await stateWriter(statePath, state);
              }
              result.yielded += 1;
              runtimeStopped = true;
              break;
            }
            // Count window only after budget check passes and before first extract
            if (attempt === 0) {
              windowsThisTick += 1;
            }
            const retryPromptPrefix =
              attempt === 0 && !retryProvider ? undefined : MALFORMED_JSON_RETRY_PROMPT_PREFIX;
            const extractOptions = retryProvider ? { forceProvider: retryProvider } : undefined;
            let attemptRawResponse: CaptureLlmRawResponse | null = null;
            try {
              attemptRawResponse = await options.llm.extract({
                projectId: chunkWindow.projectId,
                sessionId: chunkWindow.sessionId,
                transcript: chunkWindow.transcript,
                spoolOffsetStart: chunkWindow.spoolOffsetStart,
                spoolOffsetEnd: chunkWindow.spoolOffsetEnd,
                hwmOffsetStart: chunkWindow.hwmOffsetStart,
                hwmOffsetEnd: chunkWindow.hwmOffsetEnd,
                ...(retryPromptPrefix ? { retryPromptPrefix } : {}),
              }, extractOptions);
              const attemptExtraction = parseCaptureLlmExtraction(attemptRawResponse);
              rawResponse = attemptRawResponse;
              extraction = attemptExtraction;
              // Clear pendingRetryProvider on success
              if (state.retries[retryKey]?.pendingRetryProvider) {
                delete state.retries[retryKey].pendingRetryProvider;
                await stateWriter(statePath, state);
              }
              retryProvider = undefined;
              break;
            } catch (error) {
              // Clear pendingRetryProvider on both success and failure (prevents P→F→F→P cycle)
              if (state.retries[retryKey]?.pendingRetryProvider) {
                delete state.retries[retryKey].pendingRetryProvider;
                await stateWriter(statePath, state);
              }
              retryProvider = undefined;

              const category: FailureCategory = toFailureCategory(error);
              const timeoutSubtype =
                error instanceof CaptureLlmValidationError && typeof error.details.timeoutSubtype === 'string'
                  ? error.details.timeoutSubtype
                  : undefined;
              const action = toWorkerAction(category, { timeoutSubtype });
              // Capture retryProvider from error details for next attempt
              // but NOT if the retry is already exhausted (forced-provider call failed)
              const retryExhausted =
                error instanceof CaptureLlmValidationError && error.details.retryExhausted === true;
              const errorRetryProvider =
                !retryExhausted &&
                error instanceof CaptureLlmValidationError && typeof error.details.retryProvider === 'string'
                  ? error.details.retryProvider
                  : undefined;
              switch (action) {
                case 'retry-malformed': {
                  if (attempt === 0 && !retryExhausted) {
                    result.llmRetries += 1;
                    retryProvider = errorRetryProvider;
                    continue;
                  }
                  // attempt >= 1: fall through to terminal
                  terminalError = error;
                  terminalRawResponse = attemptRawResponse;
                  break;
                }
                case 'disabled': {
                  stdout.write(
                    formatCaptureLlmDisabledWarning(
                      error instanceof CaptureLlmValidationError && typeof error.details.provider === 'string'
                        ? error.details.provider
                        : 'unknown',
                      error instanceof Error ? error.message : String(error)
                    )
                  );
                  result.skipped += 1;
                  runtimeStopped = true;
                  break;
                }
                case 'rate-limited': {
                  result.rateLimited += 1;
                  runtimeStopped = true;
                  break;
                }
                case 'split': {
                  const smallerChunks = splitTranscriptChunk(chunk);
                  if (smallerChunks) {
                    chunks = [...smallerChunks, ...chunks];
                    state.splitHints[retryKey] = {
                      pathHash: chunk.pathHash,
                      start: chunk.start,
                      end: chunk.end,
                      contentHash: sourceContentHash,
                    };
                    await stateWriter(statePath, state);
                    promptSplit = true;
                    break;
                  }
                  // Cannot split further: check alternateCategory
                  const alternateCategory: FailureCategory | undefined =
                    error instanceof CaptureLlmValidationError &&
                    typeof error.details.alternateCategory === 'string'
                      ? (error.details.alternateCategory as FailureCategory)
                      : undefined;
                  if (alternateCategory) {
                    const altAction = toWorkerAction(alternateCategory);
                    if (altAction === 'rate-limited' || altAction === 'disabled' || altAction === 'blocked') {
                      // Non-destructive: skip this tick, data not abandoned
                      result.blocked += 1;
                      wasBlocked = true;
                      handleBlockedAction(state, retryKey, chunk, sourceContentHash, alternateCategory, options);
                      runtimeStopped = true;
                      break;
                    }
                    // Destructive alternate (terminal/exit-nonzero) → terminal retry
                    terminalError = error;
                    terminalRawResponse = attemptRawResponse;
                    break;
                  }
                  // No alternateCategory → blocked
                  result.blocked += 1;
                  wasBlocked = true;
                  handleBlockedAction(state, retryKey, chunk, sourceContentHash, category, options);
                  runtimeStopped = true;
                  break;
                }
                case 'blocked': {
                  result.blocked += 1;
                  wasBlocked = true;
                  handleBlockedAction(state, retryKey, chunk, sourceContentHash, category, options);
                  runtimeStopped = true;
                  break;
                }
                case 'terminal':
                default: {
                  terminalError = error;
                  terminalRawResponse = attemptRawResponse;
                  break;
                }
              }
              break;
            }
          }
          if (promptSplit) continue;
          if (runtimeStopped) {
            // For blocked action: persist state and check dead-letter threshold
            const blockedEntry = wasBlocked ? state.retries[retryKey] : undefined;
            if (blockedEntry && (blockedEntry.blockedAttempts ?? 0) > 0) {
              await stateWriter(statePath, state);
              const blockedCount = blockedEntry.blockedAttempts ?? 0;
              stdout.write(
                `[cc-memory] auto-capture warning: blocked session=${sessionId} ` +
                  `source=${chunk.pathHash.slice(0, 12)}:${chunk.start}-${chunk.end} ` +
                  `reason=${blockedEntry.blockedReason ?? 'unknown'} blocked=${blockedCount}/${RETRY_MAX_ATTEMPTS}\n`
              );
              if (blockedCount > RETRY_MAX_ATTEMPTS) {
                const created = await writeDeadLetter(root, chunkWindow, {
                  model: options.llm.model,
                  error: new Error(`blocked after ${blockedCount} attempts: ${blockedEntry.blockedReason ?? 'unknown'}`),
                  legacyRawText: undefined,
                  llmRawOutput: undefined,
                  pathHash: chunk.pathHash,
                  sourceContentHash,
                });
                if (created) result.deadLettered += 1;
                result.parked += 1;
                checkpoint.checkpoint = chunk.end;
                clearCoveredEntries(state, chunk.pathHash, checkpoint.checkpoint);
                await stateWriter(statePath, state);
                stdout.write(
                  `[cc-memory] auto-capture warning: parked-window session=${sessionId} source=${chunk.pathHash.slice(0, 12)}:${chunk.start}-${chunk.end} blocked=${blockedCount}\n`
                );
              }
            }
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }

          if (terminalError) {
            const attemptTime = (options.now?.() ?? new Date()).toISOString();
            const entry = state.retries[retryKey] ?? {
              attempts: 0,
              lastErrorClass: '',
              firstSeenIso: attemptTime,
              lastAttemptIso: '',
              pathHash: chunk.pathHash,
              start: chunk.start,
              end: chunk.end,
              contentHash: sourceContentHash,
              blockedAttempts: 0,
              lastBlockedAtIso: '',
              blockedReason: '',
            };
            entry.attempts += 1;
            entry.lastErrorClass = llmErrorCode(terminalError);
            entry.lastAttemptIso = attemptTime;
            state.retries[retryKey] = entry;
            await stateWriter(statePath, state);
            stdout.write(
              `[cc-memory] auto-capture warning: retry-pending session=${sessionId} ` +
                `source=${chunk.pathHash.slice(0, 12)}:${chunk.start}-${chunk.end} ` +
                `error=${entry.lastErrorClass} attempts=${entry.attempts}/${RETRY_MAX_ATTEMPTS}\n`
            );

            if (entry.attempts >= RETRY_MAX_ATTEMPTS) {
              const created = await writeDeadLetter(root, chunkWindow, {
                model: terminalError instanceof CaptureLlmValidationError && typeof terminalError.details.model === 'string'
                  ? terminalError.details.model
                  : terminalRawResponse?.model ?? options.llm.model,
                error: terminalError,
                legacyRawText: (terminalError as { text?: string }).text,
                llmRawOutput: terminalRawResponse?.text ?? llmRawOutputFromError(terminalError),
                pathHash: chunk.pathHash,
                sourceContentHash,
              });
              if (created) result.deadLettered += 1;
              result.parked += 1;
              checkpoint.checkpoint = chunk.end;
              clearCoveredEntries(state, chunk.pathHash, checkpoint.checkpoint);
              await stateWriter(statePath, state);
              stdout.write(
                `[cc-memory] auto-capture warning: parked-window session=${sessionId} source=${chunk.pathHash.slice(0, 12)}:${chunk.start}-${chunk.end} attempts=${RETRY_MAX_ATTEMPTS}\n`
              );
            }
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }

          if (!rawResponse || !extraction) {
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }

          try {
            const writeResult = await options.db.transaction((tx: DbClient) =>
              writeCaptureWindow(tx, chunkWindow, extraction, rawResponse, {
                path_hash: chunk.pathHash,
                start: chunk.start,
                end: chunk.end,
              }, {
                writerHost,
                generateEmbedding,
                embeddingExpected,
              })
            );
            result.processed += 1;
            result.observationsWritten += writeResult.observationsWritten;
            result.rollupsWritten += writeResult.rollupsWritten;
            result.embeddingFailed += writeResult.embeddingFailed ?? 0;
            observedAtOffset += extraction.observations.length;
            checkpoint.checkpoint = chunk.end;
            clearCoveredEntries(state, chunk.pathHash, checkpoint.checkpoint);
            await stateWriter(statePath, state);
          } catch {
            result.failed += 1;
            sessionStopped = true;
            snapshotCompleted = false;
            break;
          }
        }
        if (sessionStopped) break;
      }

      if (snapshotCompleted && !sessionStopped) {
        const outcomeCountAfter =
          result.processed + result.skipped + result.failed + result.deadLettered +
          result.rateLimited + result.malformed + result.parked + result.yielded +
          result.transcriptMissing;
        if (outcomeCountAfter === outcomeCountBefore) result.skipped += 1;
        state.spool.cursor = snapshot.safeEnd;
        await stateWriter(statePath, state);
        await maybeRotateCaptureSpool(spool, state, hasStopSentinel, getNowMs());
      }
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      stdout.write(
        `[cc-memory] auto-capture warning: worker-session-failed session=${spool.sessionIdFromPath} error=${message}\n`
      );
    } finally {
      await release();
    }
  }

  } catch (fatalErr) {
    // D1b: capture fatal error, telemetry still flows via result
    result.fatalError = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
  } finally {
    // D1b: takeTelemetry exactly once in function-level finally
    result.windows = windowsThisTick;
    const telemetry = options.llm.takeTelemetry();
    result.primaryProvider = telemetry.primaryProvider;
    result.primarySuccess += telemetry.primarySuccess;
    result.fallbackSuccess += telemetry.fallbackSuccess;
    result.fallbackFailed += telemetry.fallbackFailed;
  }

  return result;
}
