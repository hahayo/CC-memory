// src/services/memories.ts
//
// Memory service layer（v0.3 Stage 1 Track M）。
// 把 src/tools/*.ts 的 memory 邏輯收斂到這裡，並補齊：
//   - 冪等三分支（idempotency_key + content_hash）
//   - writer_host 自動填
//   - searchMemories 回 SearchResultEnvelope（含 rankPositions / scores）
//   - deleteByIdempotencyKey（Phase B undo 預留）
//
// 本層不直接 log / 不直接 throw McpError；只 throw service-level error（errors.ts）。
// MCP handler / HTTP handler 負責 map 成外部 protocol 錯誤。

import { createHash } from 'node:crypto';
import {
  eq,
  and,
  desc,
  sql,
  cosineDistance,
  isNotNull,
  count,
  min,
  max,
  type SQL,
} from 'drizzle-orm';

import { projectMemories, type Memory, type NewMemory } from '../db/schema.js';
import type {
  DbClient,
  SaveMemoryInput,
  SaveMemoryResult,
  SearchMemoriesInput,
  SearchResultEnvelope,
  SearchMode,
  RankingMeta,
  SearchQueryContext,
  ListMemoriesInput,
} from './types.js';
import { IdempotencyConflictError, InvalidArgumentError, isUniqueViolation } from './errors.js';
import { resolveWriterHost } from '../utils/writer-host.js';
import {
  generateEmbedding,
  generateQueryEmbedding,
  composeEmbeddingText,
  isEmbeddingEnabled,
} from '../utils/embedding.js';

// ---------------------------------------------------------------------------
// ProjectStats（同 src/tools/stats.ts 的 shape，本層重新 export）
// ---------------------------------------------------------------------------

export interface ProjectStats {
  totalMemories: number;
  sessionCount: number;
  decisionCount: number;
  firstMemory: Date | null;
  lastMemory: Date | null;
}

// ---------------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------------

/**
 * content_hash 涵蓋所有 caller-persisted 欄位：
 * sha256(projectId || type || summary || keywords || decisions || nextSteps)。
 *
 * 用途：同 idempotency_key 入庫時檢查 payload 是否一致。若一致 → 真冪等（idempotent=true）；
 * 若不一致 → 丟 IdempotencyConflictError，避免靜默吞 bug。
 *
 * Codex review round 2 finding：hash 若只含 summary/keywords，caller 用同 key
 * 改 decisions 或 nextSteps 會被當「同 payload 回舊 id」，新內容靜默遺失。
 * 修正：把 decisions / nextSteps 一併納入 hash。metadata 不入 hash（客戶端
 * 慣常放 transient 資訊如 timestamps，納入會造成冪等無意義失效）。
 */
function computeContentHash(
  projectId: string,
  type: string,
  summary: string,
  keywords: string[] | undefined,
  decisions: string[] | undefined,
  nextSteps: string[] | undefined
): string {
  const parts = [
    projectId,
    type,
    summary,
    JSON.stringify(keywords ?? []),
    JSON.stringify(decisions ?? []),
    JSON.stringify(nextSteps ?? []),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

// isUniqueViolation 從 errors.ts 共用 import（tasks.ts 也會用）。

// ---------------------------------------------------------------------------
// saveMemory — 冪等三分支
// ---------------------------------------------------------------------------

/**
 * normalize idempotency_key：空字串 / 只含空白 → undefined（不進冪等流程）。
 * 同 tasks 的處理；防止 client 把 '' 當 key 污染 partial-unique index
 * （codex review round 10 P2）。
 */
function normalizeIdempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function saveMemory(
  db: DbClient,
  input: SaveMemoryInput
): Promise<SaveMemoryResult> {
  const writerHost = input.writerHost ?? resolveWriterHost();

  const normalizedKey = normalizeIdempotencyKey(input.idempotencyKey);
  const hasKey = normalizedKey !== undefined;
  const contentHash = hasKey
    ? computeContentHash(
        input.projectId,
        input.type,
        input.summary,
        input.keywords,
        input.decisions,
        input.nextSteps
      )
    : null;

  // 冪等 pre-check：有 key 時先 SELECT，若命中且 hash 一致 → 直接回舊 id，
  // **完全不跑 embedding**（Codex review round 4 P3：避免重試流浪費 embedding API call
  // 與受 transient 失敗影響）。不一致則早期 throw conflict，還省了 embedding + insert 成本。
  if (hasKey) {
    const preExistingRows = (await db
      .select()
      .from(projectMemories)
      .where(eq(projectMemories.idempotencyKey, normalizedKey!))
      .limit(1)) as Memory[];
    const preExisting = preExistingRows[0];
    if (preExisting) {
      if (preExisting.contentHash === contentHash) {
        return {
          id: preExisting.id,
          hasEmbedding: preExisting.embedding !== null,
          idempotent: true,
        };
      }
      throw new IdempotencyConflictError(
        'Same idempotency key with different payload',
        {
          idempotencyKey: normalizedKey!,
          existingId: preExisting.id,
        }
      );
    }
    // pre-check miss → fall through 跑完整 insert（需算 embedding）
  }

  // Embedding（失敗不阻擋；在 pre-check miss 之後才算，避免冪等重試時重算）
  let embeddingVec: number[] | null = null;
  if (isEmbeddingEnabled()) {
    const text = composeEmbeddingText(input.summary, input.keywords, input.decisions);
    embeddingVec = await generateEmbedding(text);
  }

  const baseValues: NewMemory = {
    projectId: input.projectId,
    projectPath: input.projectPath,
    type: input.type,
    summary: input.summary,
    keywords: input.keywords ?? [],
    decisions: input.decisions ?? [],
    nextSteps: input.nextSteps ?? [],
    embedding: embeddingVec,
    metadata: input.metadata ?? {},
    idempotencyKey: hasKey ? normalizedKey! : null,
    contentHash,
    writerHost,
  };

  try {
    const inserted = (await db
      .insert(projectMemories)
      .values(baseValues)
      .returning({ id: projectMemories.id })) as Array<{ id: string }>;
    return {
      id: inserted[0]!.id,
      hasEmbedding: embeddingVec !== null,
      idempotent: false,
    };
  } catch (err) {
    if (!hasKey || !isUniqueViolation(err, 'project_memories_idempotency_idx')) {
      throw err;
    }
    // Race handler：pre-check miss 但在 embedding + insert 期間有其他 writer 搶先
    // 以同 key insert 了。重查一次比對。
    const existingRows = (await db
      .select()
      .from(projectMemories)
      .where(eq(projectMemories.idempotencyKey, normalizedKey!))
      .limit(1)) as Memory[];
    const existing = existingRows[0];
    if (!existing) {
      throw err;
    }
    if (existing.contentHash === contentHash) {
      return {
        id: existing.id,
        hasEmbedding: existing.embedding !== null,
        idempotent: true,
      };
    }
    throw new IdempotencyConflictError(
      'Same idempotency key with different payload',
      {
        idempotencyKey: input.idempotencyKey!,
        existingId: existing.id,
      }
    );
  }
}

// ---------------------------------------------------------------------------
// searchMemories — 三 mode + envelope
// ---------------------------------------------------------------------------

interface ScoredSearchItem {
  row: Memory;
  /** 來源 mode 分數：semantic = cosine similarity，hybrid = RRF 合併分數 */
  score: number;
}

async function keywordSearchRows(
  db: DbClient,
  query: string,
  projectId: string | undefined,
  type: string | undefined,
  limit: number
): Promise<Memory[]> {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  const conditions: SQL[] = [eq(projectMemories.status, 'active')];
  if (projectId) conditions.push(eq(projectMemories.projectId, projectId));
  if (type) conditions.push(eq(projectMemories.type, type));

  const whereClause = conditions.length > 1 ? and(...conditions) : conditions[0];

  const rows = (await db
    .select()
    .from(projectMemories)
    .where(whereClause)
    .orderBy(desc(projectMemories.createdAt))
    .limit(limit * 2)) as Memory[];

  if (keywords.length === 0) return rows.slice(0, limit);

  const filtered = rows.filter((memory) => {
    const text = `${memory.summary} ${(memory.keywords ?? []).join(' ')}`.toLowerCase();
    return keywords.some((kw) => text.includes(kw));
  });
  return filtered.slice(0, limit);
}

/**
 * 用「已計算好的 query embedding」跑 semantic search。
 * caller 保證 embedding 非 null；null 情況的 downgrade 在 searchMemories 上層處理，
 * 避免本函式回假的 score=0 結果讓 envelope.effectiveMode 說謊。
 */
async function semanticSearchScoredWithEmbedding(
  db: DbClient,
  queryEmbedding: number[],
  projectId: string | undefined,
  type: string | undefined,
  limit: number
): Promise<ScoredSearchItem[]> {
  const conditions: SQL[] = [
    eq(projectMemories.status, 'active'),
    isNotNull(projectMemories.embedding),
  ];
  if (projectId) conditions.push(eq(projectMemories.projectId, projectId));
  if (type) conditions.push(eq(projectMemories.type, type));

  const similarity = sql<number>`1 - (${cosineDistance(projectMemories.embedding, queryEmbedding)})`;

  const rows = (await db
    .select({
      id: projectMemories.id,
      projectId: projectMemories.projectId,
      projectPath: projectMemories.projectPath,
      type: projectMemories.type,
      summary: projectMemories.summary,
      keywords: projectMemories.keywords,
      decisions: projectMemories.decisions,
      nextSteps: projectMemories.nextSteps,
      embedding: projectMemories.embedding,
      status: projectMemories.status,
      mergedInto: projectMemories.mergedInto,
      idempotencyKey: projectMemories.idempotencyKey,
      contentHash: projectMemories.contentHash,
      writerHost: projectMemories.writerHost,
      metadata: projectMemories.metadata,
      createdAt: projectMemories.createdAt,
      updatedAt: projectMemories.updatedAt,
      similarity,
    })
    .from(projectMemories)
    .where(and(...conditions))
    .orderBy(desc(similarity))
    .limit(limit)) as Array<Memory & { similarity: number }>;

  return rows.map((r) => {
    const { similarity: s, ...row } = r;
    return { row: row as Memory, score: s };
  });
}

async function hybridSearchScoredWithEmbedding(
  db: DbClient,
  query: string,
  queryEmbedding: number[],
  projectId: string | undefined,
  type: string | undefined,
  limit: number
): Promise<ScoredSearchItem[]> {
  const [keywordRows, semanticItems] = await Promise.all([
    keywordSearchRows(db, query, projectId, type, limit),
    semanticSearchScoredWithEmbedding(db, queryEmbedding, projectId, type, limit),
  ]);

  const k = 60;
  const combined = new Map<string, { row: Memory; score: number }>();

  keywordRows.forEach((row, rank) => {
    combined.set(row.id, { row, score: 1 / (k + rank + 1) });
  });

  semanticItems.forEach((item, rank) => {
    const rrf = 1 / (k + rank + 1);
    const existing = combined.get(item.row.id);
    if (existing) {
      existing.score += rrf;
    } else {
      combined.set(item.row.id, { row: item.row, score: rrf });
    }
  });

  return Array.from(combined.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function searchMemories(
  db: DbClient,
  input: SearchMemoriesInput
): Promise<SearchResultEnvelope> {
  const requestedMode: SearchMode = input.mode ?? 'hybrid';
  const limit = input.limit ?? 10;
  const querySurface = input.querySurface ?? 'mcp';

  // 計算 effectiveMode：
  //   - isEmbeddingEnabled() === false → 直接降 keyword（不浪費 API call）
  //   - requestedMode 是 semantic/hybrid 但 generateQueryEmbedding 失敗 → 也降 keyword
  //   這樣 envelope.effectiveMode 不會謊報（避免 search_feedback.mode 記錯）
  const needsEmbedding = requestedMode !== 'keyword';
  let queryEmbedding: number[] | null = null;
  if (needsEmbedding && isEmbeddingEnabled()) {
    queryEmbedding = await generateQueryEmbedding(input.query);
  }
  const effectiveMode: SearchMode =
    needsEmbedding && queryEmbedding === null ? 'keyword' : requestedMode;

  let results: Memory[];
  let scores: number[] | null;

  if (effectiveMode === 'keyword') {
    results = await keywordSearchRows(db, input.query, input.projectId, input.type, limit);
    scores = null;
  } else if (effectiveMode === 'semantic') {
    const items = await semanticSearchScoredWithEmbedding(
      db,
      queryEmbedding!,
      input.projectId,
      input.type,
      limit
    );
    results = items.map((i) => i.row);
    scores = items.map((i) => i.score);
  } else {
    // hybrid
    const items = await hybridSearchScoredWithEmbedding(
      db,
      input.query,
      queryEmbedding!,
      input.projectId,
      input.type,
      limit
    );
    results = items.map((i) => i.row);
    scores = items.map((i) => i.score);
  }

  const rankPositions: number[] = results.map((_, i) => i + 1);
  const rankingMeta: RankingMeta = { rankPositions, scores };

  // 硬性不變量：若 scores 非 null，長度必對齊
  if (scores !== null && scores.length !== results.length) {
    throw new Error(
      `searchMemories envelope invariant broken: scores.length=${scores.length} !== results.length=${results.length}`
    );
  }

  const queryContext: SearchQueryContext = {
    query: input.query,
    requestedMode,
    effectiveMode,
    limit,
    projectId: input.projectId ?? null,
    querySurface,
  };

  return {
    results,
    effectiveMode,
    rankingMeta,
    queryContext,
  };
}

// ---------------------------------------------------------------------------
// listMemories / getMemory / deleteMemory / getProjectStats
// ---------------------------------------------------------------------------

export async function listMemories(
  db: DbClient,
  input: ListMemoriesInput
): Promise<Memory[]> {
  const { projectId, type, limit = 20, offset = 0 } = input;

  const conditions: SQL[] = [
    eq(projectMemories.projectId, projectId),
    eq(projectMemories.status, 'active'),
  ];
  if (type) conditions.push(eq(projectMemories.type, type));

  return (await db
    .select()
    .from(projectMemories)
    .where(and(...conditions))
    .orderBy(desc(projectMemories.createdAt))
    .limit(limit)
    .offset(offset)) as Memory[];
}

export async function getMemory(db: DbClient, id: string): Promise<Memory | null> {
  const rows = (await db
    .select()
    .from(projectMemories)
    .where(eq(projectMemories.id, id))
    .limit(1)) as Memory[];
  return rows[0] ?? null;
}

export async function deleteMemory(db: DbClient, id: string): Promise<boolean> {
  await db.update(projectMemories).set({ status: 'archived' }).where(eq(projectMemories.id, id));
  return true;
}

export async function getProjectStats(
  db: DbClient,
  projectId: string
): Promise<ProjectStats> {
  const baseCondition = and(
    eq(projectMemories.projectId, projectId),
    eq(projectMemories.status, 'active')
  );

  const [stats] = (await db
    .select({
      total: count(),
      first: min(projectMemories.createdAt),
      last: max(projectMemories.createdAt),
    })
    .from(projectMemories)
    .where(baseCondition)) as Array<{
    total: number;
    first: Date | null;
    last: Date | null;
  }>;

  const [sessionStats] = (await db
    .select({ count: count() })
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.type, 'session'),
        eq(projectMemories.status, 'active')
      )
    )) as Array<{ count: number }>;

  const [decisionStats] = (await db
    .select({ count: count() })
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.type, 'decision'),
        eq(projectMemories.status, 'active')
      )
    )) as Array<{ count: number }>;

  return {
    totalMemories: stats?.total ?? 0,
    sessionCount: sessionStats?.count ?? 0,
    decisionCount: decisionStats?.count ?? 0,
    firstMemory: stats?.first ?? null,
    lastMemory: stats?.last ?? null,
  };
}

// ---------------------------------------------------------------------------
// deleteByIdempotencyKey — Phase B undo 預留
// ---------------------------------------------------------------------------

/**
 * 以 idempotency_key 定位近期寫入的記憶並軟刪除。
 *
 * - 僅搜 status='active' 且 created_at > now() - maxAgeSec 秒 的 row。
 * - 找到 → 軟刪除（status='archived'）並回 true。
 * - 找不到（含過期）→ 回 false。
 * - key 為空 / maxAgeSec <= 0 → throw InvalidArgumentError。
 *
 * 用途：Phase B Telegram /undo 指令，使用者想回退最近一次同 key 寫入。
 */
export async function deleteByIdempotencyKey(
  db: DbClient,
  key: string,
  maxAgeSec: number
): Promise<boolean> {
  if (!key || key.trim().length === 0) {
    throw new InvalidArgumentError('deleteByIdempotencyKey: key must be non-empty');
  }
  if (!Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
    throw new InvalidArgumentError('deleteByIdempotencyKey: maxAgeSec must be > 0');
  }

  const cutoff = sql`NOW() - (${maxAgeSec}::int * INTERVAL '1 second')`;

  const rows = (await db
    .select({ id: projectMemories.id })
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.idempotencyKey, key),
        eq(projectMemories.status, 'active'),
        sql`${projectMemories.createdAt} > ${cutoff}`
      )
    )
    .limit(1)) as Array<{ id: string }>;

  if (rows.length === 0) return false;

  await db
    .update(projectMemories)
    .set({ status: 'archived' })
    .where(eq(projectMemories.id, rows[0].id));

  return true;
}
