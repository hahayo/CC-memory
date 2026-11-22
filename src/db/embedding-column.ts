// src/db/embedding-column.ts — 依 embedding provider 選擇實際讀寫的向量欄位
//
// provider='gemini' → 既有 1536 維 `embedding` 欄；
// provider='local'  → migration 0014 新增的 1024 維 `embedding_bge_m3` 欄。
// 所有寫入與搜尋路徑統一從這裡取欄位，避免各處散落 provider 判斷。

import { sql, type SQL } from 'drizzle-orm';
import { config } from '../config.js';
import {
  embeddingColumnName,
  type EmbeddingProvider,
} from '../utils/embedding-provider.js';
import { observations, projectMemories } from './schema.js';

export function memoryEmbeddingColumn(
  provider: EmbeddingProvider = config.embeddingProvider,
) {
  return provider === 'local' ? projectMemories.embeddingBgeM3 : projectMemories.embedding;
}

export function observationEmbeddingColumn(
  provider: EmbeddingProvider = config.embeddingProvider,
) {
  return provider === 'local' ? observations.embeddingBgeM3 : observations.embedding;
}

/** Drizzle insert property key（`embedding` 或 `embeddingBgeM3`） */
export function embeddingFieldKey(
  provider: EmbeddingProvider = config.embeddingProvider,
): 'embedding' | 'embeddingBgeM3' {
  return provider === 'local' ? 'embeddingBgeM3' : 'embedding';
}

/** raw SQL（capture-worker／session-finalize 的 sql`` 寫入）用的欄位 identifier */
export function embeddingColumnSql(
  provider: EmbeddingProvider = config.embeddingProvider,
): SQL {
  return sql`${sql.identifier(embeddingColumnName(provider))}`;
}

/**
 * 「另一個 provider」的欄位 identifier。UPDATE 改寫文字時一併設 NULL：
 * 舊向量是另一個模型依「舊文字」算的，留著會讓之後只補 NULL 列的 backfill 跳過它、
 * 切回該 provider 時搜到過期向量。設 NULL 後由 backfill 依新文字重算。
 */
export function inactiveEmbeddingColumnSql(
  provider: EmbeddingProvider = config.embeddingProvider,
): SQL {
  const other: EmbeddingProvider = provider === 'local' ? 'gemini' : 'local';
  return sql`${sql.identifier(embeddingColumnName(other))}`;
}
