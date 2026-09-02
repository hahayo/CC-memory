// tests/services/capture-spool.test.ts
//
// CC-memory v0.5 M2a RED — local hook spool append behavior.
// Hook path must stay local-only, O(1), and non-blocking on write failures.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_SKIP_TOOLS,
  appendCaptureEvent,
  appendStopSentinel,
  loadCaptureSkipTools,
  shouldSkipCaptureTool,
  type CaptureSpoolAppendResult,
  type CaptureSpoolOptions,
  type CaptureStopSentinel,
  type CaptureThinEvent,
  decodeSpoolSegment,
  sanitizeSpoolSegment,
} from '../../src/services/capture-spool.js';

const TIMESTAMP = '2026-07-06T00:00:00.000Z';
const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-spool-test-'));
  tmpRoots.push(root);
  return root;
}

function spoolOptions(spoolDir: string): CaptureSpoolOptions {
  return {
    env: {
      CC_MEMORY_SPOOL_DIR: spoolDir,
    },
  };
}

function thinEvent(overrides: Partial<CaptureThinEvent> = {}): CaptureThinEvent {
  return {
    session_id: 'session-1',
    project_id: 'project-alpha',
    tool_name: 'Bash',
    timestamp: TIMESTAMP,
    transcript_path: '/tmp/claude-session.jsonl',
    transcript_offset: 128,
    ...overrides,
  };
}

async function settleAppend(
  promise: Promise<CaptureSpoolAppendResult>
): Promise<CaptureSpoolAppendResult | Error> {
  try {
    return await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function expectedSpoolFile(root: string, projectId = 'project-alpha', sessionId = 'session-1'): string {
  return join(root, projectId, `${sessionId}.jsonl`);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function expectInsideRoot(path: string, root: string): void {
  const rel = relative(root, path);
  expect(rel.startsWith('..')).toBe(false);
  expect(isAbsolute(rel)).toBe(false);
}

describe('capture-spool append', () => {
  it('keeps every JSONL line parseable across 100 concurrent appends', async () => {
    const root = join(makeTmpRoot(), 'spool');
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        settleAppend(
          appendCaptureEvent(
            thinEvent({
              timestamp: new Date(Date.parse(TIMESTAMP) + i).toISOString(),
              transcript_offset: i,
            }),
            spoolOptions(root)
          )
        )
      )
    );

    expect(results).toEqual(
      Array.from({ length: 100 }, () => expect.objectContaining({ success: true }))
    );

    const spoolFile = expectedSpoolFile(root);
    expect(existsSync(spoolFile), spoolFile).toBe(true);
    if (!existsSync(spoolFile)) return;

    const lines = readFileSync(spoolFile, 'utf8').split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(100);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('creates spool directories with 0700 and new spool files with 0600', async () => {
    const root = join(makeTmpRoot(), 'spool');
    const result = await settleAppend(appendCaptureEvent(thinEvent(), spoolOptions(root)));

    expect(result).toMatchObject({ success: true });

    const projectDir = join(root, 'project-alpha');
    const spoolFile = expectedSpoolFile(root);
    expect(existsSync(root), root).toBe(true);
    expect(existsSync(projectDir), projectDir).toBe(true);
    expect(existsSync(spoolFile), spoolFile).toBe(true);
    if (!existsSync(root) || !existsSync(projectDir) || !existsSync(spoolFile)) return;

    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(projectDir)).toBe(0o700);
    expect(modeOf(spoolFile)).toBe(0o600);
  });

  it('encodes segments reversibly so distinct ids never share a spool directory', () => {
    expect(sanitizeSpoolSegment('手機遠端控制')).toBe('_u624b_u6a5f_u9060_u7aef_u63a7_u5236');
    expect(sanitizeSpoolSegment('a b/😀')).toBe('a_u0020b_u002f_u1f600');
    expect(sanitizeSpoolSegment('project-alpha')).toBe('project-alpha');
    expect(sanitizeSpoolSegment('AI_Copilot')).toBe('AI_Copilot');
    // Codex round-2 反例：`/` 與字面 `_u002f`、`.x`／`..x`／`_x`、前後空白
    expect(sanitizeSpoolSegment('/')).toBe('_u002f');
    expect(sanitizeSpoolSegment('_u002f')).toBe('_u005fu002f');
    expect(sanitizeSpoolSegment('.x')).toBe('_u002ex');
    expect(sanitizeSpoolSegment('..x')).toBe('_u002e.x');
    expect(sanitizeSpoolSegment('_x')).toBe('_x');
    expect(sanitizeSpoolSegment(' a ')).toBe('_u0020a_u0020');
    expect(sanitizeSpoolSegment('..')).toBe('_u002e.');
    expect(sanitizeSpoolSegment('')).toBe('unknown');
    const inputs = ['/', '_u002f', '.x', '..x', '_x', ' a ', 'a', '..', '甲乙', '丙丁', 'x\\u002fy', '_u', '__u'];
    expect(new Set(inputs.map(sanitizeSpoolSegment)).size).toBe(inputs.length);
  });

  it('sanitizes project and session ids before resolving a path under the spool root', async () => {
    const temp = makeTmpRoot();
    const root = join(temp, 'spool');
    const attempts: CaptureThinEvent[] = [
      thinEvent({ project_id: '../outside-project', session_id: 'session-1' }),
      thinEvent({ project_id: 'project/with/slash', session_id: 'session-2' }),
      thinEvent({ project_id: '', session_id: 'session-3' }),
      thinEvent({ project_id: 'project-alpha', session_id: '../outside-session' }),
      thinEvent({ project_id: 'project-alpha', session_id: '' }),
    ];

    const results = await Promise.all(
      attempts.map((event) => settleAppend(appendCaptureEvent(event, spoolOptions(root))))
    );

    expect(results).toEqual(
      Array.from({ length: attempts.length }, () =>
        expect.objectContaining({ success: true, path: expect.any(String) })
      )
    );

    for (const result of results) {
      if (result instanceof Error || typeof result.path !== 'string') continue;
      expectInsideRoot(result.path, root);
      expect(result.path.endsWith('.jsonl')).toBe(true);
    }
    expect(existsSync(join(dirname(root), 'outside-project'))).toBe(false);
    expect(existsSync(join(root, 'project-alpha', '..', 'outside-session.jsonl'))).toBe(false);
  });

  it('swallows underlying write errors and still returns success to the hook caller', async () => {
    const temp = makeTmpRoot();
    const blockedRoot = join(temp, 'spool-root-is-a-file');
    writeFileSync(blockedRoot, 'not a directory');

    const result = await settleAppend(appendCaptureEvent(thinEvent(), spoolOptions(blockedRoot)));

    expect(result).not.toBeInstanceOf(Error);
    expect(result).toMatchObject({ success: true });
  });

  it('treats CC_MEMORY_SKIP_TOOLS as a full override of the default skip list', () => {
    let defaultSkip: ReadonlySet<string> | undefined;
    expect(() => {
      defaultSkip = loadCaptureSkipTools({});
    }).not.toThrow();
    expect([...(defaultSkip ?? [])]).toEqual(DEFAULT_CAPTURE_SKIP_TOOLS);

    let bashOnly: ReadonlySet<string> | undefined;
    expect(() => {
      bashOnly = loadCaptureSkipTools({ CC_MEMORY_SKIP_TOOLS: 'Bash' });
    }).not.toThrow();
    expect([...(bashOnly ?? [])]).toEqual(['Bash']);

    let bashSkipped: boolean | undefined;
    let todoWriteSkipped: boolean | undefined;
    expect(() => {
      bashSkipped = shouldSkipCaptureTool('Bash', { CC_MEMORY_SKIP_TOOLS: 'Bash' });
      todoWriteSkipped = shouldSkipCaptureTool('TodoWrite', { CC_MEMORY_SKIP_TOOLS: 'Bash' });
    }).not.toThrow();
    expect(bashSkipped).toBe(true);
    expect(todoWriteSkipped).toBe(false);

    let emptyOverride: ReadonlySet<string> | undefined;
    let defaultToolSkipped: boolean | undefined;
    expect(() => {
      emptyOverride = loadCaptureSkipTools({ CC_MEMORY_SKIP_TOOLS: '' });
      defaultToolSkipped = shouldSkipCaptureTool('TodoWrite', { CC_MEMORY_SKIP_TOOLS: '' });
    }).not.toThrow();
    expect([...(emptyOverride ?? [])]).toEqual([]);
    expect(defaultToolSkipped).toBe(false);
  });

  it('writes only the thin PostToolUse event fields, never tool_input or tool_response bodies', async () => {
    const root = join(makeTmpRoot(), 'spool');
    const eventWithBodies = {
      ...thinEvent(),
      tool_input: { command: 'cat secret.txt' },
      tool_response: { stdout: 'secret response body' },
    };

    const result = await settleAppend(appendCaptureEvent(eventWithBodies, spoolOptions(root)));

    expect(result).toMatchObject({ success: true });

    const spoolFile = expectedSpoolFile(root);
    expect(existsSync(spoolFile), spoolFile).toBe(true);
    if (!existsSync(spoolFile)) return;

    const [line] = readJsonl(spoolFile);
    expect(Object.keys(line).sort()).toEqual(
      [
        'project_id',
        'session_id',
        'timestamp',
        'tool_name',
        'transcript_offset',
        'transcript_path',
      ].sort()
    );
    expect(line).toEqual(thinEvent());
    expect(line).not.toHaveProperty('tool_input');
    expect(line).not.toHaveProperty('tool_response');
  });

  it('writes Stop sentinel lines as transcript_path plus hwm_offset only', async () => {
    const root = join(makeTmpRoot(), 'spool');
    const sentinel: CaptureStopSentinel = {
      project_id: 'project-alpha',
      session_id: 'session-1',
      timestamp: TIMESTAMP,
      transcript_path: '/tmp/claude-session.jsonl',
      hwm_offset: 8192,
    };

    const result = await settleAppend(appendStopSentinel(sentinel, spoolOptions(root)));

    expect(result).toMatchObject({ success: true });

    const spoolFile = expectedSpoolFile(root);
    expect(existsSync(spoolFile), spoolFile).toBe(true);
    if (!existsSync(spoolFile)) return;

    const [line] = readJsonl(spoolFile);
    expect(line).toEqual({
      transcript_path: '/tmp/claude-session.jsonl',
      hwm_offset: 8192,
    });
  });
});

describe('decodeSpoolSegment (inverse of sanitizeSpoolSegment; Codex R1 finding 2)', () => {
  it('round-trips ASCII, CJK, literal _u, leading dot, spaces and astral code points', () => {
    for (const id of ['CC-memory', '手機遠端控制', '回收辨識_u測試', '.claude', 'a b/😀', '_plain', '__', '_14_raw']) {
      expect(decodeSpoolSegment(sanitizeSpoolSegment(id))).toBe(id);
    }
  });

  it('leaves unknown and already-plain segments untouched', () => {
    expect(decodeSpoolSegment('unknown')).toBe('unknown');
    expect(decodeSpoolSegment('CC-memory')).toBe('CC-memory');
    expect(decodeSpoolSegment('__')).toBe('__');
  });

  it('does not decode a lone surrogate escape into an invalid code point', () => {
    expect(decodeSpoolSegment('_ud800')).toBe('_ud800');
  });
});
