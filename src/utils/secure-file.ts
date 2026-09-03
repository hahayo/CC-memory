// src/utils/secure-file.ts
//
// 憑證類本地檔（~/.ccm-project-url、production approval marker、embedding key file）
// 的安全讀法，供 scripts/run-auto-capture-supervisor.ts 與 scripts/run-session-start-inject.ts
// 共用——單一實作，避免兩套弱檢查各自漂移（2026-09-03 inject-fix Codex 審查硬性條件 3）。
//
// 檢查順序（對已開啟的 fd 做，不 TOCTOU）：
//   1. O_NOFOLLOW 開檔：路徑本身是 symlink → ELOOP → 拒絕。
//   2. fstat：必須是 regular file（目錄／FIFO／裝置檔拒絕）。
//   3. mode 必須恰為 0600（group/other 可讀一律拒絕）。
// 內容不 trim、不檢查非空——由呼叫端依語意決定。

import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function readSecureMode0600RegularFile(filePath: string, label: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must be a regular file (symlinks are not accepted)`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file (symlinks are not accepted)`);
    }
    const mode = metadata.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `${label} must have mode 0600 (actual: ${mode.toString(8).padStart(4, '0')})`
      );
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
