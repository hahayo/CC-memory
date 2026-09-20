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

export interface GuardPendingSummary {
  summary: string;
  decisions: string[];
  next_steps: string[];
}

export interface GuardPendingLimits {
  maxSummaryChars: number;
  maxItems: number;
  maxItemChars: number;
}

const PENDING_SEPARATOR = '\n\n';

function mergeItems(existing: string[], rejected: string[], limits: GuardPendingLimits): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...existing, ...rejected]) {
    const entry = raw.length > limits.maxItemChars ? raw.slice(0, limits.maxItemChars) : raw;
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  // 超過筆數上限時保留較新的（尾端），較舊的先捨。
  return merged.length > limits.maxItems ? merged.slice(merged.length - limits.maxItems) : merged;
}

/**
 * 守衛觸發時，把這次被擋下的摘要併進既有的 pending，而不是覆蓋。
 *
 * 守衛觸發正代表 LLM 這次沒有照顧累積脈絡，所以「後一份已包含前一份」不可假設
 * （Codex R6 P2）。連續觸發時：
 * - summary：既有 + 空行 + 本次；超過上限時完整保留本次，從較舊那端截掉多出的部分。
 * - decisions／next_steps：去重後串接；超過筆數上限時捨最舊的。
 *
 * 純函式，不改動輸入。
 */
export function mergeGuardPending(
  existing: GuardPendingSummary | null | undefined,
  rejected: GuardPendingSummary,
  limits: GuardPendingLimits,
): GuardPendingSummary {
  const newest =
    rejected.summary.length > limits.maxSummaryChars
      ? rejected.summary.slice(0, limits.maxSummaryChars)
      : rejected.summary;
  let summary = newest;
  if (existing && existing.summary.length > 0 && existing.summary !== newest) {
    const room = limits.maxSummaryChars - newest.length - PENDING_SEPARATOR.length;
    if (room > 0) {
      const older =
        existing.summary.length > room
          ? existing.summary.slice(existing.summary.length - room)
          : existing.summary;
      summary = `${older}${PENDING_SEPARATOR}${newest}`;
    }
  }
  return {
    summary,
    decisions: mergeItems(existing?.decisions ?? [], rejected.decisions, limits),
    next_steps: mergeItems(existing?.next_steps ?? [], rejected.next_steps, limits),
  };
}
