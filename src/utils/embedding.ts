// src/utils/embedding.ts
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import {
  composeEmbeddingText,
  composeObservationEmbeddingText,
  EMBEDDING_REDACTION_RULES_VERSION,
  mergeEmbeddingPolicyMetadata,
  normalizeVector,
  prepareEmbeddingText,
  type EmbeddingPolicyEvidence,
  type ObservationEmbeddingInput,
  type PreparedEmbeddingText,
} from './embedding-text.js';
import {
  logEmbeddingError,
  requestLocalEmbeddings,
} from './local-embedding.js';

export {
  composeEmbeddingText,
  composeObservationEmbeddingText,
  EMBEDDING_REDACTION_RULES_VERSION,
  mergeEmbeddingPolicyMetadata,
  normalizeVector,
  prepareEmbeddingText,
};
export type {
  EmbeddingPolicyEvidence,
  ObservationEmbeddingInput,
  PreparedEmbeddingText,
};

/**
 * 本機 bge-m3 embed-service（embed-service/server.py）路徑。
 * 不記 text／response body／error message，只記白名單化的錯誤名與 status。
 */
async function generateLocalEmbedding(text: string, label: string): Promise<number[] | null> {
  const prepared = prepareEmbeddingText(text);
  const result = await requestLocalEmbeddings(
    [prepared.text],
    {
      url: config.embeddingLocalUrl,
      timeoutMs: config.embeddingLocalTimeoutMs,
    },
    label,
  );
  return result?.[0] ?? null;
}

/**
 * 批次呼叫本機 bge-m3 embed-service；texts 應已經過 prepareEmbeddingText。
 */
export async function generateLocalEmbeddings(
  texts: string[],
  options?: { url?: string; timeoutMs?: number },
): Promise<number[][] | null> {
  return requestLocalEmbeddings(
    texts,
    {
      url: options?.url ?? config.embeddingLocalUrl,
      timeoutMs: options?.timeoutMs ?? config.embeddingLocalTimeoutMs,
    },
    'local embeddings',
  );
}

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

/**
 * 生成文件 embedding（用於儲存）
 * 使用 RETRIEVAL_DOCUMENT task type
 */
export async function generateEmbedding(
  text: string,
  embeddingConfig?: EmbeddingConfig
): Promise<number[] | null> {
  if (config.embeddingProvider === 'local') {
    return generateLocalEmbedding(text, 'embedding');
  }

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
    logEmbeddingError('Failed to generate embedding', error);
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
  if (config.embeddingProvider === 'local') {
    return generateLocalEmbedding(query, 'query embedding');
  }

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
    logEmbeddingError('Failed to generate query embedding', error);
    return null;
  }
}

/**
 * 檢查 embedding 功能是否可用
 */
export function isEmbeddingEnabled(): boolean {
  return config.embeddingProvider === 'local' || Boolean(config.geminiApiKey);
}
