// scripts/hermes-reminder-poll.ts — hermes `--no-agent` reminder poller。
//
// 撈 + 認領到期提醒（channel='hermes'）：
//   - 有到期 → 印格式化訊息到 stdout（hermes --no-agent 投遞 verbatim）。
//   - 無到期 → 空 stdout（hermes 視為靜默、不投遞）。
//
// 生命週期刻意鏡像 scripts/run-reminders.ts：自建 postgres client → getDueReminders
// → await client.end() → 自然退出。**不要用 process.exit() 在 stdout.write 之後**：
// Node 對 pipe 的 stdout 是 async，process.exit() 會跳過 flush 造成截斷（hermes 抓的就是 pipe）。
// Phase 3 v0.4：DB URL 走 src/config 啟動期決策（forced personal → DATABASE_URL_PERSONAL；
// 含 sanitize 引號+\r）。缺 URL 在 import 時 throw → main().catch 不會接到，但 ESM
// top-level throw 一樣 exit 1 + stderr，stdout 保持空 → hermes --no-agent 視為靜默。
// ⚠️ 部署順序（2026-06-10 實證）：hermes cron 的 cc-reminders.sh **直接跑本 repo
// working tree——commit 即上線**。fail-fast 生效期間該 cron 必須先 `hermes cron pause
// cc-memory-reminders`，等 maintenance window Step 6 補上 DATABASE_URL_PERSONAL 後再
// resume（見 docs/personal-hub/handback-A2-A4.md Step 6 警告 ②）。
import { config } from '../src/config.js';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getDueReminders } from '../src/services/reminders.js';
import { loadScopeConfig, applyScopePolicy } from '../src/services/scope-policy.js';

async function main(): Promise<void> {
  const url = config.databaseUrl;

  const scopeConfig = loadScopeConfig();
  // forced-mode（CC_FORCE_PROJECT_ID=__personal__）：鎖定 forced namespace；非 forced 則 fail-fast。
  const projectId = applyScopePolicy(undefined, { config: scopeConfig, surface: 'scope' }) as string;

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const due = await getDueReminders(db, { projectId, channel: 'hermes' });
    if (due.length === 0) return; // 空 stdout → hermes 靜默
    const lines = due.map(({ task }) => {
      const recur =
        task.recurrenceIntervalDays !== null ? ` (每 ${task.recurrenceIntervalDays} 天)` : '';
      return `⏰ ${task.title}${recur}`;
    });
    process.stdout.write(`📌 你有 ${due.length} 則到期提醒：\n${lines.join('\n')}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // 錯誤走 stderr（--no-agent 只投遞 stdout）→ 不打擾使用者；getDueReminders 為交易式，
  // 失敗即未認領，下個週期自動重試（fail-safe）。
  console.error('[hermes-reminder-poll] 失敗:', err);
  process.exit(1);
});
