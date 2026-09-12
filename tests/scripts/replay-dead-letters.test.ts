// tests/scripts/replay-dead-letters.test.ts
//
// dead-letter replay（死信重跑）腳本的 DB-free 契約：死信解析、transcript 路徑對照、
// 候選分類、改名目標、以及 apply 前的 provider/model 守衛。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExpectedLlm,
  buildTranscriptPathMap,
  classifyCandidate,
  listDeadLetters,
  parseDeadLetter,
  parseReplayArgs,
  replayCandidates,
  replayedFileName,
  type ReplayCandidate,
  type ReplayRuntime,
} from '../../scripts/replay-dead-letters.js';
import type { CaptureLlmAdapter } from '../../src/services/capture-llm.js';

const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

const tempDirs: string[] = [];
function makeSpool(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-replay-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.dead'), { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deadLetterPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    metadata: {
      project_id: 'proj',
      session_id: 'sess-1',
      offset: { start: 10, end: 20 },
      hwm_offset: { start: 100, end: 200 },
      source: { path_hash: 'abc', start: 100, end: 200, content_hash: null },
      error_code: 'LLM_EXTRACT_FAILED',
      model: 'gpt-5.6-sol',
      ...overrides,
    },
    error: { message: 'blocked after 6 attempts: timeout' },
  });
}

describe('parseDeadLetter', () => {
  it('parses the worker dead-letter payload shape', () => {
    const record = parseDeadLetter('/x/a.json', deadLetterPayload());
    expect(record).not.toBeNull();
    expect(record!.projectId).toBe('proj');
    expect(record!.hwmOffset).toEqual({ start: 100, end: 200 });
    expect(record!.source).toEqual({ path_hash: 'abc', start: 100, end: 200, content_hash: null });
    expect(record!.errorCode).toBe('LLM_EXTRACT_FAILED');
    expect(record!.model).toBe('gpt-5.6-sol');
    expect(record!.errorMessage).toContain('timeout');
  });

  it('returns null source when the record has no transcript source (legacy haiku dead-letters)', () => {
    const record = parseDeadLetter('/x/a.json', deadLetterPayload({ source: undefined }));
    expect(record!.source).toBeNull();
  });

  it('rejects malformed JSON and missing offsets', () => {
    expect(parseDeadLetter('/x/a.json', '{not json')).toBeNull();
    expect(parseDeadLetter('/x/a.json', deadLetterPayload({ hwm_offset: undefined }))).toBeNull();
  });
});

describe('buildTranscriptPathMap', () => {
  it('maps sha256(transcript_path) from live .jsonl and rotated .sealed files, ignoring .legacy and dot-dirs', async () => {
    const spool = makeSpool();
    mkdirSync(join(spool, 'proj'));
    writeFileSync(
      join(spool, 'proj', 'live.jsonl'),
      `${JSON.stringify({ session_id: 's', transcript_path: '/t/live.jsonl', transcript_offset: 1 })}\n` +
        `${JSON.stringify({ transcript_path: '/t/live.jsonl', hwm_offset: 5 })}\n`
    );
    writeFileSync(
      join(spool, 'proj', 'old.jsonl.123.sealed'),
      `${JSON.stringify({ session_id: 's', transcript_path: '/t/sealed.jsonl', transcript_offset: 1 })}\nnot-json\n`
    );
    writeFileSync(join(spool, 'proj', 'x.hwm.v1-1.legacy'), '9104');
    writeFileSync(join(spool, '.dead', 'ignored.jsonl'), JSON.stringify({ transcript_path: '/t/dead.jsonl' }));

    const map = await buildTranscriptPathMap(spool);
    expect(map.get(sha256('/t/live.jsonl'))).toBe('/t/live.jsonl');
    expect(map.get(sha256('/t/sealed.jsonl'))).toBe('/t/sealed.jsonl');
    expect(map.has(sha256('/t/dead.jsonl'))).toBe(false);
    expect(map.size).toBe(2);
  });
});

describe('classifyCandidate', () => {
  it('classifies READABLE / path-unresolved / transcript-deleted / transcript-truncated / no-source / error-code-filtered', async () => {
    const spool = makeSpool();
    const transcript = join(spool, 'transcript.jsonl');
    writeFileSync(transcript, 'x'.repeat(300));
    const pathMap = new Map([[sha256(transcript), transcript]]);
    const base = parseDeadLetter('/x/a.json', deadLetterPayload({
      source: { path_hash: sha256(transcript), start: 100, end: 200, content_hash: null },
    }))!;

    expect((await classifyCandidate(base, pathMap, 'LLM_EXTRACT_FAILED')).status).toBe('READABLE');
    expect((await classifyCandidate(base, pathMap, 'LLM_EXTRACT_FAILED')).bytes).toBe(100);
    expect((await classifyCandidate(base, new Map(), 'LLM_EXTRACT_FAILED')).status).toBe('path-unresolved');
    expect((await classifyCandidate(base, pathMap, 'OTHER')).status).toBe('error-code-filtered');
    expect((await classifyCandidate({ ...base, source: null }, pathMap, 'LLM_EXTRACT_FAILED')).status).toBe('no-source');

    const truncated = { ...base, source: { ...base.source!, start: 100, end: 400 } };
    expect((await classifyCandidate(truncated, pathMap, 'LLM_EXTRACT_FAILED')).status).toBe('transcript-truncated');

    const deleted = new Map([[sha256(transcript), join(spool, 'gone.jsonl')]]);
    expect((await classifyCandidate(base, deleted, 'LLM_EXTRACT_FAILED')).status).toBe('transcript-deleted');
  });
});

describe('replayedFileName', () => {
  it('appends a non-.json suffix so drain/audit stop counting the file as parked', () => {
    const target = replayedFileName('/spool/.dead/abc.json');
    expect(target).toBe('/spool/.dead/abc.json.replayed');
    expect(target.endsWith('.json')).toBe(false);
  });
});

describe('parseReplayArgs', () => {
  it('defaults to dry-run, LLM_EXTRACT_FAILED, gpt-5.6-luna, no limit', () => {
    const options = parseReplayArgs([]);
    expect(options.apply).toBe(false);
    expect(options.errorCode).toBe('LLM_EXTRACT_FAILED');
    expect(options.expectModel).toBe('gpt-5.6-luna');
    expect(options.limit).toBe(Number.POSITIVE_INFINITY);
  });

  it('parses --apply --limit --expect-model', () => {
    const options = parseReplayArgs(['--apply', '--limit', '3', '--expect-model', 'gpt-x']);
    expect(options.apply).toBe(true);
    expect(options.limit).toBe(3);
    expect(options.expectModel).toBe('gpt-x');
    expect(() => parseReplayArgs(['--limit', 'abc'])).toThrow(/--limit/);
  });
});

function fakeLlm(overrides: Partial<CaptureLlmAdapter>): CaptureLlmAdapter {
  return {
    model: 'gpt-5.6-luna',
    provider: 'codex-cli',
    worstCaseCallBudgetMs: 1,
    extract: async () => { throw new Error('not used'); },
    takeTelemetry: () => ({} as never),
    ...overrides,
  };
}

describe('assertExpectedLlm', () => {
  it('accepts codex-cli with the expected model', () => {
    expect(() => assertExpectedLlm(fakeLlm({}), 'gpt-5.6-luna')).not.toThrow();
  });

  it('refuses disabled adapters, non-codex providers, and unexpected models', () => {
    expect(() => assertExpectedLlm(fakeLlm({ disabled: true, disabledReason: 'x' }), 'gpt-5.6-luna')).toThrow(/disabled/);
    expect(() => assertExpectedLlm(fakeLlm({ provider: 'claude-cli', model: 'haiku' }), 'gpt-5.6-luna')).toThrow(/codex-cli/);
    expect(() => assertExpectedLlm(fakeLlm({ model: 'gpt-5.6-sol' }), 'gpt-5.6-luna')).toThrow(/gpt-5.6-luna/);
  });
});

describe('replayCandidates', () => {
  it('reads the exact byte range, forwards it to replayCaptureWindow, and renames the dead-letter on success', async () => {
    const spool = makeSpool();
    const transcript = join(spool, 'transcript.jsonl');
    const body = 'HEAD-' + 'window-bytes-' + 'TAIL';
    writeFileSync(transcript, body);
    const start = 5;
    const end = 5 + 'window-bytes-'.length;
    const deadFile = join(spool, '.dead', 'dl.json');
    writeFileSync(deadFile, deadLetterPayload({
      source: { path_hash: sha256(transcript), start, end, content_hash: sha256('window-bytes-') },
      hwm_offset: { start, end },
    }));
    const [record] = await listDeadLetters(spool);
    const candidate: ReplayCandidate = {
      record,
      status: 'READABLE',
      transcriptPath: transcript,
      bytes: end - start,
    };
    const calls: Array<{ raw: string; hwm: { start: number; end: number } }> = [];
    const runtime: ReplayRuntime = {
      db: {} as never,
      llm: fakeLlm({}),
      generateEmbedding: async () => null,
      embeddingExpected: false,
      replay: async (input) => {
        calls.push({ raw: input.raw.toString('utf8'), hwm: input.hwmOffset });
        return { status: 'written', model: 'gpt-5.6-luna', observationsWritten: 2, rollupsWritten: 1, embeddingFailed: 0 };
      },
    };
    const out: string[] = [];
    const totals = await replayCandidates([candidate], runtime, { write: (c: string) => out.push(c) });

    expect(calls).toEqual([{ raw: 'window-bytes-', hwm: { start, end } }]);
    expect(totals).toEqual({ written: 1, observations: 2, skipped: 0, failed: 0 });
    expect(out.join('')).toContain('written');
    expect((await listDeadLetters(spool)).length).toBe(0);
    const replayed = JSON.parse(await readFile(replayedFileName(deadFile), 'utf8')) as { replayed?: { status?: string } };
    expect(replayed.replayed?.status).toBe('written');
  });

  it('leaves the dead-letter untouched on failure', async () => {
    const spool = makeSpool();
    const transcript = join(spool, 'transcript.jsonl');
    writeFileSync(transcript, 'x'.repeat(50));
    const deadFile = join(spool, '.dead', 'dl.json');
    writeFileSync(deadFile, deadLetterPayload({
      source: { path_hash: sha256(transcript), start: 0, end: 50, content_hash: null },
      hwm_offset: { start: 0, end: 50 },
    }));
    const [record] = await listDeadLetters(spool);
    const runtime: ReplayRuntime = {
      db: {} as never,
      llm: fakeLlm({}),
      generateEmbedding: async () => null,
      embeddingExpected: false,
      replay: async () => ({ status: 'failed', errorCode: 'CODEX_CLI_TIMEOUT', message: 'timeout' }),
    };
    const totals = await replayCandidates(
      [{ record, status: 'READABLE', transcriptPath: transcript, bytes: 50 }],
      runtime,
      { write: () => undefined },
    );
    expect(totals.failed).toBe(1);
    expect((await listDeadLetters(spool)).length).toBe(1);
  });
});
