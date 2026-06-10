// scripts/run-reminders.ts — 手動驅動 getDueReminders（Personal-Hub Phase 1 驗證用）。
//
// 實際 channel poller（推 Telegram / hermes）屬跨 repo 階段；本腳本只負責
// 「撈 due + 去重 + advance」並把本次投遞清單印到 stdout。
//
// 用法：
//   npx tsx scripts/run-reminders.ts [projectId] [--limit N]
//     - forced-mode（設了 CC_FORCE_PROJECT_ID）：忽略 projectId 參數，鎖定 forced namespace。
//     - project-mode（未設）：必須提供 projectId，否則 fail-fast（不會誤撈全專案）。

// Phase 3 v0.4：DB URL 走 src/config 啟動期決策（forced personal → DATABASE_URL_PERSONAL；
// 含 sanitize 引號+\r）。缺 URL 在 import 時 throw → exit 1 + stderr。
import { config } from '../src/config.js';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getDueReminders } from '../src/services/reminders.js';
import { loadScopeConfig, applyScopePolicy } from '../src/services/scope-policy.js';

function parseArgs(argv: string[]): { rawProjectId?: string; limit?: number } {
  let rawProjectId: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      limit = Number(argv[++i]);
    } else if (!a.startsWith('--')) {
      rawProjectId = a;
    }
  }
  return { rawProjectId, limit };
}

async function main(): Promise<void> {
  const url = config.databaseUrl;

  const { rawProjectId, limit } = parseArgs(process.argv.slice(2));
  const scopeConfig = loadScopeConfig();
  // applyScopePolicy：forced-mode 鎖定 forced namespace（忽略 rawProjectId）；
  // project-mode 需 rawProjectId，否則 fail-fast。
  const projectId = applyScopePolicy(rawProjectId, { config: scopeConfig, surface: 'scope' }) as string;

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const due = await getDueReminders(db, { projectId, channel: 'cli', limit });
    if (due.length === 0) {
      console.log(`[run-reminders] project="${projectId}" 無到期提醒`);
      return;
    }
    console.log(`[run-reminders] project="${projectId}" 本次投遞 ${due.length} 筆：`);
    for (const { task, slot } of due) {
      const recur =
        task.recurrenceIntervalDays !== null
          ? ` (每 ${task.recurrenceIntervalDays} 天)`
          : ' (一次性)';
      console.log(`  • [${slot.toISOString()}] ${task.title} (#${task.id.slice(0, 8)})${recur}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[run-reminders] 失敗:', err);
  process.exit(1);
});
