// scripts/lib/benchmark-runner.ts
//
// Shared evidence helpers for the v0.5 M6 benchmark harness. CLI wiring lives in
// scripts/benchmark-v05.ts; DB and credential reads are explicit at the call sites.

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const PERSONAL_NAMESPACE = '__personal__';
const DEFAULT_REAL_QUERY_LIMIT = 5;
const DEFAULT_REAL_QUERY_DAYS = 7;
const FIXED_QUERY_TARGET = 5;

export const BENCHMARK_REPORT_STATUS_LINES = {
  partial: '評測狀態：PARTIAL — 不得用於 Go/No-Go',
  pendingHumanAnnotation: '評測狀態：PENDING HUMAN ANNOTATION — 尚未完成 Go/No-Go',
} as const;

export type PgSql = ReturnType<typeof postgres>;
export type BenchmarkSource = 'fixed' | 'real';
// 實際 effectiveMode 標籤（可能是 'hybrid'/'keyword'/'semantic' 或混合如 'hybrid+keyword'）
export type CcSearchModeLabel = string;

export interface ClaudeMemSearchRow {
  id: string;
  title: string;
  projectId?: string;
}

export interface RealQuerySample {
  query: string;
  projectId: string | null;
  createdAt: Date;
  resultProjectIds: string[];
  querySurface: 'mcp';
  mode: string;
}

export interface EmbeddingCoverage {
  scope: 'all-active-non-personal';
  projectCount: number;
  activeTotal: number;
  embeddedTotal: number;
}

export interface EmbeddingCredentialEvidence {
  source: 'explicit-key-file';
  pathLabel: string;
  mode: '0600';
  modifiedAt: string;
  fingerprint: string;
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
  projectId: string;
}

export interface DrillDownReport {
  timelineNeighborCount: number;
  checkedCount: number;
  factsNonEmptyCount: number;
  filesNonEmptyCount: number;
  error?: string;
  legalEmptyReason?: string;
}

export type RollupDrillDownClassification =
  | { kind: 'available' }
  | { kind: 'legal-empty' }
  | { kind: 'inconsistent'; reason: string };

export function classifyRollupDrillDown(input: {
  metadata: unknown;
  activeObservationCount: number;
}): RollupDrillDownClassification {
  if (input.activeObservationCount > 0) return { kind: 'available' };
  const metadata = input.metadata;
  const capture = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).capture
    : undefined;
  const observationIds = capture && typeof capture === 'object'
    ? (capture as Record<string, unknown>).observation_ids
    : undefined;
  if (Array.isArray(observationIds) && observationIds.length === 0) {
    return { kind: 'legal-empty' };
  }
  return {
    kind: 'inconsistent',
    reason: 'rollup metadata does not prove an empty observation_ids set while DB has zero active observations',
  };
}

export interface BenchmarkReportQuery {
  query: string;
  source: BenchmarkSource;
  projectId: string | null;
  expectedIntent?: string;
  notes?: string;
  realQueryProvenance?: {
    querySurface: 'mcp';
    originalMode: string;
    sampledAt: Date;
  };
  ccMemoryTop5: CcMemoryReportRow[];
  claudeMemTop5?: ClaudeMemReportRow[];
  claudeMemUnavailableReason?: string;
  claudeMemScopeVerified?: boolean;
  claudeMemExcludedCount?: number;
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
  embeddingCoverage?: EmbeddingCoverage;
  embeddingCredential?: EmbeddingCredentialEvidence;
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

export function parseClaudeMemSearchText(
  text: string,
  options: { requestLimit?: number } = {}
): ClaudeMemSearchRow[] {
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
  let projectIndex = -1;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const rawCells = splitMarkdownRow(trimmed);
    if (isMarkdownSeparator(rawCells)) continue;

    const headerTitleIndex = rawCells.findIndex((cell) => cell.trim().toLowerCase() === 'title');
    if (headerTitleIndex !== -1 && !/#S[0-9A-Za-z_-]+/.test(trimmed)) {
      expectedColumns = rawCells.length;
      titleIndex = headerTitleIndex;
      projectIndex = rawCells.findIndex((cell) => cell.trim().toLowerCase() === 'project');
      continue;
    }

    const idMatch = trimmed.match(/#S[0-9A-Za-z_-]+/);
    if (!idMatch) continue;

    const cells = mergeExtraCells(rawCells, expectedColumns, titleIndex);
    const title = cells[titleIndex]?.trim();
    if (!title) continue;
    const projectId = projectIndex >= 0 ? cells[projectIndex]?.trim() : undefined;
    rows.push({
      id: idMatch[0],
      title,
      ...(projectId ? { projectId } : {}),
    });
  }

  // 部分解析（如 5 列只解出 3）同樣是格式漂移——靜默缺筆會讓三硬指標失真
  const requiredRows = expectedRows === null
    ? null
    : Math.min(expectedRows, options.requestLimit ?? expectedRows);
  if (requiredRows !== null && rows.length < requiredRows) {
    throw new Error(
      `claude-mem search format drift: expected ${requiredRows} session rows but parsed ${rows.length}`
    );
  }
  return rows;
}

export function scopeClaudeMemRows(
  rows: ClaudeMemSearchRow[],
  projectId: string | null,
  options: { resultLimit?: number; candidateLimit?: number } = {}
):
  | { verified: true; rows: ClaudeMemSearchRow[]; excludedCount: number }
  | { verified: false; rows: []; reason: string } {
  if (!projectId) {
    return {
      verified: false,
      rows: [],
      reason: 'claude-mem project scope cannot be proven for an unscoped query',
    };
  }
  if (rows.some((row) => !row.projectId)) {
    return {
      verified: false,
      rows: [],
      reason: 'claude-mem response has no verifiable Project column',
    };
  }
  const scopedRows = rows.filter((row) => row.projectId === projectId);
  const resultLimit = options.resultLimit ?? 5;
  const candidateLimit = options.candidateLimit ?? 50;
  if (rows.length >= candidateLimit && scopedRows.length < resultLimit) {
    return {
      verified: false,
      rows: [],
      reason:
        `claude-mem candidate window saturated at ${candidateLimit} but only ` +
        `${scopedRows.length}/${resultLimit} scoped rows were found`,
    };
  }
  return {
    verified: true,
    rows: scopedRows,
    excludedCount: rows.length - scopedRows.length,
  };
}

export async function resolveClaudeMemProjectScopes(
  rows: ClaudeMemSearchRow[],
  lookupProject: (sessionId: number) => Promise<string | null>
): Promise<ClaudeMemSearchRow[]> {
  return Promise.all(rows.map(async (row) => {
    if (row.projectId) return row;
    const match = row.id.match(/^#S(\d+)$/);
    if (!match) {
      throw new Error(`claude-mem session id cannot be scoped: ${row.id}`);
    }
    const projectId = await lookupProject(Number(match[1]));
    if (!projectId) {
      throw new Error(`claude-mem session ${row.id} detail has no project`);
    }
    return { ...row, projectId };
  }));
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
  options: { limit?: number; days?: number; excludeQueries?: string[] } = {}
): Promise<RealQuerySample[]> {
  const limit = options.limit ?? DEFAULT_REAL_QUERY_LIMIT;
  const days = options.days ?? DEFAULT_REAL_QUERY_DAYS;
  const excludeQueries = options.excludeQueries ?? [];
  const rows = await sql<
    {
      query: string;
      projectId: string | null;
      createdAt: Date | string;
      resultProjectIds: string[];
      querySurface: 'mcp';
      mode: string;
    }[]
  >`
    WITH latest_per_query AS (
      SELECT DISTINCT ON (query)
        query,
        query_project_id AS "projectId",
        created_at AS "createdAt",
        result_project_ids::text[] AS "resultProjectIds",
        query_surface AS "querySurface",
        mode
      FROM search_feedback
      WHERE created_at >= NOW() - (${days}::int || ' days')::interval
        AND query_surface = 'mcp'
        AND query_project_id IS NOT NULL
        AND query_project_id <> ${PERSONAL_NAMESPACE}
        AND NOT (query = ANY(${excludeQueries}::text[]))
      ORDER BY query, created_at DESC
    )
    SELECT query, "projectId", "createdAt", "resultProjectIds", "querySurface", mode
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
    const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error(`search_feedback query "${row.query}" has an invalid created_at timestamp`);
    }
    return { ...row, createdAt };
  });
}

export async function fetchEmbeddingCoverage(
  sql: PgSql
): Promise<EmbeddingCoverage> {
  const rows = await sql<
    { projectId: string; corpus: string; activeTotal: number; embeddedTotal: number }[]
  >`
    SELECT
      project_id AS "projectId",
      'project_memories' AS corpus,
      COUNT(*)::int AS "activeTotal",
      COUNT(embedding)::int AS "embeddedTotal"
    FROM project_memories
    WHERE status = 'active' AND project_id <> ${PERSONAL_NAMESPACE}
    GROUP BY project_id
    UNION ALL
    SELECT
      project_id AS "projectId",
      'observations' AS corpus,
      COUNT(*)::int AS "activeTotal",
      COUNT(embedding)::int AS "embeddedTotal"
    FROM observations
    WHERE status = 'active' AND project_id <> ${PERSONAL_NAMESPACE}
    GROUP BY project_id
  `;
  return {
    scope: 'all-active-non-personal',
    projectCount: new Set(rows.map((row) => row.projectId)).size,
    activeTotal: rows.reduce((sum, row) => sum + row.activeTotal, 0),
    embeddedTotal: rows.reduce((sum, row) => sum + row.embeddedTotal, 0),
  };
}

export async function loadBenchmarkEmbeddingCredential(
  keyFile: string,
  userHome: string
): Promise<{ apiKey: string; evidence: EmbeddingCredentialEvidence }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(keyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('embedding key file must be a regular file (symlinks are not accepted)');
    }
    throw err;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error('embedding key file must be a regular file (symlinks are not accepted)');
    }
    const mode = metadata.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`embedding key file must have mode 0600 (actual: ${mode.toString(8).padStart(4, '0')})`);
    }
    const apiKey = (await handle.readFile('utf8')).trim();
    if (!apiKey) throw new Error('embedding key file is empty');
    const relativePath = path.relative(userHome, keyFile);
    const pathLabel = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
      ? `~/${relativePath}`
      : path.basename(keyFile);
    return {
      apiKey,
      evidence: {
        source: 'explicit-key-file',
        pathLabel,
        mode: '0600',
        modifiedAt: metadata.mtime.toISOString(),
        fingerprint: `sha256:${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`,
      },
    };
  } finally {
    await handle.close();
  }
}

export function isolateBenchmarkEmbeddingEnvironment(
  env: NodeJS.ProcessEnv,
  explicitApiKey?: string
): void {
  delete env.GEMINI_API_KEY;
  // src/config.ts imports dotenv/config. Force that import to read an empty source so
  // a repo .env or caller-provided DOTENV_CONFIG_PATH cannot silently restore an old key.
  env.DOTENV_CONFIG_PATH = '/dev/null';
  if (explicitApiKey) env.GEMINI_API_KEY = explicitApiKey;
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
      ['rank', '#S id', 'title', 'Project'],
      [['', '對照不可用', query.claudeMemUnavailableReason, 'unverified']]
    );
  }
  const rows = query.claudeMemTop5 ?? [];
  if (rows.length === 0) {
    return table(['rank', '#S id', 'title', 'Project'], [['', '(no sessions)', '', 'verified']]);
  }
  return table(
    ['rank', '#S id', 'title', 'Project'],
    rows.map((row) => [row.rank, row.id, row.title, row.projectId])
  );
}

function renderDrillDown(drillDown: DrillDownReport): string {
  const base =
    `timeline 鄰接數：${drillDown.timelineNeighborCount}；` +
    `getObservations 佐證：facts 非空 ${drillDown.factsNonEmptyCount}/${drillDown.checkedCount}，` +
    `files 非空 ${drillDown.filesNonEmptyCount}/${drillDown.checkedCount}`;
  if (drillDown.error) return `${base}；error：${drillDown.error}`;
  if (drillDown.legalEmptyReason) return `${base}；legal-empty：${drillDown.legalEmptyReason}`;
  return base;
}

export function renderBenchmarkReport(input: BenchmarkReportInput): string {
  const generatedAt = input.generatedAt.toISOString();
  const realTarget = input.realQueryTarget ?? DEFAULT_REAL_QUERY_LIMIT;
  const expectedQueryTotal = FIXED_QUERY_TARGET + realTarget;
  const fixedQueryCount = input.queries.filter((query) => query.source === 'fixed').length;
  const realQueryRows = input.queries.filter((query) => query.source === 'real').length;
  const unavailableComparisons = input.queries.filter(
    (query) => query.claudeMemUnavailableReason !== undefined
  ).length;
  const unverifiedComparisons = input.queries.filter(
    (query) => query.claudeMemUnavailableReason === undefined && query.claudeMemScopeVerified !== true
  ).length;
  const missingRealProvenance = input.queries.filter(
    (query) => query.source === 'real' && !query.realQueryProvenance
  ).length;
  const drillDownErrors = input.queries.filter((query) => query.drillDown.error).length;
  const completenessIssues: string[] = [];
  if (fixedQueryCount < FIXED_QUERY_TARGET) {
    completenessIssues.push(`缺少 ${FIXED_QUERY_TARGET - fixedQueryCount} 組固定 query`);
  }
  if (input.realQueryCount < realTarget) {
    completenessIssues.push(`缺少 ${realTarget - input.realQueryCount} 組近 7 日真實 query`);
  }
  if (realQueryRows !== input.realQueryCount) {
    completenessIssues.push(
      `報告中的真實 query 列數 ${realQueryRows} 與抽樣計數 ${input.realQueryCount} 不一致`
    );
  }
  if (input.queries.length !== expectedQueryTotal) {
    completenessIssues.push(`目前只有 ${input.queries.length}/${expectedQueryTotal} 組 query`);
  }
  if (!input.worker.available) {
    completenessIssues.push('claude-mem worker 不可用');
  } else if (unavailableComparisons > 0) {
    completenessIssues.push(`${unavailableComparisons} 組 claude-mem 對照查詢不可用`);
  }
  if (unverifiedComparisons > 0) {
    completenessIssues.push(`${unverifiedComparisons} 組 claude-mem project scope 未證明`);
  }
  if (missingRealProvenance > 0) {
    completenessIssues.push(`${missingRealProvenance} 組真實 query 缺少 MCP provenance`);
  }
  if (drillDownErrors > 0) {
    completenessIssues.push(`${drillDownErrors} 組 drill-down 佐證出錯`);
  }
  if (input.ccSearchMode !== 'hybrid') {
    completenessIssues.push(
      `CC-memory 查詢未全數使用 hybrid mode（實際：${input.ccSearchMode}）`
    );
  }
  if (!input.embeddingCoverage) {
    completenessIssues.push('缺少 benchmark project 的 embedding coverage 證據');
  } else if (input.embeddingCoverage.activeTotal === 0) {
    completenessIssues.push('benchmark project 沒有可驗證的 active corpus');
  } else if (input.embeddingCoverage.embeddedTotal !== input.embeddingCoverage.activeTotal) {
    completenessIssues.push(
      `embedding coverage 未達 100%（${input.embeddingCoverage.embeddedTotal}/${input.embeddingCoverage.activeTotal}）`
    );
  }
  if (!input.embeddingCredential) {
    completenessIssues.push('缺少顯式 embedding key file 的非機密證據');
  }
  const readinessLine = completenessIssues.length > 0
    ? BENCHMARK_REPORT_STATUS_LINES.partial
    : BENCHMARK_REPORT_STATUS_LINES.pendingHumanAnnotation;
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
      `- claude-mem scope evidence：${query.claudeMemScopeVerified ? `verified（跨專案候選排除 ${query.claudeMemExcludedCount ?? 0} 筆）` : 'unverified'}`,
    ];
    if (query.source === 'fixed') {
      lines.push(`- expected_intent：${query.expectedIntent ?? ''}`);
      lines.push(`- notes：${query.notes ?? ''}`);
    }
    if (query.source === 'real' && query.realQueryProvenance) {
      lines.push(`- query surface：${query.realQueryProvenance.querySurface}`);
      lines.push(`- 原始 search mode：${query.realQueryProvenance.originalMode}`);
      lines.push(`- 抽樣時間：${query.realQueryProvenance.sampledAt.toISOString()}`);
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
    `Embedding coverage：${input.embeddingCoverage ? `${input.embeddingCoverage.embeddedTotal}/${input.embeddingCoverage.activeTotal}（scope: ${input.embeddingCoverage.scope}; projects: ${input.embeddingCoverage.projectCount}）` : '未提供'}`,
    `Embedding credential：${input.embeddingCredential ? `${input.embeddingCredential.source} ${input.embeddingCredential.pathLabel} mode=${input.embeddingCredential.mode} mtime=${input.embeddingCredential.modifiedAt} ${input.embeddingCredential.fingerprint}` : '未提供'}`,
    realLine,
    ...(input.realQueryCount > 0
      ? ['真實 query 選樣限制：樣本來自近期實際 MCP 操作；操作者可能知道配額與驗收目的，人工標註者必須將此 self-selection caveat 納入判讀。']
      : []),
    readinessLine,
    ...(completenessIssues.length > 0
      ? [`不完整原因：${completenessIssues.join('；')}`]
      : ['下一步：人工標註三硬指標；未標註前不得判定 Go']),
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
    '只有報告達到 PENDING HUMAN ANNOTATION、併用 ≥14 天且累積 ≥30 筆 auto rollup/observation，並由人工完成三硬指標標註後，才能做 Go/No-Go 判定。',
    '',
  ].join('\n');
}
