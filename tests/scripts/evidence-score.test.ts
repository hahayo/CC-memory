// tests/scripts/evidence-score.test.ts
//
// 檢索證據評測的純函式測試。內容全為虛構，不連 DB。

import { describe, expect, it } from 'vitest';
import {
  aggregateByModeScope,
  buildFactInputs,
  classifyEvidence,
  evidenceChanged,
  searchStage,
  countStages,
  FULL_MATRIX,
  parseMatrixFilter,
  hitKey,
  normalizeResultKind,
  parseLabelFile,
  preSearchStage,
  primaryFactStage,
  runStatus,
  scoreCell,
  type BenchMode,
  type BenchScope,
  type CellRuns,
  type FactInput,
  type LabelQuestion,
  type SearchRun,
} from '../../scripts/lib/evidence-score.js';
import { LIMITATION_NOTE, REDIRECT_NOTE, renderEvidenceReport, type BenchResult } from '../../scripts/lib/evidence-report.js';

const id = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const obs = (n: number): { kind: 'observation'; id: string } => ({ kind: 'observation', id: id(n) });

function run(limit: number, hitIds: number[], overrides: Partial<SearchRun> = {}): SearchRun {
  return {
    limit,
    status: 'ok',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    latencyMs: 5,
    hits: hitIds.map(obs),
    ...overrides,
  };
}

function cell(top10: SearchRun | null, top50: SearchRun | null, extra: Partial<CellRuns> = {}): CellRuns {
  return { queryName: 'q', mode: 'hybrid', scope: 'project', top10, top50, ...extra };
}

function fact(factId: string, validIds: number[], extra: Partial<FactInput> = {}): FactInput {
  return {
    factId,
    preStage: null,
    validKeys: validIds.map((n) => hitKey('observation', id(n))),
    distractorKeys: [],
    validEvidenceOutsideProject: false,
    ...extra,
  };
}

describe('parseLabelFile', () => {
  const valid = {
    version: 1,
    questions: [
      {
        id: 'QX',
        project: 'fictional-project',
        queries: [{ name: 'question', text: '虛構問題' }],
        facts: [
          {
            id: 'QX-F1',
            text: '虛構事實',
            status: 'labeled',
            evidence: [{ kind: 'memory', id: id(1), content_hash: null }],
          },
          { id: 'QX-F2', text: '虛構事實二', status: 'not_in_db' },
        ],
      },
    ],
  };

  it('接受合法標註並補預設空陣列', () => {
    const parsed = parseLabelFile(JSON.stringify(valid));
    expect(parsed.questions[0]!.facts[1]!.evidence).toEqual([]);
    expect(parsed.questions[0]!.facts[1]!.stale_distractors).toEqual([]);
  });

  it('labeled 沒有 evidence 要拒絕', () => {
    const bad = structuredClone(valid);
    bad.questions[0]!.facts[0]!.evidence = [];
    expect(() => parseLabelFile(JSON.stringify(bad))).toThrow(/至少要有一筆 evidence/);
  });

  it('id 不是 UUID、未知欄位都要拒絕', () => {
    const badId = structuredClone(valid);
    badId.questions[0]!.facts[0]!.evidence![0]!.id = 'not-a-uuid';
    expect(() => parseLabelFile(JSON.stringify(badId))).toThrow(/UUID/);
    const extra = { ...valid, extra: true };
    expect(() => parseLabelFile(JSON.stringify(extra))).toThrow(/格式錯誤/);
  });
});

describe('classifyEvidence', () => {
  it('不存在或非 active → missing', () => {
    expect(classifyEvidence('h', null)).toBe('missing');
    expect(classifyEvidence('h', { status: 'archived', contentHash: 'h' })).toBe('missing');
  });
  it('hash 不同（含 DB 為 null）→ stale_label；null 對 null → valid', () => {
    expect(classifyEvidence('h1', { status: 'active', contentHash: 'h2' })).toBe('stale_label');
    expect(classifyEvidence('h1', { status: 'active', contentHash: null })).toBe('stale_label');
    expect(classifyEvidence(null, { status: 'active', contentHash: null })).toBe('valid');
    expect(classifyEvidence('h1', { status: 'active', contentHash: 'h1' })).toBe('valid');
  });
});

describe('normalizeResultKind', () => {
  it('manual 與 rollup 都對到 memory', () => {
    expect(normalizeResultKind('manual')).toBe('memory');
    expect(normalizeResultKind('rollup')).toBe('memory');
    expect(normalizeResultKind('observation')).toBe('observation');
  });
  it('rollup 結果能命中 kind=memory 的證據', () => {
    const top10 = run(10, []);
    top10.hits = [{ kind: normalizeResultKind('rollup'), id: id(9) }];
    const facts: FactInput[] = [{ factId: 'F', preStage: null, validKeys: [hitKey('memory', id(9))], distractorKeys: [], validEvidenceOutsideProject: false }];
    expect(scoreCell(facts, cell(top10, top10)).facts[0]!.rank10).toBe(1);
  });
});

describe('preSearchStage', () => {
  it('not_in_db 與 unlabeled 照標註', () => {
    expect(preSearchStage('not_in_db', [])).toBe('not_in_db');
    expect(preSearchStage('unlabeled', ['valid'])).toBe('unlabeled');
  });
  it('有 valid 就可評；沒 valid 時 stale 優先於 missing', () => {
    expect(preSearchStage('labeled', ['missing', 'valid'])).toBeNull();
    expect(preSearchStage('labeled', ['missing', 'stale_label'])).toBe('stale_label');
    expect(preSearchStage('labeled', ['missing'])).toBe('evidence_missing');
  });
});

describe('runStatus', () => {
  it('semantic／hybrid 降成 keyword → degraded；keyword 本來就是 keyword → ok', () => {
    expect(runStatus('hybrid', 'keyword', false)).toBe('degraded');
    expect(runStatus('semantic', 'keyword', false)).toBe('degraded');
    expect(runStatus('keyword', 'keyword', false)).toBe('ok');
    expect(runStatus('hybrid', null, true)).toBe('error');
  });
});

describe('scoreCell', () => {
  it('strict_precision@10 分母固定是 10', () => {
    const score = scoreCell([fact('F1', [1])], cell(run(10, [1, 2]), run(50, [1, 2])));
    expect(score.strictPrecision10).toBe(0.1);
    expect(score.factCoverage10).toBe(1);
    expect(score.hit10).toBe(true);
    expect(score.firstEvidenceRank10).toBe(1);
  });

  it('limit=10 與 limit=50 分開判：前 10 用 limit=10 那次的結果', () => {
    // limit=50 那次證據排第 3，但 limit=10 那次沒出現 → 不算進前 10
    const score = scoreCell([fact('F1', [7])], cell(run(10, [1, 2, 3]), run(50, [1, 2, 7])));
    expect(score.facts[0]).toMatchObject({ stage: 'in_top50_not_top10', rank10: null, rank50: 3 });
    expect(score.factCoverage10).toBe(0);
    // 反過來：limit=10 有、limit=50 沒有，仍是 in_top10
    const reverse = scoreCell([fact('F1', [7])], cell(run(10, [7]), run(50, [1])));
    expect(reverse.facts[0]).toMatchObject({ stage: 'in_top10', rank10: 1, rank50: null });
  });

  it('都沒出現 → not_in_top50', () => {
    const score = scoreCell([fact('F1', [7])], cell(run(10, [1]), run(50, [1, 2])));
    expect(score.facts[0]!.stage).toBe('not_in_top50');
  });

  it('stale_label／not_in_db 不算命中也不算漏：不進分母', () => {
    const facts = [
      fact('F1', [1]),
      fact('F2', [], { preStage: 'stale_label' }),
      fact('F3', [], { preStage: 'not_in_db' }),
    ];
    const score = scoreCell(facts, cell(run(10, [1]), run(50, [1])));
    expect(score.evaluableFacts).toBe(1);
    expect(score.factCoverage10).toBe(1);
    expect(score.facts.map((f) => f.stage)).toEqual(['in_top10', 'stale_label', 'not_in_db']);
  });

  it('沒有可評事實時指標是 null，不是 0', () => {
    const score = scoreCell([fact('F1', [], { preStage: 'stale_label' })], cell(run(10, [1]), run(50, [1])));
    expect(score.factCoverage10).toBeNull();
    expect(score.strictPrecision10).toBeNull();
    expect(score.hit10).toBeNull();
  });

  it('degraded 不計分：指標 null、階段標 degraded', () => {
    const degraded = run(10, [1], { status: 'degraded', effectiveMode: 'keyword' });
    const score = scoreCell([fact('F1', [1])], cell(degraded, run(50, [1])));
    expect(score.factCoverage10).toBeNull();
    expect(score.strictPrecision10).toBeNull();
    // limit=50 正常命中：保留前 50 的結果，前 10 標未知
    expect(score.facts[0]).toMatchObject({ stage: 'in_top50_top10_unknown', rank10: null, rank50: 1 });
    const bothDegraded = scoreCell([fact('F1', [1])], cell(degraded, { ...degraded, limit: 50 }));
    expect(bothDegraded.facts[0]!.stage).toBe('degraded');
  });

  it('limit=10 正常但沒命中、limit=50 出錯 → not_in_top10（前 50 未知），不是 not_in_top50', () => {
    const score = scoreCell([fact('F1', [7])], cell(run(10, [1]), run(50, [], { status: 'error' })));
    expect(score.facts[0]!.stage).toBe('not_in_top10');
    expect(score.factCoverage10).toBe(0);
    expect(score.firstEvidenceRank50).toBeNull();
  });

  it('stale_distractor 排在第一筆 valid 證據之前；證據沒出現而 distractor 出現也算', () => {
    const distractor = { distractorKeys: [hitKey('observation', id(5))] };
    const before = scoreCell([fact('F1', [1], distractor)], cell(run(10, [5, 1]), run(50, [5, 1])));
    expect(before.facts[0]!.staleBeforeEvidence10).toBe(true);
    const after = scoreCell([fact('F1', [1], distractor)], cell(run(10, [1, 5]), run(50, [1, 5])));
    expect(after.facts[0]!.staleBeforeEvidence10).toBe(false);
    const onlyStale = scoreCell([fact('F1', [1], distractor)], cell(run(10, [5]), run(50, [5])));
    expect(onlyStale.facts[0]!.staleBeforeEvidence10).toBe(true);
    const none = scoreCell([fact('F1', [1])], cell(run(10, [5]), run(50, [5])));
    expect(none.facts[0]!.staleBeforeEvidence10).toBeNull();
  });
});

describe('primaryFactStage', () => {
  const mk = (queryName: string, top10: SearchRun, top50: SearchRun, mode: BenchMode = 'hybrid', scope: BenchScope = 'project') =>
    scoreCell([fact('F1', [7])], cell(top10, top50, { queryName, mode, scope }));

  it('只看 hybrid＋project，各 query 取最好', () => {
    const cells = [
      mk('a', run(10, [1]), run(50, [1])),
      mk('b', run(10, [1]), run(50, [1, 7])),
      mk('c', run(10, [7]), run(50, [7]), 'keyword'),
    ];
    expect(primaryFactStage('F1', cells)).toMatchObject({ stage: 'in_top50_not_top10', bestQuery: 'b', rank50: 2 });
  });

  it('主口徑全部 degraded → degraded，不是漏', () => {
    const degraded = run(10, [], { status: 'degraded', effectiveMode: 'keyword' });
    const cells = [mk('a', degraded, degraded), mk('b', degraded, degraded)];
    expect(primaryFactStage('F1', cells)).toMatchObject({ stage: 'degraded', invalidCells: 2 });
  });

  it('部分格子無效時記數', () => {
    const cells = [mk('a', run(10, [], { status: 'error' }), run(50, [])), mk('b', run(10, [1]), run(50, [1]))];
    expect(primaryFactStage('F1', cells)).toMatchObject({ stage: 'not_in_top50', invalidCells: 1 });
  });
});

describe('aggregateByModeScope', () => {
  it('degraded／error 與無可評事實的格子不進平均', () => {
    const ok = scoreCell([fact('F1', [1])], cell(run(10, [1]), run(50, [1])));
    const miss = scoreCell([fact('F1', [1])], cell(run(10, [2]), run(50, [2])));
    const degraded = scoreCell(
      [fact('F1', [1])],
      cell(run(10, [], { status: 'degraded', effectiveMode: 'keyword' }), run(50, []))
    );
    const agg = aggregateByModeScope([ok, miss, degraded]).find((a) => a.mode === 'hybrid' && a.scope === 'project')!;
    expect(agg).toMatchObject({ scoredCells: 2, meanFactCoverage10: 0.5, hitRate10: 0.5, degraded10: 1 });
    // 沒跑的 mode×scope 不出現
    expect(aggregateByModeScope([ok]).find((a) => a.mode === 'keyword' && a.scope === 'global')).toBeUndefined();
    const noEvaluable = scoreCell([fact('F1', [], { preStage: 'stale_label' })], cell(run(10, [1]), run(50, [1])));
    expect(aggregateByModeScope([noEvaluable])[0]!.meanFactCoverage10).toBeNull();
  });
});

describe('renderEvidenceReport', () => {
  it('開頭有限制說明', () => {
    const result: BenchResult = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      labelsPath: '/fake/labels.json',
      matrix: { modes: ['hybrid'], scopes: ['global'], limits: [10] },
      dataVersion: {
        gitHead: 'abc',
        gitDirty: false,
        embeddingProvider: 'local',
        embeddingEndpointHost: '127.0.0.1:8790',
        embeddingEndpointLoopback: true,
        readOnly: 'on',
        poolMax: 5,
        env: {},
        activeCounts: { observations: 1, projectMemories: 1 },
      },
      aggregates: [],
      counts: { evidenceValid: 0, evidenceStaleLabel: 0, evidenceMissing: 0, evidenceChangedDuringRun: 0, runsOk: 0, runsDegraded: 0, runsError: 0, primaryStages: [], outOfScopeFactCells: 0 },
      questions: [],
    };
    const report = renderEvidenceReport(result);
    expect(report.split('\n').slice(0, 4).join('\n')).toContain(LIMITATION_NOTE);
    expect(report).toContain(REDIRECT_NOTE);
    expect(report).toContain('向量端點主機：127.0.0.1:8790（本機）');
    expect(report).toContain('執行期間變動的證據 0 筆');
    // 矩陣沒跑主口徑（hybrid／project）要註明
    expect(report).toContain('本次矩陣沒有跑主口徑');
    expect(report).toContain('## 前 10 名組成');
  });
});

describe('parseMatrixFilter', () => {
  it('沒給參數＝全部（與舊行為相同）', () => {
    expect(parseMatrixFilter({})).toEqual(FULL_MATRIX);
    expect(FULL_MATRIX.limits).toEqual([10, 50]);
  });
  it('依固定順序去重、去空白', () => {
    expect(parseMatrixFilter({ modes: 'hybrid, keyword,hybrid', scopes: 'project', limits: '50,10' })).toEqual({
      modes: ['keyword', 'hybrid'],
      scopes: ['project'],
      limits: [10, 50],
    });
  });
  it('非法值或空值中止', () => {
    expect(() => parseMatrixFilter({ modes: 'fuzzy' })).toThrow(/--modes/);
    expect(() => parseMatrixFilter({ scopes: 'all' })).toThrow(/--scopes/);
    expect(() => parseMatrixFilter({ limits: '20' })).toThrow(/--limits/);
    expect(() => parseMatrixFilter({ limits: ',' })).toThrow(/不可為空/);
  });
});

describe('只跑單邊 limit', () => {
  it('只跑 limit=10：只分 in_top10／not_in_top10，不假裝知道 top50', () => {
    const hit = scoreCell([fact('F1', [1])], { queryName: 'q', mode: 'hybrid', scope: 'project', top10: run(10, [1]), top50: null });
    expect(hit.facts[0]).toMatchObject({ stage: 'in_top10', rank50: null });
    expect(hit.status50).toBe('not_run');
    expect(hit.firstEvidenceRank50).toBeNull();
    const miss = scoreCell([fact('F1', [7])], { queryName: 'q', mode: 'hybrid', scope: 'project', top10: run(10, [1]), top50: null });
    expect(miss.facts[0]!.stage).toBe('not_in_top10');
    expect(miss.factCoverage10).toBe(0);
  });
  it('只跑 limit=50：@10 指標為 null，階段 in_top50／not_in_top50', () => {
    const score = scoreCell([fact('F1', [1])], { queryName: 'q', mode: 'hybrid', scope: 'project', top10: null, top50: run(50, [2, 1]) });
    expect(score.facts[0]).toMatchObject({ stage: 'in_top50', rank50: 2 });
    expect(score.factCoverage10).toBeNull();
    expect(score.top10Kinds).toBeNull();
  });
});

describe('out_of_scope', () => {
  const outside = fact('F2', [9], { validEvidenceOutsideProject: true });
  it('scope=project：證據全在別的 project → out_of_scope，不計入可評事實', () => {
    const score = scoreCell([fact('F1', [1]), outside], cell(run(10, [1]), run(50, [1])));
    expect(score.facts[1]!.stage).toBe('out_of_scope');
    expect(score.evaluableFacts).toBe(1);
    expect(score.factCoverage10).toBe(1);
  });
  it('scope=global 不受影響', () => {
    const score = scoreCell([fact('F1', [1]), outside], cell(run(10, [9]), run(50, [9]), { scope: 'global' }));
    expect(score.facts[1]!.stage).toBe('in_top10');
    expect(score.evaluableFacts).toBe(2);
  });
  it('主口徑與計數反映 out_of_scope', () => {
    const cells = [scoreCell([outside], cell(run(10, [1]), run(50, [1])))];
    expect(primaryFactStage('F2', cells).stage).toBe('out_of_scope');
    expect(countStages(['out_of_scope', 'in_top10', 'out_of_scope'])).toEqual([
      { stage: 'out_of_scope', count: 2 },
      { stage: 'in_top10', count: 1 },
    ]);
  });
});

describe('主口徑被篩掉', () => {
  it('沒有 hybrid＋project 格：pre-search 階段照列，其餘 not_run', () => {
    const cells = [scoreCell([fact('F1', [1])], cell(run(10, [1]), run(50, [1]), { mode: 'keyword' }))];
    expect(primaryFactStage('F1', cells).stage).toBe('not_run');
    expect(primaryFactStage('F1', cells, 'not_in_db').stage).toBe('not_in_db');
  });
});

describe('前 10 名組成', () => {
  it('依回傳 kind 計數，彙總只含有跑的 mode×scope', () => {
    const top10 = run(10, []);
    top10.hits = [
      { kind: 'memory', id: id(1) },
      { kind: 'observation', id: id(2) },
      { kind: 'observation', id: id(3) },
    ];
    const score = scoreCell([fact('F1', [2])], cell(top10, null));
    expect(score.top10Kinds).toEqual({ memory: 1, observation: 2 });
    const aggs = aggregateByModeScope([score]);
    expect(aggs).toHaveLength(1);
    expect(aggs[0]).toMatchObject({ mode: 'hybrid', scope: 'project', meanTop10Memory: 1, meanTop10Observation: 2 });
  });
});

describe('searchStage：limit=10 與 limit=50 分開判', () => {
  const degraded10 = run(10, [], { status: 'degraded', effectiveMode: 'keyword' });
  it('limit=10 降級、limit=50 命中 → in_top50_top10_unknown', () => {
    expect(searchStage(degraded10, run(50, [1, 2, 7]), null, 3)).toBe('in_top50_top10_unknown');
  });
  it('limit=10 降級、limit=50 正常沒命中 → not_in_top50（沒進前 50 就不會進前 10）', () => {
    expect(searchStage(degraded10, run(50, [1]), null, null)).toBe('not_in_top50');
  });
  it('limit=10 正常沒命中、limit=50 出錯 → not_in_top10', () => {
    expect(searchStage(run(10, [1]), run(50, [], { status: 'error' }), null, null)).toBe('not_in_top10');
  });
  it('兩邊都不能用 → error 優先於 degraded', () => {
    expect(searchStage(degraded10, run(50, [], { status: 'error' }), null, null)).toBe('error');
    expect(searchStage(degraded10, run(50, [], { status: 'degraded' }), null, null)).toBe('degraded');
  });
});

describe('primaryFactStage：已確認的前 50 名命中不可被報成沒命中', () => {
  it('query A limit=10 降級、limit=50 命中第 3；query B 都正常沒命中 → 主摘要是 A 的 in_top50_top10_unknown', () => {
    const degraded10 = run(10, [], { status: 'degraded', effectiveMode: 'keyword' });
    const cells = [
      scoreCell([fact('F1', [7])], cell(degraded10, run(50, [1, 2, 7]), { queryName: 'A' })),
      scoreCell([fact('F1', [7])], cell(run(10, [1]), run(50, [1, 2]), { queryName: 'B' })),
    ];
    expect(primaryFactStage('F1', cells)).toMatchObject({
      stage: 'in_top50_top10_unknown',
      bestQuery: 'A',
      rank50: 3,
      invalidCells: 1,
    });
  });
  it('前 10 未知排在「確定不在前 10」之前', () => {
    const degraded10 = run(10, [], { status: 'degraded', effectiveMode: 'keyword' });
    const cells = [
      scoreCell([fact('F1', [7])], cell(run(10, [1]), run(50, [1, 7]), { queryName: 'A' })),
      scoreCell([fact('F1', [7])], cell(degraded10, run(50, [7]), { queryName: 'B' })),
    ];
    expect(primaryFactStage('F1', cells).stage).toBe('in_top50_top10_unknown');
  });
});

describe('執行期間證據變動（重核對）', () => {
  const question: LabelQuestion = {
    id: 'QX',
    project: 'proj-a',
    queries: [{ name: 'q', text: '虛構' }],
    facts: [
      { id: 'F1', text: '虛構', status: 'labeled', evidence: [{ kind: 'observation', id: id(1), content_hash: 'h' }], stale_distractors: [] },
    ],
  };
  const snap = { status: 'active', contentHash: 'h', projectId: 'proj-a' };

  it('evidenceChanged：hash／status／project／出現消失任一變動都算', () => {
    expect(evidenceChanged(snap, { ...snap })).toBe(false);
    expect(evidenceChanged(snap, { ...snap, contentHash: 'h2' })).toBe(true);
    expect(evidenceChanged(snap, { ...snap, status: 'archived' })).toBe(true);
    expect(evidenceChanged(snap, { ...snap, projectId: 'proj-b' })).toBe(true);
    expect(evidenceChanged(snap, null)).toBe(true);
    expect(evidenceChanged(null, null)).toBe(false);
  });

  it('改判 stale_label 後重新計分：原本的命中不再算', () => {
    const record = { factId: 'F1', kind: 'observation' as const, id: id(1), dbProjectId: 'proj-a' };
    const beforeInputs = buildFactInputs(question, [{ ...record, verdict: 'valid' }]);
    const afterInputs = buildFactInputs(question, [{ ...record, verdict: 'stale_label' }]);
    const runs = cell(run(10, [1]), run(50, [1]));
    expect(scoreCell(beforeInputs, runs).facts[0]!.stage).toBe('in_top10');
    const rescored = scoreCell(afterInputs, runs);
    expect(rescored.facts[0]!.stage).toBe('stale_label');
    expect(rescored.evaluableFacts).toBe(0);
    expect(rescored.factCoverage10).toBeNull();
  });

  it('buildFactInputs：證據全在別的 project 才標 validEvidenceOutsideProject', () => {
    const base = { factId: 'F1', kind: 'observation' as const, id: id(1), verdict: 'valid' as const };
    expect(buildFactInputs(question, [{ ...base, dbProjectId: 'proj-b' }])[0]!.validEvidenceOutsideProject).toBe(true);
    expect(buildFactInputs(question, [{ ...base, dbProjectId: 'proj-a' }])[0]!.validEvidenceOutsideProject).toBe(false);
  });
});
