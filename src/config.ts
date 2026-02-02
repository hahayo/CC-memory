// src/config.ts
import 'dotenv/config';

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const config = {
  // Database
  databaseUrl: process.env.DATABASE_URL || (isTest ? 'postgresql://test:test@localhost/test' : ''),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Embedding (optional - enables semantic search)
  geminiApiKey: process.env.GEMINI_API_KEY,
  embeddingModel: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),
};

// 只在非測試環境下檢查 DATABASE_URL
if (!isTest && !config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
