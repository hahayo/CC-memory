// src/db/schema.ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  vector,
  check,
  integer,
  real,
  bigint,
} from 'drizzle-orm/pg-core';
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

    // 冪等 + 跨電腦稽核（v0.3）
    // idempotencyKey：client 送出的冪等鍵，partial unique（NULL 可重複）
    // contentHash：sha256(projectId||type||summary||keywords) 用於衝突時區分「同 key 同 payload（真冪等）」vs「同 key 不同 payload（靜默吞 bug）」
    // writerHost：寫入者 hostname，跨電腦同步審計
    idempotencyKey: text('idempotency_key'),
    contentHash: text('content_hash'),
    writerHost: text('writer_host'),

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
    // 冪等 partial unique index：scope by (project_id, idempotency_key)
    // 讓 client 可在不同 project 重用同一把 key（例如 `save-${sessionId}`），
    // 不會被誤判成跨 project retry（codex review round 15 P1）。
    // idempotency_key IS NOT NULL 且 status='active' 才進 index；
    // archived row 不佔 unique slot，支援 undo → re-save 流程
    // （codex review round 19 P2：deleteByIdempotencyKey 設 status='archived' 後，
    //  同 key 再 save 應可建新 active row，而非撈到 archived row 回 idempotent=true）。
    uniqueIndex('project_memories_idempotency_idx')
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL AND ${table.status} = 'active'`),
  ]
);

// TypeScript 型別
export type Memory = typeof projectMemories.$inferSelect;
export type NewMemory = typeof projectMemories.$inferInsert;

// ---------------------------------------------------------------------------
// tasks（v0.2 新增）— 由 Phase 1 TDD 加入
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: text('project_id').notNull(),
    projectPath: text('project_path'),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    dueDate: timestamp('due_date', { withTimezone: true }),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    source: text('source').notNull().default('manual'),
    sourceRef: text('source_ref'),
    // idempotency_key 由 table-level partial unique index 綁 (project_id, idempotency_key)，
    // 不是 column-level global unique（codex review round 15 P1）。
    idempotencyKey: text('idempotency_key'),
    writerHost: text('writer_host'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (table) => [
    check('tasks_title_length_check', sql`char_length(${table.title}) BETWEEN 1 AND 500`),
    check('tasks_status_check', sql`${table.status} IN ('open','in_progress','done','cancelled')`),
    check('tasks_priority_check', sql`${table.priority} IN ('low','normal','high')`),
    check('tasks_source_check', sql`${table.source} IN ('manual','telegram','claude-code','codex','mcp')`),
    index('tasks_project_status_created_idx').on(table.projectId, table.status, table.createdAt.desc()),
    index('tasks_due_date_idx')
      .on(table.dueDate)
      .where(sql`${table.dueDate} IS NOT NULL AND ${table.status} <> 'done'`),
    // 冪等 partial unique index：scope by (project_id, idempotency_key)
    // 同一客戶端 key 可在不同 project 重用（codex review round 15 P1）。
    uniqueIndex('tasks_idempotency_project_key_idx')
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ]
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// ---------------------------------------------------------------------------
// search_feedback（v0.2 新增）— 由 Phase 1 TDD 加入
// retrieval 評估用：query / mode / 排名結果 / 使用者選擇 / thumbs
// ---------------------------------------------------------------------------

export const searchFeedback = pgTable(
  'search_feedback',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    query: text('query').notNull(),
    querySurface: text('query_surface').notNull(),
    queryProjectId: text('query_project_id'),
    mode: text('mode').notNull(),
    limit: integer('limit').notNull(),
    resultIds: uuid('result_ids').array().notNull(),
    resultProjectIds: text('result_project_ids').array().notNull(),
    rankPositions: integer('rank_positions').array().notNull(),
    scores: real('scores').array(),
    // v0.3 round 17：cc_memory_search 的 type filter（'session' / 'decision' / NULL=no filter）
    // 納入 search_feedback 讓 eval 區分「同 query 不同 type filter」的 runs
    filterType: text('filter_type'),
    selectedId: uuid('selected_id'),
    selectedRank: integer('selected_rank'),
    thumbs: text('thumbs'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('search_feedback_surface_check', sql`${table.querySurface} IN ('telegram','mcp','http')`),
    check('search_feedback_mode_check', sql`${table.mode} IN ('keyword','semantic','hybrid')`),
    check(
      'search_feedback_filter_type_check',
      sql`${table.filterType} IS NULL OR ${table.filterType} IN ('session','decision')`
    ),
    check(
      'search_feedback_thumbs_check',
      sql`${table.thumbs} IS NULL OR ${table.thumbs} IN ('up','down')`
    ),
    // v0.3：四陣列長度對齊（scores 可 NULL；非 NULL 時長度須對齊）
    // 防止 MCP handler 拼錯欄位時靜默寫入 misaligned ranking，讓 eval 報表漂移
    check(
      'search_feedback_arrays_same_length',
      sql`cardinality(${table.resultIds}) = cardinality(${table.resultProjectIds})
          AND cardinality(${table.resultIds}) = cardinality(${table.rankPositions})
          AND (${table.scores} IS NULL OR cardinality(${table.scores}) = cardinality(${table.resultIds}))`
    ),
    index('search_feedback_created_idx').on(table.createdAt.desc()),
    index('search_feedback_mode_idx').on(table.mode, table.thumbs),
  ]
);

export type SearchFeedback = typeof searchFeedback.$inferSelect;
export type NewSearchFeedback = typeof searchFeedback.$inferInsert;

// ---------------------------------------------------------------------------
// bot_user_state（v0.2 新增）— 由 Phase 1 TDD 加入
// Telegram bot active project 持久化；重啟不掉資料
// ---------------------------------------------------------------------------

export const botUserState = pgTable('bot_user_state', {
  telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).primaryKey(),
  activeProjectId: text('active_project_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BotUserState = typeof botUserState.$inferSelect;
export type NewBotUserState = typeof botUserState.$inferInsert;
