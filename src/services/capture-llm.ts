// src/services/capture-llm.ts
//
// CC-memory v0.5 M2b capture LLM adapter + schema validation.

import { spawn } from 'node:child_process';
import { constants, accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

export const DEFAULT_CAPTURE_LLM_PROVIDER = 'claude-cli';
export const GEMINI_FLASH_CAPTURE_LLM_PROVIDER = 'gemini-flash';
export const DEFAULT_CLAUDE_CLI_MODEL = 'haiku';
export const DEFAULT_CLAUDE_CLI_TIMEOUT_MS = 120_000;
export const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-2.5-flash';

export type CaptureObservationType =
  | 'decision'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'discovery'
  | 'change';

const CAPTURE_OBSERVATION_TYPES: readonly CaptureObservationType[] = [
  'decision',
  'bugfix',
  'feature',
  'refactor',
  'discovery',
  'change',
];

export interface CaptureLlmObservation {
  type: CaptureObservationType;
  title: string;
  subtitle?: string;
  facts: string[];
  concepts: string[];
  files: string[];
  narrative: string;
  discovery_tokens: number;
}

export interface CaptureLlmSessionSummary {
  summary: string;
  keywords: string[];
  decisions: string[];
  next_steps: string[];
}

export interface CaptureLlmExtraction {
  session_summary: CaptureLlmSessionSummary;
  observations: CaptureLlmObservation[];
}

export interface CaptureLlmRequest {
  projectId: string;
  sessionId: string;
  transcript: string;
  spoolOffsetStart: number;
  spoolOffsetEnd: number;
  hwmOffsetStart: number;
  hwmOffsetEnd: number;
}

export interface CaptureLlmRawResponse {
  model: string;
  text: string;
}

export interface CaptureLlmAdapter {
  readonly model: string;
  readonly provider?: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  extract(request: CaptureLlmRequest): Promise<CaptureLlmRawResponse>;
}

export interface ClaudeCliRunRequest {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  /** 附加到子程序的環境變數（merge 進 process.env）。 */
  env?: Record<string, string>;
}

export interface ClaudeCliRunResult {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
}

export type ClaudeCliRunner = (request: ClaudeCliRunRequest) => Promise<ClaudeCliRunResult>;

export interface CreateCaptureLlmAdapterOptions {
  env?: Record<string, string | undefined>;
  stdout?: { write(chunk: string): unknown };
  runClaudeCli?: ClaudeCliRunner;
  findClaudeCli?: (env: Record<string, string | undefined>) => string;
  emitDisabledWarning?: boolean;
}

export type CaptureLlmErrorCode =
  | 'CAPTURE_LLM_DISABLED'
  | 'UNSUPPORTED_CAPTURE_LLM'
  | 'CLAUDE_CLI_EXIT_NONZERO'
  | 'CLAUDE_CLI_OUTPUT_INVALID'
  | 'CLAUDE_CLI_TIMEOUT'
  | 'LLM_MALFORMED_JSON'
  | 'LLM_SCHEMA_INVALID'
  | 'LLM_EXTRACT_FAILED';

export class CaptureLlmValidationError extends Error {
  constructor(
    public readonly code: CaptureLlmErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'CaptureLlmValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', `${field} must be string[]`, {
      field,
    });
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', `${field} must be non-empty string`, {
      field,
    });
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', `${field} must be string`, {
      field,
    });
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', `${field} must be positive integer`, {
      field,
    });
  }
  return value as number;
}

function parseObservation(value: unknown, index: number): CaptureLlmObservation {
  if (!isRecord(value)) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', 'observation must be object', {
      index,
    });
  }
  const type = value.type;
  if (typeof type !== 'string' || !CAPTURE_OBSERVATION_TYPES.includes(type as CaptureObservationType)) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', 'observation type is invalid', {
      index,
      type,
    });
  }

  return {
    type: type as CaptureObservationType,
    title: requiredString(value.title, `observations[${index}].title`),
    subtitle: optionalString(value.subtitle, `observations[${index}].subtitle`),
    facts: stringArray(value.facts, `observations[${index}].facts`),
    concepts: stringArray(value.concepts, `observations[${index}].concepts`),
    files: stringArray(value.files, `observations[${index}].files`),
    narrative: requiredString(value.narrative, `observations[${index}].narrative`),
    discovery_tokens: positiveInteger(
      value.discovery_tokens,
      `observations[${index}].discovery_tokens`
    ),
  };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseCaptureLlmExtraction(response: CaptureLlmRawResponse): CaptureLlmExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(response.text));
  } catch (error) {
    throw new CaptureLlmValidationError('LLM_MALFORMED_JSON', 'LLM returned malformed JSON', {
      model: response.model,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isRecord(parsed)) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', 'LLM response must be an object', {
      model: response.model,
    });
  }
  const sessionSummary = parsed.session_summary;
  if (!isRecord(sessionSummary)) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', 'session_summary must be object', {
      model: response.model,
    });
  }
  if (!Array.isArray(parsed.observations)) {
    throw new CaptureLlmValidationError('LLM_SCHEMA_INVALID', 'observations must be array', {
      model: response.model,
    });
  }

  return {
    session_summary: {
      summary: requiredString(sessionSummary.summary, 'session_summary.summary'),
      keywords: stringArray(sessionSummary.keywords, 'session_summary.keywords'),
      decisions: stringArray(sessionSummary.decisions, 'session_summary.decisions'),
      next_steps: stringArray(sessionSummary.next_steps, 'session_summary.next_steps'),
    },
    observations: parsed.observations.map((entry, index) => parseObservation(entry, index)),
  };
}

export function estimateDiscoveryTokens(text: string): number {
  const cjkCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const asciiWordCount = (text.match(/[A-Za-z0-9]+(?:[._'-][A-Za-z0-9]+)*/g) ?? []).length;
  const punctuationAndBreakCount = (
    text.match(/[^\sA-Za-z0-9\u3400-\u9fff\uf900-\ufaff]|\r|\n/g) ?? []
  ).length;

  return Math.ceil(cjkCount * 1.0 + asciiWordCount * 1.3 + punctuationAndBreakCount * 0.3 + 12);
}

class DisabledCaptureLlmAdapter implements CaptureLlmAdapter {
  readonly disabled = true;
  readonly disabledReason: string;

  constructor(readonly model: string, reason: string, readonly provider?: string) {
    this.disabledReason = reason;
  }

  async extract(): Promise<CaptureLlmRawResponse> {
    throw new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', this.disabledReason, {
      model: this.model,
      provider: this.provider,
    });
  }
}

class UnsupportedCaptureLlmAdapter implements CaptureLlmAdapter {
  constructor(readonly model: string, readonly provider: string) {}

  async extract(): Promise<CaptureLlmRawResponse> {
    throw new CaptureLlmValidationError(
      'UNSUPPORTED_CAPTURE_LLM',
      `Unsupported capture LLM provider: ${this.provider}`,
      {
        model: this.model,
        provider: this.provider,
      }
    );
  }
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function createEnoent(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function findExecutableOnPath(command: string, pathValue: string): string {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw createEnoent(`${command} executable not found on PATH`);
}

function defaultFindClaudeCli(env: Record<string, string | undefined>): string {
  return findExecutableOnPath('claude', env.PATH ?? process.env.PATH ?? '');
}

export function formatCaptureLlmDisabledWarning(provider: string, reason: string): string {
  return `[cc-memory] auto-capture disabled (${provider}): ${reason}\n`;
}

function ensureValidationErrorHasModel(
  error: CaptureLlmValidationError,
  model: string,
  provider: string
): CaptureLlmValidationError {
  return new CaptureLlmValidationError(error.code, error.message, {
    ...error.details,
    model: typeof error.details.model === 'string' ? error.details.model : model,
    provider,
  });
}

function parseClaudeCliEnvelope(stdout: string, model: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(stdout));
  } catch (error) {
    throw new CaptureLlmValidationError(
      'CLAUDE_CLI_OUTPUT_INVALID',
      'claude-cli returned malformed JSON envelope',
      {
        model,
        provider: DEFAULT_CAPTURE_LLM_PROVIDER,
        cause: errorMessage(error),
      }
    );
  }

  if (!isRecord(parsed) || typeof parsed.result !== 'string') {
    throw new CaptureLlmValidationError(
      'CLAUDE_CLI_OUTPUT_INVALID',
      'claude-cli JSON envelope must contain a string result field',
      {
        model,
        provider: DEFAULT_CAPTURE_LLM_PROVIDER,
      }
    );
  }

  return parsed.result;
}

export function runClaudeCliSubprocess(input: ClaudeCliRunRequest): Promise<ClaudeCliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(input.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: ClaudeCliRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1_000);
    }, input.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      finish({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
      });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input.stdin);
  });
}

class ClaudeCliCaptureLlmAdapter implements CaptureLlmAdapter {
  readonly provider = DEFAULT_CAPTURE_LLM_PROVIDER;

  constructor(
    readonly model: string,
    private readonly command: string,
    private readonly timeoutMs: number,
    private readonly runClaudeCli: ClaudeCliRunner
  ) {}

  async extract(request: CaptureLlmRequest): Promise<CaptureLlmRawResponse> {
    let result: ClaudeCliRunResult;
    try {
      result = await this.runClaudeCli({
        command: this.command,
        // --strict-mcp-config：抽取子 session 不載使用者 MCP servers（啟動負擔 + 隔離）。
        args: ['-p', '--model', this.model, '--output-format', 'json', '--strict-mcp-config'],
        stdin: buildCapturePrompt(request),
        timeoutMs: this.timeoutMs,
        // 遞迴 capture 斷路器：capture hooks 看到此 marker 直接 exit 0，
        // 抽取子 session 自身不得再被 capture（仿 claude-mem 的子程序隔離概念）。
        env: { CC_MEMORY_CAPTURE_CHILD: '1' },
      });
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        throw new CaptureLlmValidationError(
          'CAPTURE_LLM_DISABLED',
          'claude CLI not found; install Claude Code CLI and ensure it is on PATH',
          {
            model: this.model,
            provider: this.provider,
          }
        );
      }
      throw new CaptureLlmValidationError('LLM_EXTRACT_FAILED', 'claude-cli subprocess failed', {
        model: this.model,
        provider: this.provider,
        cause: errorMessage(error),
      });
    }

    if (result.timedOut) {
      throw new CaptureLlmValidationError(
        'CLAUDE_CLI_TIMEOUT',
        `claude-cli timed out after ${this.timeoutMs}ms`,
        {
          model: this.model,
          provider: this.provider,
          timeoutMs: this.timeoutMs,
        }
      );
    }

    if (result.exitCode !== 0) {
      throw new CaptureLlmValidationError(
        'CLAUDE_CLI_EXIT_NONZERO',
        `claude-cli exited with code ${result.exitCode ?? 'null'}`,
        {
          model: this.model,
          provider: this.provider,
          exitCode: result.exitCode,
          signal: result.signal ?? null,
        }
      );
    }

    const text = parseClaudeCliEnvelope(result.stdout, this.model);
    try {
      parseCaptureLlmExtraction({ model: this.model, text });
    } catch (error) {
      if (error instanceof CaptureLlmValidationError) {
        throw ensureValidationErrorHasModel(error, this.model, this.provider);
      }
      throw error;
    }

    return {
      model: this.model,
      text,
    };
  }
}

class GeminiFlashCaptureLlmAdapter implements CaptureLlmAdapter {
  readonly provider = GEMINI_FLASH_CAPTURE_LLM_PROVIDER;
  private readonly ai: GoogleGenAI;

  constructor(readonly model: string, apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async extract(request: CaptureLlmRequest): Promise<CaptureLlmRawResponse> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: buildCapturePrompt(request),
    });
    return {
      model: this.model,
      text: response.text ?? '',
    };
  }
}

function buildCapturePrompt(request: CaptureLlmRequest): string {
  return [
    'You extract durable project memory from a Claude Code session transcript.',
    'Return only strict JSON with this shape:',
    '{"session_summary":{"summary":"...","keywords":[],"decisions":[],"next_steps":[]},"observations":[]}',
    'Each observation must include type, title, subtitle, facts, concepts, files, narrative, discovery_tokens.',
    'Allowed observation type values: decision, bugfix, feature, refactor, discovery, change.',
    `project_id: ${request.projectId}`,
    `session_id: ${request.sessionId}`,
    `spool_offset: ${request.spoolOffsetStart}-${request.spoolOffsetEnd}`,
    `transcript_offset: ${request.hwmOffsetStart}-${request.hwmOffsetEnd}`,
    'Transcript:',
    request.transcript,
  ].join('\n');
}

export function isCaptureLlmDisabled(adapter: CaptureLlmAdapter): boolean {
  return adapter.disabled === true;
}

export function createCaptureLlmAdapter(
  options: CreateCaptureLlmAdapterOptions = {}
): CaptureLlmAdapter {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const emitDisabledWarning = options.emitDisabledWarning ?? true;
  const provider = env.CC_CAPTURE_LLM?.trim() || DEFAULT_CAPTURE_LLM_PROVIDER;

  if (provider === DEFAULT_CAPTURE_LLM_PROVIDER) {
    const model = env.CC_CAPTURE_CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_CLI_MODEL;
    const timeoutMs = parsePositiveIntegerEnv(
      env.CC_CAPTURE_CLAUDE_TIMEOUT_MS,
      DEFAULT_CLAUDE_CLI_TIMEOUT_MS
    );
    let command: string;
    try {
      command = (options.findClaudeCli ?? defaultFindClaudeCli)(env);
    } catch (error) {
      const reason = isErrnoCode(error, 'ENOENT')
        ? 'claude CLI not found; install Claude Code CLI, ensure it is on PATH, and log in before enabling capture'
        : `claude CLI unavailable: ${errorMessage(error)}`;
      if (emitDisabledWarning) stdout.write(formatCaptureLlmDisabledWarning(provider, reason));
      return new DisabledCaptureLlmAdapter(model, reason, provider);
    }

    return new ClaudeCliCaptureLlmAdapter(
      model,
      command,
      timeoutMs,
      options.runClaudeCli ?? runClaudeCliSubprocess
    );
  }

  if (provider !== GEMINI_FLASH_CAPTURE_LLM_PROVIDER) {
    // unsupported provider 無 model 概念——model 欄位標 unknown，避免 dead-letter
    // metadata 把 provider 名誤報成 model 名
    return new UnsupportedCaptureLlmAdapter('unknown', provider);
  }

  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.CC_CAPTURE_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_FLASH_MODEL;
  if (!apiKey) {
    const reason = 'GEMINI_API_KEY is not set; gemini-flash capture requires a Gemini API key';
    if (emitDisabledWarning) stdout.write(formatCaptureLlmDisabledWarning(provider, reason));
    return new DisabledCaptureLlmAdapter(model, reason, provider);
  }

  return new GeminiFlashCaptureLlmAdapter(model, apiKey);
}
