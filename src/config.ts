// src/config.ts
import 'dotenv/config';
import { readDatabaseInputs, resolveDatabaseUrl } from './db/resolve-url.js';

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const config = {
  // Database — 啟動期 resolveDatabaseUrl() 決策一條鎖定（一 process 一 scope 一 DB）。
  // forced personal → DATABASE_URL_PERSONAL；其餘 → DATABASE_URL。
  // fail-fast 矩陣與 sanitize 規則見 src/db/resolve-url.ts（Phase 3 v0.4，ADR-001）。
  databaseUrl: resolveDatabaseUrl(readDatabaseInputs(process.env), { allowTestFallback: isTest }),

  nodeEnv: process.env.NODE_ENV || 'development',

  // Embedding (optional - enables semantic search)
  geminiApiKey: process.env.GEMINI_API_KEY,
  embeddingModel: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),

  // Todoist（optional - 啟用 cc_todoist_* 工具；同 geminiApiKey 模式）
  todoistApiToken: process.env.TODOIST_API_TOKEN,
};
