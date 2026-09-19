// src/services/summary-guard.ts
//
// Rollup summary degradation guard — prevents a long, accumulated session summary
// from being overwritten by a short, single-window-only description.

/**
 * Minimum prior summary length (characters) for the guard to activate.
 * Below this threshold, we assume the summary is still building up and
 * allow any replacement.
 */
const MIN_PRIOR_LENGTH = 200;

/**
 * If the new summary is strictly below this ratio of the prior summary's
 * length, it is considered degraded.  40% is conservative: a genuine
 * cumulative rewrite that condenses content rarely drops below half.
 */
const DEGRADATION_RATIO = 0.4;

/**
 * Determine whether `nextSummary` is a degraded replacement for `priorSummary`.
 *
 * Returns `true` when:
 *  1. `priorSummary` exists and its effective length is at least {@link MIN_PRIOR_LENGTH} characters, AND
 *  2. `nextSummary` length is strictly less than {@link DEGRADATION_RATIO} of the effective prior length.
 *
 * When `maxSummaryLength` is provided, the prior summary length is clamped to
 * that value before the ratio comparison.  This prevents an oversized prior
 * (which can exceed the schema limit if it was written before validation was
 * added) from permanently blocking any spec-compliant replacement.
 *
 * Pure function, safe to call from any context.
 */
export function isSummaryDegraded(
  priorSummary: string | null | undefined,
  nextSummary: string,
  maxSummaryLength?: number,
): boolean {
  if (!priorSummary || priorSummary.length < MIN_PRIOR_LENGTH) return false;
  const effectiveLength = maxSummaryLength !== undefined
    ? Math.min(priorSummary.length, maxSummaryLength)
    : priorSummary.length;
  if (effectiveLength < MIN_PRIOR_LENGTH) return false;
  return nextSummary.length < effectiveLength * DEGRADATION_RATIO;
}
