// tests/services/capture-llm.test.ts

import { describe, expect, it, vi } from 'vitest';
import {
  CaptureLlmValidationError,
  createCaptureLlmAdapter,
  isCaptureLlmDisabled,
  parseCaptureLlmExtraction,
} from '../../src/services/capture-llm.js';
import type { CaptureLlmRequest } from '../../src/services/capture-llm.js';

interface MockClaudeCliCall {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}

interface MockClaudeCliResult {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
}

type MockClaudeCliRunner = (call: MockClaudeCliCall) => Promise<MockClaudeCliResult>;

function adapterOptions(input: {
  env?: Record<string, string | undefined>;
  stdout?: { write(chunk: string): unknown };
  runClaudeCli?: MockClaudeCliRunner;
  findClaudeCli?: () => string;
}): Parameters<typeof createCaptureLlmAdapter>[0] & {
  runClaudeCli?: MockClaudeCliRunner;
  findClaudeCli?: () => string;
} {
  return input;
}

function stdoutSink(): { chunks: string[]; stdout: { write(chunk: string): boolean } } {
  const chunks: string[] = [];
  return {
    chunks,
    stdout: {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

function request(overrides: Partial<CaptureLlmRequest> = {}): CaptureLlmRequest {
  return {
    projectId: 'capture-llm-project',
    sessionId: 'session-claude-cli',
    transcript: 'User asked for capture LLM extraction.\nAssistant inspected files.',
    spoolOffsetStart: 10,
    spoolOffsetEnd: 42,
    hwmOffsetStart: 100,
    hwmOffsetEnd: 240,
    ...overrides,
  };
}

function extractionJson(summary = 'captured via claude-cli'): string {
  return JSON.stringify({
    session_summary: {
      summary,
      keywords: ['capture', 'claude-cli'],
      decisions: ['default capture provider is claude-cli'],
      next_steps: ['keep gemini-flash selectable'],
    },
    observations: [
      {
        type: 'decision',
        title: 'capture LLM default provider changed',
        subtitle: 'claude-cli uses Claude Code subscription quota',
        facts: ['CC_CAPTURE_LLM defaults to claude-cli'],
        concepts: ['capture-worker'],
        files: ['src/services/capture-llm.ts'],
        narrative: 'The worker calls claude-cli through a mockable subprocess adapter.',
        discovery_tokens: 21,
      },
    ],
  });
}

function claudeEnvelope(result = extractionJson()): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 12,
    result,
  });
}

async function expectValidationError(promise: Promise<unknown>): Promise<CaptureLlmValidationError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CaptureLlmValidationError);
  return caught as CaptureLlmValidationError;
}

describe('createCaptureLlmAdapter claude-cli provider selection', () => {
  it('defaults CC_CAPTURE_LLM to claude-cli when unset', () => {
    const { stdout, chunks } = stdoutSink();
    const adapter = createCaptureLlmAdapter(
      adapterOptions({
        env: {},
        stdout,
        findClaudeCli: () => 'claude',
        runClaudeCli: async () => ({ stdout: claudeEnvelope(), exitCode: 0 }),
      })
    );

    expect(adapter.model).toBe('haiku');
    expect(isCaptureLlmDisabled(adapter)).toBe(false);
    expect(chunks.join('')).toBe('');
  });

  it('keeps explicit gemini-flash behavior disabled when GEMINI_API_KEY is missing', () => {
    const { stdout, chunks } = stdoutSink();
    const adapter = createCaptureLlmAdapter(
      adapterOptions({
        env: { CC_CAPTURE_LLM: 'gemini-flash' },
        stdout,
      })
    );

    expect(isCaptureLlmDisabled(adapter)).toBe(true);
    expect(adapter.model).toBe('gemini-2.5-flash');
    expect(chunks.join('')).toContain('gemini-flash');
    expect(chunks.join('')).toContain('GEMINI_API_KEY');
  });
});

describe('claude-cli extraction subprocess contract', () => {
  it('passes model and output flags while sending the prompt through stdin', async () => {
    const calls: MockClaudeCliCall[] = [];
    const transcript = `large transcript\n${'tool output stays off argv\n'.repeat(200)}`;
    const adapter = createCaptureLlmAdapter(
      adapterOptions({
        env: {},
        stdout: stdoutSink().stdout,
        findClaudeCli: () => 'claude',
        runClaudeCli: async (call) => {
          calls.push(call);
          return { stdout: claudeEnvelope(), exitCode: 0 };
        },
      })
    );

    const raw = await adapter.extract(request({ transcript }));
    const extraction = parseCaptureLlmExtraction(raw);

    expect(extraction.session_summary.summary).toBe('captured via claude-cli');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'claude',
      args: ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config'],
      timeoutMs: 120_000,
      // 遞迴 capture 斷路器：子程序必帶 marker，hooks 據此不再 capture 抽取 session
      env: { CC_MEMORY_CAPTURE_CHILD: '1' },
    });
    expect(calls[0].stdin).toContain('project_id: capture-llm-project');
    expect(calls[0].stdin).toContain(transcript);
    expect(calls[0].args.join('\n')).not.toContain(transcript);
  });

  it('passes CC_CAPTURE_CLAUDE_MODEL through to claude without tier validation', async () => {
    const runClaudeCli = vi.fn<MockClaudeCliRunner>(async () => ({
      stdout: claudeEnvelope(extractionJson('captured with opus')),
      exitCode: 0,
    }));
    const adapter = createCaptureLlmAdapter(
      adapterOptions({
        env: { CC_CAPTURE_CLAUDE_MODEL: 'opus' },
        stdout: stdoutSink().stdout,
        findClaudeCli: () => 'claude',
        runClaudeCli,
      })
    );

    const raw = await adapter.extract(request());

    expect(raw.model).toBe('opus');
    expect(runClaudeCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['-p', '--model', 'opus', '--output-format', 'json', '--strict-mcp-config'],
      })
    );
  });

  it('maps a missing claude CLI to disabled semantics without calling the runner', () => {
    const { stdout, chunks } = stdoutSink();
    const runClaudeCli = vi.fn<MockClaudeCliRunner>(async () => ({
      stdout: claudeEnvelope(),
      exitCode: 0,
    }));
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const adapter = createCaptureLlmAdapter(
      adapterOptions({
        env: {},
        stdout,
        findClaudeCli: () => {
          throw enoent;
        },
        runClaudeCli,
      })
    );

    expect(isCaptureLlmDisabled(adapter)).toBe(true);
    expect(adapter.model).toBe('haiku');
    expect(chunks.join('')).toContain('claude-cli');
    expect(chunks.join('')).toContain('claude CLI');
    expect(runClaudeCli).not.toHaveBeenCalled();
  });

  it('throws validation errors with model metadata for nonzero exits and malformed model JSON', async () => {
    const nonzeroAdapter = createCaptureLlmAdapter(
      adapterOptions({
        env: {},
        stdout: stdoutSink().stdout,
        findClaudeCli: () => 'claude',
        runClaudeCli: async () => ({ stdout: '', stderr: 'synthetic failure', exitCode: 2 }),
      })
    );

    const nonzero = await expectValidationError(nonzeroAdapter.extract(request()));
    expect(nonzero.code).toBe('CLAUDE_CLI_EXIT_NONZERO');
    expect(nonzero.details).toMatchObject({
      model: 'haiku',
      exitCode: 2,
    });
    expect(JSON.stringify(nonzero.details)).not.toContain(request().transcript);

    const malformedAdapter = createCaptureLlmAdapter(
      adapterOptions({
        env: {},
        stdout: stdoutSink().stdout,
        findClaudeCli: () => 'claude',
        runClaudeCli: async () => ({
          stdout: claudeEnvelope('{"session_summary":'),
          exitCode: 0,
        }),
      })
    );

    const malformed = await expectValidationError(malformedAdapter.extract(request()));
    expect(malformed.code).toBe('LLM_MALFORMED_JSON');
    expect(malformed.details).toMatchObject({ model: 'haiku' });
  });

  it('turns mock timeout results into validation errors without hanging', async () => {
    const runClaudeCli = vi.fn<MockClaudeCliRunner>(async () => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
    }));
    const adapter = createCaptureLlmAdapter(
      adapterOptions({
        env: { CC_CAPTURE_CLAUDE_TIMEOUT_MS: '5' },
        stdout: stdoutSink().stdout,
        findClaudeCli: () => 'claude',
        runClaudeCli,
      })
    );

    const error = await expectValidationError(adapter.extract(request()));

    expect(error.code).toBe('CLAUDE_CLI_TIMEOUT');
    expect(error.details).toMatchObject({
      model: 'haiku',
      timeoutMs: 5,
    });
    expect(runClaudeCli).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5 }));
  });
});
