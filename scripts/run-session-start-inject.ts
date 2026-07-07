// scripts/run-session-start-inject.ts — SessionStart 注入 CLI（薄殼）。
//
// 流程：讀 hook payload JSON（stdin，欄位 cwd）→ 依 cwd basename 決定 projectId
//   → 查 Recent Activity → 渲染 → 印 SessionStart hook protocol JSON。
//
// 全程 best-effort（盡力而為）：任何錯誤（flag off / 壞 JSON / DB 連不上 /
// builder throw）一律「空 stdout、exit 0」，絕不擋 session start。DSN 解析
// 沿用 run-auto-capture.ts 慣例（config.databaseUrl）；config 動態 import 延到
// flag on 且 JSON parse 成功後，避免關閉／壞 payload 路徑觸發 DATABASE_URL 解析。

import path from 'node:path';
import { sanitizeSpoolSegment } from '../src/services/capture-spool.js';
import { buildRecentActivity } from '../src/services/recent-activity.js';
import { buildSessionStartOutput } from '../src/services/session-start-inject.js';

function injectRecentEnabled(env: Record<string, string | undefined>): boolean {
  return (env.CC_MEMORY_INJECT_RECENT ?? '').trim().toLowerCase() === 'on';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseCwd(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { cwd?: unknown };
    if (typeof parsed.cwd === 'string' && parsed.cwd.trim().length > 0) {
      return parsed.cwd;
    }
  } catch {
    return null;
  }
  return null;
}

// cwd basename → projectId（對齊 stop-capture-sentinel.sh 的 sanitize_segment：
// 取路徑最後一段、非白名單字元換 _）。sanitizeSpoolSegment 是同一套邏輯的 TS 鏡像，
// 且 resolveCaptureSpoolPath 已用它產生 hook 寫入的 spool 目錄名，故與 DB projectId 對齊。
function projectIdFromCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return sanitizeSpoolSegment(base);
}

export async function runSessionStartInject(): Promise<void> {
  // 遞迴 capture 斷路器：抽取子程序（帶 CC_MEMORY_CAPTURE_CHILD）不得觸發注入。
  if (process.env.CC_MEMORY_CAPTURE_CHILD) {
    return;
  }
  // 注入預設關閉；非 on（unset/off/空）→ 立即返回，不連 DB。
  if (!injectRecentEnabled(process.env)) {
    return;
  }

  const payload = await readStdin();
  const cwd = parseCwd(payload);
  if (!cwd) {
    return;
  }
  const projectId = projectIdFromCwd(cwd);

  // config 動態 import：延到此處才載入，避免 flag off / 壞 JSON 路徑觸發 DATABASE_URL 解析。
  const { config } = await import('../src/config.js');
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');

  const client = postgres(config.databaseUrl, { max: 1, connect_timeout: 2, idle_timeout: 2 });
  try {
    const db = drizzle(client);
    const result = await buildRecentActivity(db, { projectId });
    const output = buildSessionStartOutput(result);
    if (output) {
      process.stdout.write(`${output}\n`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'run-session-start-inject';

if (isMain) {
  runSessionStartInject().catch(() => {
    // best-effort：吞掉所有錯誤，維持空 stdout、exit 0，不擋 session start。
    process.exitCode = 0;
  });
}
