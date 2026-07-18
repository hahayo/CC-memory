// scripts/hermes-reminder-poll.ts — reminder delivery poller v2（保留歷史檔名；不依賴 Hermes runtime）。
//
// at-least-once durable delivery：
//   1. getDueReminders：撈 + 認領到期提醒（同時寫 reminder_log，DB tx 內）
//   2. enqueueDue：把 due 的 payload 放進 delivery queue（冪等，ON CONFLICT DO NOTHING）
//   3. claimDeliverable(db, 20)：FOR UPDATE SKIP LOCKED，撈最多 20 筆待投遞
//   4. 逐筆 POST Telegram sendMessage（10s timeout via AbortController）：
//      - 成功（HTTP 200）→ markDelivered
//      - 失敗（非 200 / 網路錯）→ markFailed；回 'dead' → stdout 印 ⚠️ 告警
//   5. 回傳 {dead: string[]}（dead-letter task 標題清單）
//
// stdout contract：
//   - stdout 只輸出 dead-letter 告警（⚠️ 提醒投遞失敗 5 次已放棄: <title>）
//   - 正常訊息由本 poller 直接送 Telegram
//   - systemd 將 stdout/stderr 收進 journal
//
// 環境變數：
//   TELEGRAM_API_BASE   mock 時可覆寫（預設 https://api.telegram.org）
//   TELEGRAM_BOT_TOKEN  由 systemd EnvironmentFile 注入
//   TELEGRAM_CHAT_ID    由 systemd EnvironmentFile 注入
//
// ⚠️ 不要用 process.exit() 在 stdout.write 之後：
//   Node 對 pipe 的 stdout 是 async，process.exit() 會跳過 flush 造成截斷。

import { config } from '../src/config.js';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getDueReminders } from '../src/services/reminders.js';
import { loadScopeConfig, applyScopePolicy } from '../src/services/scope-policy.js';
import {
  enqueueDue,
  claimDeliverable,
  markDelivered,
  markFailed,
} from '../src/services/delivery-queue.js';
import type { DbClient } from '../src/services/types.js';

const TELEGRAM_TIMEOUT_MS = 10_000;
const CLAIM_LIMIT = 20;

export interface RunOneTickOpts {
  telegramApiBase?: string;
  token?: string;
  chatId?: string;
  /** 測試用：覆寫 projectId（通常由 scope-policy 決定）*/
  projectId?: string;
}

export interface RunOneTickResult {
  dead: string[];
}

/**
 * 一個 tick 的主邏輯，供測試直接呼叫。
 * 生產環境由 main() 驅動；測試時注入 db + opts。
 */
export async function runOneTick(
  db: DbClient,
  opts?: RunOneTickOpts
): Promise<RunOneTickResult> {
  const telegramApiBase = opts?.telegramApiBase ?? process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
  const token = opts?.token ?? process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = opts?.chatId ?? process.env.TELEGRAM_CHAT_ID ?? '';

  // projectId：明確傳入（測試用）> scope-policy 決策（生產用）
  let projectId: string;
  if (opts?.projectId !== undefined) {
    projectId = opts.projectId;
  } else {
    const scopeConfig = loadScopeConfig();
    projectId = applyScopePolicy(undefined, { config: scopeConfig, surface: 'scope' }) as string;
  }

  const deadList: string[] = [];

  // Step 1+2：getDueReminders + enqueueDue 在同一 outer tx 內（原子：兩者同 commit 或同 rollback）。
  // getDueReminders 內部呼 db.transaction()——傳入已在 tx 中的 client 時 Drizzle/PG 以 savepoint 處理，
  // FOR UPDATE SKIP LOCKED 在 savepoint 內依然有效。enqueueDue 的 ON CONFLICT DO NOTHING 保冪等。
  // 若 outer tx 因 enqueueDue 例外 rollback：reminder_log 寫入也一併撤銷，下一 tick 重撈（at-least-once）。
  // enqueueDue 冪等確保重撈不會建出重複 queue 列（UNIQUE(task_id, scheduled_for)）。
  await db.transaction(async (tx: DbClient) => {
    const due = await getDueReminders(tx, { projectId, channel: 'telegram' });
    if (due.length > 0) {
      const queueItems = due.map(({ task, slot }) => {
        const recur =
          task.recurrenceIntervalDays !== null ? ` (每 ${task.recurrenceIntervalDays} 天)` : '';
        return {
          taskId: task.id,
          scheduledFor: slot,
          payload: `⏰ ${task.title}${recur}`,
        };
      });
      await enqueueDue(tx, queueItems);
    }
  });

  // Step 3：claimDeliverable（含前幾輪退避後再次可投遞的列）
  const claimable = await claimDeliverable(db, CLAIM_LIMIT);
  if (claimable.length === 0) return { dead: deadList };

  // Step 4：逐筆 POST Telegram sendMessage
  for (const row of claimable) {
    const sendUrl = `${telegramApiBase}/bot${token}/sendMessage`;
    let success = false;
    let errorMsg = 'unknown';

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

      const resp = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: row.payload }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        success = true;
      } else {
        errorMsg = `HTTP ${resp.status}`;
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    if (success) {
      await markDelivered(db, row.id);
    } else {
      const outcome = await markFailed(db, row.id, errorMsg);
      if (outcome === 'dead') {
        // 找到任務標題（payload 是 "⏰ <title>..." 格式）
        const title = row.payload.replace(/^⏰ /, '').replace(/ \(每 \d+ 天\)$/, '');
        const msg = `⚠️ 提醒投遞失敗 5 次已放棄: ${title}`;
        process.stdout.write(msg + '\n');
        deadList.push(title);
      }
    }
  }

  return { dead: deadList };
}

// ---------------------------------------------------------------------------
// main（生產入口）
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = config.databaseUrl;
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await runOneTick(db);
  } finally {
    await client.end();
  }
}

// 只在直接執行時啟動（import 時不跑，避免測試模組載入觸發 main）。
// tsx / ts-node 直接跑時，process.argv[1] 就是本檔路徑；
// vitest import 時，process.argv[1] 會是 vitest 的 bin 路徑，不含本檔名。
import path from 'node:path';

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'hermes-reminder-poll';

if (isMain) {
  main().catch((err) => {
    console.error('[cc-memory-reminder-poll] 失敗:', err);
    process.exit(1);
  });
}
