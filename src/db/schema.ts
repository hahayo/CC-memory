// src/db/schema.ts
import { pgTable, uuid, text, timestamp, jsonb, index, vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Embedding 維度常數（與 Gemini gemini-embedding-001 匹配）
// 這個值是固定的，不需要從環境變數讀取
const EMBEDDING_DIMENSIONS = 1536;

export const projectMemories = pgTable(
  'project_memories',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    // 專案識別
    projectId: text('project_id').notNull(),
    projectPath: text('project_path'),

    // 記憶類型: 'session' | 'decision'
    type: text('type').notNull(),

    // 內容
    summary: text('summary').notNull(),
    keywords: text('keywords').array().default(sql`'{}'::text[]`),
    decisions: text('decisions').array().default(sql`'{}'::text[]`),
    nextSteps: text('next_steps').array().default(sql`'{}'::text[]`),

    // Embedding 向量（用於語義搜尋）
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),

    // 狀態: 'active' | 'merged' | 'archived'
    status: text('status').default('active'),
    mergedInto: uuid('merged_into'),

    // 元資料
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // HNSW 索引用於快速向量相似度搜尋
    index('embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    // 專案 ID 索引
    index('project_id_idx').on(table.projectId),
    // 狀態索引
    index('status_idx').on(table.status),
  ]
);

// TypeScript 型別
export type Memory = typeof projectMemories.$inferSelect;
export type NewMemory = typeof projectMemories.$inferInsert;
