// src/utils/embedding-text.ts — embedding 文字組合與 redaction（不 import config.ts）
//
// config.ts 在模組載入時 resolve DATABASE_URL；backfill script 等從檔案讀 DSN 的
// 路徑不能依賴它，所以文字處理相關的純函式集中在這裡。

import { createHash } from 'node:crypto';

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
