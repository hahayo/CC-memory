// src/utils/repo-name.ts
import { execFileSync } from 'node:child_process';

/**
 * 從 git remote URL 解析出 `owner/repo` 格式。
 *
 * 支援：
 *   - https://github.com/owner/repo(.git)
 *   - git@github.com:owner/repo(.git)
 *   - scp-like / ssh-like 其他 host
 *
 * 策略：去掉 .git 尾綴、用 `/` 或 `:` 切，取最後兩段；少於兩段回 null。
 * 回傳 owner/repo 而非單獨 repo，避免 fork vs upstream / 不同 org 同名 repo 漂移。
 */
export function parseRepoOwnerRepoFromRemoteUrl(url: string): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s) return null;

  // 去除尾端 .git（含 trailing slash 後再去）
  s = s.replace(/\/+$/, '');
  if (s.endsWith('.git')) s = s.slice(0, -4);

  let path: string;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const schemeEnd = s.indexOf('://');
    const rest = s.slice(schemeEnd + 3);
    const firstSlash = rest.indexOf('/');
    if (firstSlash < 0) return null;
    path = rest.slice(firstSlash + 1);
  } else if (/^[^/\s]+@[^/\s:]+:/.test(s)) {
    // scp-like ssh: user@host:owner/repo → 取 first colon 後
    const colonIdx = s.indexOf(':');
    path = s.slice(colonIdx + 1);
  } else if (s.startsWith('ssh://') || s.startsWith('git://')) {
    const schemeEnd = s.indexOf('://');
    const rest = s.slice(schemeEnd + 3);
    const firstSlash = rest.indexOf('/');
    if (firstSlash < 0) return null;
    path = rest.slice(firstSlash + 1);
  } else {
    // 其餘格式（裸路徑 /srv/git/foo.git、相對路徑 ../mirror/foo.git 等）
    // 都不是可跨裝置穩定的 owner/repo → 回 null，讓 resolveProjectId
    // 走下一層 basename fallback（codex review round 6 P2）
    return null;
  }

  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // 保留 host 後的完整 path，避免把 group-a/sub/repo 跟 group-b/sub/repo
  // 都壓成 sub/repo（codex review round 16 P1）。
  // 合法字元僅 [A-Za-z0-9._-]，否則視為不可信輸入 → null
  for (const p of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(p)) return null;
  }
  return parts.join('/');
}

/**
 * 從工作目錄的 git origin remote 解析出 `owner/repo`。
 * 非 git / 無 origin / 解析失敗皆回 null（讓 project_id fallback 到下一層）。
 *
 * 注意：一律用 origin，不猜 upstream；fork vs upstream 由 client 的 origin 決定。
 */
export function resolveRepoName(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 2000,
    });
    return parseRepoOwnerRepoFromRemoteUrl(output);
  } catch {
    return null;
  }
}
