// tests/scripts/probe-claude-hooks.test.ts
//
// CC-memory v0.5 M2a RED — probe-claude-hooks report shaping.
// The CLI script is added in GREEN; this test pins the pure report builder.

import { describe, expect, it } from 'vitest';
import {
  buildHookProbeReport,
  type HookProbeInput,
  type HookProbeReport,
} from '../../src/services/hook-probe.js';

function confirmedPostToolUsePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: '/repo/cc-memory',
    duration_ms: 12,
    hook_event_name: 'PostToolUse',
    permission_mode: 'default',
    prompt_id: 'prompt-1',
    session_id: 'session-1',
    tool_input: { command: 'pwd' },
    tool_name: 'Bash',
    tool_response: { stdout: '/repo/cc-memory\n' },
    tool_use_id: 'toolu-1',
    transcript_path: '/tmp/claude-session.jsonl',
    ...overrides,
  };
}

function expectProbeReport(input: HookProbeInput): HookProbeReport {
  let report: HookProbeReport | undefined;

  expect(() => {
    report = buildHookProbeReport(input);
  }).not.toThrow();

  expect(report).toBeDefined();
  return report as HookProbeReport;
}

function expectMachineReadableReport(report: HookProbeReport): void {
  const parsed = JSON.parse(JSON.stringify(report)) as unknown;

  expect(parsed).toMatchObject({
    verdict: expect.any(String),
    fallback_needed: expect.any(Boolean),
    findings: expect.any(Object),
  });
}

describe('probe-claude-hooks report builder', () => {
  it('fail-fast when PostToolUse payload is missing top-level tool_name', () => {
    const payload = confirmedPostToolUsePayload();
    delete payload.tool_name;

    const report = expectProbeReport({
      postToolUsePayload: payload,
      transcriptPrefixReads: [],
    });

    expectMachineReadableReport(report);
    expect(report).toMatchObject({
      verdict: 'fail',
      fallback_needed: false,
      findings: {
        post_tool_use_payload: {
          status: 'FAIL',
          reason_code: 'MISSING_TOP_LEVEL_TOOL_NAME',
        },
      },
    });
  });

  it('marks fallback_needed when the same transcript prefix has inconsistent hashes', () => {
    const input: HookProbeInput = {
      postToolUsePayload: confirmedPostToolUsePayload(),
      transcriptPrefixReads: [
        {
          transcript_path: '/tmp/claude-session.jsonl',
          prefix_bytes: 4096,
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          read_order: 1,
        },
        {
          transcript_path: '/tmp/claude-session.jsonl',
          prefix_bytes: 4096,
          sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          read_order: 2,
        },
      ],
    };

    const report = expectProbeReport(input);

    expectMachineReadableReport(report);
    expect(report).toMatchObject({
      verdict: 'fail',
      fallback_needed: true,
      findings: {
        transcript_offset_stability: {
          status: 'FAIL',
          reason_code: 'TRANSCRIPT_PREFIX_HASH_MISMATCH',
          fallback_needed: true,
        },
      },
    });
  });
});
