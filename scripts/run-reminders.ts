// scripts/run-reminders.ts — 手動驅動 getDueReminders（Personal-Hub Phase 1 驗證用）。
//
// 實際 channel poller（推 Telegram / hermes）屬跨 repo 階段；本腳本只負責
// 「撈 due + 去重 + advance」並把本次投遞清單印到 stdout。
//
// 用法：
//   npx tsx scripts/run-reminders.ts [projectId] [--limit N]
//     - forced-mode（設了 CC_FORCE_PROJECT_ID）：忽略 projectId 參數，鎖定 forced namespace。
//     - project-mode（未設）：必須提供 projectId，否則 fail-fast（不會誤撈全專案）。

import 'dotenv/config';
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
  const url = process.env.DATABASE_URL?.replace(/\r/g, '').replace(/^"|"$/g, '');
  if (!url) throw new Error('DATABASE_URL not set');

  const { rawProjectId, limit } = parseArgs(process.argv.slice(2));
  const config = loadScopeConfig();
  // applyScopePolicy：forced-mode 鎖定 forced namespace（忽略 rawProjectId）；
  // project-mode 需 rawProjectId，否則 fail-fast。
  const projectId = applyScopePolicy(rawProjectId, { config, surface: 'scope' }) as string;

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
