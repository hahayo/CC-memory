// scripts/todoist-sync-poll.ts — hermes `--no-agent` Todoist sync poller（A3d）。
//
// 一次 tick：pullAndApply（Todoist /sync → upsert tasks + 前進 sync_token）。
// 生命週期鏡像 hermes-reminder-poll.ts：自建 postgres client → 跑 → client.end()
// → 自然退出（不用 process.exit，避免 stdout async pipe truncation）。
//
// stdout 原則：
//   - 無變動 → 空 stdout（靜默，hermes --no-agent 不投遞）
//   - 有變動 → 一行摘要：✅ todoist sync: +N ~M ✓C（N=active upsert, M=cancelled, C=done）
//   - 錯誤 → stderr + exit 1（hermes cron admin alert；sync_token 未前進，下輪重拉）
//
// 環境變數：
//   DATABASE_URL / DATABASE_URL_PERSONAL  由 cc-todoist-sync.sh 注入（forced personal）
//   TODOIST_API_TOKEN                     由 cc-todoist-sync.sh 注入（讀 ~/.ccm-todoist-token）
//   TODOIST_API_BASE                      測試時可覆寫（預設 https://api.todoist.com/api/v1）

import postgres from 'postgres';
import { config } from '../src/config.js';
import { pullAndApply } from '../src/services/todoist-sync.js';

async function main(): Promise<void> {
  const token = process.env.TODOIST_API_TOKEN ?? '';
  if (token.length === 0) {
    throw new Error('TODOIST_API_TOKEN 未設定（cc-todoist-sync.sh 應自 ~/.ccm-todoist-token 注入）');
  }

  const client = postgres(config.databaseUrl, { max: 1 });
  try {
    const result = await pullAndApply(client, token, {
      baseUrl: process.env.TODOIST_API_BASE,
    });
    const total = result.upserted + result.completed + result.archived;
    if (total > 0) {
      process.stdout.write(
        `✅ todoist sync: +${result.upserted} ~${result.archived} ✓${result.completed}\n`
      );
    }
  } finally {
    await client.end();
  }
}

// 只在直接執行時啟動（同 hermes-reminder-poll.ts 慣例）
import path from 'node:path';

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'todoist-sync-poll';

if (isMain) {
  main().catch((err) => {
    console.error('[todoist-sync-poll] 失敗:', err);
    process.exitCode = 1;
  });
}
