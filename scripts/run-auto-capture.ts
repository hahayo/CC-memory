// scripts/run-auto-capture.ts — hermes `--no-agent` auto-capture worker.
//
// One tick: health check project DB, harvest local spool, call injected/default
// capture LLM, write rollup + observations, then print a concise stdout summary.

import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { config } from '../src/config.js';
import {
  createCaptureLlmAdapter,
  formatCaptureLlmDisabledWarning,
  isCaptureLlmDisabled,
} from '../src/services/capture-llm.js';
import { runCaptureWorkerOnce, type CaptureWorkerResult } from '../src/services/capture-worker.js';
import { generateEmbedding } from '../src/utils/embedding.js';

/** 遮罩 DSN 中 scheme 之後、@ 之前的帳密區段 */
export function maskDsnCredentials(text: string): string {
  return text.replace(/:\/\/[^@]+@/g, '://***@');
}

async function dbHealthCheck(db: { execute(query: unknown): Promise<unknown> }): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = maskDsnCredentials(raw);
    process.stdout.write(`[cc-memory] auto-capture skipped: DB health check failed: ${message}\n`);
    return false;
  }
}

/** Format the summary line for a completed capture worker result. */
export function formatSummaryLine(result: CaptureWorkerResult): string {
  const fatal = result.fatalError ? 1 : 0;
  return `[cc-memory] auto-capture summary: processed=${result.processed} skipped=${result.skipped} dead-letter=${result.deadLettered} failed=${result.failed} rate-limited=${result.rateLimited} malformed=${result.malformed} blocked=${result.blocked} transcript-missing=${result.transcriptMissing} parked=${result.parked} yielded=${result.yielded} held=${result.held} embedding-failed=${result.embeddingFailed} primary-provider=${result.primaryProvider || 'none'} primary-success=${result.primarySuccess} fallback-success=${result.fallbackSuccess} fallback-failed=${result.fallbackFailed} fatal=${fatal} spool-bytes=${result.spoolBytes} spool-cap-pct=${result.spoolCapPct} windows=${result.windows}`;
}

export interface RunAutoCaptureTickDeps {
  runWorker?: (input: Parameters<typeof runCaptureWorkerOnce>[0]) => Promise<CaptureWorkerResult>;
  stdout?: { write(chunk: string): unknown };
}

export const DEFAULT_DB_CONNECT_TIMEOUT_SEC = 2;

/**
 * 解析 CC_DB_CONNECT_TIMEOUT_SEC。postgres.js 的 connect_timeout 預設 2 秒；高並行 drain 走同一條
 * SSH tunnel 時 2 秒太短（2026-09-20 實測 10 支 6 小時內 32 次 CONNECT_TIMEOUT），故開放覆寫。
 *
 * 只接受完整的正整數字串。刻意不用 Number.parseInt——它會吃掉開頭數字就停，讓 '15seconds' 變 15、
 * '1e3' 變 1（比預設還短），打錯字會靜默套用錯誤的逾時而非退回預設。
 */
export function resolveConnectTimeoutSec(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DB_CONNECT_TIMEOUT_SEC;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DB_CONNECT_TIMEOUT_SEC;
}

export async function runAutoCaptureTick(deps: RunAutoCaptureTickDeps = {}): Promise<CaptureWorkerResult> {
  const stdout = deps.stdout ?? process.stdout;
  const workerFn = deps.runWorker ?? runCaptureWorkerOnce;
  const client = postgres(config.databaseUrl, {
    max: 1,
    connect_timeout: resolveConnectTimeoutSec(process.env.CC_DB_CONNECT_TIMEOUT_SEC),
    idle_timeout: 2,
  });
  const db = drizzle(client);
  try {
    const llm = createCaptureLlmAdapter({
      env: process.env,
      stdout,
      emitDisabledWarning: false,
    });
    if (isCaptureLlmDisabled(llm)) {
      stdout.write(
        formatCaptureLlmDisabledWarning(
          llm.provider ?? 'unknown',
          llm.disabledReason ?? 'capture LLM provider unavailable'
        )
      );
    }
    const result = await workerFn({
      db,
      llm,
      dbHealthCheck: () => dbHealthCheck(db),
      generateEmbedding,
      stdout,
    });
    stdout.write(`${formatSummaryLine(result)}\n`);
    if (result.fatalError) {
      process.exitCode = 1;
    }
    return result;
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'run-auto-capture';

if (isMain) {
  runAutoCaptureTick().catch((error) => {
    const raw = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[run-auto-capture] failed: ${maskDsnCredentials(raw)}\n`);
    process.exitCode = 1;
  });
}
