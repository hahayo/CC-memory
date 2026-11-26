// scripts/lib/evidence-score.ts
//
// 檢索證據評測（evidence bench）的標註檔格式與算分純函式。
// 不連 DB、不 import src/config，測試可以直接餵資料。

import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const;
export const SEARCH_SCOPES = ['project', 'global'] as const;
export const SEARCH_LIMITS = [10, 50] as const;
export const PRECISION_K = 10;

export type EvidenceKind = 'observation' | 'memory';
export type BenchMode = (typeof SEARCH_MODES)[number];
export type BenchScope = (typeof SEARCH_SCOPES)[number];
export type ResultKind = 'manual' | 'rollup' | 'observation';

// ---------------------------------------------------------------------------
// 標註檔
// ---------------------------------------------------------------------------

const evidenceKindSchema = z.enum(['observation', 'memory']);
const uuidSchema = z.string().regex(UUID_RE, 'id 必須是 UUID');

const evidenceSchema = z
  .object({
    kind: evidenceKindSchema,
    id: uuidSchema,
    // project_memories.content_hash 可為 null；標註照抄 DB 值，null 對 null 視為相同
    content_hash: z.string().min(1).nullable(),
  })
  .strict();

const distractorSchema = z.object({ kind: evidenceKindSchema, id: uuidSchema }).strict();

const factSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    status: z.enum(['labeled', 'not_in_db', 'unlabeled']),
    evidence: z.array(evidenceSchema).default([]),
    stale_distractors: z.array(distractorSchema).default([]),
  })
  .strict()
  .refine((fact) => fact.status !== 'labeled' || fact.evidence.length > 0, {
    message: 'status=labeled 的事實至少要有一筆 evidence',
  });

const querySchema = z.object({ name: z.string().min(1), text: z.string().trim().min(1) }).strict();

const questionSchema = z
  .object({
    id: z.string().min(1),
    project: z.string().min(1),
    session_id: z.string().optional(),
    queries: z.array(querySchema).min(1),
    facts: z.array(factSchema).min(1),
  })
  .strict()
  .refine((q) => new Set(q.queries.map((x) => x.name)).size === q.queries.length, {
    message: 'queries[].name 不可重複',
  })
  .refine((q) => new Set(q.facts.map((x) => x.id)).size === q.facts.length, {
    message: 'facts[].id 不可重複',
  });

const labelFileSchema = z
  .object({ version: z.literal(1), questions: z.array(questionSchema).min(1) })
  .strict()
  .refine((f) => new Set(f.questions.map((q) => q.id)).size === f.questions.length, {
    message: 'questions[].id 不可重複',
  });

export type LabelFile = z.infer<typeof labelFileSchema>;
export type LabelQuestion = LabelFile['questions'][number];
export type LabelFact = LabelQuestion['facts'][number];

export function parseLabelFile(text: string): LabelFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // 不轉存 JSON.parse 的訊息：它會帶出標註檔片段
    throw new Error(`標註檔不是合法 JSON（${err instanceof Error ? err.name : 'Error'}）`);
  }
  const parsed = labelFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`標註檔格式錯誤：\n  ${issues.join('\n  ')}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// 證據核對
// ---------------------------------------------------------------------------

export type EvidenceVerdict = 'valid' | 'missing' | 'stale_label';

export interface EvidenceDbRow {
  status: string | null;
  contentHash: string | null;
}

/** 不存在或非 active → missing；hash 不同（含一邊是 null）→ stale_label；相同 → valid。 */
export function classifyEvidence(labelHash: string | null, row: EvidenceDbRow | null): EvidenceVerdict {
  if (row === null || row.status !== 'active') return 'missing';
  return row.contentHash === labelHash ? 'valid' : 'stale_label';
}

export function normalizeResultKind(kind: ResultKind): EvidenceKind {
  return kind === 'observation' ? 'observation' : 'memory';
}

export function hitKey(kind: EvidenceKind, id: string): string {
  return `${kind}:${id.toLowerCase()}`;
}


// ---------------------------------------------------------------------------
// 矩陣篩選（CLI --modes／--scopes／--limits）
// ---------------------------------------------------------------------------

export interface MatrixFilter {
  modes: BenchMode[];
  scopes: BenchScope[];
  limits: BenchLimit[];
}

export type BenchLimit = (typeof SEARCH_LIMITS)[number];

export const FULL_MATRIX: MatrixFilter = {
  modes: [...SEARCH_MODES],
  scopes: [...SEARCH_SCOPES],
  limits: [...SEARCH_LIMITS],
};

function listSchema<T extends string>(values: readonly [T, ...T[]], flag: string) {
  return z
    .string()
    .transform((raw) => raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
    .pipe(z.array(z.enum(values, { error: `${flag} 只接受 ${values.join(',')}` })).min(1, `${flag} 不可為空`))
    .transform((items) => values.filter((value) => items.includes(value)));
}

const modesSchema = listSchema(SEARCH_MODES, '--modes');
const scopesSchema = listSchema(SEARCH_SCOPES, '--scopes');
const limitsSchema = listSchema(['10', '50'] as const, '--limits');

/** 未給的參數＝全部；值非法時丟錯（CLI 中止）。輸出依固定順序去重。 */
export function parseMatrixFilter(input: { modes?: string; scopes?: string; limits?: string }): MatrixFilter {
  const parse = <T>(schema: z.ZodType<T>, raw: string | undefined, fallback: T): T => {
    if (raw === undefined) return fallback;
    const result = schema.safeParse(raw);
    if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join('；'));
    return result.data;
  };
  return {
    modes: parse(modesSchema, input.modes, FULL_MATRIX.modes),
    scopes: parse(scopesSchema, input.scopes, FULL_MATRIX.scopes),
    limits: parse(limitsSchema, input.limits, ['10', '50']).map((value) => Number(value) as BenchLimit),
  };
}

// ---------------------------------------------------------------------------
// 事實分類
// ---------------------------------------------------------------------------

/** 搜尋前就決定的階段；null＝可評（labeled 且至少一筆 valid 證據）。 */
export type PreSearchStage = 'not_in_db' | 'stale_label' | 'evidence_missing' | 'unlabeled';
/**
 * 搜尋後的階段（limit=10 與 limit=50 的結果分開判，能確定的才下結論）：
 * - in_top50_top10_unknown：limit=10 那次 degraded／error，但 limit=50 正常且命中 → 前 10 未知
 * - in_top50：沒跑 limit=10（--limits 50），limit=50 命中
 * - not_in_top10：limit=10 正常沒命中，limit=50 沒跑或不正常 → 前 50 未知
 * - not_in_top50_top10_unknown：limit=10 degraded／error，limit=50 正常沒命中 → 前 10 未知
 *   （兩次搜尋各自撈候選再排序，limit=10 可能命中而 limit=50 沒有，不能推成沒進前 10）
 * - not_in_top50：limit=50 正常沒命中，且 limit=10 正常沒命中或沒跑
 */
export type SearchStage =
  | 'in_top10'
  | 'in_top50_top10_unknown'
  | 'in_top50_not_top10'
  | 'in_top50'
  | 'not_in_top10'
  | 'not_in_top50_top10_unknown'
  | 'not_in_top50'
  | 'degraded'
  | 'error';
/** out_of_scope：scope=project 的格子裡，事實所有 valid 證據都在別的 project。not_run：主口徑沒跑。 */
export type FactStage = PreSearchStage | 'out_of_scope' | SearchStage | 'not_run';

/**
 * 由好到壞；取各 query 最佳時用。前 10 未知的排在「確定不在前 10」之前，
 * 免得主摘要把可能進前 10 的事實報成沒進。
 */
const SEARCH_STAGE_ORDER: readonly SearchStage[] = [
  'in_top10',
  'in_top50_top10_unknown',
  'in_top50',
  'in_top50_not_top10',
  'not_in_top50_top10_unknown',
  'not_in_top10',
  'not_in_top50',
  'degraded',
  'error',
];

/** 報表與計數用的顯示順序 */
export const FACT_STAGE_ORDER: readonly FactStage[] = [
  'not_in_db',
  'stale_label',
  'evidence_missing',
  'unlabeled',
  'out_of_scope',
  ...SEARCH_STAGE_ORDER.filter((stage) => stage !== 'degraded' && stage !== 'error').reverse(),
  'degraded',
  'error',
  'not_run',
];

export function preSearchStage(
  status: LabelFact['status'],
  verdicts: readonly EvidenceVerdict[]
): PreSearchStage | null {
  if (status === 'not_in_db') return 'not_in_db';
  if (status === 'unlabeled') return 'unlabeled';
  if (verdicts.includes('valid')) return null;
  if (verdicts.includes('stale_label')) return 'stale_label';
  return 'evidence_missing';
}

export interface FactInput {
  factId: string;
  preStage: PreSearchStage | null;
  validKeys: readonly string[];
  distractorKeys: readonly string[];
  /** 所有 valid 證據的 project_id 都不是題目的 project（帶 projectId 本來就搜不到） */
  validEvidenceOutsideProject: boolean;
}

export interface EvidenceRecordLike {
  factId: string;
  kind: EvidenceKind;
  id: string;
  verdict: EvidenceVerdict;
  dbProjectId: string | null;
}

/** 由證據核對結果建出計分輸入；開跑前與跑完重核對後都用同一個函式。 */
export function buildFactInputs(question: LabelQuestion, records: readonly EvidenceRecordLike[]): FactInput[] {
  return question.facts.map((fact) => {
    const own = records.filter((record) => record.factId === fact.id);
    const valid = own.filter((record) => record.verdict === 'valid');
    return {
      factId: fact.id,
      preStage: preSearchStage(
        fact.status,
        own.map((record) => record.verdict)
      ),
      validKeys: fact.status === 'labeled' ? valid.map((record) => hitKey(record.kind, record.id)) : [],
      distractorKeys: fact.stale_distractors.map((d) => hitKey(d.kind, d.id)),
      validEvidenceOutsideProject: valid.length > 0 && valid.every((record) => record.dbProjectId !== question.project),
    };
  });
}

export interface EvidenceSnapshot {
  status: string | null;
  contentHash: string | null;
  projectId: string | null;
}

/** 開跑前與跑完的 DB 快照是否不同（出現／消失、status、content_hash、project_id 任一變動）。 */
export function evidenceChanged(before: EvidenceSnapshot | null, after: EvidenceSnapshot | null): boolean {
  if (before === null || after === null) return before !== after;
  return (
    before.status !== after.status || before.contentHash !== after.contentHash || before.projectId !== after.projectId
  );
}

// ---------------------------------------------------------------------------
// 每格算分
// ---------------------------------------------------------------------------

export type RunStatus = 'ok' | 'degraded' | 'error';
export type CellRunStatus = RunStatus | 'not_run';

export interface SearchRun {
  limit: number;
  status: RunStatus;
  requestedMode: BenchMode;
  effectiveMode: string | null;
  latencyMs: number | null;
  hits: { kind: EvidenceKind; id: string }[];
  error?: string;
}

export interface CellRuns {
  queryName: string;
  mode: BenchMode;
  scope: BenchScope;
  /** null＝--limits 篩掉沒跑 */
  top10: SearchRun | null;
  top50: SearchRun | null;
}

export function runStatus(
  requestedMode: BenchMode,
  effectiveMode: string | null,
  failed: boolean
): RunStatus {
  if (failed || effectiveMode === null) return 'error';
  if (requestedMode !== 'keyword' && effectiveMode === 'keyword') return 'degraded';
  return 'ok';
}

/** 1-based 最佳名次；沒有＝null。 */
export function bestRank(hits: SearchRun['hits'], keys: ReadonlySet<string>): number | null {
  const index = hits.findIndex((hit) => keys.has(hitKey(hit.kind, hit.id)));
  return index === -1 ? null : index + 1;
}

export interface CellFactScore {
  factId: string;
  stage: FactStage;
  rank10: number | null;
  rank50: number | null;
  /** 有 stale_distractor 排在第一筆 valid 證據之前（證據沒出現而 distractor 出現也算）；null＝不適用 */
  staleBeforeEvidence10: boolean | null;
  staleBeforeEvidence50: boolean | null;
}

export interface CellScore {
  queryName: string;
  mode: BenchMode;
  scope: BenchScope;
  status10: CellRunStatus;
  status50: CellRunStatus;
  /** 可評事實數（不含 pre-search 階段與 out_of_scope） */
  evaluableFacts: number;
  /** 以下 @10 指標只在 status10=ok 且 evaluableFacts>0 時有值，否則 null（不算 0 分） */
  factCoverage10: number | null;
  hit10: boolean | null;
  strictPrecision10: number | null;
  firstEvidenceRank10: number | null;
  /** 只在 status50=ok 且 evaluableFacts>0 時有值 */
  firstEvidenceRank50: number | null;
  /** limit=10 那次回傳的組成；status10 不是 ok 時 null */
  top10Kinds: { memory: number; observation: number } | null;
  latencyMs10: number | null;
  latencyMs50: number | null;
  facts: CellFactScore[];
}

const isOk = (run: SearchRun | null): run is SearchRun => run !== null && run.status === 'ok';
const statusOf = (run: SearchRun | null): CellRunStatus => run?.status ?? 'not_run';

function staleBefore(
  run: SearchRun | null,
  evidenceRank: number | null,
  distractorKeys: readonly string[]
): boolean | null {
  if (!isOk(run) || distractorKeys.length === 0) return null;
  const distractorRank = bestRank(run.hits, new Set(distractorKeys));
  if (distractorRank === null) return false;
  return evidenceRank === null || distractorRank < evidenceRank;
}

export function searchStage(
  top10: SearchRun | null,
  top50: SearchRun | null,
  rank10: number | null,
  rank50: number | null
): SearchStage {
  const s10 = statusOf(top10);
  const s50 = statusOf(top50);
  if (s10 === 'ok' && rank10 !== null) return 'in_top10';
  if (s50 === 'ok' && rank50 === null) {
    return s10 === 'ok' || s10 === 'not_run' ? 'not_in_top50' : 'not_in_top50_top10_unknown';
  }
  if (s10 === 'ok' && s50 === 'ok') return 'in_top50_not_top10';
  if (s10 === 'ok') return 'not_in_top10';
  if (s50 === 'ok') return s10 === 'not_run' ? 'in_top50' : 'in_top50_top10_unknown';
  // 兩邊都沒有可用結果：回報較嚴重的那個
  if (s10 === 'error' || s50 === 'error') return 'error';
  if (s10 === 'degraded' || s50 === 'degraded') return 'degraded';
  return 'error';
}

function excludedStage(fact: FactInput, scope: BenchScope): PreSearchStage | 'out_of_scope' | null {
  if (fact.preStage !== null) return fact.preStage;
  if (scope === 'project' && fact.validEvidenceOutsideProject) return 'out_of_scope';
  return null;
}

export function scoreCell(facts: readonly FactInput[], cell: CellRuns): CellScore {
  const { top10, top50 } = cell;
  const evaluable: FactInput[] = [];
  const factScores: CellFactScore[] = facts.map((fact) => {
    const excluded = excludedStage(fact, cell.scope);
    if (excluded !== null) {
      return {
        factId: fact.factId,
        stage: excluded,
        rank10: null,
        rank50: null,
        staleBeforeEvidence10: null,
        staleBeforeEvidence50: null,
      };
    }
    evaluable.push(fact);
    const keys = new Set(fact.validKeys);
    const rank10 = isOk(top10) ? bestRank(top10.hits, keys) : null;
    const rank50 = isOk(top50) ? bestRank(top50.hits, keys) : null;
    return {
      factId: fact.factId,
      stage: searchStage(top10, top50, rank10, rank50),
      rank10,
      rank50,
      staleBeforeEvidence10: staleBefore(top10, rank10, fact.distractorKeys),
      staleBeforeEvidence50: staleBefore(top50, rank50, fact.distractorKeys),
    };
  });

  const allValidKeys = new Set(evaluable.flatMap((fact) => fact.validKeys));
  const scored10 = isOk(top10) && evaluable.length > 0;
  const scored50 = isOk(top50) && evaluable.length > 0;
  const covered = factScores.filter((fact) => fact.rank10 !== null).length;
  const top10Hits = isOk(top10) ? top10.hits.slice(0, PRECISION_K) : [];
  const precisionHits = top10Hits.filter((hit) => allValidKeys.has(hitKey(hit.kind, hit.id))).length;

  return {
    queryName: cell.queryName,
    mode: cell.mode,
    scope: cell.scope,
    status10: statusOf(top10),
    status50: statusOf(top50),
    evaluableFacts: evaluable.length,
    factCoverage10: scored10 ? covered / evaluable.length : null,
    hit10: scored10 ? covered > 0 : null,
    // 分母固定是 k，不用 min(k, 預期證據數)
    strictPrecision10: scored10 ? precisionHits / PRECISION_K : null,
    firstEvidenceRank10: scored10 ? bestRank(top10!.hits, allValidKeys) : null,
    firstEvidenceRank50: scored50 ? bestRank(top50!.hits, allValidKeys) : null,
    top10Kinds: isOk(top10)
      ? {
          memory: top10Hits.filter((hit) => hit.kind === 'memory').length,
          observation: top10Hits.filter((hit) => hit.kind === 'observation').length,
        }
      : null,
    latencyMs10: top10?.latencyMs ?? null,
    latencyMs50: top50?.latencyMs ?? null,
    facts: factScores,
  };
}

// ---------------------------------------------------------------------------
// 主口徑：hybrid＋帶 projectId，各 query 取最佳
// ---------------------------------------------------------------------------

export const PRIMARY_MODE: BenchMode = 'hybrid';
export const PRIMARY_SCOPE: BenchScope = 'project';

export interface PrimaryFactStage {
  factId: string;
  stage: FactStage;
  bestQuery: string | null;
  rank10: number | null;
  rank50: number | null;
  /** 主口徑格子中，limit=10 或 limit=50 任一次 degraded／error 的格數；>0 時結論可能偏差 */
  invalidCells: number;
}

/** 主口徑格子被篩掉時：pre-search 階段照樣成立，其餘記 not_run。 */
export function primaryFactStage(
  factId: string,
  cells: readonly CellScore[],
  preStage: PreSearchStage | null = null
): PrimaryFactStage {
  const candidates = cells
    .filter((cell) => cell.mode === PRIMARY_MODE && cell.scope === PRIMARY_SCOPE)
    .map((cell) => ({ cell, fact: cell.facts.find((fact) => fact.factId === factId) }))
    .filter((entry): entry is { cell: CellScore; fact: CellFactScore } => entry.fact !== undefined);

  const first = candidates[0]?.fact.stage;
  if (first === undefined) {
    return { factId, stage: preStage ?? 'not_run', bestQuery: null, rank10: null, rank50: null, invalidCells: 0 };
  }
  if (!SEARCH_STAGE_ORDER.includes(first as SearchStage)) {
    return { factId, stage: first, bestQuery: null, rank10: null, rank50: null, invalidCells: 0 };
  }

  const bad = (status: CellRunStatus): boolean => status === 'degraded' || status === 'error';
  const invalidCells = candidates.filter(({ cell }) => bad(cell.status10) || bad(cell.status50)).length;
  const best = [...candidates].sort((a, b) => {
    const order =
      SEARCH_STAGE_ORDER.indexOf(a.fact.stage as SearchStage) -
      SEARCH_STAGE_ORDER.indexOf(b.fact.stage as SearchStage);
    if (order !== 0) return order;
    return (a.fact.rank10 ?? a.fact.rank50 ?? Infinity) - (b.fact.rank10 ?? b.fact.rank50 ?? Infinity);
  })[0]!;
  return {
    factId,
    stage: best.fact.stage,
    bestQuery: best.cell.queryName,
    rank10: best.fact.rank10,
    rank50: best.fact.rank50,
    invalidCells,
  };
}

export function countStages(stages: readonly FactStage[]): { stage: FactStage; count: number }[] {
  return FACT_STAGE_ORDER.map((stage) => ({ stage, count: stages.filter((s) => s === stage).length })).filter(
    (entry) => entry.count > 0
  );
}

// ---------------------------------------------------------------------------
// mode × scope 彙總
// ---------------------------------------------------------------------------

export interface ModeScopeAggregate {
  mode: BenchMode;
  scope: BenchScope;
  /** 計分格數＝status10=ok 且有可評事實 */
  scoredCells: number;
  meanFactCoverage10: number | null;
  /** hit@10＝計分格中「至少一個事實的 valid 證據進前 10」的比例 */
  hitRate10: number | null;
  meanStrictPrecision10: number | null;
  /** 前 10 名組成：status10=ok 的格子平均 memory／observation 筆數 */
  meanTop10Memory: number | null;
  meanTop10Observation: number | null;
  meanLatencyMs10: number | null;
  meanLatencyMs50: number | null;
  degraded10: number;
  error10: number;
  degraded50: number;
  error50: number;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 沒跑的 mode × scope 不出現在結果裡。 */
export function aggregateByModeScope(cells: readonly CellScore[]): ModeScopeAggregate[] {
  return SEARCH_MODES.flatMap((mode) =>
    SEARCH_SCOPES.map((scope) => ({ mode, scope, group: cells.filter((c) => c.mode === mode && c.scope === scope) }))
  )
    .filter(({ group }) => group.length > 0)
    .map(({ mode, scope, group }) => {
      const scored = group.filter((cell) => cell.factCoverage10 !== null);
      const kinds = group.flatMap((cell) => (cell.top10Kinds === null ? [] : [cell.top10Kinds]));
      return {
        mode,
        scope,
        scoredCells: scored.length,
        meanFactCoverage10: mean(scored.map((cell) => cell.factCoverage10!)),
        hitRate10: mean(scored.map((cell) => (cell.hit10 ? 1 : 0))),
        meanStrictPrecision10: mean(scored.map((cell) => cell.strictPrecision10!)),
        meanTop10Memory: mean(kinds.map((k) => k.memory)),
        meanTop10Observation: mean(kinds.map((k) => k.observation)),
        meanLatencyMs10: mean(
          group.filter((cell) => cell.status10 === 'ok' && cell.latencyMs10 !== null).map((cell) => cell.latencyMs10!)
        ),
        meanLatencyMs50: mean(
          group.filter((cell) => cell.status50 === 'ok' && cell.latencyMs50 !== null).map((cell) => cell.latencyMs50!)
        ),
        degraded10: group.filter((cell) => cell.status10 === 'degraded').length,
        error10: group.filter((cell) => cell.status10 === 'error').length,
        degraded50: group.filter((cell) => cell.status50 === 'degraded').length,
        error50: group.filter((cell) => cell.status50 === 'error').length,
      };
    });
}
