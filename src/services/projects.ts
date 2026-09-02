// src/services/projects.ts
//
// 專案 ID 解析（5 層）+ listProjects + projectExists。
// 所有 service 都 call resolveProjectId()，確保跨裝置同 repo 解析出一致 id。
//
// 5 層優先序：
//   1. explicit（函式參數傳入，來自 MCP tool / HTTP query / Telegram /setproj 等）
//   2. env CC_MEMORY_PROJECT_ID（容器 / CI / 單機手動覆蓋 **server cwd** 解析）
//   3. CLAUDE.md 中的 <!-- cc-memory: project="..." --> 標記
//   4. git repo root basename（2026-09-02 起；舊為 git origin owner/repo）
//   5. basename(cwd)
//
// cwdIsExplicit=true（codex review round 20 P1）：呼叫者主動送 project_path 時
// 跳過 layer 2 env，用 path 往下找 marker / git / basename。
// 理由：env 的角色是「server 不知道自己在哪」的 fallback；caller 明確送 path
// = 已知答案，env 不該覆蓋掉答案造成跨 project misroute。

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { eq, ne, and, notInArray, sql } from 'drizzle-orm';
import { projectMemories, tasks } from '../db/schema.js';
import { RESERVED_PROJECT_IDS } from './scope-policy.js';
import type { DbClient } from './types.js';

// 保留 namespace（如 __personal__）不出現在一般專案清單（隱私邊界方向 2 防禦縱深）。
const RESERVED_PROJECT_ID_LIST: string[] = [...RESERVED_PROJECT_IDS];

type ReadFileSyncFn = (path: string) => string;
type ExistsSyncFn = (path: string) => boolean;

export interface ResolveProjectIdInput {
  explicit?: string | null;
  cwd?: string;
  /**
   * cwd 是否來自 caller 明示（codex review round 20 P1）。
   * true → 跳過 env layer，因為 caller 已明確表達「從這個 path 解析」；
   * false（預設）→ 套完整 5 層（env 可 override cwd-derived lookup）。
   */
  cwdIsExplicit?: boolean;
  /** 允許測試 override env；production code 應不傳此參數 */
  envOverride?: string | null;
  /** DI hooks；production 預設為 fs.readFileSync / fs.existsSync */
  readFileSyncFn?: ReadFileSyncFn;
  existsSyncFn?: ExistsSyncFn;
}

function nonEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

const WALK_UP_MAX_DEPTH = 64; // 防 symlink 循環或奇怪 path

function findRepoRoot(
  cwd: string,
  existsFn: ExistsSyncFn,
  readFn: ReadFileSyncFn
): string | null {
  // 從 cwd 往上找第一個「真正的 git repo」目錄；找不到回 null。
  // 判定條件：.git/HEAD 存在（正常 clone/init）或 .git 是 worktree pointer 檔案。
  // 空 .git 目錄（如環境殘留）不算合法 repo root。
  let current = cwd;
  for (let i = 0; i < WALK_UP_MAX_DEPTH; i++) {
    if (existsFn(join(current, '.git', 'HEAD'))) return current;
    // worktree：.git 是檔案內容以 'gitdir:' 開頭
    try {
      const content = readFn(join(current, '.git'));
      if (content.trimStart().startsWith('gitdir:')) return current;
    } catch {
      // .git 不存在或不可讀 → 非 repo root
    }
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
  return null;
}

function tryReadClaudeMdMarker(
  cwd: string,
  readFn: ReadFileSyncFn,
  existsFn: ExistsSyncFn
): string | null {
  // CLAUDE.md marker 只在 repo 內有效。演進：
  //   - codex round 21 P2：caller 常從 repo subdirectory 呼叫；只讀 ${cwd}/CLAUDE.md
  //     會漏 repo-root marker → 加 walk-up 往上找。
  //   - codex round 22 P1：walk-up 無邊界會撿 `~/CLAUDE.md` / monorepo 父目錄 marker
  //     → 碰到 `.git` 的 repo root 停止。
  //   - codex round 23 P1：cwd 不在 git repo 內時（例 `~/scratch/demo`），walk-up
  //     仍會一路走到 `~/CLAUDE.md` → 把 demo 解成陌生 project。修法：先找 repo
  //     root；找不到 repo root（非 git 目錄）→ marker 完全不適用，回 null 讓
  //     layer 4/5 fallback 接手。
  const repoRoot = findRepoRoot(cwd, existsFn, readFn);
  if (repoRoot === null) return null;

  // 在 [cwd, repoRoot] 範圍內逐層讀 CLAUDE.md，找 marker
  let current = cwd;
  for (let i = 0; i < WALK_UP_MAX_DEPTH; i++) {
    try {
      const content = readFn(join(current, 'CLAUDE.md'));
      const match = content.match(/<!--\s*cc-memory:\s*project="([^"]+)"\s*-->/);
      if (match) return match[1];
    } catch {
      // CLAUDE.md 不存在 / 不可讀 → 往上一層
    }
    if (current === repoRoot) break; // 到 repo root 停止（不越出）
    const parent = dirname(current);
    if (parent === current) break; // 理論上不會到（repoRoot 已限制），防禦性保留
    current = parent;
  }
  return null;
}

function basenameOf(cwd: string): string {
  // 支援 Windows 路徑
  const normalized = cwd.replace(/\\/g, '/');
  return basename(normalized);
}

/**
 * 同步 5 層解析。故意做 sync 版本：
 *   - MCP handler 裡好 call，不要逼每個呼叫者 await
 *   - readFile / git 都是本地 I/O，< 10ms，不值得 async
 */
export function resolveProjectId(input: ResolveProjectIdInput = {}): string {
  const {
    explicit,
    cwd = process.cwd(),
    cwdIsExplicit = false,
    envOverride,
    readFileSyncFn = (p: string) => readFileSync(p, 'utf-8'),
    existsSyncFn = existsSync,
  } = input;

  // layer 1: explicit
  const lvl1 = nonEmpty(explicit);
  if (lvl1) return lvl1;

  // layer 2: env（caller 送明示 path 時跳過；codex review round 20 P1）
  if (!cwdIsExplicit) {
    const envSource = envOverride !== undefined ? envOverride : process.env.CC_MEMORY_PROJECT_ID;
    const lvl2 = nonEmpty(envSource);
    if (lvl2) return lvl2;
  }

  // layer 3: CLAUDE.md marker
  const lvl3 = nonEmpty(tryReadClaudeMdMarker(cwd, readFileSyncFn, existsSyncFn));
  if (lvl3) return lvl3;

  // layer 4: git repo root basename（2026-09-02 使用者拍板：取代舊的 git origin owner/repo 層，
  // 與 hooks/capture-common.sh resolve_project_id 一致——無 marker 時 repo 內任何子目錄都解析成同一 id；
  // 跨裝置一致性改靠 CLAUDE.md marker 或相同 clone 目錄名）
  const repoRoot = findRepoRoot(cwd, existsSyncFn, readFileSyncFn);
  const lvl4 = repoRoot === null ? null : nonEmpty(basenameOf(repoRoot));
  if (lvl4) return lvl4;

  // layer 5: basename(cwd)
  return basenameOf(cwd);
}

// ---------------------------------------------------------------------------
// DB helpers — listProjects / projectExists
// ---------------------------------------------------------------------------

/**
 * 回專案 ID union（memories.active + tasks.status != cancelled），已 dedup + 排序。
 */
export async function listProjects(db: DbClient): Promise<string[]> {
  const [memRows, taskRows] = await Promise.all([
    db
      .selectDistinct({ projectId: projectMemories.projectId })
      .from(projectMemories)
      .where(
        and(
          eq(projectMemories.status, 'active'),
          notInArray(projectMemories.projectId, RESERVED_PROJECT_ID_LIST)
        )
      ),
    db
      .selectDistinct({ projectId: tasks.projectId })
      .from(tasks)
      .where(
        and(
          ne(tasks.status, 'cancelled'),
          notInArray(tasks.projectId, RESERVED_PROJECT_ID_LIST)
        )
      ),
  ]);

  const set = new Set<string>();
  for (const r of memRows as Array<{ projectId: string }>) set.add(r.projectId);
  for (const r of taskRows as Array<{ projectId: string }>) set.add(r.projectId);
  return Array.from(set).sort();
}

/**
 * 檢查 projectId 是否在 memories（active）或 tasks（非 cancelled）中存在。
 */
export async function projectExists(db: DbClient, projectId: string): Promise<boolean> {
  const [memExists, taskExists] = await Promise.all([
    db
      .select({ one: sql`1` })
      .from(projectMemories)
      .where(and(eq(projectMemories.projectId, projectId), eq(projectMemories.status, 'active')))
      .limit(1),
    db
      .select({ one: sql`1` })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), ne(tasks.status, 'cancelled')))
      .limit(1),
  ]);
  return (memExists as unknown[]).length > 0 || (taskExists as unknown[]).length > 0;
}
