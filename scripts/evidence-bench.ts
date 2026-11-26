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
// 向量端點必須是本機（loopback），否則需要 --allow-remote-embedding；錯誤只記類別與錯誤碼。

import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { isReservedProjectId, RESERVED_PROJECT_ID_LIST } from '../src/services/scope-policy.js';
import { assertNoPersonalProjectRefs } from './lib/benchmark-runner.js';
import {
  aggregateByModeScope,
  buildFactInputs,
  classifyEvidence,
  countStages,
  evidenceChanged,
  hitKey,
  normalizeResultKind,
  parseLabelFile,
  parseMatrixFilter,
  primaryFactStage,
  runStatus,
  scoreCell,
  type BenchMode,
  type BenchScope,
  type CellRuns,
  type EvidenceKind,
  type EvidenceSnapshot,
  type LabelFile,
  type LabelQuestion,
  type MatrixFilter,
  type SearchRun,
} from './lib/evidence-score.js';
import {
  describeLocalEndpoint,
  existingOutputFiles,
  findProtectedRoot,
  mainWorktreeFromCommonDir,
  parseWorktreeList,
  realpathNearestExisting,
  safeErrorLabel,
  writeNewFile,
} from './lib/evidence-guards.js';
import {
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

/** 參數或環境不對；訊息是本腳本自己寫的，可以印出。 */
class UsageError extends Error {}
/** 執行中的自我檢查失敗；訊息是本腳本自己寫的，可以印出。 */
class BenchAbortError extends Error {}

function parseCliValues(argv: string[]) {
  return parseArgs({
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
}

function parseCli(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof parseCliValues>;
  try {
    parsed = parseCliValues(argv);
  } catch (err) {
    throw new UsageError(`參數錯誤：${(err as Error).message}`);
  }
  const { values } = parsed;
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

async function gitOutput(args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync('git', args, { cwd: REPO_DIR })).stdout.trim();
  } catch {
    return null;
  }
}

/** 目前 worktree、共用 .git 的主目錄、同 repo 的所有 worktree；git 查不到的就只擋目前 worktree。 */
async function protectedRepoRoots(): Promise<string[]> {
  const roots = new Set<string>([REPO_DIR]);
  const commonDir = await gitOutput(['rev-parse', '--git-common-dir']);
  if (commonDir) roots.add(mainWorktreeFromCommonDir(commonDir, REPO_DIR));
  const worktrees = await gitOutput(['worktree', 'list', '--porcelain']);
  if (worktrees) parseWorktreeList(worktrees).forEach((path) => roots.add(path));
  return [...roots];
}

const OUTPUT_FILES = ['result.json', 'report.md'] as const;

/**
 * 查驗輸出目錄並回傳它的真實路徑（之後寫檔一律用這個）：
 * 不可落在 repo（含同 repo 的其他 worktree），裡面也不可已有 result.json／report.md（含符號連結）。
 * 開跑前（連資料庫前）跑一次，寫檔前再跑一次；寫檔本身另用 'wx' 當最後一道。
 */
async function verifyOutDir(out: string): Promise<string> {
  const hit = await findProtectedRoot(out, await protectedRepoRoots());
  if (hit !== null) {
    throw new UsageError(
      `--out 不可放在 repo 底下（${hit}）：報表含事實敘述等內部內容，repo 是公開的。請改放 repo 外，例如 ~/.cache/cc-memory/evidence-bench/runs/`
    );
  }
  const realOut = await realpathNearestExisting(out);
  const existing = await existingOutputFiles(realOut, OUTPUT_FILES);
  if (existing.length > 0) {
    throw new UsageError(
      `--out 目錄裡已有 ${existing.join('、')}（可能是舊報表或符號連結），不覆寫。請換一個新的 --out 目錄`
    );
  }
  return realOut;
}

function selectQuestions(labels: LabelFile, only: string[] | null): LabelQuestion[] {
  if (only === null) return labels.questions;
  const known = new Set(labels.questions.map((q) => q.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new UsageError(`--only 有標註檔裡沒有的題目：${unknown.join(', ')}`);
  const wanted = new Set(only);
  return labels.questions.filter((q) => wanted.has(q.id));
}

async function gitInfo(): Promise<{ head: string; dirty: boolean }> {
  const head = await gitOutput(['rev-parse', 'HEAD']);
  const status = await gitOutput(['status', '--porcelain']);
  return { head: head ?? 'unknown', dirty: (status ?? '').length > 0 };
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

type EvidenceRow = { id: string; status: string | null; content_hash: string | null; project_id: string };

/** 保留 namespace（__personal__）的列一律排除，與全域搜尋同一份清單；被排除的證據會判成 missing。 */
async function fetchEvidenceRows(
  sql: postgres.Sql,
  kind: EvidenceKind,
  ids: string[]
): Promise<Map<string, EvidenceSnapshot>> {
  const rows = new Map<string, EvidenceSnapshot>();
  if (ids.length === 0) return rows;
  const found =
    kind === 'observation'
      ? await sql<EvidenceRow[]>`
          select id::text, status, content_hash, project_id from observations
          where id = any(${ids}::uuid[]) and not (project_id = any(${RESERVED_PROJECT_ID_LIST}::text[]))`
      : await sql<EvidenceRow[]>`
          select id::text, status, content_hash, project_id from project_memories
          where id = any(${ids}::uuid[]) and not (project_id = any(${RESERVED_PROJECT_ID_LIST}::text[]))`;
  for (const row of found) {
    rows.set(hitKey(kind, row.id), { status: row.status, contentHash: row.content_hash, projectId: row.project_id });
  }
  return rows;
}

async function fetchQuestionEvidence(sql: postgres.Sql, question: LabelQuestion): Promise<Map<string, EvidenceSnapshot>> {
  const idsByKind = (kind: EvidenceKind): string[] => [
    ...new Set(question.facts.flatMap((fact) => fact.evidence.filter((e) => e.kind === kind).map((e) => e.id))),
  ];
  return new Map([
    ...(await fetchEvidenceRows(sql, 'observation', idsByKind('observation'))),
    ...(await fetchEvidenceRows(sql, 'memory', idsByKind('memory'))),
  ]);
}

async function runSearch(
  search: SearchFn,
  db: unknown,
  question: LabelQuestion,
  queryText: string,
  mode: BenchMode,
  scope: BenchScope,
  limit: number
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
      error: safeErrorLabel(err),
    };
  }
}

async function evaluateQuestion(
  sql: postgres.Sql,
  search: SearchFn,
  db: unknown,
  question: LabelQuestion,
  matrix: MatrixFilter
): Promise<QuestionResult> {
  const before = await fetchQuestionEvidence(sql, question);
  const evidenceItems = question.facts.flatMap((fact) => fact.evidence.map((item) => ({ factId: fact.id, item })));
  const initial: EvidenceCheckRecord[] = evidenceItems.map(({ factId, item }) => {
    const row = before.get(hitKey(item.kind, item.id)) ?? null;
    return {
      factId,
      kind: item.kind,
      id: item.id,
      verdict: classifyEvidence(item.content_hash, row),
      dbStatus: row?.status ?? null,
      dbProjectId: row?.projectId ?? null,
      changedDuringRun: false,
    };
  });
  const initialInputs = buildFactInputs(question, initial);

  const runs: CellRuns[] = [];
  for (const query of question.queries) {
    for (const mode of matrix.modes) {
      for (const scope of matrix.scopes) {
        const top10 = matrix.limits.includes(10)
          ? await runSearch(search, db, question, query.text, mode, scope, 10)
          : null;
        const top50 = matrix.limits.includes(50)
          ? await runSearch(search, db, question, query.text, mode, scope, 50)
          : null;
        runs.push({ queryName: query.name, mode, scope, top10, top50 });
      }
    }
  }

  // 搜尋可能跑很久；期間被原地改寫的證據改判 stale_label，整題用重核對後的結果計分
  const after = await fetchQuestionEvidence(sql, question);
  const evidence = initial.map((record): EvidenceCheckRecord => {
    const key = hitKey(record.kind, record.id);
    if (!evidenceChanged(before.get(key) ?? null, after.get(key) ?? null)) return record;
    return { ...record, verdict: 'stale_label', changedDuringRun: true };
  });
  const factInputs = evidence.some((record) => record.changedDuringRun)
    ? buildFactInputs(question, evidence)
    : initialInputs;
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
  await verifyOutDir(args.out);
  const conn = process.env.DATABASE_URL?.trim() ?? '';
  if (conn.length === 0) {
    throw new UsageError('DATABASE_URL 沒設。請先 export DATABASE_URL（本腳本不內建任何預設連線）');
  }

  // config.ts 在 import 時才讀 env 與 .env，所以 DATABASE_URL 檢查完再動態載入；
  // 之後用「載入後實際生效」的 provider 與端點判斷會不會外送，全部在連資料庫之前。
  let config: (typeof import('../src/config.js'))['config'];
  try {
    ({ config } = await import('../src/config.js'));
  } catch (err) {
    throw new UsageError(`設定載入失敗：${safeErrorLabel(err)}（檢查 EMBEDDING_PROVIDER 等環境變數）`);
  }
  const provider = config.embeddingProvider;
  const endpoint =
    provider === 'local'
      ? describeLocalEndpoint(config.embeddingLocalUrl)
      : { host: 'Gemini API（外部）', loopback: false };
  process.stdout.write(`EMBEDDING_PROVIDER=${provider}，向量端點主機=${endpoint.host}\n`);
  if (!endpoint.loopback) {
    process.stderr.write(
      `\n!!! 警告：向量端點不是本機（provider=${provider}，主機=${endpoint.host}）。semantic／hybrid 的查詢文字會送出本機。\n` +
        '!!! 線上 wrapper 用的是 local（127.0.0.1 的 bge-m3）。確定要送出才加 --allow-remote-embedding。\n\n'
    );
    if (!args.allowRemoteEmbedding) return 2;
  }

  let labelText: string;
  try {
    labelText = await readFile(args.labels, 'utf8');
  } catch (err) {
    throw new UsageError(`讀不到標註檔：${safeErrorLabel(err)}`);
  }
  let labels: LabelFile;
  try {
    labels = parseLabelFile(labelText);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const questions = selectQuestions(labels, args.only);
  for (const question of questions) {
    if (isReservedProjectId(question.project)) {
      throw new UsageError(`題目 ${question.id} 的 project 是保留 namespace，不可評測`);
    }
    assertNoPersonalProjectRefs({ label: `題目 ${question.id}`, projectId: question.project });
  }

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
      throw new BenchAbortError('唯讀連線沒生效（default_transaction_read_only 不是 on），中止');
    }
    const db = drizzle(sql);

    const [git, [counts]] = await Promise.all([
      gitInfo(),
      sql<{ observations: number; project_memories: number }[]>`
        select
          (select count(*)::int from observations
            where status = 'active' and not (project_id = any(${RESERVED_PROJECT_ID_LIST}::text[]))) as observations,
          (select count(*)::int from project_memories
            where status = 'active' and not (project_id = any(${RESERVED_PROJECT_ID_LIST}::text[]))) as project_memories`,
    ]);
    const dataVersion: DataVersion = {
      gitHead: git.head,
      gitDirty: git.dirty,
      embeddingProvider: provider,
      embeddingEndpointHost: endpoint.host,
      embeddingEndpointLoopback: endpoint.loopback,
      readOnly: readOnly.default_transaction_read_only,
      poolMax: POOL_MAX,
      env: envSettings(provider, services),
      activeCounts: { observations: counts!.observations, projectMemories: counts!.project_memories },
    };

    const results: QuestionResult[] = [];
    for (const question of questions) {
      process.stdout.write(`評測 ${question.id}（${question.queries.length} 個 query）…\n`);
      results.push(await evaluateQuestion(sql, services.searchMemoryIndexes, db, question, args.matrix));
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
        evidenceChangedDuringRun: allEvidence.filter((e) => e.changedDuringRun).length,
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

    // 跑了很久才寫檔：先重新查驗一次，建好目錄後再查一次真實路徑，寫檔用 'wx'
    const checkedOut = await verifyOutDir(args.out);
    await mkdir(checkedOut, { recursive: true });
    const realOut = await verifyOutDir(checkedOut);
    try {
      await writeNewFile(join(realOut, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
      await writeNewFile(join(realOut, 'report.md'), renderEvidenceReport(result));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UsageError('寫檔時發現輸出檔已存在（可能是符號連結），未覆寫。請換一個新的 --out 目錄重跑');
      }
      throw err;
    }
    process.stdout.write(
      `完成：搜尋 ok=${result.counts.runsOk} degraded=${result.counts.runsDegraded} error=${result.counts.runsError}\n` +
        `報表：${join(realOut, 'report.md')}\n`
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
    // 只有本腳本自己寫的訊息才印全文；其他錯誤只印類別與錯誤碼（不轉存原始 message）
    const own = err instanceof UsageError || err instanceof BenchAbortError;
    process.stderr.write(`evidence-bench 失敗：${own ? (err as Error).message : safeErrorLabel(err)}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
