#!/usr/bin/env npx tsx
// scripts/measure-pre-llm-elapsed.ts
//
// Phase 0 量測：從 tick (執行輪次) 起點到第一次 llm.extract() 呼叫前的 elapsed (耗時)。
//
// 涵蓋範圍：
//   DB health check (資料庫健康檢查，SELECT 1)、totalSpoolBytes (遞迴 spool 大小)、
//   listSpoolSessions (session 列舉)、archiveLegacySidecars (舊側車歸檔)、
//   loadTickCursor (游標載入)、acquireSpoolLock (取鎖)、loadOrMigrateCaptureState
//   (讀取 / 遷移 capture 狀態)。
//
// 注意：本腳本唯讀——不寫 DB、不動 spool／state：
//   1. stateWriter 注入 no-op (不寫任何狀態檔)。
//   2. llm.extract() 立刻 throw CaptureLlmValidationError('CAPTURE_LLM_DISABLED')，
//      此路徑在 worker 內觸發 runtimeStopped=true → snapshotCompleted=false，
//      跳過所有 stateWriter 呼叫（確認方式：grep runtimeStopped capture-worker.ts）。
//   3. db 只在 dbHealthCheck (SELECT 1) 時真實存取；其餘 db 操作不會到達。
//   4. CC_CAPTURE_RETRY_MIN_INTERVAL_MS=0 使已有 retry state 的 session 不被 park，
//      避免 stateWriter 因 retry 路徑被呼叫。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';

import {
  CaptureLlmValidationError,
  type CaptureLlmAdapter,
  type CaptureLlmRequest,
  type CaptureLlmRawResponse,
} from '../src/services/capture-llm.js';
import { runCaptureWorkerOnce } from '../src/services/capture-worker.js';

// ─── DSN 讀取 ───────────────────────────────────────────────────────────────

async function readDsn(): Promise<string | null> {
  const path = join(homedir(), '.ccm-project-url');
  try {
    const raw = await readFile(path, 'utf-8');
    return raw.trim();
  } catch {
    return null;
  }
}

// ─── 假 LLM adapter (適配器) ────────────────────────────────────────────────
// extract() 被呼叫時立刻 throw CAPTURE_LLM_DISABLED，並記錄呼叫時間戳。

interface MeasuringAdapter extends CaptureLlmAdapter {
  getExtractCalledAtMs(): number | null;
  reset(): void;
}

function makeMeasuringAdapter(): MeasuringAdapter {
  let extractCalledAtMs: number | null = null;

  return {
    model: 'measure-only',
    provider: 'measure-only',
    // disabled 必須為 false：若 true，worker 在 isCaptureLlmDisabled() 處提前
    // 跳過，extract() 永遠不被呼叫，量不到目標 elapsed。
    disabled: false,

    async extract(_req: CaptureLlmRequest): Promise<CaptureLlmRawResponse> {
      extractCalledAtMs = Date.now();
      throw new CaptureLlmValidationError(
        'CAPTURE_LLM_DISABLED',
        'measure-pre-llm-elapsed: intentional early-exit probe',
        { provider: 'measure-only' }
      );
    },

    getExtractCalledAtMs(): number | null {
      return extractCalledAtMs;
    },

    reset(): void {
      extractCalledAtMs = null;
    },
  };
}

// ─── 量測一次 tick ───────────────────────────────────────────────────────────

interface TickMeasurement {
  totalElapsedMs: number;
  extractCalledMs: number | null; // null = extract() 未被呼叫（spool 空或 adapter disabled 提前退）
  dbHealthMs: number | null;      // null = 跳過或失敗
}

async function measureOnce(
  db: ReturnType<typeof drizzle> | null,
  adapter: MeasuringAdapter,
  env: Record<string, string | undefined>
): Promise<TickMeasurement> {
  adapter.reset();

  const tickStartMs = Date.now();
  let dbHealthMs: number | null = null;

  // dbHealthCheck (資料庫健康檢查) 函式：執行 SELECT 1 並量測耗時。
  // 若 db 為 null（連線失敗），直接回傳 false 並記錄 0 ms。
  async function dbHealthCheck(_dbArg: unknown): Promise<boolean> {
    if (!db) {
      dbHealthMs = 0;
      return false;
    }
    const t0 = Date.now();
    try {
      await db.execute(sql`SELECT 1`);
      dbHealthMs = Date.now() - t0;
      return true;
    } catch {
      dbHealthMs = Date.now() - t0;
      return false;
    }
  }

  // stateWriter no-op：注入給 runCaptureWorkerOnce 避免寫入任何狀態檔。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function noopStateWriter(_path: string, _state: any): Promise<void> {
    // 刻意空函式：Phase 0 唯讀量測，不允許寫入任何 .state 檔案。
  }

  // generateEmbedding no-op：不觸發 Gemini API 呼叫。
  async function noopEmbedding(_text: string): Promise<number[] | null> {
    return null;
  }

  // 抑制 worker stdout（工作程序標準輸出）：18,043 個 session 的警告
  // 會產生大量噪音，量測腳本只需要 elapsed 數字。
  const devNull = { write(_chunk: string) { /* 刻意 no-op */ } };

  try {
    await runCaptureWorkerOnce({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      env,
      llm: adapter,
      dbHealthCheck: db ? dbHealthCheck : undefined,
      stateWriter: noopStateWriter,
      generateEmbedding: noopEmbedding,
      stdout: devNull,
    });
  } catch {
    // 非預期錯誤：仍記錄 elapsed，供診斷。
  }

  const totalElapsedMs = Date.now() - tickStartMs;
  const extractCalledMs = adapter.getExtractCalledAtMs();

  return {
    totalElapsedMs,
    extractCalledMs: extractCalledMs !== null ? extractCalledMs - tickStartMs : null,
    dbHealthMs,
  };
}

// ─── 統計工具 ────────────────────────────────────────────────────────────────

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const RUNS = 10;
  const THRESHOLD_MS = 58_000; // tick 開窗門檻：elapsed + 182,000 <= 240,000

  // 讀取 DSN (資料庫連線字串)
  const dsn = await readDsn();
  let pg: ReturnType<typeof postgres> | null = null;
  let db: ReturnType<typeof drizzle> | null = null;

  if (dsn) {
    try {
      pg = postgres(dsn, { max: 1, idle_timeout: 30 });
      db = drizzle(pg);
      console.log(`[measure] DB DSN loaded from ~/.ccm-project-url`);
    } catch (err) {
      console.warn(`[measure] DB 連線初始化失敗，health check 將以 0 ms 計：${err}`);
    }
  } else {
    console.warn('[measure] ~/.ccm-project-url 不存在，DB health check 跳過，以 0 ms 計。');
  }

  // CC_CAPTURE_RETRY_MIN_INTERVAL_MS=0：避免 retry park 路徑觸發 stateWriter。
  const env: Record<string, string | undefined> = {
    ...process.env,
    CC_CAPTURE_RETRY_MIN_INTERVAL_MS: '0',
  };

  const adapter = makeMeasuringAdapter();
  const totalElapseds: number[] = [];
  const extractElapseds: number[] = [];
  const dbHealthTimes: number[] = [];

  console.log(`[measure] 開始量測，跑 ${RUNS} 次...`);
  console.log('');

  for (let i = 1; i <= RUNS; i++) {
    const m = await measureOnce(db, adapter, env);
    totalElapseds.push(m.totalElapsedMs);
    if (m.extractCalledMs !== null) extractElapseds.push(m.extractCalledMs);
    if (m.dbHealthMs !== null) dbHealthTimes.push(m.dbHealthMs);

    const extractStr =
      m.extractCalledMs !== null ? `${m.extractCalledMs} ms` : '(未呼叫—spool 空或提前退)';
    const dbStr = m.dbHealthMs !== null ? `${m.dbHealthMs} ms` : 'skipped';
    console.log(
      `  Run ${String(i).padStart(2)}: total=${m.totalElapsedMs} ms  pre-extract=${extractStr}  db-health=${dbStr}`
    );
  }

  console.log('');
  console.log('─── 結果 ───────────────────────────────────────────');

  if (extractElapseds.length > 0) {
    const p95Extract = p95(extractElapseds);
    const worstExtract = Math.max(...extractElapseds);
    const passP95 = p95Extract <= THRESHOLD_MS;
    const passWorst = worstExtract <= THRESHOLD_MS;

    console.log(`pre-extract elapsed（到第一次 llm.extract 前）：`);
    console.log(`  p95  = ${p95Extract} ms  ${passP95 ? '✓' : '✗'} (門檻 ${THRESHOLD_MS} ms)`);
    console.log(`  最壞 = ${worstExtract} ms  ${passWorst ? '✓' : '✗'} (門檻 ${THRESHOLD_MS} ms)`);
    console.log(`  全部 = ${extractElapseds.join(', ')} ms`);
    console.log('');

    const conclusion = passP95 && passWorst
      ? `結論：p95 ${p95Extract} ms ≤ ${THRESHOLD_MS} ms，最壞值 ${worstExtract} ms ≤ ${THRESHOLD_MS} ms。預算鏈無需調整。`
      : `結論：⚠️ p95 或最壞值超過 ${THRESHOLD_MS} ms 門檻，需同步調整 240/270/300 整條預算鏈。`;
    console.log(conclusion);
  } else {
    console.log('⚠️  extract() 從未被呼叫——spool 可能為空，或 adapter 被提前 disabled 排除。');
    console.log('    totalElapsed 僅供參考（未含主要 spool 掃描路徑）。');
    console.log('    請確認 CC_MEMORY_SPOOL_DIR 指向含有 session 的 spool。');
    console.log(`  total-elapsed p95  = ${p95(totalElapseds)} ms`);
    console.log(`  total-elapsed 最壞 = ${Math.max(...totalElapseds)} ms`);
  }

  if (dbHealthTimes.length > 0) {
    console.log('');
    console.log(
      `DB health check：p95 = ${p95(dbHealthTimes)} ms，最壞 = ${Math.max(...dbHealthTimes)} ms`
    );
  }

  // 清理 DB 連線 (資料庫連線)
  if (pg) {
    await pg.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[measure] 未預期錯誤：', err);
  process.exit(1);
});
