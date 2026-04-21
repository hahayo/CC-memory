// src/tools/search.ts
//
// v0.3 Stage 1 Track M：實作搬到 src/services/memories.ts。
//
// 注意：service 層的 searchMemories 回傳 SearchResultEnvelope（含 rankingMeta / queryContext）。
// 為避免破壞 pre-v0.2 的 mock 測試（tests/tools/search.test.ts 期望回 Memory[]），
// 這個 tools 入口保留 legacy 簽章：薄適配層解包 envelope.results。
// Stage 2 MCP handler rewire 會直接 import services/memories.js 以存取完整 envelope。

import type { Memory } from '../db/schema.js';
import type { DbClient, SearchMemoriesInput, SearchResultEnvelope } from '../services/types.js';
import { searchMemories as searchMemoriesEnvelope } from '../services/memories.js';

export type { SearchMemoriesInput as SearchInput } from '../services/types.js';
export type { SearchMode } from '../services/types.js';

/**
 * Legacy 適配：回 Memory[]；新 code 應直接 import
 * `searchMemories` from `src/services/memories.js` 取完整 envelope。
 */
export async function searchMemories(
  db: DbClient,
  input: SearchMemoriesInput
): Promise<Memory[]> {
  const envelope: SearchResultEnvelope = await searchMemoriesEnvelope(db, input);
  return envelope.results;
}
