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
const UNSAFE_SEGMENT_CHARS = /[^A-Za-z0-9._-]+/g;

export function sanitizeSpoolSegment(value: string): string {
  const sanitized = value.trim().replace(UNSAFE_SEGMENT_CHARS, '_').replace(/^\.+/, '_');
  if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
    return 'unknown';
  }
  return sanitized;
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
