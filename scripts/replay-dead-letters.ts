#!/usr/bin/env npx tsx
/**
 * scripts/replay-dead-letters.ts — 重跑 spool/.dead 裡的死信窗口（dead-letter replay）。
 *
 * 適用：LLM 抽取連續超時被 park 的窗口（error_code=LLM_EXTRACT_FAILED）。
 * 主迴圈 park 時 checkpoint 已越過該區間，永遠不會回頭；此腳本照死信記錄的
 * transcript 位置把原文撈回來，用「現在的」provider/model 重抽一次並寫 DB。
 *
 * 安全設計：
 *   - 預設 dry-run，只列清單；`--apply` 才會呼叫 LLM 與寫 DB。
 *   - apply 走與 live worker 相同的 flock（live tick 撞鎖會以 exit 75 讓路）。
 *   - apply 必過 production approval marker（與 supervisor 同一道閘）。
 *   - apply 必須 provider=codex-cli 且 model 等於 --expect-model（預設 gpt-5.6-luna），
 *     避免 shell 預設值（claude-cli/haiku 或 gpt-5.6-sol）偷偷生效。
 *   - 成功的死信檔改名為 `<name>.json.replayed`（非 .json，drain/audit 不再計為 parked）。
 *   - 不碰 capture-state 檔。
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createCaptureLlmAdapter,
  isCaptureLlmDisabled,
  type CaptureLlmAdapter,
} from '../src/services/capture-llm.js';
import type { ReplayCaptureWindowResult } from '../src/services/capture-worker.js';
import type { DbClient } from '../src/services/types.js';
import { checkProductionApproval } from './run-auto-capture-supervisor.js';

const DEFAULT_SPOOL_DIR = path.join(homedir(), '.cache', 'cc-memory', 'spool');
const DEFAULT_PROJECT_URL_FILE = path.join(homedir(), '.ccm-project-url');
const DEFAULT_GEMINI_KEY_FILE = path.join(homedir(), '.gemini-api-key');
const DEFAULT_LOCK_FILE = path.join(homedir(), '.cache', 'cc-memory', 'auto-capture-run.lock');
const DEFAULT_ERROR_CODE = 'LLM_EXTRACT_FAILED';
const DEFAULT_EXPECT_MODEL = 'gpt-5.6-luna';
const REPLAYED_SUFFIX = '.replayed';

export interface ReplayCliOptions {
  apply: boolean;
  spoolDir: string;
  projectUrlFile: string;
  geminiKeyFile: string;
  lockFile: string;
  errorCode: string;
  expectModel: string;
  limit: number;
}

export interface DeadLetterSource {
  path_hash: string;
  start: number;
  end: number;
  content_hash: string | null;
}

export interface DeadLetterRecord {
  file: string;
  projectId: string;
  sessionId: string;
  spoolOffset: { start: number; end: number };
  hwmOffset: { start: number; end: number };
  source: DeadLetterSource | null;
  errorCode: string;
  model: string;
  errorMessage: string;
}

export type ReplayCandidateStatus =
  | 'READABLE'
  | 'no-source'
  | 'path-unresolved'
  | 'transcript-deleted'
  | 'transcript-truncated'
  | 'error-code-filtered';

export interface ReplayCandidate {
  record: DeadLetterRecord;
  status: ReplayCandidateStatus;
  transcriptPath: string | null;
  bytes: number;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

export function parseReplayArgs(args: string[]): ReplayCliOptions {
  const limitRaw = optionValue(args, '--limit');
  const limit = limitRaw === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) && limitRaw !== undefined) {
    throw new Error(`--limit must be a positive integer, got ${limitRaw}`);
  }
  return {
    apply: args.includes('--apply'),
    spoolDir: optionValue(args, '--spool-dir') ?? DEFAULT_SPOOL_DIR,
    projectUrlFile: optionValue(args, '--project-url-file') ?? DEFAULT_PROJECT_URL_FILE,
    geminiKeyFile: optionValue(args, '--gemini-key-file') ?? DEFAULT_GEMINI_KEY_FILE,
    lockFile: optionValue(args, '--lock-file') ?? DEFAULT_LOCK_FILE,
    errorCode: optionValue(args, '--error-code') ?? DEFAULT_ERROR_CODE,
    expectModel: optionValue(args, '--expect-model') ?? DEFAULT_EXPECT_MODEL,
    limit,
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** 解析單一死信檔；格式不符回 null（呼叫端略過並列印）。 */
export function parseDeadLetter(file: string, raw: string): DeadLetterRecord | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const metadata = (payload as { metadata?: Record<string, unknown> }).metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const projectId = metadata.project_id;
  const sessionId = metadata.session_id;
  if (typeof projectId !== 'string' || typeof sessionId !== 'string') return null;
  const offset = metadata.offset as { start?: unknown; end?: unknown } | undefined;
  const hwm = metadata.hwm_offset as { start?: unknown; end?: unknown } | undefined;
  const spoolStart = nonNegativeInteger(offset?.start);
  const spoolEnd = nonNegativeInteger(offset?.end);
  const hwmStart = nonNegativeInteger(hwm?.start);
  const hwmEnd = nonNegativeInteger(hwm?.end);
  if (spoolStart === null || spoolEnd === null || hwmStart === null || hwmEnd === null) return null;

  let source: DeadLetterSource | null = null;
  const rawSource = metadata.source as Record<string, unknown> | undefined;
  if (rawSource && typeof rawSource.path_hash === 'string') {
    const start = nonNegativeInteger(rawSource.start);
    const end = nonNegativeInteger(rawSource.end);
    if (start !== null && end !== null && end > start) {
      source = {
        path_hash: rawSource.path_hash,
        start,
        end,
        content_hash: typeof rawSource.content_hash === 'string' ? rawSource.content_hash : null,
      };
    }
  }
  const error = (payload as { error?: { message?: unknown } }).error;
  return {
    file,
    projectId,
    sessionId,
    spoolOffset: { start: spoolStart, end: spoolEnd },
    hwmOffset: { start: hwmStart, end: hwmEnd },
    source,
    errorCode: typeof metadata.error_code === 'string' ? metadata.error_code : 'unknown',
    model: typeof metadata.model === 'string' ? metadata.model : 'unknown',
    errorMessage: typeof error?.message === 'string' ? error.message : '',
  };
}

export async function listDeadLetters(spoolDir: string): Promise<DeadLetterRecord[]> {
  const deadDir = path.join(spoolDir, '.dead');
  const entries = await readdir(deadDir, { withFileTypes: true }).catch(() => []);
  const records: DeadLetterRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(deadDir, entry.name);
    const parsed = parseDeadLetter(file, await readFile(file, 'utf8'));
    if (parsed) records.push(parsed);
  }
  return records.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * 掃 spool 的 live `.jsonl` 與 rotated `.sealed` 檔，建 sha256(transcript_path) → transcript_path 對照。
 * `.legacy` 是 v1 hwm 數值檔，沒有 record，略過。
 */
export async function buildTranscriptPathMap(spoolDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const projects = await readdir(spoolDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory() || project.name.startsWith('.')) continue;
    const dir = path.join(spoolDir, project.name);
    const files = await readdir(dir).catch(() => []);
    for (const name of files) {
      if (!name.endsWith('.jsonl') && !name.endsWith('.sealed')) continue;
      const raw = await readFile(path.join(dir, name), 'utf8').catch(() => '');
      for (const line of raw.split('\n')) {
        if (!line.includes('"transcript_path"')) continue;
        try {
          const record = JSON.parse(line) as { transcript_path?: unknown };
          const transcriptPath = record.transcript_path;
          if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
            const key = sha256Hex(transcriptPath);
            if (!map.has(key)) map.set(key, transcriptPath);
          }
        } catch {
          // malformed spool line：略過
        }
      }
    }
  }
  return map;
}

export async function classifyCandidate(
  record: DeadLetterRecord,
  pathMap: Map<string, string>,
  errorCode: string,
): Promise<ReplayCandidate> {
  const base = { record, transcriptPath: null as string | null, bytes: 0 };
  if (record.errorCode !== errorCode) return { ...base, status: 'error-code-filtered' };
  if (!record.source) return { ...base, status: 'no-source' };
  const transcriptPath = pathMap.get(record.source.path_hash);
  if (!transcriptPath) return { ...base, status: 'path-unresolved' };
  const fileStat = await stat(transcriptPath).catch(() => null);
  if (!fileStat) return { ...base, transcriptPath, status: 'transcript-deleted' };
  if (fileStat.size < record.source.end) return { ...base, transcriptPath, status: 'transcript-truncated' };
  return {
    record,
    transcriptPath,
    status: 'READABLE',
    bytes: record.source.end - record.source.start,
  };
}

export function replayedFileName(deadLetterFile: string): string {
  return `${deadLetterFile}${REPLAYED_SUFFIX}`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function formatCandidateLine(candidate: ReplayCandidate): string {
  const r = candidate.record;
  const src = r.source ? `${shortHash(r.source.path_hash)}:${r.source.start}-${r.source.end}` : '-';
  const kb = candidate.bytes > 0 ? `${Math.ceil(candidate.bytes / 1024)}KB` : '-';
  return `${candidate.status.padEnd(20)} ${r.model.padEnd(13)} ${r.projectId.padEnd(30)} ${kb.padStart(6)} ${src} ${path.basename(r.file)}`;
}

async function readTranscriptRange(transcriptPath: string, start: number, end: number): Promise<Buffer> {
  const whole = await readFile(transcriptPath);
  return whole.subarray(start, end);
}

export interface ReplayRuntime {
  db: DbClient;
  llm: CaptureLlmAdapter;
  generateEmbedding: (text: string) => Promise<number[] | null>;
  embeddingExpected: boolean;
  replay: typeof import('../src/services/capture-worker.js').replayCaptureWindow;
}

export interface ReplayTotals {
  written: number;
  observations: number;
  skipped: number;
  failed: number;
}

/** 對 READABLE 候選逐一重跑；成功即改名死信檔。回傳統計。 */
export async function replayCandidates(
  candidates: ReplayCandidate[],
  runtime: ReplayRuntime,
  stdout: { write(chunk: string): unknown },
): Promise<ReplayTotals> {
  const totals: ReplayTotals = { written: 0, observations: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    const r = candidate.record;
    if (candidate.status !== 'READABLE' || !candidate.transcriptPath || !r.source) continue;
    const raw = await readTranscriptRange(candidate.transcriptPath, r.source.start, r.source.end);
    const startedAt = Date.now();
    const result: ReplayCaptureWindowResult = await runtime.replay({
      db: runtime.db,
      llm: runtime.llm,
      projectId: r.projectId,
      sessionId: r.sessionId,
      transcriptPath: candidate.transcriptPath,
      raw,
      spoolOffset: r.spoolOffset,
      hwmOffset: r.hwmOffset,
      source: r.source,
      generateEmbedding: runtime.generateEmbedding,
      embeddingExpected: runtime.embeddingExpected,
    });
    const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
    const label = `${r.projectId} ${shortHash(r.source.path_hash)}:${r.source.start}-${r.source.end}`;
    if (result.status === 'written') {
      totals.written += 1;
      totals.observations += result.observationsWritten;
      await markReplayed(r.file, result);
      stdout.write(
        `[replay] written  ${label} model=${result.model} observations=${result.observationsWritten} embedding-failed=${result.embeddingFailed} ${elapsed}\n`
      );
    } else if (result.status === 'skipped') {
      totals.skipped += 1;
      if (result.reason === 'already-covered') await markReplayed(r.file, result);
      stdout.write(`[replay] skipped  ${label} reason=${result.reason} ${elapsed}\n`);
    } else {
      totals.failed += 1;
      stdout.write(`[replay] failed   ${label} code=${result.errorCode} ${elapsed} message=${result.message.slice(0, 160)}\n`);
    }
  }
  return totals;
}

async function markReplayed(deadLetterFile: string, result: ReplayCaptureWindowResult): Promise<void> {
  // 先寫好 .json.replayed（非 .json，drain/audit 不再計為 parked），再刪原檔；中途中斷最多留兩份，不會丟資料。
  const payload = JSON.parse(await readFile(deadLetterFile, 'utf8')) as Record<string, unknown>;
  payload.replayed = { at: new Date().toISOString(), ...result };
  await writeFile(replayedFileName(deadLetterFile), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await unlink(deadLetterFile);
}

function reexecUnderFlock(options: ReplayCliOptions): number | null {
  if (process.env.CC_MEMORY_REPLAY_FLOCKED === '1') return null;
  mkdirSync(path.dirname(options.lockFile), { recursive: true, mode: 0o700 });
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawnSync(
    '/usr/bin/flock',
    ['-w', '300', '-E', '73', options.lockFile, process.execPath, tsxCli, process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, CC_MEMORY_REPLAY_FLOCKED: '1' } },
  );
  if (child.status === 73) {
    process.stderr.write(`[replay] lock busy after 300s: ${options.lockFile}\n`);
    return 3;
  }
  return child.status ?? 1;
}

async function loadGeminiKey(file: string): Promise<string | undefined> {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  const key = await readFile(file, 'utf8').then((v) => v.trim()).catch(() => '');
  return key || undefined;
}

export function assertExpectedLlm(llm: CaptureLlmAdapter, expectModel: string): void {
  if (isCaptureLlmDisabled(llm)) {
    throw new Error(`capture LLM disabled: ${llm.disabledReason ?? 'unknown'}`);
  }
  if (llm.provider !== 'codex-cli') {
    throw new Error(`provider must be codex-cli for replay, got ${llm.provider ?? 'unknown'} (set CC_CAPTURE_LLM=codex-cli)`);
  }
  if (llm.model !== expectModel) {
    throw new Error(`model must be ${expectModel}, got ${llm.model} (set CC_CAPTURE_CODEX_MODEL or --expect-model)`);
  }
}

async function main(): Promise<number> {
  const options = parseReplayArgs(process.argv.slice(2));
  const stdout = process.stdout;

  if (options.apply) {
    const flocked = reexecUnderFlock(options);
    if (flocked !== null) return flocked;
  }

  const records = await listDeadLetters(options.spoolDir);
  const pathMap = await buildTranscriptPathMap(options.spoolDir);
  const candidates: ReplayCandidate[] = [];
  for (const record of records) candidates.push(await classifyCandidate(record, pathMap, options.errorCode));

  const counts = new Map<ReplayCandidateStatus, number>();
  for (const c of candidates) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  stdout.write(`[replay] dead-letters=${records.length} error-code=${options.errorCode}\n`);
  for (const [status, n] of [...counts.entries()].sort()) stdout.write(`[replay]   ${status}=${n}\n`);

  const readable = candidates.filter((c) => c.status === 'READABLE').slice(0, options.limit);
  stdout.write(`[replay] readable=${readable.length}${Number.isFinite(options.limit) ? ` (limit ${options.limit})` : ''}\n`);
  for (const c of candidates) {
    if (c.status === 'READABLE' || c.status === 'path-unresolved' || c.status === 'transcript-truncated') {
      stdout.write(`  ${formatCandidateLine(c)}\n`);
    }
  }

  if (!options.apply) {
    const llm = createCaptureLlmAdapter({ env: process.env, emitDisabledWarning: false });
    stdout.write(`[replay] dry-run; effective provider=${llm.provider ?? 'unknown'} model=${llm.model} (apply requires codex-cli/${options.expectModel})\n`);
    return 0;
  }
  if (readable.length === 0) {
    stdout.write('[replay] nothing to replay\n');
    return 0;
  }

  let databaseUrl: string;
  try {
    databaseUrl = (await readFile(options.projectUrlFile, 'utf8')).trim();
    if (!databaseUrl) throw new Error('project URL file is empty');
    await checkProductionApproval({ databaseUrl, now: new Date() });
  } catch (error) {
    process.stderr.write(`[replay] preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.env.DATABASE_URL = databaseUrl;
  const geminiKey = await loadGeminiKey(options.geminiKeyFile);
  if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;
  else process.stderr.write('[replay] warning: embeddings-disabled; rows will use NULL embedding\n');

  const llm = createCaptureLlmAdapter({ env: process.env, emitDisabledWarning: false });
  try {
    assertExpectedLlm(llm, options.expectModel);
  } catch (error) {
    process.stderr.write(`[replay] preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  stdout.write(`[replay] apply provider=${llm.provider} model=${llm.model} windows=${readable.length}\n`);

  // src/config.ts 在 module load 時讀 DATABASE_URL，必須在設好 env 之後才 import。
  const [{ config }, { replayCaptureWindow }, { generateEmbedding }, postgresModule, drizzleModule] =
    await Promise.all([
      import('../src/config.js'),
      import('../src/services/capture-worker.js'),
      import('../src/utils/embedding.js'),
      import('postgres'),
      import('drizzle-orm/postgres-js'),
    ]);
  if (config.databaseUrl !== databaseUrl) {
    process.stderr.write('[replay] preflight failed: runtime config resolved a different DATABASE_URL\n');
    return 1;
  }
  const client = postgresModule.default(databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 5 });
  const db = drizzleModule.drizzle(client) as unknown as DbClient;
  try {
    const totals = await replayCandidates(readable, {
      db,
      llm,
      generateEmbedding,
      embeddingExpected: Boolean(geminiKey),
      replay: replayCaptureWindow,
    }, stdout);
    stdout.write(
      `[replay] summary: written=${totals.written} observations=${totals.observations} skipped=${totals.skipped} failed=${totals.failed}\n`
    );
    return totals.failed > 0 ? 2 : 0;
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'replay-dead-letters';

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[replay] failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
