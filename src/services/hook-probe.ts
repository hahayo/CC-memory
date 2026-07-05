// src/services/hook-probe.ts
//
// CC-memory v0.5 M2a probe report pure logic.

export type HookProbeVerdict = 'pass' | 'fail';
export type HookProbeFindingStatus = 'PASS' | 'FAIL';

export interface HookProbeFinding {
  status: HookProbeFindingStatus;
  reason_code?: string;
  fallback_needed?: boolean;
  detail?: string;
}

export interface HookProbeReport {
  verdict: HookProbeVerdict;
  fallback_needed: boolean;
  findings: Record<string, HookProbeFinding>;
}

export interface TranscriptPrefixRead {
  transcript_path: string;
  prefix_bytes: number;
  sha256: string;
  read_order: number;
}

export interface HookProbeInput {
  postToolUsePayload: Record<string, unknown>;
  transcriptPrefixReads: readonly TranscriptPrefixRead[];
  requireToolName?: boolean;
  transcriptReadable?: boolean;
}

function topLevelString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function findTranscriptHashMismatch(
  reads: readonly TranscriptPrefixRead[]
): TranscriptPrefixRead | null {
  const hashesByPrefix = new Map<string, string>();
  const ordered = [...reads].sort((a, b) => a.read_order - b.read_order);

  for (const read of ordered) {
    const key = `${read.transcript_path}\0${read.prefix_bytes}`;
    const previousHash = hashesByPrefix.get(key);
    if (previousHash !== undefined && previousHash !== read.sha256) {
      return read;
    }
    hashesByPrefix.set(key, read.sha256);
  }

  return null;
}

export function buildHookProbeReport(input: HookProbeInput): HookProbeReport {
  const findings: Record<string, HookProbeFinding> = {};
  const payloadFailures: string[] = [];
  const requireToolName = input.requireToolName ?? true;

  if (requireToolName && topLevelString(input.postToolUsePayload, 'tool_name') === null) {
    payloadFailures.push('MISSING_TOP_LEVEL_TOOL_NAME');
  }
  if (topLevelString(input.postToolUsePayload, 'transcript_path') === null) {
    payloadFailures.push('MISSING_TOP_LEVEL_TRANSCRIPT_PATH');
  }
  if (topLevelString(input.postToolUsePayload, 'session_id') === null) {
    payloadFailures.push('MISSING_TOP_LEVEL_SESSION_ID');
  }
  if (input.transcriptReadable === false) {
    payloadFailures.push('TRANSCRIPT_PATH_NOT_READABLE');
  }

  findings.post_tool_use_payload =
    payloadFailures.length > 0
      ? {
          status: 'FAIL',
          reason_code: payloadFailures[0],
          detail: payloadFailures.join(','),
        }
      : { status: 'PASS' };

  const mismatch = findTranscriptHashMismatch(input.transcriptPrefixReads);
  findings.transcript_offset_stability =
    mismatch === null
      ? { status: 'PASS', fallback_needed: false }
      : {
          status: 'FAIL',
          reason_code: 'TRANSCRIPT_PREFIX_HASH_MISMATCH',
          fallback_needed: true,
          detail: `${mismatch.transcript_path}:${mismatch.prefix_bytes}`,
        };

  const fallbackNeeded = findings.transcript_offset_stability.fallback_needed === true;
  const failed = Object.values(findings).some((finding) => finding.status === 'FAIL');

  return {
    verdict: failed ? 'fail' : 'pass',
    fallback_needed: fallbackNeeded,
    findings,
  };
}
