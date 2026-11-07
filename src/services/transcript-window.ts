/**
 * transcript（對話紀錄檔）切窗：把一段位元組範圍切成 ≤ maxBytes、行界優先、UTF-8 安全的連續子窗。
 *
 * 從 capture-worker.ts 抽出來（2026-11-08）：死信重放腳本也要用同一套切法，但 capture-worker.ts
 * 一載入就會連帶讀 src/config.ts（要求 DATABASE_URL），dry-run 不能碰 DB，所以純函式放這裡。
 */

import { CLAUDE_CLI_PROVIDER_ID, type CaptureLlmAdapter } from './capture-llm.js';

const DEFAULT_CAPTURE_MAX_WINDOW_BYTES = 256 * 1024;
const DEFAULT_CLAUDE_CAPTURE_MAX_WINDOW_BYTES = 32 * 1024;

export interface TranscriptChunk {
  path: string;
  pathHash: string;
  start: number;
  end: number;
  raw: Buffer;
}

/** 單次 LLM 呼叫的 transcript 位元組上限：env 優先，否則 claude-cli 32 KiB、其他 256 KiB。 */
export function captureMaxWindowBytes(
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

export function utf8SafeEnd(buffer: Buffer, start: number, proposedEnd: number, hardEnd: number): number {
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

export function splitTranscriptRange(
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
