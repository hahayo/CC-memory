// scripts/lib/benchmark-runner.ts
//
// Pure helpers for the v0.5 M6 benchmark harness. CLI wiring lives in
// scripts/benchmark-v05.ts; this file stays read-only and side-effect free.

import postgres from 'postgres';

const PERSONAL_NAMESPACE = '__personal__';
const DEFAULT_REAL_QUERY_LIMIT = 5;
const DEFAULT_REAL_QUERY_DAYS = 7;

export type PgSql = ReturnType<typeof postgres>;
export type BenchmarkSource = 'fixed' | 'real';
// 實際 effectiveMode 標籤（可能是 'hybrid'/'keyword'/'semantic' 或混合如 'hybrid+keyword'）
export type CcSearchModeLabel = string;

export interface ClaudeMemSearchRow {
  id: string;
  title: string;
}

export interface RealQuerySample {
  query: string;
  projectId: string | null;
  createdAt: Date;
  resultProjectIds: string[];
}

export interface CcMemoryReportRow {
  rank: number;
  id: string;
  summary: string;
  score: number | null;
}

export interface ClaudeMemReportRow {
  rank: number;
  id: string;
  title: string;
}

export interface DrillDownReport {
  timelineNeighborCount: number;
  checkedCount: number;
  factsNonEmptyCount: number;
  filesNonEmptyCount: number;
  error?: string;
}

export interface BenchmarkReportQuery {
  query: string;
  source: BenchmarkSource;
  projectId: string | null;
  expectedIntent?: string;
  notes?: string;
  ccMemoryTop5: CcMemoryReportRow[];
  claudeMemTop5?: ClaudeMemReportRow[];
  claudeMemUnavailableReason?: string;
  drillDown: DrillDownReport;
}

export interface BenchmarkReportInput {
  generatedAt: Date;
  dbSource: string;
  worker: {
    available: boolean;
    status?: string;
    version?: string;
  };
  ccSearchMode: CcSearchModeLabel;
  realQueryCount: number;
  realQueryTarget?: number;
  queries: BenchmarkReportQuery[];
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith('|') && trimmed.endsWith('|')
    ? trimmed.slice(1, -1)
    : trimmed;
  const cells: string[] = [];
  let current = '';
  let escaping = false;

  for (const char of body) {
    if (escaping) {
      // 只把 `\|` 視為跳脫的管線；其他 backslash 序列原樣保留（如 C:\tmp、\b）
      current += char === '|' ? '|' : `\\${char}`;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  cells.push(current.trim());
  return cells;
}

function isMarkdownSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
}

function mergeExtraCells(
  cells: string[],
  expectedColumns: number,
  titleIndex: number
): string[] {
  if (cells.length <= expectedColumns || titleIndex < 0 || titleIndex >= expectedColumns) {
    return cells;
  }
  const extra = cells.length - expectedColumns;
  const before = cells.slice(0, titleIndex);
  const title = cells.slice(titleIndex, titleIndex + extra + 1).join(' | ').trim();
  const after = cells.slice(titleIndex + extra + 1);
  return [...before, title, ...after];
}

export function parseClaudeMemSearchText(text: string): ClaudeMemSearchRow[] {
  const foundMatch = text.trimStart().match(/^Found\s+(\d+)\b/i);
  const foundCount = foundMatch ? Number(foundMatch[1]) : null;
  // 回應含 "(x obs, y sessions, z prompts)" 明細時以 sessions 數為預期列數，
  // 否則退回 Found N（type=sessions 下兩者一致）。嚴格匹配明細括號格式，
  // 避免 query 文字本身含「N sessions」造成誤判
  const sessionsMatch = text.match(
    /\(\s*\d+\s+obs,\s*(\d+)\s+sessions?,\s*\d+\s+prompts?\s*\)/i
  );
  const expectedRows = sessionsMatch ? Number(sessionsMatch[1]) : foundCount;
  const rows: ClaudeMemSearchRow[] = [];
  let expectedColumns = 4;
  let titleIndex = 2;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const rawCells = splitMarkdownRow(trimmed);
    if (isMarkdownSeparator(rawCells)) continue;

    const headerTitleIndex = rawCells.findIndex((cell) => cell.trim().toLowerCase() === 'title');
    if (headerTitleIndex !== -1 && !/#S[0-9A-Za-z_-]+/.test(trimmed)) {
      expectedColumns = rawCells.length;
      titleIndex = headerTitleIndex;
      continue;
    }

    const idMatch = trimmed.match(/#S[0-9A-Za-z_-]+/);
    if (!idMatch) continue;

    const cells = mergeExtraCells(rawCells, expectedColumns, titleIndex);
    const title = cells[titleIndex]?.trim();
    if (!title) continue;
    rows.push({ id: idMatch[0], title });
  }

  // 部分解析（如 5 列只解出 3）同樣是格式漂移——靜默缺筆會讓三硬指標失真
  if (expectedRows !== null && rows.length < expectedRows) {
    throw new Error(
      `claude-mem search format drift: expected ${expectedRows} session rows but parsed ${rows.length}`
    );
  }
  return rows;
}

// 格式漂移 = harness 自身壞掉，呼叫端必須 fail 整支，不得吞成單組 query 的 unavailable
export function isClaudeMemFormatDriftError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('claude-mem search format drift');
}

export function assertNoPersonalProjectRefs(input: {
  label: string;
  projectId?: string | null;
  resultProjectIds?: string[];
}): void {
  if (input.projectId?.includes(PERSONAL_NAMESPACE)) {
    throw new Error(
      `${input.label}: project scope contains forbidden ${PERSONAL_NAMESPACE} namespace`
    );
  }
  const badResult = input.resultProjectIds?.find((projectId) =>
    projectId.includes(PERSONAL_NAMESPACE)
  );
  if (badResult) {
    throw new Error(
      `${input.label}: result projectId contains forbidden ${PERSONAL_NAMESPACE} namespace`
    );
  }
}

export async function fetchRecentRealQueries(
  sql: PgSql,
  options: { limit?: number; days?: number } = {}
): Promise<RealQuerySample[]> {
  const limit = options.limit ?? DEFAULT_REAL_QUERY_LIMIT;
  const days = options.days ?? DEFAULT_REAL_QUERY_DAYS;
  const rows = await sql<
    {
      query: string;
      projectId: string | null;
      createdAt: Date;
      resultProjectIds: string[];
    }[]
  >`
    WITH latest_per_query AS (
      SELECT DISTINCT ON (query)
        query,
        query_project_id AS "projectId",
        created_at AS "createdAt",
        result_project_ids::text[] AS "resultProjectIds"
      FROM search_feedback
      WHERE created_at >= NOW() - (${days}::int || ' days')::interval
        AND (query_project_id IS NULL OR query_project_id <> ${PERSONAL_NAMESPACE})
      ORDER BY query, created_at DESC
    )
    SELECT query, "projectId", "createdAt", "resultProjectIds"
    FROM latest_per_query
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => {
    assertNoPersonalProjectRefs({
      label: `search_feedback query "${row.query}"`,
      projectId: row.projectId,
      resultProjectIds: row.resultProjectIds,
    });
    return row;
  });
}

export function databaseHostPortLabel(conn: string): string {
  try {
    const url = new URL(conn);
    const port = url.port || (url.protocol.startsWith('postgres') ? '5432' : '');
    return port ? `${url.hostname}:${port}` : url.hostname;
  } catch {
    return '(invalid DATABASE_URL)';
  }
}

function escapeCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
}

function table(headers: string[], rows: unknown[][]): string {
  const header = `| ${headers.map(escapeCell).join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function workerLabel(worker: BenchmarkReportInput['worker']): string {
  if (!worker.available) return 'worker 不可用';
  const status = worker.status ?? 'available';
  return worker.version ? `${status}（version: ${worker.version}）` : status;
}

function projectScopeLabel(projectId: string | null): string {
  return projectId ?? '全專案';
}

function renderCcRows(rows: CcMemoryReportRow[]): string {
  if (rows.length === 0) {
    return table(['rank', 'memory id', 'summary 前 80 字', 'score'], [['', '(no rollup)', '', '']]);
  }
  return table(
    ['rank', 'memory id', 'summary 前 80 字', 'score'],
    rows.map((row) => [
      row.rank,
      row.id,
      truncateText(row.summary, 80),
      row.score === null ? 'N/A' : row.score.toFixed(4),
    ])
  );
}

function renderClaudeRows(query: BenchmarkReportQuery): string {
  if (query.claudeMemUnavailableReason) {
    return table(
      ['rank', '#S id', 'title'],
      [['', 'worker 不可用', query.claudeMemUnavailableReason]]
    );
  }
  const rows = query.claudeMemTop5 ?? [];
  if (rows.length === 0) {
    return table(['rank', '#S id', 'title'], [['', '(no sessions)', '']]);
  }
  return table(
    ['rank', '#S id', 'title'],
    rows.map((row) => [row.rank, row.id, row.title])
  );
}

function renderDrillDown(drillDown: DrillDownReport): string {
  const base =
    `timeline 鄰接數：${drillDown.timelineNeighborCount}；` +
    `getObservations 佐證：facts 非空 ${drillDown.factsNonEmptyCount}/${drillDown.checkedCount}，` +
    `files 非空 ${drillDown.filesNonEmptyCount}/${drillDown.checkedCount}`;
  return drillDown.error ? `${base}；error：${drillDown.error}` : base;
}

export function renderBenchmarkReport(input: BenchmarkReportInput): string {
  const generatedAt = input.generatedAt.toISOString();
  const realTarget = input.realQueryTarget ?? DEFAULT_REAL_QUERY_LIMIT;
  const realLine =
    input.realQueryCount < realTarget
      ? `真實 query 抽樣結果：真實 query 僅 ${input.realQueryCount} 組（目標 ${realTarget} 組，不硬湊）`
      : `真實 query 抽樣結果：${input.realQueryCount} 組`;

  const sections = input.queries.map((query, index) => {
    const lines = [
      `## Query ${index + 1}: ${query.query}`,
      '',
      `- query 文字：${query.query}`,
      `- 來源：${query.source}`,
      `- project scope：${projectScopeLabel(query.projectId)}`,
    ];
    if (query.source === 'fixed') {
      lines.push(`- expected_intent：${query.expectedIntent ?? ''}`);
      lines.push(`- notes：${query.notes ?? ''}`);
    }
    lines.push(
      '',
      '### CC-memory rollup Top-5',
      '',
      renderCcRows(query.ccMemoryTop5),
      '',
      '### claude-mem Top-5',
      '',
      renderClaudeRows(query),
      '',
      '### Drill-down 佐證',
      '',
      renderDrillDown(query.drillDown)
    );
    return lines.join('\n');
  });

  const summaryRows = input.queries.map((query) => [query.query, '', '', '', '']);

  return [
    '# CC-memory v0.5 M6 Benchmark Report',
    '',
    `產生時間：${generatedAt}`,
    `DB 來源：${input.dbSource}`,
    `claude-mem worker：${workerLabel(input.worker)}`,
    `CC-memory search mode：${input.ccSearchMode}`,
    realLine,
    '',
    '## AGPL-3.0 紅線聲明',
    '',
    '本 benchmark 對 claude-mem 僅做唯讀對照查詢（HTTP interface 層），不複製其原始碼／prompt／schema；資料讀取 ≠ 程式碼衍生。',
    '',
    ...sections.flatMap((section) => [section, '']),
    '## 匯總表',
    '',
    table(
      [
        'query',
        'Top-5 交集數【人工】',
        'CC first-relevant rank【人工】',
        'claude-mem first-relevant rank【人工】',
        '錯抓數【人工】',
      ],
      summaryRows
    ),
    '',
    '## 標註指引',
    '',
    '- **Top-5 交集**：兩邊 Top-5 中指向同一工作事件／主題的結果算交集 1（跨系統 id 不同，以內容對應為準）',
    '- **first-relevant rank**：該側 Top-5 中第一個命中 expected_intent（真實 query 則以 query 語意）的 rank；全未命中記 `-`',
    '- **錯抓**：該側 Top-5 中與 query 明顯無關的結果數；錯抓率 = 全部組的錯抓數合計 ÷ 全部組的結果數合計',
    '',
    '## 三硬指標匯總（人工標註後填寫）',
    '',
    table(
      ['指標', '門檻', '值【人工】', '判定【人工】'],
      [
        ['Top-5 交集 ≥3 的組數 / 總組數', '≥7/10', '', ''],
        ['平均 first-relevant rank（CC vs claude-mem）', 'CC ≤ claude-mem', '', ''],
        ['錯抓率', '<10%', '', ''],
      ]
    ),
    '',
    '本輪只建 harness；正式評測與 Go/No-Go 判定需併用 ≥14 天且 ≥30 筆 auto rollup/observation（~2026-07-21 後）',
    '',
  ].join('\n');
}
