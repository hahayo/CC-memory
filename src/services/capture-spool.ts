// src/services/capture-spool.ts
//
// CC-memory v0.5 M2a local hook spool append service.

import { chmod, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_CAPTURE_SKIP_TOOLS = [
  'ListMcpResourcesTool',
  'SlashCommand',
  'Skill',
  'TodoWrite',
  'AskUserQuestion',
] as const;

export interface CaptureThinEvent {
  session_id: string;
  project_id: string;
  tool_name: string;
  timestamp: string;
  transcript_path: string;
  transcript_offset: number;
}

export interface CaptureStopSentinel {
  project_id: string;
  session_id: string;
  timestamp: string;
  transcript_path: string;
  hwm_offset: number;
}

export interface CaptureSpoolOptions {
  env?: Record<string, string | undefined>;
}

export interface CaptureSpoolAppendResult {
  success: boolean;
  skipped?: boolean;
  path?: string;
  reason?: string;
}

const DEFAULT_SPOOL_DIR = join(homedir(), '.cache', 'cc-memory', 'spool');
const SAFE_SEGMENT_CHAR = /^[A-Za-z0-9-]$/;

/**
 * spool 目錄／檔名編碼（與 hooks/capture-common.sh 的 sanitize_segment 同構、可逆、不同 id 不碰撞）：
 * `[A-Za-z0-9.-]` 原樣；`_` 後面接 `u` 時編成 `_u005f`（否則原樣）；第一個字元若是 `.` 編成 `_u002e`；
 * 其餘每個 code point 編成 `_uXXXX`（至少 4 位十六進位）；空字串 → `unknown`。
 * 不 trim（與 bash 端一致；舊版 trim + 一律換 `_` 會讓不同中文名崩塌成同一目錄）。
 */
export function sanitizeSpoolSegment(value: string): string {
  const chars = Array.from(value);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '_') {
      out += chars[i + 1] === 'u' ? '_u005f' : '_';
    } else if (ch === '.') {
      out += out.length === 0 ? '_u002e' : '.';
    } else if (SAFE_SEGMENT_CHAR.test(ch)) {
      out += ch;
    } else {
      out += `_u${(ch.codePointAt(0) ?? 0xfffd).toString(16).padStart(4, '0')}`;
    }
  }
  return out.length === 0 ? 'unknown' : out;
}

/**
 * spool 目錄名 → 原始 project_id 的 best-effort 解碼（Codex R1 finding 2／R1b high 1）。
 * 編碼端 `_uXXXX` 不定長且無分隔，本質上不是單射：`中a` → `_u4e2da`、`😀` → `_u1f600`、
 * `U+1000`+`00` 與 `U+100000` 同為 `_u100000`——所以這不是反函數，只是啟發式：固定取 4 位十六進位
 * （BMP 字元後面接 `[0-9a-f]` 的情況遠多於 BMP 外字元）。4 位落在 surrogate 區（D800–DFFF）不是合法
 * code point，原樣保留。`unknown` 原樣回傳。worker 只在「spool 檔第一個 snapshot 就是 sentinel-only、
 * state 還沒記到 projectId」時才用它；之後一律用 state 持久化的原始 id。
 */
export function decodeSpoolSegment(value: string): string {
  return value.replace(/_u([0-9a-f]{4})/g, (whole, hex: string) => {
    const code = Number.parseInt(hex, 16);
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}

function spoolRoot(env: Record<string, string | undefined>): string {
  const configured = env.CC_MEMORY_SPOOL_DIR?.trim();
  return resolve(configured && configured.length > 0 ? configured : DEFAULT_SPOOL_DIR);
}

export function resolveCaptureSpoolPath(
  projectId: string,
  sessionId: string,
  options: CaptureSpoolOptions = {}
): string {
  const env = options.env ?? process.env;
  const root = spoolRoot(env);
  const project = sanitizeSpoolSegment(projectId);
  const session = sanitizeSpoolSegment(sessionId);
  return join(root, project, `${session}.jsonl`);
}

async function ensureSpoolDirectories(root: string, projectDir: string): Promise<void> {
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(projectDir, 0o700);
}

async function appendJsonLine(path: string, value: Record<string, unknown>): Promise<void> {
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function appendCaptureEvent(
  event: CaptureThinEvent,
  options: CaptureSpoolOptions = {}
): Promise<CaptureSpoolAppendResult> {
  const env = options.env ?? process.env;
  const root = spoolRoot(env);
  const project = sanitizeSpoolSegment(event.project_id);
  const session = sanitizeSpoolSegment(event.session_id);
  const projectDir = join(root, project);
  const path = join(projectDir, `${session}.jsonl`);

  try {
    await ensureSpoolDirectories(root, projectDir);
    await appendJsonLine(path, {
      session_id: event.session_id,
      project_id: event.project_id,
      tool_name: event.tool_name,
      timestamp: event.timestamp,
      transcript_path: event.transcript_path,
      transcript_offset: event.transcript_offset,
    });
    return { success: true, path };
  } catch (error) {
    return { success: true, path, reason: errorReason(error) };
  }
}

export async function appendStopSentinel(
  sentinel: CaptureStopSentinel,
  options: CaptureSpoolOptions = {}
): Promise<CaptureSpoolAppendResult> {
  const env = options.env ?? process.env;
  const root = spoolRoot(env);
  const project = sanitizeSpoolSegment(sentinel.project_id);
  const session = sanitizeSpoolSegment(sentinel.session_id);
  const projectDir = join(root, project);
  const path = join(projectDir, `${session}.jsonl`);

  try {
    await ensureSpoolDirectories(root, projectDir);
    await appendJsonLine(path, {
      transcript_path: sentinel.transcript_path,
      hwm_offset: sentinel.hwm_offset,
    });
    return { success: true, path };
  } catch (error) {
    return { success: true, path, reason: errorReason(error) };
  }
}

export function loadCaptureSkipTools(
  env: Record<string, string | undefined> = process.env
): ReadonlySet<string> {
  const configured = env.CC_MEMORY_SKIP_TOOLS;
  const source =
    typeof configured === 'string' ? configured : DEFAULT_CAPTURE_SKIP_TOOLS.join(',');
  const entries = source
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}

export function shouldSkipCaptureTool(
  toolName: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  return loadCaptureSkipTools(env).has(toolName);
}
