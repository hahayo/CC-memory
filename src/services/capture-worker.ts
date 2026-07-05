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
const ROTATE_SIZE_BYTES = 10 * 1024 * 1024;
const ROTATE_IDLE_MS = 24 * 60 * 60 * 1000;

export interface CaptureWorkerResult {
  processed: number;
  skipped: number;
  failed: number;
  deadLettered: number;
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
  const transcript = await readTranscriptSlice(transcriptPath, hwmOffsetStart, hwmOffsetEnd);

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
        ${input.observation.discovery_tokens},
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
  const baseCapture: CaptureMetadata = {
    version: '0.5',
    session_id: window.sessionId,
    observation_ids: previousCapture?.observation_ids ?? [],
    model: rawResponse.model,
    spool_offsets: [
      ...(previousCapture?.spool_offsets ?? []),
      { start: window.spoolOffsetStart, end: window.spoolOffsetEnd },
    ],
    summarize_count: (previousCapture?.summarize_count ?? 0) + 1,
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
  for (let index = 0; index < extraction.observations.length; index += 1) {
    const observation = extraction.observations[index];
    const observedAt = new Date(window.processingTime.getTime() + index);
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

async function writeDeadLetter(
  root: string,
  window: CaptureWindow,
  input: {
    model: string;
    error: unknown;
    rawText?: string;
  }
): Promise<void> {
  const hash = contentHash([
    window.projectId,
    window.sessionId,
    window.spoolOffsetStart,
    window.spoolOffsetEnd,
    llmErrorCode(input.error),
    input.model,
    input.rawText ?? llmErrorMessage(input.error),
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
    llm_output: input.rawText,
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

      if (isCaptureLlmDisabled(options.llm)) {
        result.skipped += 1;
        continue;
      }

      let rawResponse: CaptureLlmRawResponse;
      let extraction: CaptureLlmExtraction;
      try {
        rawResponse = await options.llm.extract({
          projectId: window.projectId,
          sessionId: window.sessionId,
          transcript: window.transcript,
          spoolOffsetStart: window.spoolOffsetStart,
          spoolOffsetEnd: window.spoolOffsetEnd,
          hwmOffsetStart: window.hwmOffsetStart,
          hwmOffsetEnd: window.hwmOffsetEnd,
        });
        extraction = parseCaptureLlmExtraction(rawResponse);
      } catch (error) {
        await writeDeadLetter(root, window, {
          model: error instanceof CaptureLlmValidationError && typeof error.details.model === 'string'
            ? error.details.model
            : options.llm.model,
          error,
          rawText: (error as { text?: string }).text,
        });
        result.deadLettered += 1;
        continue;
      }

      try {
        const writeResult = await options.db.transaction((tx: DbClient) =>
          writeCaptureWindow(tx, window, extraction, rawResponse, {
            writerHost,
            generateEmbedding,
          })
        );
        await writeHwmAtomically(hwmPath, currentSize);
        result.processed += 1;
        result.observationsWritten += writeResult.observationsWritten;
        result.rollupsWritten += writeResult.rollupsWritten;
        await maybeRotateSpool(spool, currentSize, currentSize, hasStopSentinel);
      } catch {
        result.failed += 1;
      }
    } finally {
      await release();
    }
  }

  return result;
}
