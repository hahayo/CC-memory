// tests/services/summary-guard.test.ts
//
// Pure-function unit tests for the rollup summary degradation guard.

import { describe, expect, it } from 'vitest';
import { isSummaryDegraded, mergeGuardPending } from '../../src/services/summary-guard.js';

describe('isSummaryDegraded', () => {
  it('returns false when there is no prior summary (first window)', () => {
    expect(isSummaryDegraded(null, 'New session summary about the feature.')).toBe(false);
  });

  it('returns false when prior summary is empty', () => {
    expect(isSummaryDegraded('', 'New session summary about the feature.')).toBe(false);
  });

  it('returns false when prior summary is short (below threshold)', () => {
    const prior = 'Short summary.'; // well below 200 chars
    const next = 'Even shorter.';
    expect(isSummaryDegraded(prior, next)).toBe(false);
  });

  it('returns false when the new summary is comparable length to the prior', () => {
    const prior = 'A'.repeat(300);
    const next = 'B'.repeat(250); // 83% of prior, above 40% threshold
    expect(isSummaryDegraded(prior, next)).toBe(false);
  });

  it('returns true when a long prior summary is replaced by a much shorter one', () => {
    const prior = 'Detailed summary about the session including root cause analysis, decisions made, and next steps. '.repeat(5);
    const next = 'This segment verified the page.'; // ~30 chars vs ~490 chars
    expect(isSummaryDegraded(prior, next)).toBe(true);
  });

  it('returns true at exactly the 40% boundary (new < 40% of prior)', () => {
    const prior = 'X'.repeat(200);
    const next = 'Y'.repeat(79); // 79/200 = 39.5% < 40%
    expect(isSummaryDegraded(prior, next)).toBe(true);
  });

  it('returns false at exactly 40% ratio', () => {
    const prior = 'X'.repeat(200);
    const next = 'Y'.repeat(80); // 80/200 = 40%, not strictly less
    expect(isSummaryDegraded(prior, next)).toBe(false);
  });

  it('returns false when prior is exactly at the minimum length threshold', () => {
    // Prior must be >= 200 chars for the guard to activate
    const prior = 'Z'.repeat(199);
    const next = 'A'.repeat(10); // tiny, but prior is below threshold
    expect(isSummaryDegraded(prior, next)).toBe(false);
  });

  it('returns true when prior is exactly 200 chars and new is tiny', () => {
    const prior = 'Z'.repeat(200);
    const next = 'A'.repeat(10); // 10/200 = 5%
    expect(isSummaryDegraded(prior, next)).toBe(true);
  });

  it('returns false when new summary is empty but prior is below threshold', () => {
    expect(isSummaryDegraded('short prior', '')).toBe(false);
  });

  it('returns true when new summary is empty and prior is above threshold', () => {
    const prior = 'W'.repeat(300);
    expect(isSummaryDegraded(prior, '')).toBe(true);
  });

  it('handles undefined prior as no prior', () => {
    expect(isSummaryDegraded(undefined, 'anything')).toBe(false);
  });

  // Fix 3: maxSummaryLength clamp prevents oversized prior from permanently blocking
  describe('with maxSummaryLength', () => {
    it('does not trigger when prior exceeds schema limit and new is at limit (prior 5000, new 1500, max 1500)', () => {
      const prior = 'X'.repeat(5000);
      const next = 'Y'.repeat(1500); // 1500 / min(5000, 1500) = 100% — not degraded
      expect(isSummaryDegraded(prior, next, 1500)).toBe(false);
    });

    it('still triggers when new is truly tiny relative to clamped prior', () => {
      const prior = 'X'.repeat(5000);
      const next = 'Y'.repeat(100); // 100 / min(5000, 1500) = 6.7% — degraded
      expect(isSummaryDegraded(prior, next, 1500)).toBe(true);
    });

    it('clamps prior to maxSummaryLength for ratio check', () => {
      const prior = 'X'.repeat(3000);
      const next = 'Y'.repeat(700); // Without clamp: 700/3000 = 23% → degraded
      // With clamp to 1500: 700/1500 = 46.7% → not degraded
      expect(isSummaryDegraded(prior, next, 1500)).toBe(false);
    });

    it('does not affect priors already below the max', () => {
      const prior = 'X'.repeat(300);
      const next = 'Y'.repeat(50); // 50/300 = 16.7% → degraded regardless
      expect(isSummaryDegraded(prior, next, 1500)).toBe(true);
    });

    it('returns false when clamped effective length falls below MIN_PRIOR_LENGTH', () => {
      const prior = 'X'.repeat(500);
      const next = 'Y'.repeat(10);
      // Clamp to 100 → effectiveLength 100 < 200 → guard inactive
      expect(isSummaryDegraded(prior, next, 100)).toBe(false);
    });
  });
});

describe('mergeGuardPending', () => {
  const limits = { maxSummaryChars: 100, maxItems: 3, maxItemChars: 10 };

  it('stores the rejected summary as-is when there is no existing pending', () => {
    const rejected = { summary: 'window two', decisions: ['d1'], next_steps: ['n1'] };
    expect(mergeGuardPending(null, rejected, limits)).toEqual(rejected);
  });

  it('keeps the earlier pending when the guard fires twice in a row', () => {
    const first = { summary: 'window one', decisions: ['d1'], next_steps: ['n1'] };
    const second = { summary: 'window two', decisions: ['d2'], next_steps: ['n2'] };
    const merged = mergeGuardPending(first, second, limits);
    expect(merged.summary).toBe('window one\n\nwindow two');
    expect(merged.decisions).toEqual(['d1', 'd2']);
    expect(merged.next_steps).toEqual(['n1', 'n2']);
  });

  it('keeps the newest summary whole and trims the older end when over the limit', () => {
    const first = { summary: 'A'.repeat(90), decisions: [], next_steps: [] };
    const second = { summary: 'B'.repeat(60), decisions: [], next_steps: [] };
    const merged = mergeGuardPending(first, second, limits);
    expect(merged.summary.length).toBeLessThanOrEqual(limits.maxSummaryChars);
    expect(merged.summary.endsWith('B'.repeat(60))).toBe(true);
    expect(merged.summary.startsWith('A')).toBe(true);
  });

  it('falls back to the newest alone when it already fills the limit', () => {
    const first = { summary: 'old', decisions: [], next_steps: [] };
    const second = { summary: 'N'.repeat(150), decisions: [], next_steps: [] };
    expect(mergeGuardPending(first, second, limits).summary).toBe('N'.repeat(100));
  });

  it('dedupes items, clamps item length, and drops the oldest beyond maxItems', () => {
    const first = { summary: 's1', decisions: ['a', 'b'], next_steps: ['x'.repeat(20)] };
    const second = { summary: 's2', decisions: ['b', 'c', 'd'], next_steps: ['x'.repeat(20)] };
    const merged = mergeGuardPending(first, second, limits);
    expect(merged.decisions).toEqual(['b', 'c', 'd']);
    expect(merged.next_steps).toEqual(['x'.repeat(10)]);
  });

  it('does not duplicate an identical consecutive rejected summary', () => {
    const same = { summary: 'same text', decisions: [], next_steps: [] };
    expect(mergeGuardPending(same, same, limits).summary).toBe('same text');
  });

  it('does not mutate its inputs', () => {
    const first = { summary: 'one', decisions: ['d1'], next_steps: [] };
    const second = { summary: 'two', decisions: ['d2'], next_steps: [] };
    const snapshot = JSON.stringify([first, second]);
    mergeGuardPending(first, second, limits);
    expect(JSON.stringify([first, second])).toBe(snapshot);
  });
});
