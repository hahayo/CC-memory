// scripts/lib/evidence-report.ts
//
// 檢索證據評測的 result.json 型別與 report.md 產生（純函式）。

import { relative, isAbsolute } from 'node:path';
import { PRIMARY_MODE, PRIMARY_SCOPE } from './evidence-score.js';
import type {
  CellRuns,
  CellScore,
  EvidenceKind,
  EvidenceVerdict,
  FactStage,
  LabelFact,
  MatrixFilter,
  ModeScopeAggregate,
  PreSearchStage,
  PrimaryFactStage,
} from './evidence-score.js';

export const LIMITATION_NOTE =
  '題目都來自已被抓到的對話，這份數字量不到抓取覆蓋率造成的漏答，不是整體回想率。';

export interface EvidenceCheckRecord {
  factId: string;
  kind: EvidenceKind;
  id: string;
  verdict: EvidenceVerdict;
  dbStatus: string | null;
  dbProjectId: string | null;
}

export interface EnvSetting {
  raw: string | null;
  effective: string;
}

export interface DataVersion {
  gitHead: string;
  gitDirty: boolean;
  embeddingProvider: string;
  readOnly: string;
  poolMax: number;
  env: Record<string, EnvSetting>;
  activeCounts: { observations: number; projectMemories: number };
}

export interface QuestionResult {
  id: string;
  project: string;
  sessionId: string | null;
  facts: {
    id: string;
    text: string;
    status: LabelFact['status'];
    preStage: PreSearchStage | null;
    primary: PrimaryFactStage;
  }[];
  evidence: EvidenceCheckRecord[];
  cells: CellScore[];
  runs: CellRuns[];
}

export interface BenchResult {
  version: 1;
  generatedAt: string;
  labelsPath: string;
  dataVersion: DataVersion;
  matrix: MatrixFilter;
  aggregates: ModeScopeAggregate[];
  counts: {
    evidenceValid: number;
    evidenceStaleLabel: number;
    evidenceMissing: number;
    runsOk: number;
    runsDegraded: number;
    runsError: number;
    /** 主口徑每個階段的事實數 */
    primaryStages: { stage: FactStage; count: number }[];
    /** scope=project 格子裡被記成 out_of_scope 的（事實×格）數 */
    outOfScopeFactCells: number;
  };
  questions: QuestionResult[];
}

/** child 是否等於 parent 或在 parent 底下（兩者都應是絕對路徑）。 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function fmtNum(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits);
}

function fmtPct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(0)}%`;
}

function cellText(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cellText).join(' | ')} |`),
  ];
}

function stageWithRank(stage: FactStage, rank10: number | null, rank50: number | null): string {
  if (stage === 'in_top10') return `in_top10 (#${rank10})`;
  if (stage === 'in_top50_not_top10') return `in_top50_not_top10 (#${rank50})`;
  if (stage === 'in_top50') return `in_top50 (#${rank50})`;
  return stage;
}

export function renderEvidenceReport(result: BenchResult): string {
  const { dataVersion: dv } = result;
  const factsWithInvalidCells = result.questions
    .flatMap((question) => question.facts)
    .filter((fact) => fact.primary.invalidCells > 0).length;
  const ran10 = result.matrix.limits.includes(10);
  const ran50 = result.matrix.limits.includes(50);
  const primaryRan = result.matrix.modes.includes(PRIMARY_MODE) && result.matrix.scopes.includes(PRIMARY_SCOPE);
  const lines: string[] = [
    '# 檢索證據評測報告',
    '',
    `> 限制：${LIMITATION_NOTE}`,
    '',
    '## 資料版本',
    '',
    `- 產生時間：${result.generatedAt}`,
    `- git HEAD：${dv.gitHead}${dv.gitDirty ? '（工作區有未提交改動）' : ''}`,
    `- EMBEDDING_PROVIDER：${dv.embeddingProvider}`,
    `- 連線 default_transaction_read_only：${dv.readOnly}；連線池 max=${dv.poolMax}`,
    `- active 筆數：observations=${dv.activeCounts.observations}、project_memories=${dv.activeCounts.projectMemories}`,
    '- 下列設定是評測程序自己的環境值，不一定等於線上 MCP server 的值：',
    ...Object.entries(dv.env).map(
      ([name, setting]) => `  - ${name}：${setting.raw === null ? '未設' : `"${setting.raw}"`} → ${setting.effective}`
    ),
    `- 本次矩陣：modes=${result.matrix.modes.join(',')}、scopes=${result.matrix.scopes.join(',')}、limits=${result.matrix.limits.join(',')}（沒跑的格子不列、不進平均）`,
    '',
    '## 計數',
    '',
    `- 證據：valid=${result.counts.evidenceValid}、stale_label=${result.counts.evidenceStaleLabel}、missing=${result.counts.evidenceMissing}`,
    `- 搜尋次數：ok=${result.counts.runsOk}、degraded=${result.counts.runsDegraded}、error=${result.counts.runsError}`,
    `- 主口徑各階段事實數：${result.counts.primaryStages.map((e) => `${e.stage}=${e.count}`).join('、') || '—'}；其中 ${factsWithInvalidCells} 個事實有無效格`,
    `- out_of_scope（事實×帶 projectId 格）：${result.counts.outOfScopeFactCells}（證據全在別的 project，不計入該格可評事實數）`,
    '',
    '## 每個 mode × scope 的平均',
    '',
    '計分格＝limit=10 那次搜尋正常（非 degraded／error）且題目有可評事實；degraded／error 不算 0 分，另列次數。',
    'hit@10＝計分格中至少一個事實的 valid 證據進前 10 的比例。strict_precision@10 分母固定是 10。',
    '每個 query 算一格，query 多的題目權重較大。',
    '延遲：每格先跑 limit=10 再跑 limit=50，limit=10 常吃到冷快取，兩欄不能互相比較；只拿同一欄跨 mode／scope 比。',
    '',
    ...table(
      [
        'mode',
        'scope',
        '計分格',
        'fact_coverage@10',
        'hit@10',
        'strict_precision@10',
        '延遲 ms (10/50)',
        'degraded (10/50)',
        'error (10/50)',
      ],
      result.aggregates.map((agg) => [
        agg.mode,
        agg.scope,
        String(agg.scoredCells),
        fmtPct(agg.meanFactCoverage10),
        fmtPct(agg.hitRate10),
        fmtNum(agg.meanStrictPrecision10),
        `${fmtNum(agg.meanLatencyMs10, 0)} / ${fmtNum(agg.meanLatencyMs50, 0)}`,
        `${ran10 ? agg.degraded10 : '—'} / ${ran50 ? agg.degraded50 : '—'}`,
        `${ran10 ? agg.error10 : '—'} / ${ran50 ? agg.error50 : '—'}`,
      ])
    ),
    '',
    '## 前 10 名組成',
    '',
    '每個 mode × scope 在 limit=10 那次搜尋正常的格子，前 10 筆平均有幾筆 memory（manual／rollup）、幾筆 observation。',
    '',
    ...table(
      ['mode', 'scope', 'memory', 'observation'],
      result.aggregates.map((agg) => [agg.mode, agg.scope, fmtNum(agg.meanTop10Memory, 1), fmtNum(agg.meanTop10Observation, 1)])
    ),
    '',
    `## 每個事實卡在哪一步（主口徑：${PRIMARY_MODE}＋帶 projectId，各 query 取最好）`,
    '',
    ...(primaryRan
      ? []
      : [
          `> 注意：本次矩陣沒有跑主口徑（${PRIMARY_MODE}／${PRIMARY_SCOPE}），下表只有搜尋前就能判定的階段，其餘記 not_run；請看各格明細。`,
          '',
        ]),
    ...table(
      ['題目', '事實', '敘述', '卡在哪一步', '最好的 query', '無效格'],
      result.questions.flatMap((question) =>
        question.facts.map((fact) => [
          question.id,
          fact.id,
          fact.text,
          stageWithRank(fact.primary.stage, fact.primary.rank10, fact.primary.rank50),
          fact.primary.bestQuery ?? '—',
          String(fact.primary.invalidCells),
        ])
      )
    ),
  ];

  for (const question of result.questions) {
    lines.push(
      '',
      `## ${question.id}（${question.project}）各格明細`,
      '',
      ...table(
        [
          'query',
          'mode',
          'scope',
          '狀態 (10/50)',
          'coverage@10',
          'precision@10',
          '首筆證據名次 (10/50)',
          ...question.facts.map((fact) => fact.id),
        ],
        question.cells.map((cell) => [
          cell.queryName,
          cell.mode,
          cell.scope,
          `${cell.status10} / ${cell.status50}`,
          fmtPct(cell.factCoverage10),
          fmtNum(cell.strictPrecision10),
          `${cell.firstEvidenceRank10 ?? '—'} / ${cell.firstEvidenceRank50 ?? '—'}`,
          ...cell.facts.map((fact) => {
            const stale = fact.staleBeforeEvidence10 === true ? '，stale 在前' : '';
            return `${stageWithRank(fact.stage, fact.rank10, fact.rank50)}${stale}`;
          }),
        ])
      )
    );
    const problems = question.evidence.filter((record) => record.verdict !== 'valid');
    if (problems.length > 0) {
      lines.push(
        '',
        '證據核對異常：',
        '',
        ...table(
          ['事實', 'kind', 'id', '判定', 'DB status'],
          problems.map((record) => [record.factId, record.kind, record.id, record.verdict, record.dbStatus ?? '不存在'])
        )
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
