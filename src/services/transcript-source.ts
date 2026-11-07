/**
 * transcript（對話紀錄檔）來源讀取：原檔不在時改讀同名 `.zst`（zstd 壓縮檔）。
 *
 * 背景（2026-11-08）：Codex CLI 會把舊的 rollout 對話檔壓成 `<path>.jsonl.zst` 並刪掉原檔
 * （~/.codex/sessions 下 2026-10-27 至 10-31 已壓 8,500 多個，之後仍會持續），worker 只認 `.jsonl`
 * 就把 1,772 場對話當成「對話檔不見了」寫成死信。這裡集中處理「原檔 → 壓縮檔」的退路，
 * worker（capture-worker）、死信重放（replay-dead-letters）共用同一份邏輯。
 *
 * 安全邊界：壓縮檔只接受 regular file（lstat，不跟隨 symlink），解壓上限
 * MAX_DECOMPRESSED_TRANSCRIPT_BYTES，超過或格式壞掉一律回 null（呼叫端照「來源不可用」處理）。
 */

import { lstat, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { zstdDecompress as zstdDecompressCb } from 'node:zlib';

export const COMPRESSED_TRANSCRIPT_SUFFIX = '.zst';
/** 實測最大 Codex rollout 解壓後約 20 MB；512 MiB 留足夠餘裕又擋住惡意壓縮炸彈。 */
export const MAX_DECOMPRESSED_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

/** Node ≥ 22.15 才有內建 zstd；舊版（engines 仍允許 20）沒有退路，一律當成「壓縮檔讀不到」。 */
const zstdDecompress = typeof zstdDecompressCb === 'function' ? promisify(zstdDecompressCb) : null;

export function compressedTranscriptPath(path: string): string {
  return `${path}${COMPRESSED_TRANSCRIPT_SUFFIX}`;
}

/** 只讀壓縮檔 `<path>.zst`；不存在、不是 regular file、解壓失敗或超過上限都回 null。 */
export async function readCompressedTranscript(path: string): Promise<Buffer | null> {
  if (!zstdDecompress) return null;
  const compressedPath = compressedTranscriptPath(path);
  try {
    const info = await lstat(compressedPath);
    if (!info.isFile()) return null;
    const compressed = await readFile(compressedPath);
    return await zstdDecompress(compressed, { maxOutputLength: MAX_DECOMPRESSED_TRANSCRIPT_BYTES });
  } catch {
    return null;
  }
}

/** 先讀原檔；讀不到（已刪、無權限）才退到 `<path>.zst`。兩者都沒有回 null。 */
export async function readTranscriptSource(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return readCompressedTranscript(path);
  }
}

/** 來源目前的位元組長度：原檔用 stat，壓縮檔要解壓後才知道；兩者都沒有回 null。 */
export async function transcriptSourceLength(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    const buffer = await readCompressedTranscript(path);
    return buffer ? buffer.length : null;
  }
}
