// src/utils/embedding.ts
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';
import { config } from '../config.js';

export const EMBEDDING_REDACTION_RULES_VERSION = '2026-08-19.3';

export interface EmbeddingPolicyEvidence {
  rules_version: string;
  redaction_count: number;
  rule_counts: Record<string, number>;
  input_sha256: string;
}

export interface PreparedEmbeddingText {
  text: string;
  evidence: EmbeddingPolicyEvidence;
}

interface EmbeddingRedactionRule {
  id: string;
  pattern: RegExp;
  replacement: string;
}

const EMBEDDING_REDACTION_RULES: EmbeddingRedactionRule[] = [
  {
    id: 'private_key',
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
    replacement: '[REDACTED:private_key]',
  },
  {
    id: 'google_api_key',
    pattern: /AIza[0-9A-Za-z_-]{30,}/gu,
    replacement: '[REDACTED:google_api_key]',
  },
  {
    id: 'openai_api_key',
    pattern: /sk-[0-9A-Za-z_-]{20,}/gu,
    replacement: '[REDACTED:openai_api_key]',
  },
  {
    id: 'github_token',
    pattern: /gh[pousr]_[0-9A-Za-z]{20,}/gu,
    replacement: '[REDACTED:github_token]',
  },
  {
    id: 'aws_access_key',
    pattern: /AKIA[0-9A-Z]{16}/gu,
    replacement: '[REDACTED:aws_access_key]',
  },
];

const LABELED_SECRET_PATTERN =
  /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|api[_ -]?key|secret[_ -]?key|access[_ -]?token))(["']?\s*[:=]\s*["'`]?)(?!\[REDACTED:)([^\s"'`]{8,})/giu;

export function prepareEmbeddingText(text: string): PreparedEmbeddingText {
  let prepared = text;
  const ruleCounts: Record<string, number> = {};

  for (const rule of EMBEDDING_REDACTION_RULES) {
    let count = 0;
    prepared = prepared.replace(rule.pattern, () => {
      count += 1;
      return rule.replacement;
    });
    if (count > 0) ruleCounts[rule.id] = count;
  }

  let labeledSecretCount = 0;
  prepared = prepared.replace(
    LABELED_SECRET_PATTERN,
    (_match, label: string, separator: string) => {
      labeledSecretCount += 1;
      return `${label}${separator}[REDACTED:labeled_secret]`;
    },
  );
  if (labeledSecretCount > 0) ruleCounts.labeled_secret = labeledSecretCount;

  return {
    text: prepared,
    evidence: {
      rules_version: EMBEDDING_REDACTION_RULES_VERSION,
      redaction_count: Object.values(ruleCounts).reduce((sum, count) => sum + count, 0),
      rule_counts: ruleCounts,
      input_sha256: createHash('sha256').update(prepared, 'utf8').digest('hex'),
    },
  };
}

export function mergeEmbeddingPolicyMetadata(
  metadata: unknown,
  evidence: EmbeddingPolicyEvidence,
): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  base.embedding_policy = evidence;
  return base;
}

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

export interface ObservationEmbeddingInput {
  title: string;
  facts: string[];
  narrative: string;
}

/**
 * 組合文本用於生成 embedding
 * 將 summary、keywords、decisions 組合成單一文本
 */
export function composeEmbeddingText(
  summary: string,
  keywords?: string[],
  decisions?: string[]
): string {
  const parts: string[] = [summary];

  if (keywords && keywords.length > 0) {
    parts.push(`關鍵字: ${keywords.join(', ')}`);
  }

  if (decisions && decisions.length > 0) {
    parts.push(`決策: ${decisions.join('; ')}`);
  }

  return parts.join('\n');
}

export function composeObservationEmbeddingText(
  observation: ObservationEmbeddingInput
): string {
  return [observation.title, observation.facts.join(' '), observation.narrative].join('\n');
}

/**
 * 正規化向量（L2 normalization）
 */
export function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return vector;
  return vector.map(val => val / magnitude);
}

/**
 * 生成文件 embedding（用於儲存）
 * 使用 RETRIEVAL_DOCUMENT task type
 */
export async function generateEmbedding(
  text: string,
  embeddingConfig?: EmbeddingConfig
): Promise<number[] | null> {
  const apiKey = embeddingConfig?.apiKey || config.geminiApiKey;

  if (!apiKey) {
    return null;
  }

  const model = embeddingConfig?.model || config.embeddingModel;
  const dimensions = embeddingConfig?.dimensions || config.embeddingDimensions;

  try {
    const genAI = new GoogleGenAI({ apiKey });
    const prepared = prepareEmbeddingText(text);

    const response = await genAI.models.embedContent({
      model,
      contents: prepared.text,
      config: {
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: dimensions,
      },
    });

    const embedding = response.embeddings?.[0]?.values;

    if (!embedding || embedding.length === 0) {
      console.error('No embedding returned from Gemini API');
      return null;
    }

    return normalizeVector(embedding);
  } catch (error) {
    // 刻意不記錄 error.message（provider 可能回吐請求內容，見 tests/utils/embedding.test.ts
    // 「egress redaction」）。只記錯誤類別與 HTTP status，讓 supervisor journal 能分辨
    // 配額（429）／驗證（401/403）／網路（無 status）——2026-09-01 事故因此不可考。
    // error.name 是 provider 可改寫的字串，只放行識別字形式，避免被塞入回吐內容。
    const rawName = error instanceof Error ? error.name : 'UnknownError';
    const name = /^[A-Za-z0-9_]{1,40}$/.test(rawName) ? rawName : 'Error';
    const status = (error as { status?: unknown } | null)?.status;
    const statusText = typeof status === 'number' ? ` status=${status}` : '';
    console.error(`Failed to generate embedding (${name}${statusText})`);
    return null;
  }
}

/**
 * 生成查詢 embedding（用於搜尋）
 * 使用 RETRIEVAL_QUERY task type
 */
export async function generateQueryEmbedding(
  query: string,
  embeddingConfig?: EmbeddingConfig
): Promise<number[] | null> {
  const apiKey = embeddingConfig?.apiKey || config.geminiApiKey;

  if (!apiKey) {
    return null;
  }

  const model = embeddingConfig?.model || config.embeddingModel;
  const dimensions = embeddingConfig?.dimensions || config.embeddingDimensions;

  try {
    const genAI = new GoogleGenAI({ apiKey });
    const prepared = prepareEmbeddingText(query);

    const response = await genAI.models.embedContent({
      model,
      contents: prepared.text,
      config: {
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: dimensions,
      },
    });

    const embedding = response.embeddings?.[0]?.values;

    if (!embedding || embedding.length === 0) {
      console.error('No embedding returned from Gemini API');
      return null;
    }

    return normalizeVector(embedding);
  } catch (error) {
    // 同 generateEmbedding：不記 message，只記白名單化的錯誤類別與 HTTP status。
    const rawName = error instanceof Error ? error.name : 'UnknownError';
    const name = /^[A-Za-z0-9_]{1,40}$/.test(rawName) ? rawName : 'Error';
    const status = (error as { status?: unknown } | null)?.status;
    const statusText = typeof status === 'number' ? ` status=${status}` : '';
    console.error(`Failed to generate query embedding (${name}${statusText})`);
    return null;
  }
}

/**
 * 檢查 embedding 功能是否可用
 */
export function isEmbeddingEnabled(): boolean {
  return !!config.geminiApiKey;
}
