/**
 * keyword 搜尋共用：把查詢字串拆成關鍵字，產生 SQL 端的 ILIKE 條件與「命中幾個關鍵字」分數。
 *
 * 2026-10-23 前 keyword 模式是「先抓最新 N 筆、再在 JS 裡 includes 過濾」，超過幾天前的主題一律查不到
 * （盲測 Q4／Q8 資料都在 DB 卻搜不到）。改成在 DB 端掃整個範圍後，這裡負責：
 * - 切詞、去重、數量上限（防長句或貼上的 log 把掃描成本乘上 K 倍）
 * - ILIKE 跳脫（`%`、`_`、`\`）
 * - 任一關鍵字命中即算命中（與舊 JS 過濾語意一致），但排序改用「命中的關鍵字個數」優先、
 *   再最新優先——否則多關鍵字查詢裡只要有一個常見短字（例：`B`），最新幾十筆就能塞滿 limit，
 *   真正命中多個詞的舊紀錄照樣出不來（Antigravity review 2026-10-23 high）。
 * - 不在 JS 先 toLowerCase：欄位與關鍵字都交給 PostgreSQL 的 lower() 折疊，兩邊各自折疊會在全形字母、
 *   特殊 Unicode 字元上出現「字面相同卻搜不到」（同 review low）。
 */
import { sql, type SQL } from 'drizzle-orm';

/** 一次查詢最多拿幾個關鍵字；超過的忽略，避免 K 個 ILIKE 把全表掃描成本放大。 */
export const MAX_KEYWORD_TERMS = 8;

/** 切詞：空白切開、去空字串、去重（保留順序）、最多 MAX_KEYWORD_TERMS 個。 */
export function keywordTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of query.split(/\s+/)) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_KEYWORD_TERMS) break;
  }
  return out;
}

/** ILIKE 的 `%`、`_`、`\` 必須跳脫，否則使用者打 `foo_bar` 會變成萬用字元。 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 每個關鍵字一個 `%term%`。 */
export function keywordLikePatterns(query: string): string[] {
  return keywordTerms(query).map((term) => `%${escapeLike(term)}%`);
}

export interface KeywordMatchSql {
  /** WHERE 用：任一關鍵字命中。 */
  where: SQL;
  /** 命中的關鍵字個數（整數，1..K）；ORDER BY 與 baseScore 用。 */
  hits: SQL<number>;
  /** 關鍵字總數 K。 */
  total: number;
}

/**
 * 以 haystack（呼叫端已用 lower() 折疊、串好的文字欄位運算式）產生 WHERE 條件與命中數。
 * pattern 也交給 PostgreSQL 的 lower() 折疊，兩邊同一套規則，不在 JS 先 toLowerCase。
 * 用 LIKE 而非 ILIKE：ILIKE 每筆每個關鍵字都重做多位元組大小寫折疊，實測慢 3 倍。
 * 沒有關鍵字時回 null（呼叫端維持「不過濾、最新優先」）。
 */
export function keywordMatchSql(haystack: SQL, query: string): KeywordMatchSql | null {
  const patterns = keywordLikePatterns(query);
  if (patterns.length === 0) return null;
  const tests = patterns.map((pattern) => sql`(${haystack} LIKE lower(${pattern}))`);
  const where = sql.join(tests, sql` OR `);
  const hits = sql<number>`(${sql.join(
    tests.map((t) => sql`(CASE WHEN ${t} THEN 1 ELSE 0 END)`),
    sql` + `
  )})`;
  return { where: sql`(${where})`, hits, total: patterns.length };
}
