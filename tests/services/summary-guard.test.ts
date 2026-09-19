// tests/services/summary-guard.test.ts
//
// Pure-function unit tests for the rollup summary degradation guard.

import { describe, expect, it } from 'vitest';
import { isSummaryDegraded } from '../../src/services/summary-guard.js';

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
});
