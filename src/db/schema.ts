// src/db/schema.ts
// Placeholder - will be implemented in Task 3
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const projectMemories = pgTable('project_memories', {
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

  // 狀態: 'active' | 'merged' | 'archived'
  status: text('status').default('active'),
  mergedInto: uuid('merged_into'),

  // 元資料
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// TypeScript 型別
export type Memory = typeof projectMemories.$inferSelect;
export type NewMemory = typeof projectMemories.$inferInsert;
