// scripts/run-session-start-inject.ts — SessionStart 注入 CLI（薄殼）。
//
// 流程：讀 hook payload JSON（stdin，欄位 cwd）→ resolveProjectIdDetailed（CLAUDE.md marker
//   → git 根目錄名；與 MCP server／capture hooks 同一套規則）→ 只在命中 marker／git-root
//   時繼續（非 git 且無 marker 的目錄一律不注入，避免 /tmp/CC-memory 這類撞名目錄把真正
//   專案的近期活動注進來）→ 安全讀 ~/.ccm-project-url 當 DSN → 查 Recent Activity → 渲染
//   → 印 SessionStart hook protocol JSON。
//
// DSN 來源（2026-09-03 inject-fix，Codex 審查硬性條件 1–3）：
//   - 不 import src/config.ts（它開頭 `import 'dotenv/config'`，會把 hook 殼刻意 unset 的
//     CC_FORCE_PROJECT_ID／DATABASE_URL_PERSONAL 從 .env 復活），也不看 process.env.DATABASE_URL。
//   - 一律以 readSecureMode0600RegularFile 讀 ~/.ccm-project-url（no-follow、fstat regular、
//     mode 0600），內容 trim 後非空才連線；任何失敗 → 不注入。
//
// 全程 best-effort（盡力而為）：任何錯誤（flag off / 壞 JSON / URL 檔異常 / DB 連不上 /
// builder throw）一律「空 stdout、exit 0」，絕不擋 session start。
//
// 依賴可注入（InjectDeps）：讓測試證明「真的把 cwd 以 cwdIsExplicit:true 餵給 resolver」
// 以及「非 git 目錄時不開 DB」，而不是只驗空 stdout。

import { homedir } from 'node:os';
import path from 'node:path';
import { buildRecentActivity, type RecentActivityResult } from '../src/services/recent-activity.js';
import {
  resolveProjectIdDetailed,
  type ResolveProjectIdInput,
  type ResolvedProjectId,
} from '../src/services/projects.js';
import {
  buildSessionStartOutput,
  resolveInjectTokenBudget,
} from '../src/services/session-start-inject.js';
import type { DbClient } from '../src/services/types.js';
import { readSecureMode0600RegularFile } from '../src/utils/secure-file.js';

const PROJECT_URL_FILE_NAME = '.ccm-project-url';

export interface InjectDbHandle {
  db: DbClient;
  end: () => Promise<void>;
}

export interface InjectDeps {
  env: Record<string, string | undefined>;
  readPayload: () => Promise<string>;
  resolveProject: (input: ResolveProjectIdInput) => ResolvedProjectId;
  readProjectUrl: () => Promise<string>;
  openDb: (databaseUrl: string) => Promise<InjectDbHandle>;
  fetchRecentActivity: (
    db: DbClient,
    input: { projectId: string; tokenBudget?: number }
  ) => Promise<RecentActivityResult>;
  writeOutput: (line: string) => void;
}

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

export function parseCwd(payload: string): string | null {
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

/** 安全讀 ~/.ccm-project-url：0600 regular file、trim 後非空；否則 throw（呼叫端視為不注入）。 */
export async function readSecureProjectUrl(homeDir: string = homedir()): Promise<string> {
  const filePath = path.join(homeDir, PROJECT_URL_FILE_NAME);
  const value = (await readSecureMode0600RegularFile(filePath, 'project database url file')).trim();
  if (!value) {
    throw new Error(`project database url file is empty: ${filePath}`);
  }
  return value;
}

async function openPostgresDb(databaseUrl: string): Promise<InjectDbHandle> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 2,
    // 已連上但查詢卡住時 fail-fast（session-start 阻塞只剩外層 hook timeout 兜底）
    connection: { statement_timeout: 3000 },
  });
  return {
    db: drizzle(client),
    end: () => client.end().catch(() => undefined),
  };
}

const DEFAULT_DEPS: InjectDeps = {
  env: process.env,
  readPayload: readStdin,
  resolveProject: resolveProjectIdDetailed,
  readProjectUrl: () => readSecureProjectUrl(),
  openDb: openPostgresDb,
  fetchRecentActivity: buildRecentActivity,
  writeOutput: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

/** 只有 marker／git-root 兩層算「真的解析到 repo」；其餘（cwd basename 撞名）不注入。 */
export function isInjectableProjectSource(resolved: ResolvedProjectId): boolean {
  return resolved.source === 'marker' || resolved.source === 'git-root';
}

export async function runSessionStartInject(overrides: Partial<InjectDeps> = {}): Promise<void> {
  const deps: InjectDeps = { ...DEFAULT_DEPS, ...overrides };

  // 遞迴 capture 斷路器：抽取子程序（帶 CC_MEMORY_CAPTURE_CHILD）不得觸發注入。
  if (deps.env.CC_MEMORY_CAPTURE_CHILD) {
    return;
  }
  // 注入預設關閉；非 on（unset/off/空）→ 立即返回，不連 DB。
  if (!injectRecentEnabled(deps.env)) {
    return;
  }

  const payload = await deps.readPayload();
  const cwd = parseCwd(payload);
  if (!cwd) {
    return;
  }

  // cwdIsExplicit:true：hook payload 的 cwd 就是答案，跳過 env CC_MEMORY_PROJECT_ID 層
  // （hook 殼另已 unset，此處是第二道）。
  const resolved = deps.resolveProject({ cwd, cwdIsExplicit: true });
  if (!isInjectableProjectSource(resolved)) {
    return;
  }

  // DSN：只信 ~/.ccm-project-url（安全讀法），不看繼承的 DATABASE_URL。讀不到 → 不注入。
  const databaseUrl = await deps.readProjectUrl();

  const handle = await deps.openDb(databaseUrl);
  try {
    const result = await deps.fetchRecentActivity(handle.db, {
      projectId: resolved.projectId,
      tokenBudget: resolveInjectTokenBudget(deps.env),
    });
    const output = buildSessionStartOutput(result);
    if (output) {
      deps.writeOutput(output);
    }
  } finally {
    await handle.end();
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
