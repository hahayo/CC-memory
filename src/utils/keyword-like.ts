/**
 * keyword 搜尋共用：把查詢字串拆成關鍵字，轉成 SQL ILIKE pattern（任一關鍵字命中即算命中）。
 *
 * 2026-10-23 前 keyword 模式是「先抓最新 N 筆、再在 JS 裡 includes 過濾」，超過幾天前的主題一律查不到
 * （盲測 Q4／Q8 資料都在 DB 卻搜不到）。改成在 DB 端用 ILIKE 掃整個專案後，這裡負責 pattern 的跳脫。
 */

/** 與舊 JS 過濾相同的切詞：小寫、空白切開、去空字串。 */
export function keywordTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** ILIKE 的 `%`、`_`、`\` 必須跳脫，否則使用者打 `foo_bar` 會變成萬用字元。 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 每個關鍵字一個 `%term%`；呼叫端用 OR 串起來。 */
export function keywordLikePatterns(query: string): string[] {
  return keywordTerms(query).map((term) => `%${escapeLike(term)}%`);
}
