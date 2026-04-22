// src/services/projects.ts
//
// 專案 ID 解析（5 層）+ listProjects + projectExists。
// 所有 service 都 call resolveProjectId()，確保跨裝置同 repo 解析出一致 id。
//
// 5 層優先序：
//   1. explicit（函式參數傳入，來自 MCP tool / HTTP query / Telegram /setproj 等）
//   2. env CC_MEMORY_PROJECT_ID（容器 / CI / 單機手動覆蓋 **server cwd** 解析）
//   3. CLAUDE.md 中的 <!-- cc-memory: project="..." --> 標記
//   4. git origin remote → owner/repo
//   5. basename(cwd)
//
// cwdIsExplicit=true（codex review round 20 P1）：呼叫者主動送 project_path 時
// 跳過 layer 2 env，用 path 往下找 marker / git / basename。
// 理由：env 的角色是「server 不知道自己在哪」的 fallback；caller 明確送 path
// = 已知答案，env 不該覆蓋掉答案造成跨 project misroute。

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { eq, ne, and, sql } from 'drizzle-orm';
import { projectMemories, tasks } from '../db/schema.js';
import { resolveRepoName } from '../utils/repo-name.js';
import type { DbClient } from './types.js';

type ReadFileSyncFn = (path: string) => string;
type ResolveRepoNameFn = (cwd: string) => string | null;

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
  /** DI hooks；production 預設為 fs.readFileSync / resolveRepoName */
  readFileSyncFn?: ReadFileSyncFn;
  resolveRepoNameFn?: ResolveRepoNameFn;
}

function nonEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function tryReadClaudeMdMarker(cwd: string, readFn: ReadFileSyncFn): string | null {
  try {
    const content = readFn(join(cwd, 'CLAUDE.md'));
    const match = content.match(/<!--\s*cc-memory:\s*project="([^"]+)"\s*-->/);
    if (match) return match[1];
  } catch {
    // CLAUDE.md 不存在或不可讀，往下 fallback
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
    resolveRepoNameFn = resolveRepoName,
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
  const lvl3 = nonEmpty(tryReadClaudeMdMarker(cwd, readFileSyncFn));
  if (lvl3) return lvl3;

  // layer 4: git origin → owner/repo
  const lvl4 = nonEmpty(resolveRepoNameFn(cwd));
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
      .where(eq(projectMemories.status, 'active')),
    db
      .selectDistinct({ projectId: tasks.projectId })
      .from(tasks)
      .where(ne(tasks.status, 'cancelled')),
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
