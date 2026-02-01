// src/utils/project-id.ts
import { readFile } from 'fs/promises';
import { basename, join } from 'path';

type ReadFileFn = (path: string) => Promise<string>;

/**
 * 從工作目錄取得專案 ID
 * 優先順序：
 * 1. CLAUDE.md 中的 <!-- cc-memory: project="xxx" --> 標記
 * 2. 目錄名稱
 */
export async function getProjectId(
  workingDir: string,
  readFileFn: ReadFileFn = (p) => readFile(p, 'utf-8')
): Promise<string> {
  try {
    // 嘗試讀取 CLAUDE.md
    const claudeMdPath = join(workingDir, 'CLAUDE.md');
    const content = await readFileFn(claudeMdPath);

    // 解析 <!-- cc-memory: project="xxx" --> 標記
    const match = content.match(/<!--\s*cc-memory:\s*project="([^"]+)"\s*-->/);
    if (match) {
      return match[1];
    }
  } catch {
    // CLAUDE.md 不存在，繼續 fallback
  }

  // Fallback: 使用目錄名稱（支援 Unix 和 Windows 路徑）
  // 處理 Windows 路徑分隔符
  const normalizedPath = workingDir.replace(/\\/g, '/');
  return basename(normalizedPath);
}
