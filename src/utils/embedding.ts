// src/utils/embedding.ts
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
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

    const response = await genAI.models.embedContent({
      model,
      contents: text,
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
    console.error('Failed to generate embedding:', error);
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

    const response = await genAI.models.embedContent({
      model,
      contents: query,
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
    console.error('Failed to generate query embedding:', error);
    return null;
  }
}

/**
 * 檢查 embedding 功能是否可用
 */
export function isEmbeddingEnabled(): boolean {
  return !!config.geminiApiKey;
}
