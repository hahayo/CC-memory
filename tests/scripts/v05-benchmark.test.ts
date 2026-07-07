// tests/scripts/v05-benchmark.test.ts
//
// v0.5 M6 6a — benchmark fixture parser RED tests. Pure file parsing, no DB.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseBenchmarkFixtures } from '../../scripts/lib/benchmark-fixtures.js';
import {
  fetchRecentRealQueries,
  isClaudeMemFormatDriftError,
  parseClaudeMemSearchText,
  renderBenchmarkReport,
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
      { id: '#S1234', title: 'Drizzle array binding fix' },
      { id: '#S5678', title: 'Refine delete guard' },
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
      { id: '#S42', title: 'Title with raw | pipe text' },
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
          claudeMemTop5: [{ rank: 1, id: '#S1234', title: 'Drizzle array binding fix' }],
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
    expect(report).toContain('AGPL-3.0 紅線聲明');
    expect(report).toContain('不複製其原始碼／prompt／schema');
    expect(report).toContain('| query | Top-5 交集數【人工】 | CC first-relevant rank【人工】 | claude-mem first-relevant rank【人工】 | 錯抓數【人工】 |');
    expect(report).toContain('| drizzle array 綁定 record 錯誤 |  |  |  |  |');
    expect(report).toContain('## 三硬指標匯總（人工標註後填寫）');
    expect(report).toContain('| 指標 | 門檻 | 值【人工】 | 判定【人工】 |');
    expect(report).toContain('| Top-5 交集 ≥3 的組數 / 總組數 | ≥7/10 |  |  |');
    expect(report).toContain('| 平均 first-relevant rank（CC vs claude-mem） | CC ≤ claude-mem |  |  |');
    expect(report).toContain('| 錯抓率 | <10% |  |  |');
    expect(report).toContain('正式評測與 Go/No-Go 判定需併用 ≥14 天且 ≥30 筆 auto rollup/observation（~2026-07-21 後）');
    expect(report).toContain('## 標註指引');
    expect(report).toContain('**Top-5 交集**');
    expect(report).toContain('同一工作事件／主題');
    expect(report).toContain('**first-relevant rank**');
    expect(report).toContain('expected_intent');
    expect(report).toContain('**錯抓**');
    expect(report).toContain('錯抓率 =');
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
      'mcp',
      ${input.projectId},
      'keyword',
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

    expect(mine.map((row) => row.query)).toEqual([
      `${SQL_PREFIX}-cross-project`,
      `${SQL_PREFIX}-duplicate`,
    ]);
    expect(mine[0].projectId).toBeNull();
    expect(mine[1].projectId).toBe('CC-memory');
    expect(mine).toHaveLength(2);

    const report = renderBenchmarkReport({
      generatedAt: new Date('2026-07-08T00:00:00.000Z'),
      dbSource: 'localhost:5433',
      worker: { available: false },
      ccSearchMode: 'keyword',
      realQueryCount: mine.length,
      realQueryTarget: 5,
      queries: [],
    });
    expect(report).toContain('真實 query 僅 2 組');
    expect(JSON.stringify(mine)).not.toContain('__personal__');
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
