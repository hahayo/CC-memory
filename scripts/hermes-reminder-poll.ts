// scripts/hermes-reminder-poll.ts — hermes `--no-agent` reminder poller。
//
// 撈 + 認領到期提醒（channel='hermes'）：
//   - 有到期 → 印格式化訊息到 stdout（hermes --no-agent 投遞 verbatim）。
//   - 無到期 → 空 stdout（hermes 視為靜默、不投遞）。
//
// 生命週期刻意鏡像 scripts/run-reminders.ts：自建 postgres client → getDueReminders
// → await client.end() → 自然退出。**不要用 process.exit() 在 stdout.write 之後**：
// Node 對 pipe 的 stdout 是 async，process.exit() 會跳過 flush 造成截斷（hermes 抓的就是 pipe）。
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getDueReminders } from '../src/services/reminders.js';
import { loadScopeConfig, applyScopePolicy } from '../src/services/scope-policy.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.replace(/\r/g, '').replace(/^"|"$/g, '');
  if (!url) throw new Error('DATABASE_URL not set');

  const config = loadScopeConfig();
  // forced-mode（CC_FORCE_PROJECT_ID=__personal__）：鎖定 forced namespace；非 forced 則 fail-fast。
  const projectId = applyScopePolicy(undefined, { config, surface: 'scope' }) as string;

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
