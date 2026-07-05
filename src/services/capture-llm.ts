// src/services/capture-llm.ts
//
// CC-memory v0.5 M2b capture LLM adapter + schema validation.

import { GoogleGenAI } from '@google/genai';

export const DEFAULT_CAPTURE_LLM_PROVIDER = 'gemini-flash';
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
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  extract(request: CaptureLlmRequest): Promise<CaptureLlmRawResponse>;
}

export interface CreateCaptureLlmAdapterOptions {
  env?: Record<string, string | undefined>;
  stdout?: { write(chunk: string): unknown };
}

export type CaptureLlmErrorCode =
  | 'CAPTURE_LLM_DISABLED'
  | 'UNSUPPORTED_CAPTURE_LLM'
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

  constructor(readonly model: string, reason: string) {
    this.disabledReason = reason;
  }

  async extract(): Promise<CaptureLlmRawResponse> {
    throw new CaptureLlmValidationError('CAPTURE_LLM_DISABLED', this.disabledReason, {
      model: this.model,
    });
  }
}

class UnsupportedCaptureLlmAdapter implements CaptureLlmAdapter {
  constructor(readonly model: string, private readonly provider: string) {}

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

class GeminiFlashCaptureLlmAdapter implements CaptureLlmAdapter {
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
  const provider = env.CC_CAPTURE_LLM?.trim() || DEFAULT_CAPTURE_LLM_PROVIDER;

  if (provider !== DEFAULT_CAPTURE_LLM_PROVIDER) {
    return new UnsupportedCaptureLlmAdapter(provider, provider);
  }

  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.CC_CAPTURE_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_FLASH_MODEL;
  if (!apiKey) {
    stdout.write('[cc-memory] auto-capture disabled: GEMINI_API_KEY is not set\n');
    return new DisabledCaptureLlmAdapter(model, 'GEMINI_API_KEY is not set');
  }

  return new GeminiFlashCaptureLlmAdapter(model, apiKey);
}
