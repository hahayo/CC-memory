// tests/services/search-ranking.test.ts
//
// Pure unit tests for session-recency weighting and rollup floor logic.
// No DB required — exercises sortWeightedIndexCandidates directly with fixtures.

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MemoryIndexResult, SearchResultKind } from '../../src/services/types.js';
import type { IndexSearchCandidate } from '../../src/services/observations.js';
import {
  sortWeightedIndexCandidates,
  candidateFetchLimit,
  hybridRankLists,
  applyObservationReserve,
  type SourceWeights,
  type SessionRecencyConfig,
  type WeightedIndexCandidate,
} from '../../src/services/memories.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PROJECT = 'test-project';

const DEFAULT_WEIGHTS: SourceWeights = {
  manual: 1,
  rollup: 0.85,
  observationDecision: 0.8,
  observationAuto: 0.65,
};

/** Recency disabled — identical to pre-feature behavior. */
const RECENCY_OFF: SessionRecencyConfig = { recencyMin: 1.0, rollupFloor: 0 };

/** Default recency config matching production defaults. */
const RECENCY_ON: SessionRecencyConfig = { recencyMin: 0.9, rollupFloor: 1 };

function makeResult(overrides: Partial<MemoryIndexResult> = {}): MemoryIndexResult {
  return {
    id: randomUUID(),
    projectId: PROJECT,
    kind: 'manual' as SearchResultKind,
    type: 'session',
    title: 'test',
    subtitle: null,
    sessionId: null,
    discoveryTokens: null,
    occurredAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function makeCandidate(
  overrides: {
    result?: Partial<MemoryIndexResult>;
    baseScore?: number;
    semanticScore?: number | null;
    sourceOrder?: number;
  } = {}
): IndexSearchCandidate {
  const kind = overrides.result?.kind ?? 'manual';
  const defaultSourceOrder =
    kind === 'manual' ? 0 : kind === 'rollup' ? 1 : overrides.result?.type === 'decision' ? 2 : 3;
  return {
    result: makeResult(overrides.result),
    baseScore: overrides.baseScore ?? 1,
    semanticScore: overrides.semanticScore ?? null,
    sourceOrder: overrides.sourceOrder ?? defaultSourceOrder,
  };
}

function ids(sorted: WeightedIndexCandidate[]): string[] {
  return sorted.map((c) => c.result.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sortWeightedIndexCandidates — session recency', () => {
  // -----------------------------------------------------------------------
  // Regression: recency OFF matches original behavior
  // -----------------------------------------------------------------------
  it('recency OFF produces identical order to pre-feature logic', () => {
    const sessionId = 'sess-A';
    const early = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 0.95,
    });
    const late = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 0.9,
    });

    const sorted = sortWeightedIndexCandidates([late, early], DEFAULT_WEIGHTS, RECENCY_OFF);
    // With recency off: early has 0.95*0.65=0.6175, late has 0.9*0.65=0.585
    // Early should come first (higher weighted score)
    expect(ids(sorted)).toEqual([early.result.id, late.result.id]);
  });

  // -----------------------------------------------------------------------
  // Core: later observation outranks earlier one within same session
  // -----------------------------------------------------------------------
  it('later observation outranks earlier when recency compensates for lower baseScore', () => {
    const sessionId = 'sess-A';
    // Early has slightly higher baseScore, but recency pulls it down
    const early = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 0.95,
    });
    const late = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 0.9,
    });

    const sorted = sortWeightedIndexCandidates([early, late], DEFAULT_WEIGHTS, RECENCY_ON);
    // early: 0.95 * 0.65 * 0.9 = 0.55575
    // late:  0.90 * 0.65 * 1.0 = 0.585
    // late should win
    expect(ids(sorted)).toEqual([late.result.id, early.result.id]);
    expect(sorted[0].weightedScore).toBeCloseTo(0.585);
    expect(sorted[1].weightedScore).toBeCloseTo(0.55575);
  });

  // -----------------------------------------------------------------------
  // Same baseScore, same session → later observation wins
  // -----------------------------------------------------------------------
  it('same baseScore observations: later wins with recency on', () => {
    const sessionId = 'sess-B';
    const early = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 1,
    });
    const late = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
    });

    const sorted = sortWeightedIndexCandidates([early, late], DEFAULT_WEIGHTS, RECENCY_ON);
    // early: 1 * 0.65 * 0.9 = 0.585
    // late:  1 * 0.65 * 1.0 = 0.65
    expect(ids(sorted)).toEqual([late.result.id, early.result.id]);
  });

  // -----------------------------------------------------------------------
  // Different sessions: no cross-session recency interaction
  // -----------------------------------------------------------------------
  it('observations in different sessions are not affected by each other', () => {
    const earlyA = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId: 'sess-A',
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 1,
    });
    const earlyB = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId: 'sess-B',
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 1,
    });

    const sorted = sortWeightedIndexCandidates(
      [earlyA, earlyB],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // Both are the only item in their session → multiplier = 1.0
    // Same weighted score → tie-break by sourceOrder (same), baseScore (same), occurredAt (same)
    expect(sorted[0].weightedScore).toEqual(sorted[1].weightedScore);
    expect(sorted[0].weightedScore).toBeCloseTo(0.65);
  });

  // -----------------------------------------------------------------------
  // Manual memories remain highest priority regardless of recency
  // -----------------------------------------------------------------------
  it('manual memories are unaffected by recency and stay on top', () => {
    const manual = makeCandidate({
      result: { kind: 'manual' },
      baseScore: 0.7,
    });
    const lateObs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId: 'sess-A',
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
    });

    const sorted = sortWeightedIndexCandidates(
      [lateObs, manual],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // manual: 0.7 * 1.0 = 0.7
    // lateObs: 1.0 * 0.65 * 1.0 = 0.65 (only item in session → 1.0 multiplier)
    expect(sorted[0].result.kind).toBe('manual');
    expect(sorted[0].weightedScore).toBeCloseTo(0.7);
  });

  // -----------------------------------------------------------------------
  // Dense-rank: same occurredAt → same multiplier
  // -----------------------------------------------------------------------
  it('observations with identical occurredAt get the same recency multiplier', () => {
    const sessionId = 'sess-C';
    const sameTime = new Date('2026-07-01T00:30:00Z');
    const obs1 = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: sameTime,
      },
      baseScore: 1,
    });
    const obs2 = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: sameTime,
      },
      baseScore: 1,
    });
    const late = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
    });

    const sorted = sortWeightedIndexCandidates(
      [obs1, obs2, late],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // obs1 and obs2 share rank 0 (earliest), late is rank 1
    // obs1/obs2: 1 * 0.65 * 0.9 = 0.585
    // late: 1 * 0.65 * 1.0 = 0.65
    expect(sorted[0].result.id).toBe(late.result.id);
    expect(sorted[1].weightedScore).toBeCloseTo(sorted[2].weightedScore);
    expect(sorted[1].weightedScore).toBeCloseTo(0.585);
  });

  // -----------------------------------------------------------------------
  // Three observations in same session: linear interpolation
  // -----------------------------------------------------------------------
  it('three observations get linearly interpolated multipliers', () => {
    const sessionId = 'sess-D';
    const obs1 = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 1,
    });
    const obs2 = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T00:30:00Z'),
      },
      baseScore: 1,
    });
    const obs3 = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
    });

    const sorted = sortWeightedIndexCandidates(
      [obs1, obs2, obs3],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // recencyMin=0.9: rank0→0.9, rank1→0.95, rank2→1.0
    // obs1: 1*0.65*0.9 = 0.585, obs2: 1*0.65*0.95 = 0.6175, obs3: 1*0.65*1.0 = 0.65
    expect(ids(sorted)).toEqual([obs3.result.id, obs2.result.id, obs1.result.id]);
    expect(sorted[0].weightedScore).toBeCloseTo(0.65);
    expect(sorted[1].weightedScore).toBeCloseTo(0.6175);
    expect(sorted[2].weightedScore).toBeCloseTo(0.585);
  });

  // -----------------------------------------------------------------------
  // Single observation in session gets multiplier 1.0 (no penalty)
  // -----------------------------------------------------------------------
  it('single observation in a session is unpenalized', () => {
    const obs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId: 'sess-solo',
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 1,
    });

    const sorted = sortWeightedIndexCandidates([obs], DEFAULT_WEIGHTS, RECENCY_ON);
    expect(sorted[0].weightedScore).toBeCloseTo(0.65); // 1 * 0.65 * 1.0
  });
});

describe('sortWeightedIndexCandidates — rollup session floor', () => {
  // -----------------------------------------------------------------------
  // Rollup does not fall below its session's observation scores
  // -----------------------------------------------------------------------
  it('rollup is floored at max observation weightedScore in same session', () => {
    const sessionId = 'sess-R';
    const rollup = makeCandidate({
      result: {
        kind: 'rollup',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T02:00:00Z'),
      },
      baseScore: 0.5,
      sourceOrder: 1,
    });
    const obs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 3,
    });

    const sorted = sortWeightedIndexCandidates(
      [obs, rollup],
      DEFAULT_WEIGHTS,
      { recencyMin: 1, rollupFloor: 1 } // recency off, floor on
    );
    // obs: 1 * 0.65 = 0.65
    // rollup initial: 0.5 * 0.85 = 0.425, floored to 0.65
    // Tie → sourceOrder: rollup=1 < obs=3 → rollup first
    expect(sorted[0].result.kind).toBe('rollup');
    expect(sorted[0].weightedScore).toBeCloseTo(0.65);
    expect(sorted[1].result.kind).toBe('observation');
  });

  // -----------------------------------------------------------------------
  // Rollup floor OFF: rollup can rank below its observations
  // -----------------------------------------------------------------------
  it('rollup floor OFF: rollup stays at its natural score', () => {
    const sessionId = 'sess-R';
    const rollup = makeCandidate({
      result: {
        kind: 'rollup',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T02:00:00Z'),
      },
      baseScore: 0.5,
      sourceOrder: 1,
    });
    const obs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 3,
    });

    const sorted = sortWeightedIndexCandidates(
      [obs, rollup],
      DEFAULT_WEIGHTS,
      { recencyMin: 1, rollupFloor: 0 } // both off
    );
    // obs: 1 * 0.65 = 0.65 > rollup: 0.5 * 0.85 = 0.425
    expect(sorted[0].result.kind).toBe('observation');
    expect(sorted[1].result.kind).toBe('rollup');
    expect(sorted[1].weightedScore).toBeCloseTo(0.425);
  });

  // -----------------------------------------------------------------------
  // Rollup already above observations: floor is a no-op
  // -----------------------------------------------------------------------
  it('rollup already above observations is not changed by floor', () => {
    const sessionId = 'sess-R2';
    const rollup = makeCandidate({
      result: {
        kind: 'rollup',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T02:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 1,
    });
    const obs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 0.5,
      sourceOrder: 3,
    });

    const sorted = sortWeightedIndexCandidates(
      [obs, rollup],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // rollup: 1 * 0.85 = 0.85, obs: 0.5 * 0.65 = 0.325 (single obs → no recency penalty)
    // Rollup already above → floor no-op
    expect(sorted[0].result.kind).toBe('rollup');
    expect(sorted[0].weightedScore).toBeCloseTo(0.85);
  });

  // -----------------------------------------------------------------------
  // Cross-session: rollup floor does not leak across sessions
  // -----------------------------------------------------------------------
  it('rollup floor does not apply across different sessions', () => {
    const rollup = makeCandidate({
      result: {
        kind: 'rollup',
        type: 'session',
        sessionId: 'sess-X',
        occurredAt: new Date('2026-07-01T02:00:00Z'),
      },
      baseScore: 0.5,
      sourceOrder: 1,
    });
    const obs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId: 'sess-Y', // different session
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 3,
    });

    const sorted = sortWeightedIndexCandidates(
      [obs, rollup],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // No floor: rollup stays at 0.5*0.85=0.425
    expect(sorted[0].result.kind).toBe('observation');
    expect(sorted[1].weightedScore).toBeCloseTo(0.425);
  });
});

describe('sortWeightedIndexCandidates — combined recency + rollup floor', () => {
  it('rollup floors after recency adjustment has been applied to observations', () => {
    const sessionId = 'sess-combo';
    const rollup = makeCandidate({
      result: {
        kind: 'rollup',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T02:00:00Z'),
      },
      baseScore: 0.5,
      sourceOrder: 1,
    });
    const earlyObs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 3,
    });
    const lateObs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 3,
    });

    const sorted = sortWeightedIndexCandidates(
      [earlyObs, lateObs, rollup],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // earlyObs: 1*0.65*0.9 = 0.585, lateObs: 1*0.65*1.0 = 0.65
    // rollup initial: 0.5*0.85 = 0.425, floored to max obs = 0.65
    // Rollup and lateObs tie at 0.65 → sourceOrder rollup=1 < obs=3 → rollup first
    expect(sorted[0].result.kind).toBe('rollup');
    expect(sorted[0].weightedScore).toBeCloseTo(0.65);
    expect(sorted[1].result.id).toBe(lateObs.result.id);
    expect(sorted[2].result.id).toBe(earlyObs.result.id);
  });

  it('decision observations still outrank auto observations within same session', () => {
    const sessionId = 'sess-types';
    const autoObs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'session',
        sessionId,
        occurredAt: new Date('2026-07-01T01:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 3,
    });
    const decisionObs = makeCandidate({
      result: {
        kind: 'observation',
        type: 'decision',
        sessionId,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
      baseScore: 1,
      sourceOrder: 2,
    });

    const sorted = sortWeightedIndexCandidates(
      [autoObs, decisionObs],
      DEFAULT_WEIGHTS,
      RECENCY_ON
    );
    // decision: 1*0.8*0.9 = 0.72 (early), auto: 1*0.65*1.0 = 0.65 (late)
    // decision still wins
    expect(sorted[0].result.type).toBe('decision');
    expect(sorted[0].weightedScore).toBeCloseTo(0.72);
  });

  it('does not mutate input candidates array', () => {
    const candidates: IndexSearchCandidate[] = [
      makeCandidate({
        result: { kind: 'observation', type: 'session', sessionId: 's1', occurredAt: new Date() },
        baseScore: 1,
      }),
    ];
    const copy = [...candidates];
    sortWeightedIndexCandidates(candidates, DEFAULT_WEIGHTS, RECENCY_ON);
    // Input array reference should be unchanged
    expect(candidates.length).toBe(copy.length);
    expect(candidates[0].result.id).toBe(copy[0].result.id);
    // Input candidate object should not have weightedScore added
    expect((candidates[0] as any).weightedScore).toBeUndefined();
  });
});

describe('candidateFetchLimit — over-sample control', () => {
  it('returns original limit when both recency and floor are disabled', () => {
    expect(candidateFetchLimit(5, RECENCY_OFF)).toBe(5);
    expect(candidateFetchLimit(1, RECENCY_OFF)).toBe(1);
    expect(candidateFetchLimit(50, RECENCY_OFF)).toBe(50);
  });

  it('over-samples by 3x when recency is enabled', () => {
    expect(candidateFetchLimit(5, { recencyMin: 0.9, rollupFloor: 0 })).toBe(15);
    expect(candidateFetchLimit(10, { recencyMin: 0.9, rollupFloor: 0 })).toBe(30);
  });

  it('over-samples by 3x when rollup floor is enabled', () => {
    expect(candidateFetchLimit(5, { recencyMin: 1.0, rollupFloor: 1 })).toBe(15);
  });

  it('over-samples by 3x when both are enabled', () => {
    expect(candidateFetchLimit(10, RECENCY_ON)).toBe(30);
  });

  it('caps only the over-sampled excess at 100; requested limit is always fetched in full', () => {
    expect(candidateFetchLimit(50, RECENCY_ON)).toBe(150); // 50 + min(100, 100)
    expect(candidateFetchLimit(100, RECENCY_ON)).toBe(200); // 100 + min(200, 100)
    expect(candidateFetchLimit(200, RECENCY_ON)).toBe(300); // 200 + min(400, 100)
  });

  it('limit=1 over-samples to 3 when active', () => {
    expect(candidateFetchLimit(1, RECENCY_ON)).toBe(3);
  });
});

describe('hybridRankLists — RRF rank grouping under over-sampling', () => {
  const tag = (prefix: string, n: number): IndexSearchCandidate[] =>
    Array.from({ length: n }, (_, i) => makeCandidate({ result: { title: `${prefix}${i}` } }));
  const titles = (lists: IndexSearchCandidate[][]): string[][] =>
    lists.map((l) => l.map((c) => c.result.title));

  it('returns a single concatenated list when not over-sampling (baseline behaviour)', () => {
    expect(titles(hybridRankLists(tag('m', 3), tag('o', 2), false))).toEqual([
      ['m0', 'm1', 'm2', 'o0', 'o1'],
    ]);
  });

  it('ranks memory and observation independently when over-sampling', () => {
    const lists = hybridRankLists(tag('m', 6), tag('o', 6), true);
    expect(titles(lists)).toEqual([
      ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'],
      ['o0', 'o1', 'o2', 'o3', 'o4', 'o5'],
    ]);
    // observation rank is independent of how many memories were fetched
    expect(lists[1][0].result.title).toBe('o0');
  });

  it('keeps an empty observation list as its own (empty) group when over-sampling', () => {
    expect(titles(hybridRankLists(tag('m', 4), [], true))).toEqual([['m0', 'm1', 'm2', 'm3'], []]);
  });
});

describe('applyObservationReserve — 前 limit 名保留觀察名額', () => {
  const rollups = (n: number): IndexSearchCandidate[] =>
    Array.from({ length: n }, (_, i) =>
      makeCandidate({ result: { kind: 'rollup', title: `r${i}`, sessionId: `s${i}` }, baseScore: 1 - i / 100 })
    );
  const observations = (n: number): IndexSearchCandidate[] =>
    Array.from({ length: n }, (_, i) =>
      makeCandidate({ result: { kind: 'observation', title: `o${i}`, sessionId: `s${i}` }, baseScore: 0.5 - i / 100 })
    );
  const titles = (list: IndexSearchCandidate[]): string[] => list.map((c) => c.result.title);

  it('ratio 0（關閉）時與 slice(0, limit) 完全相同', () => {
    const sorted = [...rollups(12), ...observations(5)];
    expect(applyObservationReserve(sorted, 10, 0)).toEqual(sorted.slice(0, 10));
  });

  it('候選數不超過 limit 時原樣回傳（沒有可補的）', () => {
    const sorted = [...rollups(4), ...observations(2)];
    expect(applyObservationReserve(sorted, 10, 0.4)).toEqual(sorted);
  });

  it('前 limit 名全是 rollup 時，尾端 rollup 讓位給排名最高的觀察（ceil(10×0.4)=4 筆）', () => {
    const sorted = [...rollups(12), ...observations(5)];
    const result = applyObservationReserve(sorted, 10, 0.4);
    expect(result).toHaveLength(10);
    expect(titles(result)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'o0', 'o1', 'o2', 'o3']);
  });

  it('前 limit 名已有足夠觀察時不動', () => {
    const sorted = [
      ...rollups(3),
      ...observations(4),
      ...rollups(3).map((c) => ({ ...c, result: { ...c.result, title: `${c.result.title}-late` } })),
      ...observations(2),
    ];
    const result = applyObservationReserve(sorted, 10, 0.4);
    expect(result).toEqual(sorted.slice(0, 10));
  });

  it('名額只補到候選裡有的觀察數，不會湊假的', () => {
    const sorted = [...rollups(12), ...observations(1)];
    const result = applyObservationReserve(sorted, 10, 0.4);
    expect(result).toHaveLength(10);
    expect(titles(result).filter((t) => t.startsWith('o'))).toEqual(['o0']);
    expect(titles(result).slice(0, 9)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
  });

  it('讓位的是非觀察項目；limit 內已有的觀察一律保留', () => {
    const sorted = [...rollups(8), ...observations(1), ...rollups(3), ...observations(4)];
    // limit 內原本是 r0..r7、o0、一筆 rollup；要補 3 筆觀察，讓位的是最後那筆 rollup 與 r7、r6
    const result = applyObservationReserve(sorted, 10, 0.4);
    expect(result).toHaveLength(10);
    expect(result.filter((c) => c.result.kind === 'observation')).toHaveLength(4);
    expect(result.slice(0, 6)).toEqual(sorted.slice(0, 6));
    expect(result[6].result.id).toBe(sorted[8].result.id);
    expect(result.slice(7).map((c) => c.result.id)).toEqual(sorted.slice(12, 15).map((c) => c.result.id));
  });

  it('ratio 超過 1 以 limit 為上限（全部名額都給觀察）', () => {
    const sorted = [...rollups(5), ...observations(5)];
    const result = applyObservationReserve(sorted, 3, 5);
    expect(titles(result)).toEqual(['o0', 'o1', 'o2']);
  });
});
