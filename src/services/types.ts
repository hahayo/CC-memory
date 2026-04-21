// src/services/types.ts
//
// Service 層共用 input / output 型別。
// 目的：Stage 1 三個 subagent 各自寫 service 時，全部 import 這份，
// 不自行拼欄位，避免 Track M 和 Track F 對 searchMemories 回傳形狀
// 理解不一致導致 recordSearchQuery 拼欄位漂移。

import type { Memory, Task } from '../db/schema.js';

// ============================================================================
// DbClient — 消除 service 層的 `db as any`，同時又不綁死具體 drizzle runtime
// ============================================================================

/**
 * Drizzle postgres-js client 的最小 type alias。
 * service 內部實際用到的 API（select/insert/update/delete/transaction）
 * 都是 drizzle runtime 提供；這個 alias 只擋住 `any` 的蔓延。
 * 若未來換 driver，改這裡一處即可。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbClient = any;

// ============================================================================
// Search mode + envelope（Track M + Track F + Stage 2 MCP handler 共用）
// ============================================================================

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface RankingMeta {
  /** 結果排名位置，1-based；長度必須 = results.length */
  rankPositions: number[];
  /** 相似度分數；可為 null（keyword-only mode）；非 null 時長度 = results.length */
  scores: number[] | null;
}

export interface SearchQueryContext {
  query: string;
  requestedMode: SearchMode;
  effectiveMode: SearchMode;
  limit: number;
  projectId: string | null;
  querySurface: 'telegram' | 'mcp' | 'http';
}

/**
 * searchMemories 回傳的封裝物。
 * MCP handler 從這裡直接取欄位餵給 recordSearchQuery，不自行拼。
 */
export interface SearchResultEnvelope<T = Memory> {
  results: T[];
  /** 實際執行的 mode（例如 embedding disabled 時 semantic/hybrid 會降成 keyword） */
  effectiveMode: SearchMode;
  /** 排名資訊，四陣列長度必須對齊 */
  rankingMeta: RankingMeta;
  /** recordSearchQuery 所需的完整上下文（query / requested / limit / projectId / surface） */
  queryContext: SearchQueryContext;
}

// ============================================================================
// Save / Search / List / Get / Delete 輸入
// ============================================================================

export type MemoryType = 'session' | 'decision';

export interface SaveMemoryInput {
  projectId: string;
  projectPath?: string;
  type: MemoryType;
  summary: string;
  keywords?: string[];
  decisions?: string[];
  nextSteps?: string[];
  metadata?: Record<string, unknown>;
  /** 冪等鍵；非 null 時 DB 有 partial unique index */
  idempotencyKey?: string;
  /** 覆蓋預設 resolveWriterHost()；通常不傳 */
  writerHost?: string;
}

export interface SaveMemoryResult {
  id: string;
  hasEmbedding: boolean;
  /** 若 idempotency 命中既有 row（hash 相同），此旗標為 true */
  idempotent: boolean;
}

export interface SearchMemoriesInput {
  query: string;
  projectId?: string;
  type?: MemoryType;
  limit?: number;
  mode?: SearchMode;
  querySurface?: 'telegram' | 'mcp' | 'http';
}

export interface ListMemoriesInput {
  projectId: string;
  type?: MemoryType;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Task 輸入
// ============================================================================

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';
export type TaskSource = 'manual' | 'telegram' | 'claude-code' | 'codex' | 'mcp';

export interface CreateTaskInput {
  projectId: string;
  projectPath?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date;
  tags?: string[];
  source?: TaskSource;
  sourceRef?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  writerHost?: string;
}

export interface ListTasksInput {
  projectId: string;
  status?: TaskStatus | TaskStatus[];
  limit?: number;
  offset?: number;
}

export interface UpdateTaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskOptions {
  /** optimistic locking：僅當目前 status 符合時才 update；不符合 throw StaleTaskError */
  expectedStatus: TaskStatus;
}

export type ResolveShortIdResult =
  | { kind: 'FOUND'; task: Task }
  | { kind: 'NOT_FOUND' }
  | { kind: 'AMBIGUOUS'; candidates: Task[] };

// ============================================================================
// MCP handler 回傳錯誤結構（Stage 2 wire-up 用）
// ============================================================================

export interface McpError {
  code:
    | 'CONFLICT'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INVALID_TRANSITION'
    | 'NOT_FOUND'
    | 'AMBIGUOUS'
    | 'INVALID_ARGUMENT'
    | 'INTERNAL';
  message: string;
  details?: Record<string, unknown>;
}
