// src/services/capture-worker.ts
//
// CC-memory v0.5 M2b capture worker.

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import {
  CaptureLlmValidationError,
  estimateDiscoveryTokens,
  formatCaptureLlmDisabledWarning,
  isCaptureLlmDisabled,
  parseCaptureLlmExtraction,
  type CaptureLlmAdapter,
  type CaptureLlmExtraction,
  type CaptureLlmObservation,
  type CaptureLlmRawResponse,
} from './capture-llm.js';
import type { DbClient } from './types.js';
import { composeEmbeddingText, generateEmbedding as defaultGenerateEmbedding } from '../utils/embedding.js';
import { resolveWriterHost } from '../utils/writer-host.js';

const DEFAULT_SPOOL_DIR = join(homedir(), '.cache', 'cc-memory', 'spool');
const DEFAULT_SPOOL_MAX_MB = 500;
const DEFAULT_CAPTURE_MAX_WINDOW_BYTES = 256 * 1024;
// 注入污染防線 marker：SessionStart 注入內容帶 `source=cc-memory-inject`，
// 其字串子集為此常數；transcript 內含此字串的行整行排除，不送 LLM 抽取。
const INJECTION_MARKER = 'cc-memory-inject';
const RAW_LLM_OUTPUT_LIMIT = 2048;
const ROTATE_SIZE_BYTES = 10 * 1024 * 1024;
const ROTATE_IDLE_MS = 24 * 60 * 60 * 1000;
const MALFORMED_JSON_RETRY_PROMPT_PREFIX =
  'Previous output was not valid JSON. Output JSON only; the first character must be `{` and the last character must be `}`. Do not include markdown, code fences, or commentary.';

export interface CaptureWorkerResult {
  processed: number;
  skipped: number;
  failed: number;
  deadLettered: number;
  llmRetries: number;
  observationsWritten: number;
  rollupsWritten: number;
}

export interface CaptureWorkerOptions {
  db: DbClient;
  env?: Record<string, string | undefined>;
  llm: CaptureLlmAdapter;
  dbHealthCheck?: (db: DbClient) => Promise<boolean>;
  now?: () => Date;
  writerHost?: string;
  generateEmbedding?: (text: string) => Promise<number[] | null>;
  stdout?: { write(chunk: string): unknown };
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
  summarize_count: number;
  discovery_tokens: number;
}

interface RollupRow {
  id: string;
  metadata: unknown;
}

interface WriteWindowResult {
  observationsWritten: number;
  rollupsWritten: number;
}

function emptyResult(): CaptureWorkerResult {
  return {
    processed: 0,
    skipped: 0,
    failed: 0,
    deadLettered: 0,
    llmRetries: 0,
    observationsWritten: 0,
    rollupsWritten: 0,
  };
}

function spoolRoot(env: Record<string, string | undefined>): string {
  const configured = env.CC_MEMORY_SPOOL_DIR?.trim();
  return resolve(configured && configured.length > 0 ? configured : DEFAULT_SPOOL_DIR);
}

function hwmPathFor(spoolPath: string): string {
  return spoolPath.replace(/\.jsonl$/, '.hwm');
}

function lockPathFor(spoolPath: string): string {
  return `${spoolPath}.lock`;
}

function vectorLiteral(embedding: number[] | null): string | null {
  if (!embedding || embedding.length === 0) return null;
  return `[${embedding.join(',')}]`;
}

function sha256(input: string): string {
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

async function writeHwmAtomically(path: string, value: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, String(value), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

async function acquireSpoolLock(spoolPath: string): Promise<(() => Promise<void>) | null> {
  const lockPath = lockPathFor(spoolPath);
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.close();
    await chmod(lockPath, 0o600);
    return async () => {
      await unlink(lockPath).catch(() => undefined);
    };
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST') {
      return null;
    }
    throw error;
  }
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

function captureMaxWindowBytes(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.CC_CAPTURE_MAX_WINDOW_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 4 ? parsed : DEFAULT_CAPTURE_MAX_WINDOW_BYTES;
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

function parseSpoolRecords(buffer: Buffer): SpoolRecord[] {
  const text = buffer.toString('utf8');
  const records: SpoolRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as SpoolRecord;
    records.push(parsed);
  }
  return records;
}

function firstString(records: SpoolRecord[], key: keyof SpoolRecord): string | null {
  for (const record of records) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function minNumber(records: SpoolRecord[], key: keyof SpoolRecord, fallback: number): number {
  const values = records
    .map((record) => record[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : fallback;
}

function maxNumber(records: SpoolRecord[], key: keyof SpoolRecord, fallback: number): number {
  const values = records
    .map((record) => record[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : fallback;
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

async function readTranscriptSlice(path: string | null, start: number, end: number): Promise<string> {
  if (!path) return '';
  try {
    const buffer = await readFile(path);
    const safeStart = Math.max(0, Math.min(start, buffer.length));
    const safeEnd = Math.max(safeStart, Math.min(end, buffer.length));
    return buffer.subarray(safeStart, safeEnd).toString('utf8');
  } catch {
    return '';
  }
}

async function readWindow(spool: SpoolSession, start: number, end: number, now: Date): Promise<CaptureWindow | null> {
  const buffer = await readFile(spool.path);
  const safeStart = Math.max(0, Math.min(start, buffer.length));
  const safeEnd = Math.max(safeStart, Math.min(end, buffer.length));
  if (safeStart >= safeEnd) return null;

  const records = parseSpoolRecords(buffer.subarray(safeStart, safeEnd));
  if (records.length === 0) return null;

  const projectId = firstString(records, 'project_id') ?? spool.projectIdFromPath;
  const sessionId = firstString(records, 'session_id') ?? spool.sessionIdFromPath;
  const transcriptPath = firstString(records, 'transcript_path');
  const hwmOffsetStart = minNumber(records, 'transcript_offset', 0);
  const hwmOffsetEnd = maxNumber(records, 'hwm_offset', hwmOffsetStart);
  // 過濾放在分塊之前：先剔除注入 marker 行，再交由後續空窗口 skip / chunking 處理。
  const transcript = stripInjectionMarkerLines(
    await readTranscriptSlice(transcriptPath, hwmOffsetStart, hwmOffsetEnd)
  );

  return {
    spool,
    records,
    projectId,
    sessionId,
    transcriptPath,
    transcript,
    spoolOffsetStart: safeStart,
    spoolOffsetEnd: safeEnd,
    hwmOffsetStart,
    hwmOffsetEnd,
    processingTime: now,
  };
}

function splitCaptureWindow(window: CaptureWindow, maxBytes: number): CaptureWindow[] {
  if (Buffer.byteLength(window.transcript, 'utf8') <= maxBytes) {
    return [{ ...window, observedAtOffset: 0 }];
  }

  const chunks: CaptureWindow[] = [];
  let startIndex = 0;
  let hwmOffsetStart = window.hwmOffsetStart;

  while (startIndex < window.transcript.length) {
    let endIndex = startIndex;
    let byteLength = 0;
    let newlineEndIndex = -1;
    let newlineByteLength = 0;

    for (let index = startIndex; index < window.transcript.length;) {
      const codePoint = window.transcript.codePointAt(index);
      if (codePoint === undefined) break;
      const char = String.fromCodePoint(codePoint);
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (byteLength > 0 && byteLength + charBytes > maxBytes) break;

      byteLength += charBytes;
      index += char.length;
      endIndex = index;

      if (char === '\n') {
        newlineEndIndex = index;
        newlineByteLength = byteLength;
      }
    }

    if (newlineEndIndex > startIndex && endIndex < window.transcript.length) {
      endIndex = newlineEndIndex;
      byteLength = newlineByteLength;
    }

    const transcript = window.transcript.slice(startIndex, endIndex);
    const hwmOffsetEnd = hwmOffsetStart + byteLength;
    chunks.push({
      ...window,
      transcript,
      hwmOffsetStart,
      hwmOffsetEnd,
      observedAtOffset: 0,
    });
    startIndex = endIndex;
    hwmOffsetStart = hwmOffsetEnd;
  }

  return chunks;
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
    summarize_count:
      typeof record.summarize_count === 'number' && Number.isFinite(record.summarize_count)
        ? record.summarize_count
        : 0,
    discovery_tokens:
      typeof record.discovery_tokens === 'number' && Number.isFinite(record.discovery_tokens)
        ? record.discovery_tokens
        : 0,
  };
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
  text: string
): Promise<number[] | null> {
  try {
    return await generateEmbedding(text);
  } catch {
    return null;
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
  const metadata = {
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
    },
  };
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
  options: Required<Pick<CaptureWorkerOptions, 'writerHost' | 'generateEmbedding'>>
): Promise<WriteWindowResult> {
  const summary = extraction.session_summary;
  const idempotencyKey = `capture:v05:${window.projectId}:${window.sessionId}`;
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
    composeEmbeddingText(summary.summary, summary.keywords, summary.decisions)
  );

  const existing = await selectRollup(tx, window.projectId, idempotencyKey);
  const previousCapture = existingCaptureMetadata(existing?.metadata);
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
    summarize_count: (previousCapture?.summarize_count ?? 0) + (isReplayedWindow ? 0 : 1),
    discovery_tokens: discoveryTokens,
  };

  let rollupId = existing?.id ?? null;
  if (!rollupId) {
    const initialMetadata = mergeMetadata(existing?.metadata, baseCapture);
    rollupId = await insertRollup(tx, {
      window,
      extraction,
      model: rawResponse.model,
      idempotencyKey,
      contentHash: rollupContentHash,
      writerHost: options.writerHost,
      embedding: rollupEmbedding,
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
      [observation.title, observation.facts.join(' '), observation.narrative].join('\n')
    );
    const insertedId = await insertObservation(tx, {
      window,
      observation,
      rollupId,
      model: rawResponse.model,
      writerHost: options.writerHost,
      observedAt,
      embedding: observationEmbedding,
    });
    if (insertedId) insertedObservationIds.push(insertedId);
  }

  const finalCapture: CaptureMetadata = {
    ...baseCapture,
    observation_ids: [...baseCapture.observation_ids, ...insertedObservationIds],
  };
  const finalMetadata = mergeMetadata(existing?.metadata, finalCapture);
  await updateRollup(tx, {
    rollupId,
    window,
    extraction,
    contentHash: rollupContentHash,
    writerHost: options.writerHost,
    embedding: rollupEmbedding,
    metadata: finalMetadata,
  });

  return {
    observationsWritten: insertedObservationIds.length,
    rollupsWritten: 1,
  };
}

function llmErrorCode(error: unknown): string {
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

function isMalformedJsonLlmError(error: unknown): boolean {
  return error instanceof CaptureLlmValidationError && error.code === 'LLM_MALFORMED_JSON';
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
  }
): Promise<void> {
  const llmRawOutput = truncateLlmRawOutput(input.llmRawOutput);
  const hash = contentHash([
    window.projectId,
    window.sessionId,
    window.spoolOffsetStart,
    window.spoolOffsetEnd,
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
  await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function maybeRotateSpool(spool: SpoolSession, hwm: number, size: number, hasStopSentinel: boolean): Promise<void> {
  if (hwm < size) return;
  const info = await stat(spool.path).catch(() => null);
  if (!info) return;
  const shouldRotateBySize = size > ROTATE_SIZE_BYTES;
  const shouldRotateByAge = hasStopSentinel && Date.now() - info.mtimeMs > ROTATE_IDLE_MS;
  if (!shouldRotateBySize && !shouldRotateByAge) return;

  const sealed = `${spool.path}.${Date.now()}.sealed`;
  await rename(spool.path, sealed).catch(() => undefined);
}

async function spoolHasStopSentinel(spoolPath: string): Promise<boolean> {
  try {
    return (await readFile(spoolPath, 'utf8')).includes('"hwm_offset"');
  } catch {
    return false;
  }
}

export async function runCaptureWorkerOnce(
  options: CaptureWorkerOptions
): Promise<CaptureWorkerResult> {
  const env = options.env ?? process.env;
  const root = spoolRoot(env);
  const stdout = options.stdout ?? process.stdout;
  const result = emptyResult();

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
  const maxWindowBytes = captureMaxWindowBytes(env);
  const totalBytes = await totalSpoolBytes(root);
  if (totalBytes > maxBytes) {
    stdout.write(
      `[cc-memory] auto-capture skipped: spool size ${totalBytes} exceeds cap ${maxBytes}\n`
    );
    return { ...result, skipped: 1 };
  }

  const sessions = await listSpoolSessions(root);
  if (sessions.length === 0) return result;
  const writerHost = options.writerHost ?? resolveWriterHost();
  const generateEmbedding = options.generateEmbedding ?? defaultGenerateEmbedding;

  for (const spool of sessions) {
    const release = await acquireSpoolLock(spool.path);
    if (!release) {
      result.skipped += 1;
      continue;
    }

    try {
      const spoolInfo = await stat(spool.path);
      const currentSize = spoolInfo.size;
      const hwmPath = hwmPathFor(spool.path);
      const hwm = Math.min(await readHwm(hwmPath), currentSize);
      if (hwm >= currentSize) {
        result.skipped += 1;
        await maybeRotateSpool(spool, hwm, currentSize, await spoolHasStopSentinel(spool.path));
        continue;
      }

      const window = await readWindow(spool, hwm, currentSize, options.now?.() ?? new Date());
      if (!window) {
        result.skipped += 1;
        continue;
      }
      const hasStopSentinel = window.records.some(
        (record) => typeof record.hwm_offset === 'number'
      );

      if (window.projectId === '__personal__') {
        await writeHwmAtomically(hwmPath, currentSize);
        result.skipped += 1;
        await maybeRotateSpool(spool, currentSize, currentSize, hasStopSentinel);
        continue;
      }

      if (window.transcript.trim().length === 0) {
        await writeHwmAtomically(hwmPath, currentSize);
        result.skipped += 1;
        await maybeRotateSpool(spool, currentSize, currentSize, hasStopSentinel);
        continue;
      }

      if (isCaptureLlmDisabled(options.llm)) {
        result.skipped += 1;
        continue;
      }

      const chunks = splitCaptureWindow(window, maxWindowBytes);
      let observedAtOffset = 0;
      let sawDeadLetter = false;
      let sawWriteFailure = false;
      let sawRuntimeDisabled = false;

      for (const chunk of chunks) {
        const chunkWindow = { ...chunk, observedAtOffset };
        let rawResponse: CaptureLlmRawResponse | null = null;
        let extraction: CaptureLlmExtraction | null = null;
        let chunkDeadLettered = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const retryPromptPrefix =
            attempt === 0 ? undefined : MALFORMED_JSON_RETRY_PROMPT_PREFIX;
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
            });
            const attemptExtraction = parseCaptureLlmExtraction(attemptRawResponse);
            rawResponse = attemptRawResponse;
            extraction = attemptExtraction;
            break;
          } catch (error) {
            if (attempt === 0 && isMalformedJsonLlmError(error)) {
              result.llmRetries += 1;
              continue;
            }
            if (error instanceof CaptureLlmValidationError && error.code === 'CAPTURE_LLM_DISABLED') {
              stdout.write(
                formatCaptureLlmDisabledWarning(
                  typeof error.details.provider === 'string' ? error.details.provider : 'unknown',
                  error.message
                )
              );
              result.skipped += 1;
              sawRuntimeDisabled = true;
              break;
            }
            await writeDeadLetter(root, chunkWindow, {
              model: error instanceof CaptureLlmValidationError && typeof error.details.model === 'string'
                ? error.details.model
                : attemptRawResponse?.model ?? options.llm.model,
              error,
              legacyRawText: (error as { text?: string }).text,
              llmRawOutput: attemptRawResponse?.text ?? llmRawOutputFromError(error),
            });
            result.deadLettered += 1;
            sawDeadLetter = true;
            chunkDeadLettered = true;
            break;
          }
        }
        if (sawRuntimeDisabled) break;
        if (chunkDeadLettered || !rawResponse || !extraction) continue;

        try {
          const writeResult = await options.db.transaction((tx: DbClient) =>
            writeCaptureWindow(tx, chunkWindow, extraction, rawResponse, {
              writerHost,
              generateEmbedding,
            })
          );
          result.processed += 1;
          result.observationsWritten += writeResult.observationsWritten;
          result.rollupsWritten += writeResult.rollupsWritten;
          observedAtOffset += extraction.observations.length;
        } catch {
          result.failed += 1;
          sawWriteFailure = true;
          break;
        }
      }

      if (!sawDeadLetter && !sawWriteFailure && !sawRuntimeDisabled) {
        await writeHwmAtomically(hwmPath, currentSize);
        await maybeRotateSpool(spool, currentSize, currentSize, hasStopSentinel);
      }
    } catch {
      // 框架層失敗（stat/readHwm/readWindow/spool parse/HWM 寫入）：單一壞 spool
      // 不得中止整輪 worker——記 failed 後續處理下一個 session。
      result.failed += 1;
    } finally {
      await release();
    }
  }

  return result;
}
