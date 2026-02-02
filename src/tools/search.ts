// src/tools/search.ts
import { projectMemories, Memory } from '../db/schema.js';
import { eq, and, desc, sql, SQL, cosineDistance, isNotNull } from 'drizzle-orm';
import { generateQueryEmbedding, isEmbeddingEnabled } from '../utils/embedding.js';

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchInput {
  query: string;
  projectId?: string;
  type?: 'session' | 'decision';
  limit?: number;
  mode?: SearchMode;
}

export interface SearchResultWithScore extends Memory {
  similarity?: number;
}

// 使用 any 以支援 drizzle 的複雜查詢 API
type DbClient = any;

/**
 * 關鍵字搜尋（原有邏輯）
 */
async function keywordSearch(
  database: DbClient,
  query: string,
  projectId: string | undefined,
  type: string | undefined,
  limit: number
): Promise<Memory[]> {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  const conditions: SQL[] = [eq(projectMemories.status, 'active')];

  if (projectId) {
    conditions.push(eq(projectMemories.projectId, projectId));
  }

  if (type) {
    conditions.push(eq(projectMemories.type, type));
  }

  const whereClause = conditions.length > 1
    ? and(...conditions)
    : conditions[0];

  const results = await database
    .select()
    .from(projectMemories)
    .where(whereClause)
    .orderBy(desc(projectMemories.createdAt))
    .limit(limit * 2); // 多取一些以便過濾

  // 過濾包含關鍵字的結果
  if (keywords.length > 0) {
    const filtered = results.filter((memory: Memory) => {
      const text = `${memory.summary} ${memory.keywords?.join(' ') || ''}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
    return filtered.slice(0, limit);
  }

  return results.slice(0, limit);
}

/**
 * 語義搜尋（使用 pgvector）
 */
async function semanticSearch(
  database: DbClient,
  query: string,
  projectId: string | undefined,
  type: string | undefined,
  limit: number
): Promise<SearchResultWithScore[]> {
  // 生成查詢 embedding
  const queryEmbedding = await generateQueryEmbedding(query);

  if (!queryEmbedding) {
    // 如果無法生成 embedding，降級為關鍵字搜尋
    return keywordSearch(database, query, projectId, type, limit);
  }

  // 建立 where 條件
  const conditions: SQL[] = [
    eq(projectMemories.status, 'active'),
    isNotNull(projectMemories.embedding),
  ];

  if (projectId) {
    conditions.push(eq(projectMemories.projectId, projectId));
  }

  if (type) {
    conditions.push(eq(projectMemories.type, type));
  }

  const whereClause = and(...conditions);

  // 計算相似度（1 - cosine distance = cosine similarity）
  const similarity = sql<number>`1 - (${cosineDistance(projectMemories.embedding, queryEmbedding)})`;

  const results = await database
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
      metadata: projectMemories.metadata,
      createdAt: projectMemories.createdAt,
      updatedAt: projectMemories.updatedAt,
      similarity,
    })
    .from(projectMemories)
    .where(whereClause)
    .orderBy(desc(similarity))
    .limit(limit);

  return results;
}

/**
 * 混合搜尋（語義 + 關鍵字）
 * 使用 RRF (Reciprocal Rank Fusion) 合併結果
 */
async function hybridSearch(
  database: DbClient,
  query: string,
  projectId: string | undefined,
  type: string | undefined,
  limit: number
): Promise<SearchResultWithScore[]> {
  // 同時執行兩種搜尋
  const [keywordResults, semanticResults] = await Promise.all([
    keywordSearch(database, query, projectId, type, limit),
    semanticSearch(database, query, projectId, type, limit),
  ]);

  // RRF 合併
  const k = 60; // RRF 參數
  const scores = new Map<string, { memory: Memory; score: number; similarity?: number }>();

  // 計算關鍵字搜尋的 RRF 分數
  keywordResults.forEach((memory, rank) => {
    const rrfScore = 1 / (k + rank + 1);
    scores.set(memory.id, { memory, score: rrfScore });
  });

  // 計算語義搜尋的 RRF 分數並合併
  semanticResults.forEach((result, rank) => {
    const rrfScore = 1 / (k + rank + 1);
    const existing = scores.get(result.id);

    if (existing) {
      existing.score += rrfScore;
      existing.similarity = result.similarity;
    } else {
      scores.set(result.id, {
        memory: result,
        score: rrfScore,
        similarity: result.similarity,
      });
    }
  });

  // 排序並返回
  const sorted = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted.map(item => ({
    ...item.memory,
    similarity: item.similarity,
  }));
}

/**
 * 主搜尋函數
 */
export async function searchMemories(
  database: DbClient,
  input: SearchInput
): Promise<SearchResultWithScore[]> {
  const { query, projectId, type, limit = 10, mode = 'hybrid' } = input;

  // 如果沒有啟用 embedding，強制使用關鍵字搜尋
  const effectiveMode = isEmbeddingEnabled() ? mode : 'keyword';

  switch (effectiveMode) {
    case 'keyword':
      return keywordSearch(database, query, projectId, type, limit);

    case 'semantic':
      return semanticSearch(database, query, projectId, type, limit);

    case 'hybrid':
      return hybridSearch(database, query, projectId, type, limit);

    default:
      return keywordSearch(database, query, projectId, type, limit);
  }
}
