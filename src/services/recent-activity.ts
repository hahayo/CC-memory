// src/services/recent-activity.ts
//
// v0.5 M4 4b — Recent Activity builder。
// SessionStart injector 的資料來源：只讀「最近 rollup memories」的輕索引，
// 不查 observations 表、不查全文、不現算 discovery_tokens。
// 產出帶 source='cc-memory-inject' marker，capture worker 看到會排除（注入污染防線，
// 見 docs/auto-capture-v0.5/plan.md §Injection Pollution Defense）。

import { and, desc, eq, sql } from 'drizzle-orm';
import { projectMemories, type Memory } from '../db/schema.js';
import { estimateDiscoveryTokens } from './capture-llm.js';
import { ForbiddenError, InvalidArgumentError } from './errors.js';
import type { DbClient } from './types.js';

// 預設值（監督者定案）：limit 20、token budget 1200。
const DEFAULT_LIMIT = 20;
const DEFAULT_TOKEN_BUDGET = 1200;
// summaryExcerpt 上限；超過 budget 時第二步再壓到 SHRUNK。
const EXCERPT_MAX_CHARS = 120;
const EXCERPT_SHRUNK_CHARS = 60;

export interface RecentActivityRow {
  id: string;
  updatedAt: string; // ISO 8601
  summaryExcerpt: string;
  /** 讀 metadata.capture.observation_ids；drill-down 用，缺值 → [] */
  observationIds: string[];
  observationCount: number;
  /** 讀 metadata.capture.discovery_tokens，不現算 */
  discoveryTokens: number;
}

export interface RecentActivityResult {
  /** 注入污染防線 marker（capture worker 看到會排除） */
  source: 'cc-memory-inject';
  projectId: string;
  rows: RecentActivityRow[];
}

export interface BuildRecentActivityInput {
  projectId: string;
  limit?: number;
  tokenBudget?: number;
}

export async function buildRecentActivity(
  db: DbClient,
  input: BuildRecentActivityInput
): Promise<RecentActivityResult> {
  const { projectId } = input;
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new InvalidArgumentError('buildRecentActivity: projectId 必須為非空字串', { projectId });
  }
  // ScopePolicy 語義：__personal__ 是保留 namespace，不得出現在任何 project 結果。
  if (projectId === '__personal__') {
    throw new ForbiddenError('buildRecentActivity: __personal__ 不得出現在任何結果', { projectId });
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new InvalidArgumentError('buildRecentActivity: limit 必須為正整數', { limit });
  }
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new InvalidArgumentError('buildRecentActivity: tokenBudget 必須為正數', {
      tokenBudget,
    });
  }

  const memories = await queryRecentRollups(db, projectId, limit);
  const rows = applyTokenBudget(memories.map(toRow), tokenBudget);

  return { source: 'cc-memory-inject', projectId, rows };
}

// ---------------------------------------------------------------------------
// 查詢：最近 rollup（= metadata 有 capture key，M3 既有判別慣例），
// status='active'、updated_at DESC、LIMIT。不查 observations 表、不查全文。
// ---------------------------------------------------------------------------

async function queryRecentRollups(
  db: DbClient,
  projectId: string,
  limit: number
): Promise<Memory[]> {
  return (await db
    .select()
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.status, 'active'),
        // rollup 判別：metadata->'capture' 存在（manual memory 無此 key，被排除）。
        sql`${projectMemories.metadata} -> 'capture' IS NOT NULL`
      )
    )
    // desc(id) 次要 tie-break：updated_at 相同時順序穩定（budget 第三步「丟最舊」需確定性）
    .orderBy(desc(projectMemories.updatedAt), desc(projectMemories.id))
    .limit(limit)) as Memory[];
}

// ---------------------------------------------------------------------------
// Row 映射：全部欄位來自 memory 本體與 metadata.capture，不現算、不查子表。
// ---------------------------------------------------------------------------

function toRow(memory: Memory): RecentActivityRow {
  const capture = readCapture(memory.metadata);
  const observationIds = readObservationIds(capture);
  return {
    id: memory.id,
    updatedAt: toIso(memory.updatedAt),
    summaryExcerpt: makeExcerpt(memory.summary, EXCERPT_MAX_CHARS),
    observationIds,
    observationCount: observationIds.length,
    discoveryTokens: readDiscoveryTokens(capture),
  };
}

function readCapture(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const capture = (metadata as { capture?: unknown }).capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return null;
  return capture as Record<string, unknown>;
}

function readObservationIds(capture: Record<string, unknown> | null): string[] {
  const value = capture?.observation_ids;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function readDiscoveryTokens(capture: Record<string, unknown> | null): number {
  // 只讀 metadata；缺值或非 finite number → 0，絕不現算、絕不重估。
  const value = capture?.discovery_tokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toIso(value: Date | string | null): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value ?? 0).toISOString();
}

function makeExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Token budget：估「rows 序列化後的文字」，超過依 plan.md L261 三步截斷。
// 不 mutate 傳入 rows，每步建副本。
// ---------------------------------------------------------------------------

function serializedTokens(rows: RecentActivityRow[]): number {
  return estimateDiscoveryTokens(JSON.stringify(rows));
}

function applyTokenBudget(rows: RecentActivityRow[], budget: number): RecentActivityRow[] {
  if (rows.length === 0 || serializedTokens(rows) <= budget) return rows;

  // 第一步：清空所有 observationIds（observationCount 保留）。
  let working = rows.map((row) => ({ ...row, observationIds: [] as string[] }));
  if (serializedTokens(working) <= budget) return working;

  // 第二步：summaryExcerpt 再截到 60 字元。
  working = working.map((row) => ({
    ...row,
    summaryExcerpt: makeExcerpt(row.summaryExcerpt, EXCERPT_SHRUNK_CHARS),
  }));
  if (serializedTokens(working) <= budget) return working;

  // 第三步：從最舊的 row 開始丟（rows 依 updated_at DESC，最舊在陣列尾端）。
  const trimmed = [...working];
  while (trimmed.length > 0 && serializedTokens(trimmed) > budget) {
    trimmed.pop();
  }
  return trimmed;
}
