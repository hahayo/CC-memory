#!/usr/bin/env tsx
// scripts/probe-claude-hooks.ts
//
// Re-runnable M2a hook payload and transcript-prefix probe.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  buildHookProbeReport,
  type HookProbeReport,
  type TranscriptPrefixRead,
} from '../src/services/hook-probe.js';

interface PayloadRecord {
  line: number;
  payload: Record<string, unknown>;
}

interface PayloadProbeOutput {
  line: number;
  hook_event_name: string | null;
  verdict: 'PASS' | 'FAIL';
  fallback_needed: boolean;
  findings: HookProbeReport['findings'];
}

interface ProbeOutput {
  gate: string;
  verdict: 'PASS' | 'FAIL';
  fallback_needed: boolean;
  checked_at: string;
  payload_count: number;
  findings: {
    payloads?: PayloadProbeOutput[];
    probe_input?: {
      status: 'FAIL';
      reason_code: string;
      detail?: string;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readInput(): Promise<string> {
  const path = process.argv[2];
  if (path && path !== '-') {
    return readFile(path, 'utf8');
  }
  return readStdin();
}

function normalizePayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.payload)) return value.payload;
  return value;
}

function parsePayloads(raw: string): PayloadRecord[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry, index) => ({ line: index + 1, payload: normalizePayload(entry) }))
        .filter((entry): entry is PayloadRecord => entry.payload !== null);
    }
    const payload = normalizePayload(parsed);
    if (payload !== null) return [{ line: 1, payload }];
  } catch {
    // Fall through to JSONL parsing.
  }

  return raw
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter((entry) => entry.text.length > 0)
    .map((entry) => {
      const parsed = JSON.parse(entry.text) as unknown;
      const payload = normalizePayload(parsed);
      if (payload === null) {
        throw new Error(`line ${entry.line} is not a JSON object`);
      }
      return { line: entry.line, payload };
    });
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function sha256Prefix(path: string, bytes: number): Promise<string> {
  const hash = createHash('sha256');
  if (bytes <= 0) return hash.digest('hex');

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, {
      start: 0,
      end: bytes - 1,
      highWaterMark: 64 * 1024,
    });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return hash.digest('hex');
}

async function transcriptReads(
  transcriptPath: string
): Promise<{ readable: boolean; reads: TranscriptPrefixRead[] }> {
  try {
    await access(transcriptPath, constants.R_OK);
    const info = await stat(transcriptPath);
    const prefixBytes = info.size;
    const first = await sha256Prefix(transcriptPath, prefixBytes);
    const second = await sha256Prefix(transcriptPath, prefixBytes);
    return {
      readable: true,
      reads: [
        {
          transcript_path: transcriptPath,
          prefix_bytes: prefixBytes,
          sha256: first,
          read_order: 1,
        },
        {
          transcript_path: transcriptPath,
          prefix_bytes: prefixBytes,
          sha256: second,
          read_order: 2,
        },
      ],
    };
  } catch {
    return { readable: false, reads: [] };
  }
}

async function probePayload(record: PayloadRecord): Promise<PayloadProbeOutput> {
  const hookEventName = stringField(record.payload, 'hook_event_name');
  const transcriptPath = stringField(record.payload, 'transcript_path');
  const transcript = transcriptPath
    ? await transcriptReads(transcriptPath)
    : { readable: undefined, reads: [] as TranscriptPrefixRead[] };
  const report = buildHookProbeReport({
    postToolUsePayload: record.payload,
    transcriptPrefixReads: transcript.reads,
    transcriptReadable: transcript.readable,
    requireToolName: hookEventName === 'Stop' ? false : true,
  });

  return {
    line: record.line,
    hook_event_name: hookEventName,
    verdict: report.verdict === 'pass' ? 'PASS' : 'FAIL',
    fallback_needed: report.fallback_needed,
    findings: report.findings,
  };
}

function noPayloadsOutput(): ProbeOutput {
  return {
    gate: 'M2a hook payload probe',
    verdict: 'FAIL',
    fallback_needed: false,
    checked_at: new Date().toISOString(),
    payload_count: 0,
    findings: {
      probe_input: {
        status: 'FAIL',
        reason_code: 'NO_PAYLOADS',
      },
    },
  };
}

async function main(): Promise<void> {
  const payloads = parsePayloads(await readInput());
  if (payloads.length === 0) {
    console.log(JSON.stringify(noPayloadsOutput(), null, 2));
    process.exitCode = 1;
    return;
  }

  const reports = await Promise.all(payloads.map((record) => probePayload(record)));
  const failed = reports.some((report) => report.verdict === 'FAIL');
  const fallbackNeeded = reports.some((report) => report.fallback_needed);
  const output: ProbeOutput = {
    gate: 'M2a hook payload probe',
    verdict: failed ? 'FAIL' : 'PASS',
    fallback_needed: fallbackNeeded,
    checked_at: new Date().toISOString(),
    payload_count: reports.length,
    findings: {
      payloads: reports,
    },
  };

  console.log(JSON.stringify(output, null, 2));
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  const output: ProbeOutput = {
    gate: 'M2a hook payload probe',
    verdict: 'FAIL',
    fallback_needed: false,
    checked_at: new Date().toISOString(),
    payload_count: 0,
    findings: {
      probe_input: {
        status: 'FAIL',
        reason_code: 'PROBE_RUNTIME_ERROR',
        detail,
      },
    },
  };
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = 1;
});
