// src/services/session-start-inject.ts
//
// v0.5 M4 4c — SessionStart 注入渲染核心（純函式，可單元測試，不碰 DB）。
// 把 Recent Activity builder 結果渲染成注入文字索引，再包成 Claude Code
// SessionStart hook protocol（協議）JSON。
//
// 注入污染防線（injection pollution defense）：渲染文字必含字面 marker（標記）
// `source=cc-memory-inject`；capture worker 看到含此字串的 transcript 行會整行排除，
// 避免注入索引被下輪抽取又存成 observation（見 docs/auto-capture-v0.5/plan.md
// §Injection Pollution Defense）。
//
// 本檔刻意「不」呼叫 recordSearchQuery、「不」import feedback 模組——注入是唯讀
// 消費端（read-only consumer），不得寫 search telemetry（搜尋遙測）。

import type { RecentActivityResult } from './recent-activity.js';

/** 注入污染防線 marker：capture worker 過濾含此字串的 transcript 行。 */
export const INJECT_SOURCE_MARKER = 'source=cc-memory-inject';

const SESSION_START_HOOK_EVENT = 'SessionStart';

export interface SessionStartHookOutput {
  hookSpecificOutput: {
    hookEventName: typeof SESSION_START_HOOK_EVENT;
    additionalContext: string;
  };
}

/**
 * 把 Recent Activity 結果渲染成注入文字索引。
 * - 必含字面 marker `source=cc-memory-inject`（污染防線識別用）。
 * - 每列：id / updated_at / observation count / discovery_tokens / summary excerpt。
 * - 不含 observation narrative（敘事）全文——builder 本就只帶輕索引，render 亦只吐索引欄位。
 * - rows 空 → 回空字串（呼叫端據此決定 stdout 什麼都不印）。
 */
export function renderRecentActivityContext(result: RecentActivityResult): string {
  if (!result || result.rows.length === 0) {
    return '';
  }
  const header = `<cc-memory recent activity> ${INJECT_SOURCE_MARKER} project=${result.projectId}`;
  const lines = result.rows.map(
    (row) =>
      `- [${row.id}] updated=${row.updatedAt} observations=${row.observationCount} discovery_tokens=${row.discoveryTokens} :: ${row.summaryExcerpt}`
  );
  return [header, ...lines].join('\n');
}

/**
 * 組 Claude Code SessionStart hook protocol JSON 字串。
 * 渲染文字為空 → 回 null（呼叫端據此 stdout 什麼都不印）。
 */
export function buildSessionStartOutput(result: RecentActivityResult): string | null {
  const additionalContext = renderRecentActivityContext(result);
  if (additionalContext.length === 0) {
    return null;
  }
  const output: SessionStartHookOutput = {
    hookSpecificOutput: {
      hookEventName: SESSION_START_HOOK_EVENT,
      additionalContext,
    },
  };
  return JSON.stringify(output);
}
