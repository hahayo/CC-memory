// src/services/feedback.ts
//
// Phase 5-A retrieval signal：cc_memory_search 每次呼叫都被動寫一筆
// search_feedback 9 欄 row。MCP handler 只要把 searchMemories 回傳的
// SearchResultEnvelope 整顆傳進來，不需要自行拼欄位。
//
// 設計要點：
//   1. 吃整個 envelope，caller 不得拆欄位 → 防 `mode: requestedMode` 這種 bug
//   2. service 層早失敗 assertion（長度對齊），DB CHECK 是第二道防線
//   3. 不 throw DB 層例外（例如 CHECK 觸發）— 讓 caller 自行 handle；
//      但對「MCP handler 拼錯 envelope」這種邏輯 bug，service 層就直接 throw
//      InvalidArgumentError 讓測試 / 上層看到。

import { searchFeedback } from '../db/schema.js';
import { InvalidArgumentError } from './errors.js';
import type { DbClient, SearchResultEnvelope } from './types.js';

/**
 * 被動記錄一次 search 的完整上下文（query / mode / ranked results）。
 *
 * 預期 caller（MCP / HTTP / Telegram handler）在成功執行 searchMemories
 * 之後「fire and forget」呼叫本函式；但為了讓 Phase A 測試能斷言，
 * 本函式回 Promise<void>，失敗會 throw，由 caller 決定是否 swallow。
 */
export async function recordSearchQuery(
  db: DbClient,
  envelope: SearchResultEnvelope
): Promise<void> {
  const { results, effectiveMode, rankingMeta, queryContext } = envelope;
  const n = results.length;

  // ---- early-fail assertions ----
  // rankPositions 長度必須對齊 results（DB CHECK 也會擋，但 service 層先擋訊息更清楚）
  if (rankingMeta.rankPositions.length !== n) {
    throw new InvalidArgumentError(
      `recordSearchQuery: rankPositions length (${rankingMeta.rankPositions.length}) does not match results length (${n})`,
      {
        resultsLength: n,
        rankPositionsLength: rankingMeta.rankPositions.length,
      }
    );
  }
  // scores 非 null 時長度必須對齊
  if (
    rankingMeta.scores !== null &&
    rankingMeta.scores.length !== n
  ) {
    throw new InvalidArgumentError(
      `recordSearchQuery: scores length (${rankingMeta.scores.length}) does not match results length (${n})`,
      {
        resultsLength: n,
        scoresLength: rankingMeta.scores.length,
      }
    );
  }

  const resultIds = results.map((r) => r.id);
  const resultProjectIds = results.map((r) => r.projectId);

  // 保險再檢一次（若未來 results 型別膨脹，這條仍然保護 DB）
  if (resultProjectIds.length !== n) {
    throw new InvalidArgumentError(
      `recordSearchQuery: resultProjectIds length mismatch`,
      {
        resultsLength: n,
        resultProjectIdsLength: resultProjectIds.length,
      }
    );
  }

  await db.insert(searchFeedback).values({
    query: queryContext.query,
    querySurface: queryContext.querySurface,
    queryProjectId: queryContext.projectId,
    // 使用 envelope.effectiveMode（真正執行的 mode），不是 requestedMode
    mode: effectiveMode,
    limit: queryContext.limit,
    resultIds,
    resultProjectIds,
    rankPositions: rankingMeta.rankPositions,
    scores: rankingMeta.scores,
    // type filter（session / decision / null）— 讓 eval 能區分不同 filter 的 runs
    filterType: queryContext.filterType,
  });
}
