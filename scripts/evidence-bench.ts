#!/usr/bin/env npx tsx
// scripts/evidence-bench.ts
//
// 檢索證據評測：不靠 LLM。讀標註檔（題目＋每個事實的證據資料列），對正式庫用唯讀連線
// 直接呼叫線上同一條 searchMemoryIndexes，回報每個事實的證據排第幾名、卡在哪一步。
//
// 用法：
//   DATABASE_URL=... EMBEDDING_PROVIDER=local npx tsx scripts/evidence-bench.ts \
//     --labels <path> [--out <dir>] [--only Q10,Q4] [--allow-remote-embedding]
//
// 標註檔含內部內容，不放進 repo；只收路徑參數。
// 不經 MCP handler（search_feedback 寫入只在 src/index.ts 的 handler），連線開唯讀交易。

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { resolveEmbeddingProvider } from '../src/utils/embedding-provider.js';
import { assertNoPersonalProjectRefs } from './lib/benchmark-runner.js';
import {
  aggregateByModeScope,
  classifyEvidence,
  countStages,
  hitKey,
  normalizeResultKind,
  parseLabelFile,
  parseMatrixFilter,
  preSearchStage,
  primaryFactStage,
  runStatus,
  scoreCell,
  type BenchMode,
  type BenchScope,
  type CellRuns,
  type EvidenceDbRow,
  type EvidenceKind,
  type FactInput,
  type LabelFile,
  type LabelQuestion,
  type MatrixFilter,
  type SearchRun,
} from './lib/evidence-score.js';
import {
  isPathInside,
  renderEvidenceReport,
  type BenchResult,
  type DataVersion,
  type EnvSetting,
  type EvidenceCheckRecord,
  type QuestionResult,
} from './lib/evidence-report.js';

const POOL_MAX = 5; // 與 src/db/client.ts 線上連線池相同，延遲才可比
const execFileAsync = promisify(execFile);
const REPO_DIR = dirname(__dirname);

type SearchFn = (typeof import('../src/services/memories.js'))['searchMemoryIndexes'];
type ReserveFns = Pick<
  typeof import('../src/services/memories.js'),
  'readObservationReserveRatio' | 'readSessionRecencyConfig'
>;

interface CliArgs {
  labels: string;
  out: string;
  only: string[] | null;
  matrix: MatrixFilter;
  allowRemoteEmbedding: boolean;
}

class UsageError extends Error {}

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      labels: { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string' },
      modes: { type: 'string' },
      scopes: { type: 'string' },
      limits: { type: 'string' },
      'allow-remote-embedding': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.labels) throw new UsageError('缺 --labels <path>');
  let matrix: MatrixFilter;
  try {
    matrix = parseMatrixFilter({ modes: values.modes, scopes: values.scopes, limits: values.limits });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    labels: resolve(values.labels),
    out: resolve(values.out ?? join(homedir(), '.cache', 'cc-memory', 'evidence-bench', 'runs', stamp)),
    only: values.only
      ? values.only
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : null,
    matrix,
    allowRemoteEmbedding: values['allow-remote-embedding'] === true,
  };
}

function assertOutOutsideRepo(out: string): void {
  if (isPathInside(out, REPO_DIR)) {
    throw new UsageError(
      `--out 不可放在 repo 底下（${REPO_DIR}）：報表含事實敘述等內部內容，repo 是公開的。請改放 repo 外，例如 ~/.cache/cc-memory/evidence-bench/runs/`
    );
  }
}

function selectQuestions(labels: LabelFile, only: string[] | null): LabelQuestion[] {
  if (only === null) return labels.questions;
  const known = new Set(labels.questions.map((q) => q.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new UsageError(`--only 有標註檔裡沒有的題目：${unknown.join(', ')}`);
  const wanted = new Set(only);
  return labels.questions.filter((q) => wanted.has(q.id));
}

function safeMessage(err: unknown, secret: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return secret.length > 0 ? message.split(secret).join('<DATABASE_URL>') : message;
}

async function gitInfo(): Promise<{ head: string; dirty: boolean }> {
  try {
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR })).stdout.trim();
    const status = (await execFileAsync('git', ['status', '--porcelain'], { cwd: REPO_DIR })).stdout.trim();
    return { head, dirty: status.length > 0 };
  } catch {
    return { head: 'unknown', dirty: false };
  }
}

function envSettings(provider: string, fns: ReserveFns): Record<string, EnvSetting> {
  const raw = (name: string): string | null => process.env[name] ?? null;
  // readSourceWeights 未 export：只列原始值，未設或無法解析時由 service 用內建預設
  const weight = (name: string): EnvSetting => {
    const value = raw(name);
    const parsed = Number.parseFloat(value ?? '');
    return { raw: value, effective: Number.isNaN(parsed) ? '內建預設' : String(parsed) };
  };
  const recency = fns.readSessionRecencyConfig();
  return {
    EMBEDDING_PROVIDER: { raw: raw('EMBEDDING_PROVIDER'), effective: provider },
    CC_MEMORY_INCLUDE_OBSERVATIONS: {
      raw: raw('CC_MEMORY_INCLUDE_OBSERVATIONS'),
      effective: (raw('CC_MEMORY_INCLUDE_OBSERVATIONS') ?? 'on').trim().toLowerCase() === 'off' ? 'off' : 'on',
    },
    CC_MEMORY_WEIGHT_MANUAL: weight('CC_MEMORY_WEIGHT_MANUAL'),
    CC_MEMORY_WEIGHT_ROLLUP: weight('CC_MEMORY_WEIGHT_ROLLUP'),
    CC_MEMORY_WEIGHT_OBSERVATION_DECISION: weight('CC_MEMORY_WEIGHT_OBSERVATION_DECISION'),
    CC_MEMORY_WEIGHT_OBSERVATION_AUTO: weight('CC_MEMORY_WEIGHT_OBSERVATION_AUTO'),
    CC_MEMORY_WEIGHT_SESSION_RECENCY_MIN: {
      raw: raw('CC_MEMORY_WEIGHT_SESSION_RECENCY_MIN'),
      effective: String(recency.recencyMin),
    },
    CC_MEMORY_WEIGHT_ROLLUP_SESSION_FLOOR: {
      raw: raw('CC_MEMORY_WEIGHT_ROLLUP_SESSION_FLOOR'),
      effective: String(recency.rollupFloor),
    },
    CC_MEMORY_SEARCH_OBSERVATION_RESERVE: {
      raw: raw('CC_MEMORY_SEARCH_OBSERVATION_RESERVE'),
      effective: String(fns.readObservationReserveRatio()),
    },
  };
}

async function fetchEvidenceRows(
  sql: postgres.Sql,
  kind: EvidenceKind,
  ids: string[]
): Promise<Map<string, EvidenceDbRow & { projectId: string }>> {
  const rows = new Map<string, EvidenceDbRow & { projectId: string }>();
  if (ids.length === 0) return rows;
  const found =
    kind === 'observation'
      ? await sql<{ id: string; status: string | null; content_hash: string | null; project_id: string }[]>`
          select id::text, status, content_hash, project_id from observations where id = any(${ids}::uuid[])`
      : await sql<{ id: string; status: string | null; content_hash: string | null; project_id: string }[]>`
          select id::text, status, content_hash, project_id from project_memories where id = any(${ids}::uuid[])`;
  for (const row of found) {
    rows.set(hitKey(kind, row.id), { status: row.status, contentHash: row.content_hash, projectId: row.project_id });
  }
  return rows;
}

async function runSearch(
  search: SearchFn,
  db: unknown,
  question: LabelQuestion,
  queryText: string,
  mode: BenchMode,
  scope: BenchScope,
  limit: number,
  secret: string
): Promise<SearchRun> {
  const started = performance.now();
  try {
    const envelope = await search(db, {
      query: queryText,
      mode,
      limit,
      projectId: scope === 'project' ? question.project : undefined,
    });
    const latencyMs = Math.round(performance.now() - started);
    assertNoPersonalProjectRefs({
      label: `${question.id} ${mode}/${scope}/${limit}`,
      resultProjectIds: envelope.results.map((result) => result.projectId),
    });
    return {
      limit,
      status: runStatus(mode, envelope.effectiveMode, false),
      requestedMode: mode,
      effectiveMode: envelope.effectiveMode,
      latencyMs,
      hits: envelope.results.map((result) => ({ kind: normalizeResultKind(result.kind), id: result.id })),
    };
  } catch (err) {
    return {
      limit,
      status: 'error',
      requestedMode: mode,
      effectiveMode: null,
      latencyMs: null,
      hits: [],
      error: safeMessage(err, secret),
    };
  }
}

async function evaluateQuestion(
  sql: postgres.Sql,
  search: SearchFn,
  db: unknown,
  question: LabelQuestion,
  matrix: MatrixFilter,
  secret: string
): Promise<QuestionResult> {
  const idsByKind = (kind: EvidenceKind): string[] => [
    ...new Set(question.facts.flatMap((fact) => fact.evidence.filter((e) => e.kind === kind).map((e) => e.id))),
  ];
  const dbRows = new Map([
    ...(await fetchEvidenceRows(sql, 'observation', idsByKind('observation'))),
    ...(await fetchEvidenceRows(sql, 'memory', idsByKind('memory'))),
  ]);

  const evidence: EvidenceCheckRecord[] = [];
  const factInputs: FactInput[] = question.facts.map((fact) => {
    const records = fact.evidence.map((item): EvidenceCheckRecord => {
      const row = dbRows.get(hitKey(item.kind, item.id)) ?? null;
      return {
        factId: fact.id,
        kind: item.kind,
        id: item.id,
        verdict: classifyEvidence(item.content_hash, row),
        dbStatus: row?.status ?? null,
        dbProjectId: row?.projectId ?? null,
      };
    });
    evidence.push(...records);
    const valid = records.filter((r) => r.verdict === 'valid');
    return {
      factId: fact.id,
      preStage: preSearchStage(
        fact.status,
        records.map((record) => record.verdict)
      ),
      validKeys: fact.status === 'labeled' ? valid.map((r) => hitKey(r.kind, r.id)) : [],
      distractorKeys: fact.stale_distractors.map((d) => hitKey(d.kind, d.id)),
      validEvidenceOutsideProject: valid.length > 0 && valid.every((r) => r.dbProjectId !== question.project),
    };
  });

  const runs: CellRuns[] = [];
  for (const query of question.queries) {
    for (const mode of matrix.modes) {
      for (const scope of matrix.scopes) {
        const top10 = matrix.limits.includes(10)
          ? await runSearch(search, db, question, query.text, mode, scope, 10, secret)
          : null;
        const top50 = matrix.limits.includes(50)
          ? await runSearch(search, db, question, query.text, mode, scope, 50, secret)
          : null;
        runs.push({ queryName: query.name, mode, scope, top10, top50 });
      }
    }
  }
  const cells = runs.map((cell) => scoreCell(factInputs, cell));

  return {
    id: question.id,
    project: question.project,
    sessionId: question.session_id ?? null,
    facts: question.facts.map((fact, index) => ({
      id: fact.id,
      text: fact.text,
      status: fact.status,
      preStage: factInputs[index]!.preStage,
      primary: primaryFactStage(fact.id, cells, factInputs[index]!.preStage),
    })),
    evidence,
    cells,
    runs,
  };
}

async function main(): Promise<number> {
  const args = parseCli(process.argv.slice(2));
  assertOutOutsideRepo(args.out);
  const conn = process.env.DATABASE_URL?.trim() ?? '';
  if (conn.length === 0) {
    throw new UsageError('DATABASE_URL 沒設。請先 export DATABASE_URL（本腳本不內建任何預設連線）');
  }

  const provider = resolveEmbeddingProvider(process.env);
  process.stdout.write(`EMBEDDING_PROVIDER=${provider}\n`);
  if (provider !== 'local') {
    process.stderr.write(
      '\n!!! 警告：EMBEDDING_PROVIDER 不是 local。semantic／hybrid 的查詢文字會送到外部 Gemini API。\n' +
        '!!! 線上 wrapper 用的是 local（本機 bge-m3）。確定要送出才加 --allow-remote-embedding。\n\n'
    );
    if (!args.allowRemoteEmbedding) return 2;
  }

  const labels = parseLabelFile(await readFile(args.labels, 'utf8'));
  const questions = selectQuestions(labels, args.only);
  for (const question of questions) {
    assertNoPersonalProjectRefs({ label: `題目 ${question.id}`, projectId: question.project });
  }

  // config.ts 在 import 時才讀 env，所以 DATABASE_URL 檢查完再動態載入 service
  const services = await import('../src/services/memories.js');

  const sql = postgres(conn, {
    max: POOL_MAX,
    idle_timeout: 300, // 與 src/db/client.ts 相同，避免閒置斷線後重連時間算進延遲
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { default_transaction_read_only: true, application_name: 'cc-memory-evidence-bench' },
  });
  try {
    const [readOnly] = await sql<{ default_transaction_read_only: string }[]>`show default_transaction_read_only`;
    if (readOnly?.default_transaction_read_only !== 'on') {
      throw new Error('唯讀連線沒生效（default_transaction_read_only 不是 on），中止');
    }
    const db = drizzle(sql);

    const [git, [counts]] = await Promise.all([
      gitInfo(),
      sql<{ observations: number; project_memories: number }[]>`
        select
          (select count(*)::int from observations where status = 'active') as observations,
          (select count(*)::int from project_memories where status = 'active') as project_memories`,
    ]);
    const dataVersion: DataVersion = {
      gitHead: git.head,
      gitDirty: git.dirty,
      embeddingProvider: provider,
      readOnly: readOnly.default_transaction_read_only,
      poolMax: POOL_MAX,
      env: envSettings(provider, services),
      activeCounts: { observations: counts!.observations, projectMemories: counts!.project_memories },
    };

    const results: QuestionResult[] = [];
    for (const question of questions) {
      process.stdout.write(`評測 ${question.id}（${question.queries.length} 個 query）…\n`);
      results.push(await evaluateQuestion(sql, services.searchMemoryIndexes, db, question, args.matrix, conn));
    }

    const allRuns = results.flatMap((q) => q.runs.flatMap((cell) => [cell.top10, cell.top50]).filter((run) => run !== null));
    const allEvidence = results.flatMap((q) => q.evidence);
    const result: BenchResult = {
      version: 1,
      generatedAt: new Date().toISOString(),
      labelsPath: args.labels,
      dataVersion,
      matrix: args.matrix,
      aggregates: aggregateByModeScope(results.flatMap((q) => q.cells)),
      counts: {
        evidenceValid: allEvidence.filter((e) => e.verdict === 'valid').length,
        evidenceStaleLabel: allEvidence.filter((e) => e.verdict === 'stale_label').length,
        evidenceMissing: allEvidence.filter((e) => e.verdict === 'missing').length,
        runsOk: allRuns.filter((run) => run.status === 'ok').length,
        runsDegraded: allRuns.filter((run) => run.status === 'degraded').length,
        runsError: allRuns.filter((run) => run.status === 'error').length,
        primaryStages: countStages(results.flatMap((q) => q.facts.map((fact) => fact.primary.stage))),
        outOfScopeFactCells: results
          .flatMap((q) => q.cells.flatMap((cell) => cell.facts))
          .filter((fact) => fact.stage === 'out_of_scope').length,
      },
      questions: results,
    };

    await mkdir(args.out, { recursive: true });
    await writeFile(join(args.out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(join(args.out, 'report.md'), renderEvidenceReport(result), 'utf8');
    process.stdout.write(
      `完成：搜尋 ok=${result.counts.runsOk} degraded=${result.counts.runsDegraded} error=${result.counts.runsError}\n` +
        `報表：${join(args.out, 'report.md')}\n`
    );
    return 0;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const secret = process.env.DATABASE_URL?.trim() ?? '';
    process.stderr.write(`evidence-bench 失敗：${safeMessage(err, secret)}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
