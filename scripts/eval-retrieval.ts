#!/usr/bin/env npx tsx
// scripts/eval-retrieval.ts
//
// Phase 5-A retrieval eval 報表。從 search_feedback 表產生 3 區塊 markdown：
//   1. 每日查詢數（queries / distinct_projects）
//   2. Mode 分佈（14 天總覽）
//   3. 結果穩定度（Jaccard of adjacent runs, per-project）
//
// 用法：
//   DATABASE_URL=postgres://... npx tsx scripts/eval-retrieval.ts > reports/retrieval-eval-$(date +%F).md
//
// 選擇：直接用 `postgres` raw SQL，不拉 drizzle（script 不該為跑報表拖整包 ORM）。

import postgres from 'postgres';

const CONN =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgres://test:test@localhost:5433/cc_memory_test';

const DAYS = 14;

type DailyRow = { date: string; queries: number; distinct_projects: number };
type ModeRow = { mode: string; count: number; pct: number };
type JaccardRow = { project_id: string; avg_jaccard: number; samples: number };

function pct(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 100);
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 1;
  return inter / union;
}

async function fetchDaily(
  sql: ReturnType<typeof postgres>
): Promise<DailyRow[]> {
  // 用 server 的 current_date 避免時區漂移；cast project_id IS NOT NULL 才算 distinct
  const rows = await sql<
    { date: string; queries: string; distinct_projects: string }[]
  >`
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
      COUNT(*)::text AS queries,
      COUNT(DISTINCT query_project_id) FILTER (WHERE query_project_id IS NOT NULL)::text AS distinct_projects
    FROM search_feedback
    WHERE created_at >= NOW() - (${DAYS}::int || ' days')::interval
    GROUP BY 1
    ORDER BY 1 DESC
  `;
  return rows.map((r) => ({
    date: r.date,
    queries: Number(r.queries),
    distinct_projects: Number(r.distinct_projects),
  }));
}

async function fetchModes(
  sql: ReturnType<typeof postgres>
): Promise<ModeRow[]> {
  const rows = await sql<{ mode: string; count: string }[]>`
    SELECT mode, COUNT(*)::text AS count
    FROM search_feedback
    WHERE created_at >= NOW() - (${DAYS}::int || ' days')::interval
    GROUP BY mode
    ORDER BY COUNT(*) DESC
  `;
  const total = rows.reduce((acc, r) => acc + Number(r.count), 0);
  return rows.map((r) => ({
    mode: r.mode,
    count: Number(r.count),
    pct: pct(Number(r.count), total),
  }));
}

async function fetchJaccard(
  sql: ReturnType<typeof postgres>
): Promise<JaccardRow[]> {
  // group by (query, projectId, mode)；按 created_at ASC 排序；相鄰 2 次計 Jaccard。
  // 用 result_ids::text[]（pg uuid[] → string[]）。
  // 群組 key 納入 limit + filter_type，避免同 query 不同 limit / filter
  // 被錯當同一組比 Jaccard（codex review round 17 P3）：
  //   - limit=5 → limit=20 即使 top-5 一致，limit=20 的聯集會被稀釋
  //   - filter_type='decision' vs no filter 結果集本就不同
  const rows = await sql<
    {
      query_project_id: string;
      query: string;
      mode: string;
      limit: number;
      filter_type: string | null;
      result_ids: string[];
    }[]
  >`
    SELECT
      query_project_id,
      query,
      mode,
      "limit"::int AS "limit",
      filter_type,
      (result_ids)::text[] AS result_ids
    FROM search_feedback
    WHERE created_at >= NOW() - (${DAYS}::int || ' days')::interval
      AND query_project_id IS NOT NULL
    ORDER BY query_project_id, query, mode, "limit", filter_type NULLS LAST, created_at ASC
  `;

  // group by (query_project_id, query, mode)，相鄰比對
  const perProject = new Map<
    string,
    { sum: number; samples: number }
  >();
  let prevKey: string | null = null;
  let prevIds: string[] | null = null;
  for (const r of rows) {
    // NULL cross-project rows 已由 SQL WHERE 過濾掉（穩定度無意義）；
    // 能走到這裡的 row 保證 query_project_id 非 null（codex review round 5 P2）。
    const projectKey = r.query_project_id!;
    // 納入 limit + filter_type 進 group key（codex review round 17 P3）
    const key = `${projectKey}\0${r.query}\0${r.mode}\0${r.limit}\0${r.filter_type ?? ''}`;
    if (key === prevKey && prevIds) {
      const j = jaccard(prevIds, r.result_ids);
      const cur = perProject.get(projectKey) ?? { sum: 0, samples: 0 };
      cur.sum += j;
      cur.samples += 1;
      perProject.set(projectKey, cur);
    }
    prevKey = key;
    prevIds = r.result_ids;
  }

  const out: JaccardRow[] = [];
  for (const [project_id, { sum, samples }] of perProject) {
    if (samples === 0) continue;
    out.push({
      project_id,
      avg_jaccard: sum / samples,
      samples,
    });
  }
  out.sort((a, b) => b.samples - a.samples || a.project_id.localeCompare(b.project_id));
  return out;
}

function renderDaily(rows: DailyRow[]): string {
  if (rows.length === 0) {
    return '| Date | queries | distinct_projects |\n|---|---|---|\n| (no data) | 0 | 0 |';
  }
  const header = '| Date | queries | distinct_projects |\n|---|---|---|';
  const body = rows
    .map((r) => `| ${r.date} | ${r.queries} | ${r.distinct_projects} |`)
    .join('\n');
  return `${header}\n${body}`;
}

function renderModes(rows: ModeRow[]): string {
  if (rows.length === 0) {
    return '| mode | count | pct |\n|---|---|---|\n| (no data) | 0 | 0% |';
  }
  const header = '| mode | count | pct |\n|---|---|---|';
  const body = rows
    .map((r) => `| ${r.mode} | ${r.count} | ${r.pct}% |`)
    .join('\n');
  return `${header}\n${body}`;
}

function renderJaccard(rows: JaccardRow[]): string {
  if (rows.length === 0) {
    return (
      '| project_id | avg_jaccard | samples |\n|---|---|---|\n' +
      '| (no adjacent runs found) | N/A | 0 |'
    );
  }
  const header = '| project_id | avg_jaccard | samples |\n|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| ${r.project_id} | ${r.avg_jaccard.toFixed(2)} | ${r.samples} |`
    )
    .join('\n');
  return `${header}\n${body}`;
}

async function main(): Promise<void> {
  const sql = postgres(CONN, { max: 1, idle_timeout: 2 });
  try {
    const [daily, modes, jacc] = await Promise.all([
      fetchDaily(sql),
      fetchModes(sql),
      fetchJaccard(sql),
    ]);

    const now = new Date().toISOString();
    const out = [
      `# Retrieval Eval Report`,
      ``,
      `生成時間：${now}  資料範圍：最近 ${DAYS} 天`,
      ``,
      `## 1. 每日查詢數（per day）`,
      ``,
      renderDaily(daily),
      ``,
      `## 2. Mode 分佈（${DAYS} 天總覽）`,
      ``,
      renderModes(modes),
      ``,
      `## 3. 結果穩定度（Jaccard of adjacent runs）`,
      ``,
      `演算：\`group by (query, projectId, mode)\`，同組內按 created_at ASC 排序，`,
      `相鄰兩次 result_ids 計 Jaccard similarity = |A∩B| / |A∪B|；取 project 平均。`,
      ``,
      renderJaccard(jacc),
      ``,
      `## Phase B 指標（待 Phase B 實裝）`,
      ``,
      `- 接受率（accept rate）：N/A（待 Phase B 加 selected_id 更新 handler）`,
      `- Top-1 命中率：N/A（待 Phase B 加 selected_rank = 1 比率）`,
      `- 撤銷率（undo rate）：N/A（待 Phase B 加 thumbs=down / rollback 追蹤）`,
      ``,
    ].join('\n');

    // stdout，呼叫端自行 redirect
    // eslint-disable-next-line no-console
    console.log(out);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('eval-retrieval failed:', err);
  process.exit(1);
});
