// scripts/lib/evidence-guards.ts
//
// 檢索證據評測的安全檢查：輸出目錄不可落在 repo（含同 repo 的其他 worktree）、
// 向量端點必須是本機、錯誤只留類別與錯誤碼。

import { realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// 路徑
// ---------------------------------------------------------------------------

/** child 是否等於 parent 或在 parent 底下（兩者都應是絕對路徑）。用路徑片段判斷，`..bench` 這種名字不算往上。 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * 對「已存在的最近上層目錄」做 realpath，再接回還不存在的尾段。
 * 這樣 repo 外的符號連結指回 repo 內時，比對的是真實位置。
 */
export async function realpathNearestExisting(target: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') {
        throw err;
      }
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** `git rev-parse --git-common-dir` 的輸出 → 共用 .git 所屬的主目錄（非 .git 結尾就回 common dir 本身）。 */
export function mainWorktreeFromCommonDir(commonDir: string, cwd: string): string {
  const absolute = resolve(cwd, commonDir);
  return basename(absolute) === '.git' ? dirname(absolute) : absolute;
}

/** `git worktree list --porcelain` 的輸出 → 所有 worktree 路徑。 */
export function parseWorktreeList(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((path) => path.length > 0);
}

/** 回傳 out 落在哪個受保護目錄底下（out 與 roots 都先 realpath）；沒有就 null。 */
export async function findProtectedRoot(out: string, roots: readonly string[]): Promise<string | null> {
  const realOut = await realpathNearestExisting(out);
  for (const root of roots) {
    const realRoot = await realpathNearestExisting(root);
    if (isPathInside(realOut, realRoot)) return root;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 向量端點
// ---------------------------------------------------------------------------

/** 只有 loopback 算本機：127.0.0.0/8、::1、localhost。 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.split('.')[0] === '127';
  if (isIP(host) === 6) return host === '::1';
  return false;
}

export interface EndpointInfo {
  /** 主機加連接埠，不含帳密與路徑；解析失敗為 '(無法解析)' */
  host: string;
  loopback: boolean;
}

export function describeLocalEndpoint(url: string): EndpointInfo {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, loopback: isLoopbackHostname(parsed.hostname) };
  } catch {
    return { host: '(無法解析)', loopback: false };
  }
}

// ---------------------------------------------------------------------------
// 錯誤
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /^[A-Za-z0-9_]{1,60}$/;
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
/** Node 系統錯誤碼（ECONNREFUSED 等），只是固定代號，不含查詢內容 */
const ERRNO_RE = /^E[A-Z]{2,20}$/;

/**
 * 錯誤只留類別名稱＋（若有）PostgreSQL 錯誤碼或 Node 系統錯誤碼，不轉存 message：
 * Drizzle 的錯誤訊息會帶查詢參數。沿 cause 往下找錯誤碼（最多 5 層）。
 */
export function safeErrorLabel(err: unknown): string {
  const rawName = err instanceof Error ? err.name : typeof err;
  const name = IDENTIFIER_RE.test(rawName) ? rawName : 'Error';
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && (SQLSTATE_RE.test(code) || ERRNO_RE.test(code))) return `${name} (code=${code})`;
    current = (current as { cause?: unknown }).cause;
  }
  return name;
}
