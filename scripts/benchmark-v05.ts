#!/usr/bin/env npx tsx
// scripts/benchmark-v05.ts
//
// Thin CLI for the v0.5 M6 benchmark harness.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { parseBenchmarkFixtures } from './lib/benchmark-fixtures.js';
import {
  assertNoPersonalProjectRefs,
  databaseHostPortLabel,
  fetchRecentRealQueries,
  isClaudeMemFormatDriftError,
  parseClaudeMemSearchText,
  renderBenchmarkReport,
  type BenchmarkReportQuery,
  type CcMemoryReportRow,
  type ClaudeMemReportRow,
  type DrillDownReport,
} from './lib/benchmark-runner.js';
import type { MemoryIndexResult } from '../src/services/types.js';

const DEFAULT_CONN = 'postgres://test:test@localhost:5433/cc_memory_test';
const CLAUDE_MEM_BASE_URL = 'http://127.0.0.1:37777';
// 50：搭配 type='session' 縮到 session 級語料後的餘裕——manual session 記憶仍會佔位，
// 撈太少會讓第 5 個 rollup 進不了 envelope（對審 P2：兩側 Top-5 對等性）
const SEARCH_FETCH_LIMIT = 50;
const ROLLUP_LIMIT = 5;
const SUPPORT_LIMIT = 3;

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/benchmark-v05.ts --fixtures docs/auto-capture-v0.5/benchmark-fixtures.md',
  ].join('\n');
}

function parseArgs(argv: string[]): { fixtures: string } {
  let fixtures: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixtures') {
      fixtures = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!fixtures) throw new Error(`Missing --fixtures\n${usage()}`);
  return { fixtures };
}

function resolveConn(env: NodeJS.ProcessEnv): string {
  return env.DATABASE_URL ?? env.TEST_DATABASE_URL ?? DEFAULT_CONN;
}

function dateStamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  // 10s：claude-mem worker 首次查詢有 warm-up 延遲，2s 會把第一組 query 誤判為不可用
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function jsonStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

async function readWorkerHealth(): Promise<{
  available: boolean;
  status?: string;
  version?: string;
  reason?: string;
}> {
  try {
    const url = new URL('/api/health', CLAUDE_MEM_BASE_URL);
    const json = await fetchJson(url);
    return {
      available: true,
      status: jsonStringField(json, 'status') ?? 'ok',
      version: jsonStringField(json, 'version'),
    };
  } catch (err) {
    return { available: false, reason: messageOf(err) };
  }
}

function extractClaudeMemText(json: unknown): string {
  if (typeof json === 'string') return json;
  if (!json || typeof json !== 'object') {
    throw new Error('claude-mem search response was not an object');
  }
  const record = json as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  const content = record.content;
  if (Array.isArray(content)) {
    const first = content[0];
    if (first && typeof first === 'object') {
      const text = (first as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  throw new Error('claude-mem search response missing content[0].text');
}

async function searchClaudeMem(input: {
  query: string;
  projectId: string | null;
  workerAvailable: boolean;
  workerReason?: string;
}): Promise<{ rows?: ClaudeMemReportRow[]; unavailableReason?: string }> {
  if (!input.workerAvailable) {
    return { unavailableReason: input.workerReason ?? 'worker 不可用' };
  }

  try {
    const url = new URL('/api/search', CLAUDE_MEM_BASE_URL);
    url.searchParams.set('query', input.query);
    url.searchParams.set('limit', String(ROLLUP_LIMIT));
    url.searchParams.set('type', 'sessions');
    if (input.projectId) url.searchParams.set('project', input.projectId);
    const json = await fetchJson(url);
    const rows = parseClaudeMemSearchText(extractClaudeMemText(json))
      .slice(0, ROLLUP_LIMIT)
      .map((row, index) => ({ rank: index + 1, id: row.id, title: row.title }));
    return { rows };
  } catch (err) {
    // 格式漂移 = parser 與 claude-mem 輸出不再對齊，report 會系統性缺筆——fail 整支
    if (isClaudeMemFormatDriftError(err)) throw err;
    return { unavailableReason: messageOf(err) };
  }
}

function scoreAt(results: MemoryIndexResult[], index: number, scores: number[] | null): number | null {
  if (!scores) return null;
  if (index < 0 || index >= results.length) return null;
  return scores[index] ?? null;
}

async function runCcMemoryQuery(input: {
  db: ReturnType<typeof drizzle>;
  query: string;
  projectId: string | null;
  searchMemoryIndexes: typeof import('../src/services/memories.js').searchMemoryIndexes;
  timeline: typeof import('../src/services/observations.js').timeline;
  getObservations: typeof import('../src/services/observations.js').getObservations;
}): Promise<{ rows: CcMemoryReportRow[]; drillDown: DrillDownReport; effectiveMode: string }> {
  assertNoPersonalProjectRefs({
    label: `benchmark query "${input.query}"`,
    projectId: input.projectId,
  });

  // type='session'：CC 側限定 session 級語料（觀察索引整組排除），與 claude-mem 的
  // type=sessions 對等——混合語料排名後過濾 rollup 會讓 rank 語義不對等且被 observation 擠位
  const envelope = await input.searchMemoryIndexes(input.db, {
    query: input.query,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    limit: SEARCH_FETCH_LIMIT,
    type: 'session',
    querySurface: 'mcp',
  });

  assertNoPersonalProjectRefs({
    label: `CC-memory results for "${input.query}"`,
    projectId: envelope.queryContext.projectId,
    resultProjectIds: envelope.results.map((result) => result.projectId),
  });

  const rollups = envelope.results
    .map((result, index) => ({ result, index }))
    .filter((entry) => entry.result.kind === 'rollup')
    .slice(0, ROLLUP_LIMIT);

  const rows = rollups.map((entry, index) => ({
    rank: index + 1,
    id: entry.result.id,
    summary: entry.result.title,
    score: scoreAt(envelope.results, entry.index, envelope.rankingMeta.scores),
  }));

  const drillDown: DrillDownReport = {
    timelineNeighborCount: 0,
    checkedCount: 0,
    factsNonEmptyCount: 0,
    filesNonEmptyCount: 0,
  };
  const effectiveMode = envelope.queryContext.effectiveMode;

  const top = rollups[0]?.result;
  if (!top) return { rows, drillDown, effectiveMode };

  try {
    const timelineResult = await input.timeline(input.db, top.id, 2, 2, top.projectId);
    assertNoPersonalProjectRefs({
      label: `timeline results for "${input.query}"`,
      resultProjectIds: timelineResult.observations.map((row) => row.projectId),
    });
    const ids = timelineResult.observations.slice(0, SUPPORT_LIMIT).map((row) => row.id);
    const observations = await input.getObservations(input.db, ids, top.projectId);
    assertNoPersonalProjectRefs({
      label: `getObservations results for "${input.query}"`,
      resultProjectIds: observations.map((row) => row.projectId),
    });
    drillDown.timelineNeighborCount = timelineResult.observations.length;
    drillDown.checkedCount = observations.length;
    drillDown.factsNonEmptyCount = observations.filter((row) => row.facts.length > 0).length;
    drillDown.filesNonEmptyCount = observations.filter((row) => row.files.length > 0).length;
  } catch (err) {
    drillDown.error = messageOf(err);
  }

  return { rows, drillDown, effectiveMode };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const conn = resolveConn(process.env);
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = conn;
  }

  const [{ searchMemoryIndexes }, { timeline, getObservations }] = await Promise.all([
    import('../src/services/memories.js'),
    import('../src/services/observations.js'),
  ]);

  const fixtureText = await readFile(args.fixtures, 'utf8');
  const fixtures = parseBenchmarkFixtures(fixtureText);
  const client = postgres(conn, { max: 1, idle_timeout: 2 });
  const db = drizzle(client);
  const generatedAt = new Date();

  try {
    const realSamples = await fetchRecentRealQueries(client);
    const worker = await readWorkerHealth();
    const queries = [
      ...fixtures.map((fixture) => ({
        query: fixture.query,
        source: 'fixed' as const,
        projectId: fixture.projectId,
        expectedIntent: fixture.expectedIntent,
        notes: fixture.notes,
      })),
      ...realSamples.map((sample) => ({
        query: sample.query,
        source: 'real' as const,
        projectId: sample.projectId,
      })),
    ];

    const reportQueries: BenchmarkReportQuery[] = [];
    const effectiveModes = new Set<string>();
    for (const query of queries) {
      assertNoPersonalProjectRefs({
        label: `benchmark query "${query.query}"`,
        projectId: query.projectId,
      });
      const [ccMemory, claudeMem] = await Promise.all([
        runCcMemoryQuery({
          db,
          query: query.query,
          projectId: query.projectId,
          searchMemoryIndexes,
          timeline,
          getObservations,
        }),
        searchClaudeMem({
          query: query.query,
          projectId: query.projectId,
          workerAvailable: worker.available,
          workerReason: worker.reason,
        }),
      ]);
      effectiveModes.add(ccMemory.effectiveMode);
      reportQueries.push({
        ...query,
        ccMemoryTop5: ccMemory.rows,
        claudeMemTop5: claudeMem.rows,
        claudeMemUnavailableReason: claudeMem.unavailableReason,
        drillDown: ccMemory.drillDown,
      });
    }

    const report = renderBenchmarkReport({
      generatedAt,
      dbSource: databaseHostPortLabel(conn),
      worker,
      // 用實際 effectiveMode（embedding 失敗會 fallback keyword），不能只看 env 猜
      ccSearchMode:
        effectiveModes.size > 0
          ? [...effectiveModes].join('+')
          : process.env.GEMINI_API_KEY
            ? 'hybrid'
            : 'keyword',
      realQueryCount: realSamples.length,
      realQueryTarget: 5,
      queries: reportQueries,
    });

    const outputPath = join(
      'docs',
      'auto-capture-v0.5',
      `benchmark-${dateStamp(generatedAt)}.md`
    );
    const existed = existsSync(outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, report, 'utf8');
    console.log(`${existed ? 'Overwrote' : 'Wrote'} ${outputPath}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('benchmark-v05 failed:', err);
  process.exit(1);
});
