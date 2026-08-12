// tests/scripts/v05-benchmark.test.ts
//
// v0.5 M6 6a — benchmark fixture parser RED tests. Pure file parsing, no DB.

import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseBenchmarkFixtures } from '../../scripts/lib/benchmark-fixtures.js';
import {
  fetchRecentRealQueries,
  fetchEmbeddingCoverage,
  isClaudeMemFormatDriftError,
  isolateBenchmarkEmbeddingEnvironment,
  classifyRollupDrillDown,
  loadBenchmarkEmbeddingCredential,
  parseClaudeMemSearchText,
  renderBenchmarkReport,
  resolveClaudeMemProjectScopes,
  scopeClaudeMemRows,
} from '../../scripts/lib/benchmark-runner.js';
import { connectTestDb, type Sql } from '../helpers/db.js';

const REPO_ROOT = process.cwd();
const FIXTURE_PATH = join(
  REPO_ROOT,
  'docs',
  'auto-capture-v0.5',
  'benchmark-fixtures.md'
);
const QUERIES = [
  'drizzle array 綁定 record 錯誤',
  'refine_delete 存在性洩漏',
  'estimator discovery tokens 校準',
  'ccm-project-url DSN 事故',
  'capture prompt injection 防護',
];
const VALIDATION_ERROR = /^Invalid benchmark fixtures:/;
const SQL_PREFIX = `v05-benchmark-${randomUUID().slice(0, 8)}`;

function readFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

describe('parseBenchmarkFixtures', () => {
  it('parses the real fixture file into five complete rows', () => {
    const fixtures = parseBenchmarkFixtures(readFixture());

    expect(fixtures).toHaveLength(5);
    for (const fixture of fixtures) {
      expect(typeof fixture.query).toBe('string');
      expect(fixture.query.trim().length).toBeGreaterThan(0);
      expect(typeof fixture.expectedIntent).toBe('string');
      expect(fixture.expectedIntent.trim().length).toBeGreaterThan(0);
      expect(typeof fixture.projectId).toBe('string');
      expect(fixture.projectId.trim().length).toBeGreaterThan(0);
      expect(typeof fixture.notes).toBe('string');
      expect(fixture.notes.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the project id and query order from the fixture table', () => {
    const fixtures = parseBenchmarkFixtures(readFixture());

    expect(fixtures.map((fixture) => fixture.projectId)).toEqual([
      'CC-memory',
      'CC-memory',
      'CC-memory',
      'CC-memory',
      'CC-memory',
    ]);
    expect(fixtures.map((fixture) => fixture.query)).toEqual(QUERIES);
  });

  it('rejects a table missing the notes column', () => {
    const markdown = [
      '| query | expected_intent | project_id |',
      '|---|---|---|',
      '| q | intent | CC-memory |',
    ].join('\n');

    expect(() => parseBenchmarkFixtures(markdown)).toThrow(VALIDATION_ERROR);
  });

  it('rejects an empty notes cell', () => {
    const markdown = [
      '| query | expected_intent | project_id | notes |',
      '|---|---|---|---|',
      '| q | intent | CC-memory |   |',
    ].join('\n');

    expect(() => parseBenchmarkFixtures(markdown)).toThrow(VALIDATION_ERROR);
  });

  it('rejects a table with unexpected header names', () => {
    const markdown = [
      '| query | intent | project_id | notes |',
      '|---|---|---|---|',
      '| q | intent | CC-memory | note |',
    ].join('\n');

    expect(() => parseBenchmarkFixtures(markdown)).toThrow(VALIDATION_ERROR);
  });

  it('rejects markdown without a table', () => {
    expect(() => parseBenchmarkFixtures('No benchmark fixture table here.')).toThrow(
      VALIDATION_ERROR
    );
  });

  it('preserves backslash sequences and only unescapes escaped pipes', () => {
    const markdown = [
      '| query | expected_intent | project_id | notes |',
      '|---|---|---|---|',
      '| C:\\tmp\\run.ps1 錯誤 | regex \\btoken\\b 修法 | CC-memory | 含跳脫管線 a\\|b |',
    ].join('\n');

    const [fixture] = parseBenchmarkFixtures(markdown);
    expect(fixture.query).toBe('C:\\tmp\\run.ps1 錯誤');
    expect(fixture.expectedIntent).toBe('regex \\btoken\\b 修法');
    expect(fixture.notes).toBe('含跳脫管線 a|b');
  });
});

describe('parseClaudeMemSearchText', () => {
  it('parses session ids and titles from a normal claude-mem markdown table', () => {
    const text = [
      'Found 2 sessions matching your query',
      '',
      '| Session | Score | Title | Project |',
      '|---|---:|---|---|',
      '| #S1234 | 0.91 | Drizzle array binding fix | CC-memory |',
      '| #S5678 | 0.82 | Refine delete guard | CC-memory |',
    ].join('\n');

    expect(parseClaudeMemSearchText(text)).toEqual([
      { id: '#S1234', title: 'Drizzle array binding fix', projectId: 'CC-memory' },
      { id: '#S5678', title: 'Refine delete guard', projectId: 'CC-memory' },
    ]);
  });

  it('returns an empty list for Found 0 responses', () => {
    expect(parseClaudeMemSearchText('Found 0 sessions matching your query')).toEqual([]);
  });

  it('throws when Found N is positive but no session rows can be parsed', () => {
    const text = [
      'Found 3 sessions matching your query',
      '',
      'The response format changed and no markdown rows are present.',
    ].join('\n');

    expect(() => parseClaudeMemSearchText(text)).toThrow(/claude-mem search format drift/i);
  });

  it('throws on partial parse drift (expected sessions count exceeds parsed rows)', () => {
    const text = [
      'Found 2 result(s) matching "q" (0 obs, 2 sessions, 0 prompts)',
      '',
      '| ID | Time | T | Title | Read |',
      '|---|---|---|---|---|',
      '| #S1 | 1:00 AM | X | Only one row parsed | - |',
    ].join('\n');

    expect(() => parseClaudeMemSearchText(text)).toThrow(/format drift.*expected 2.*parsed 1/i);
  });

  it('accepts a full request window when Found count describes more total matches', () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      `| #S${index + 1} | 1:00 AM | X | title-${index + 1} | - |`
    );
    const text = [
      'Found 120 result(s) matching "q" (0 obs, 120 sessions, 0 prompts)',
      '',
      '| ID | Time | T | Title | Read |',
      '|---|---|---|---|---|',
      ...rows,
    ].join('\n');

    expect(parseClaudeMemSearchText(text, { requestLimit: 50 })).toHaveLength(50);
  });

  it('classifies format drift errors for the CLI rethrow path', () => {
    expect(
      isClaudeMemFormatDriftError(new Error('claude-mem search format drift: expected 2'))
    ).toBe(true);
    expect(isClaudeMemFormatDriftError(new Error('HTTP 500'))).toBe(false);
    expect(isClaudeMemFormatDriftError('not-an-error')).toBe(false);
  });

  it('keeps a title containing pipe characters when the row has extra columns', () => {
    const text = [
      'Found 1 sessions matching your query',
      '',
      '| Session | Score | Title | Project |',
      '|---|---:|---|---|',
      '| #S42 | 0.77 | Title with raw | pipe text | CC-memory |',
    ].join('\n');

    expect(parseClaudeMemSearchText(text)).toEqual([
      { id: '#S42', title: 'Title with raw | pipe text', projectId: 'CC-memory' },
    ]);
  });

  it('keeps scope unverified when the response has no Project column', () => {
    const rows = parseClaudeMemSearchText([
      'Found 1 result(s) matching "q" (0 obs, 1 sessions, 0 prompts)',
      '',
      '| ID | Time | T | Title | Read |',
      '|---|---|---|---|---|',
      '| #S1 | 1:00 AM | X | Unknown scope | - |',
    ].join('\n'));

    expect(rows).toEqual([{ id: '#S1', title: 'Unknown scope' }]);
    expect(scopeClaudeMemRows(rows, 'CC-memory')).toMatchObject({
      verified: false,
      rows: [],
      reason: expect.stringContaining('Project'),
    });
  });

  it('drops cross-project claude-mem rows and proves scope from the Project column', () => {
    const scoped = scopeClaudeMemRows([
      { id: '#S1', title: 'right', projectId: 'CC-memory' },
      { id: '#S2', title: 'wrong', projectId: 'line_cards' },
    ], 'CC-memory');

    expect(scoped).toEqual({
      verified: true,
      rows: [{ id: '#S1', title: 'right', projectId: 'CC-memory' }],
      excludedCount: 1,
    });
  });

  it('refuses a saturated candidate window that cannot supply a scoped Top-5', () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `#S${index + 1}`,
      title: `row-${index + 1}`,
      projectId: index < 4 ? 'CC-memory' : 'other-project',
    }));

    expect(scopeClaudeMemRows(rows, 'CC-memory', { resultLimit: 5, candidateLimit: 50 }))
      .toMatchObject({ verified: false, reason: expect.stringContaining('saturated') });
  });

  it('resolves missing Project values through public session-detail ids before scoping', async () => {
    const lookedUp: number[] = [];
    const rows = await resolveClaudeMemProjectScopes([
      { id: '#S9544', title: 'right' },
      { id: '#S1234', title: 'wrong', projectId: 'line_cards' },
    ], async (sessionId) => {
      lookedUp.push(sessionId);
      return 'CC-memory';
    });

    expect(lookedUp).toEqual([9544]);
    expect(rows).toEqual([
      { id: '#S9544', title: 'right', projectId: 'CC-memory' },
      { id: '#S1234', title: 'wrong', projectId: 'line_cards' },
    ]);
  });
});

describe('renderBenchmarkReport', () => {
  it('renders the required benchmark skeleton and leaves manual scoring columns blank', () => {
    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-07-08T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: true, status: 'ok', version: '0.1.0' },
      ccSearchMode: 'keyword',
      realQueryCount: 1,
      realQueryTarget: 5,
      queries: [
        {
          query: 'drizzle array 綁定 record 錯誤',
          source: 'fixed',
          projectId: 'CC-memory',
          expectedIntent: '找到 drizzle array 綁定修法',
          notes: 'bugfix 意圖',
          ccMemoryTop5: [
            {
              rank: 1,
              id: '11111111-1111-4111-8111-111111111111',
              summary: 'Drizzle array binding fix summary',
              score: null,
            },
          ],
          claudeMemTop5: [{
            rank: 1,
            id: '#S1234',
            title: 'Drizzle array binding fix',
            projectId: 'CC-memory',
          }],
          drillDown: {
            timelineNeighborCount: 2,
            checkedCount: 2,
            factsNonEmptyCount: 1,
            filesNonEmptyCount: 1,
          },
        },
      ],
    });

    expect(report).toContain('產生時間：2026-07-08T00:00:00.000Z');
    expect(report).toContain('DB 來源：localhost:5433');
    expect(report).toContain('claude-mem worker：ok（version: 0.1.0）');
    expect(report).toContain('CC-memory search mode：keyword');
    expect(report).toContain('真實 query 僅 1 組');
    expect(report).toContain('評測狀態：PARTIAL — 不得用於 Go/No-Go');
    expect(report).toContain('缺少 4 組近 7 日真實 query');
    expect(report).toContain('目前只有 1/10 組 query');
    expect(report).toContain('AGPL-3.0 紅線聲明');
    expect(report).toContain('不複製其原始碼／prompt／schema');
    expect(report).toContain('| query | Top-5 交集數【人工】 | CC first-relevant rank【人工】 | claude-mem first-relevant rank【人工】 | 錯抓數【人工】 |');
    expect(report).toContain('| drizzle array 綁定 record 錯誤 |  |  |  |  |');
    expect(report).toContain('## 三硬指標匯總（人工標註後填寫）');
    expect(report).toContain('| 指標 | 門檻 | 值【人工】 | 判定【人工】 |');
    expect(report).toContain('| Top-5 交集 ≥3 的組數 / 總組數 | ≥7/10 |  |  |');
    expect(report).toContain('| 平均 first-relevant rank（CC vs claude-mem） | CC ≤ claude-mem |  |  |');
    expect(report).toContain('| 錯抓率 | <10% |  |  |');
    expect(report).toContain(
      '只有報告達到 PENDING HUMAN ANNOTATION、併用 ≥14 天且累積 ≥30 筆 auto rollup/observation'
    );
    expect(report).toContain('## 標註指引');
    expect(report).toContain('**Top-5 交集**');
    expect(report).toContain('同一工作事件／主題');
    expect(report).toContain('**first-relevant rank**');
    expect(report).toContain('expected_intent');
    expect(report).toContain('**錯抓**');
    expect(report).toContain('錯抓率 =');
  });

  it('keeps a machine-complete report pending until a human annotates the hard metrics', () => {
    const queries = Array.from({ length: 10 }, (_, index) => ({
      query: `query-${index + 1}`,
      source: index < 5 ? 'fixed' as const : 'real' as const,
      projectId: 'CC-memory',
      ccMemoryTop5: [],
      claudeMemTop5: [],
      claudeMemScopeVerified: true,
      ...(index >= 5
        ? {
            realQueryProvenance: {
              querySurface: 'mcp' as const,
              originalMode: 'hybrid',
              sampledAt: new Date(`2026-08-11T00:00:0${index - 5}.000Z`),
            },
          }
        : {}),
      drillDown: {
        timelineNeighborCount: 0,
        checkedCount: 0,
        factsNonEmptyCount: 0,
        filesNonEmptyCount: 0,
        ...(index === 0 ? { legalEmptyReason: 'spec-legal empty extraction' } : {}),
      },
    }));

    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: true, status: 'ok', version: '10.5.2' },
      ccSearchMode: 'hybrid',
      embeddingCoverage: {
        scope: 'all-active-non-personal',
        projectCount: 3,
        activeTotal: 100,
        embeddedTotal: 100,
      },
      embeddingCredential: {
        source: 'explicit-key-file',
        pathLabel: '~/.gemini-api-key',
        mode: '0600',
        modifiedAt: '2026-08-12T00:00:00.000Z',
        fingerprint: 'sha256:123456789abc',
      },
      realQueryCount: 5,
      realQueryTarget: 5,
      queries,
    });

    expect(report).toContain(
      '評測狀態：PENDING HUMAN ANNOTATION — 尚未完成 Go/No-Go'
    );
    expect(report).not.toContain('評測狀態：PARTIAL');
    expect(report).toContain('legal-empty：spec-legal empty extraction');
  });

  it('keeps hybrid partial unless every active row in the benchmark projects has an embedding', () => {
    const queries = Array.from({ length: 10 }, (_, index) => ({
      query: `query-${index + 1}`,
      source: index < 5 ? 'fixed' as const : 'real' as const,
      projectId: 'CC-memory',
      ccMemoryTop5: [],
      claudeMemTop5: [],
      drillDown: { timelineNeighborCount: 0, checkedCount: 0, factsNonEmptyCount: 0, filesNonEmptyCount: 0 },
    }));
    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: true },
      ccSearchMode: 'hybrid',
      embeddingCoverage: {
        scope: 'all-active-non-personal', projectCount: 3,
        activeTotal: 100, embeddedTotal: 99,
      },
      embeddingCredential: {
        source: 'explicit-key-file', pathLabel: '~/.gemini-api-key', mode: '0600',
        modifiedAt: '2026-08-12T00:00:00.000Z', fingerprint: 'sha256:123456789abc',
      },
      realQueryCount: 5,
      queries,
    });

    expect(report).toContain('評測狀態：PARTIAL');
    expect(report).toContain('embedding coverage 未達 100%（99/100）');
  });

  it('keeps an otherwise complete hybrid report partial when drill-down evidence errors', () => {
    const queries = Array.from({ length: 10 }, (_, index) => ({
      query: `query-${index + 1}`,
      source: index < 5 ? 'fixed' as const : 'real' as const,
      projectId: 'CC-memory',
      ccMemoryTop5: [],
      claudeMemTop5: [],
      claudeMemScopeVerified: true,
      ...(index >= 5 ? {
        realQueryProvenance: {
          querySurface: 'mcp' as const,
          originalMode: 'hybrid',
          sampledAt: new Date('2026-08-12T00:00:00.000Z'),
        },
      } : {}),
      drillDown: {
        timelineNeighborCount: 0, checkedCount: 0, factsNonEmptyCount: 0, filesNonEmptyCount: 0,
        ...(index === 0 ? { error: 'timeline failed' } : {}),
      },
    }));
    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: true },
      ccSearchMode: 'hybrid',
      embeddingCoverage: {
        scope: 'all-active-non-personal', projectCount: 2, activeTotal: 100, embeddedTotal: 100,
      },
      embeddingCredential: {
        source: 'explicit-key-file', pathLabel: '~/.gemini-api-key', mode: '0600',
        modifiedAt: '2026-08-12T00:00:00.000Z', fingerprint: 'sha256:123456789abc',
      },
      realQueryCount: 5,
      queries,
    });

    expect(report).toContain('評測狀態：PARTIAL');
    expect(report).toContain('1 組 drill-down 佐證出錯');
  });

  it('keeps a complete ten-query keyword run partial until every query uses hybrid search', () => {
    const queries = Array.from({ length: 10 }, (_, index) => ({
      query: `query-${index + 1}`,
      source: index < 5 ? 'fixed' as const : 'real' as const,
      projectId: 'CC-memory',
      ccMemoryTop5: [],
      claudeMemTop5: [],
      drillDown: {
        timelineNeighborCount: 0,
        checkedCount: 0,
        factsNonEmptyCount: 0,
        filesNonEmptyCount: 0,
      },
    }));

    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: true, status: 'ok', version: '10.5.2' },
      ccSearchMode: 'keyword',
      realQueryCount: 5,
      realQueryTarget: 5,
      queries,
    });

    expect(report).toContain('評測狀態：PARTIAL — 不得用於 Go/No-Go');
    expect(report).toContain('CC-memory 查詢未全數使用 hybrid mode');
  });

  it('marks a report partial when any claude-mem comparison query is unavailable', () => {
    const queries = Array.from({ length: 10 }, (_, index) => ({
      query: `query-${index + 1}`,
      source: index < 5 ? 'fixed' as const : 'real' as const,
      projectId: 'CC-memory',
      ccMemoryTop5: [],
      ...(index === 4
        ? { claudeMemUnavailableReason: 'HTTP 503' }
        : { claudeMemTop5: [] }),
      drillDown: {
        timelineNeighborCount: 0,
        checkedCount: 0,
        factsNonEmptyCount: 0,
        filesNonEmptyCount: 0,
      },
    }));

    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: true, status: 'ok', version: '10.5.2' },
      ccSearchMode: 'hybrid',
      realQueryCount: 5,
      realQueryTarget: 5,
      queries,
    });

    expect(report).toContain('評測狀態：PARTIAL — 不得用於 Go/No-Go');
    expect(report).toContain('1 組 claude-mem 對照查詢不可用');
  });
});

describe('classifyRollupDrillDown', () => {
  it('recognizes a spec-legal empty extraction only when metadata and DB agree', () => {
    expect(classifyRollupDrillDown({
      metadata: { capture: { observation_ids: [] } },
      activeObservationCount: 0,
    })).toEqual({ kind: 'legal-empty' });
  });

  it('keeps a rollup with active observations available for timeline drill-down', () => {
    expect(classifyRollupDrillDown({
      metadata: { capture: { observation_ids: ['id-1'] } },
      activeObservationCount: 1,
    })).toEqual({ kind: 'available' });
  });

  it('rejects metadata/DB disagreement instead of disguising missing observations as legal empty', () => {
    expect(classifyRollupDrillDown({
      metadata: { capture: { observation_ids: ['missing-id'] } },
      activeObservationCount: 0,
    })).toMatchObject({ kind: 'inconsistent', reason: expect.stringContaining('metadata') });
  });
});

async function cleanupFeedback(sql: Sql): Promise<void> {
  // prefix-scoped：test DB 可能被另一個 session 的 suite 同時使用（repo 已有先例），
  // 全表 DELETE 會掃掉對方測試中的 rows；比照 feedback.test.ts / memories.test.ts 慣例
  await sql`DELETE FROM search_feedback WHERE query LIKE ${SQL_PREFIX + '%'}`;
}

async function seedFeedback(
  sql: Sql,
  input: {
    query: string;
    projectId: string | null;
    resultProjectIds: string[];
    createdAt: string;
    querySurface?: 'mcp' | 'telegram' | 'http';
    mode?: 'keyword' | 'semantic' | 'hybrid';
  }
): Promise<void> {
  const resultIds = input.resultProjectIds.map(() => randomUUID());
  const ranks = input.resultProjectIds.map((_, index) => index + 1);
  await sql`
    INSERT INTO search_feedback (
      query,
      query_surface,
      query_project_id,
      mode,
      "limit",
      result_ids,
      result_project_ids,
      rank_positions,
      created_at
    )
    VALUES (
      ${input.query},
      ${input.querySurface ?? 'mcp'},
      ${input.projectId},
      ${input.mode ?? 'keyword'},
      5,
      ${resultIds}::uuid[],
      ${input.resultProjectIds}::text[],
      ${ranks}::int[],
      ${input.createdAt}::timestamptz
    )
  `;
}

describe('fetchRecentRealQueries', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = await connectTestDb();
  });

  beforeEach(async () => {
    await cleanupFeedback(sql);
  });

  afterEach(async () => {
    await cleanupFeedback(sql);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  it('samples latest distinct recent non-personal query rows and leaves fewer than five as-is', async () => {
    const now = Date.now();
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-duplicate`,
      projectId: 'CC-memory',
      resultProjectIds: ['CC-memory'],
      createdAt: new Date(now - 60_000).toISOString(),
    });
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-duplicate`,
      projectId: 'older-project',
      resultProjectIds: ['older-project'],
      createdAt: new Date(now - 120_000).toISOString(),
    });
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-cross-project`,
      projectId: null,
      resultProjectIds: ['CC-memory'],
      createdAt: new Date(now - 30_000).toISOString(),
    });
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-personal-query`,
      projectId: '__personal__',
      resultProjectIds: ['__personal__'],
      createdAt: new Date(now - 10_000).toISOString(),
    });
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-old`,
      projectId: 'CC-memory',
      resultProjectIds: ['CC-memory'],
      createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // limit 放大再 filter 自己 prefix：預設 limit 5 在並行 session 也寫入時
    // 可能被別人的 rows 擠出，導致自己的 rows 進不了結果
    const rows = await fetchRecentRealQueries(sql, { limit: 100 });
    const mine = rows.filter((row) => row.query.startsWith(SQL_PREFIX));

    expect(mine.map((row) => row.query)).toEqual([`${SQL_PREFIX}-duplicate`]);
    expect(mine[0].projectId).toBe('CC-memory');
    expect(mine).toHaveLength(1);

    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-07-08T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: false },
      ccSearchMode: 'keyword',
      realQueryCount: mine.length,
      realQueryTarget: 5,
      queries: [],
    });
    expect(report).toContain('真實 query 僅 1 組');
    expect(JSON.stringify(mine)).not.toContain('__personal__');
  });

  it('samples only MCP rows and carries source mode and timestamp provenance', async () => {
    const now = new Date();
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-mcp`, projectId: 'CC-memory', resultProjectIds: ['CC-memory'],
      createdAt: now.toISOString(), querySurface: 'mcp', mode: 'hybrid',
    });
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-telegram`, projectId: 'CC-memory', resultProjectIds: ['CC-memory'],
      createdAt: new Date(now.getTime() + 1000).toISOString(), querySurface: 'telegram',
    });

    const mine = (await fetchRecentRealQueries(sql, { limit: 100 }))
      .filter((row) => row.query.startsWith(SQL_PREFIX));

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ query: `${SQL_PREFIX}-mcp`, querySurface: 'mcp', mode: 'hybrid' });
    expect(mine[0].createdAt).toBeInstanceOf(Date);
  });

  it('excludes fixed fixture text before selecting the five real-query rows', async () => {
    const now = Date.now();
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-fixed`, projectId: 'CC-memory', resultProjectIds: ['CC-memory'],
      createdAt: new Date(now).toISOString(),
    });
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-real`, projectId: 'CC-memory', resultProjectIds: ['CC-memory'],
      createdAt: new Date(now - 1000).toISOString(),
    });

    const mine = (await fetchRecentRealQueries(sql, {
      limit: 100,
      excludeQueries: [`${SQL_PREFIX}-fixed`],
    })).filter((row) => row.query.startsWith(SQL_PREFIX));

    expect(mine.map((row) => row.query)).toEqual([`${SQL_PREFIX}-real`]);
  });

  it('throws when a sampled result project id contains the personal namespace', async () => {
    await seedFeedback(sql, {
      query: `${SQL_PREFIX}-bad-result`,
      projectId: 'CC-memory',
      resultProjectIds: ['CC-memory', '__personal__'],
      createdAt: new Date().toISOString(),
    });

    await expect(fetchRecentRealQueries(sql, { limit: 100 })).rejects.toThrow(/__personal__/);
  });
});

describe('formal hybrid evidence', () => {
  it('disables dotenv and ambient keys before optionally installing the explicit key', () => {
    const env: NodeJS.ProcessEnv = {
      GEMINI_API_KEY: 'ambient-must-be-removed',
      DOTENV_CONFIG_PATH: '/tmp/attacker-controlled.env',
    };

    isolateBenchmarkEmbeddingEnvironment(env);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.DOTENV_CONFIG_PATH).toBe('/dev/null');

    isolateBenchmarkEmbeddingEnvironment(env, 'explicit-key');
    expect(env.GEMINI_API_KEY).toBe('explicit-key');
    expect(env.DOTENV_CONFIG_PATH).toBe('/dev/null');
  });
  it('counts all active non-personal production corpus for replacement readiness', async () => {
    const rows = await fetchEmbeddingCoverage(sqlForCoverage([
      { projectId: 'CC-memory', corpus: 'project_memories', activeTotal: 3, embeddedTotal: 2 },
      { projectId: 'CC-memory', corpus: 'observations', activeTotal: 7, embeddedTotal: 7 },
      { projectId: 'line_cards', corpus: 'observations', activeTotal: 5, embeddedTotal: 4 },
    ]));

    expect(rows).toEqual({
      scope: 'all-active-non-personal', projectCount: 2, activeTotal: 15, embeddedTotal: 13,
    });
  });

  it('loads only an explicit regular 0600 key file and returns non-secret evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccm-benchmark-key-'));
    const keyPath = join(dir, 'gemini.key');
    try {
      writeFileSync(keyPath, 'secret-value-never-rendered\n');
      chmodSync(keyPath, 0o600);
      const loaded = await loadBenchmarkEmbeddingCredential(keyPath, dir);

      expect(loaded.apiKey).toBe('secret-value-never-rendered');
      expect(JSON.stringify(loaded.evidence)).not.toContain(loaded.apiKey);
      expect(loaded.evidence).toMatchObject({
        source: 'explicit-key-file', pathLabel: '~/gemini.key', mode: '0600',
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{12}$/),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects permissive and symlinked embedding key files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccm-benchmark-key-reject-'));
    const target = join(dir, 'target.key');
    const link = join(dir, 'link.key');
    try {
      writeFileSync(target, 'not-rendered\n');
      chmodSync(target, 0o644);
      await expect(loadBenchmarkEmbeddingCredential(target, dir)).rejects.toThrow(/0600/);
      chmodSync(target, 0o600);
      symlinkSync(target, link);
      await expect(loadBenchmarkEmbeddingCredential(link, dir)).rejects.toThrow(/regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function sqlForCoverage(rows: unknown[]) {
  return (() => Promise.resolve(rows)) as unknown as Parameters<typeof fetchEmbeddingCoverage>[0];
}
