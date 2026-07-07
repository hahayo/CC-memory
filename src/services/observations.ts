// src/services/observations.ts
//
// v0.5 M3 retrieval service for observation indexes, timelines, and batch reads.

import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';

import { observations, projectMemories, type Observation } from '../db/schema.js';
import { generateQueryEmbedding, isEmbeddingEnabled } from '../utils/embedding.js';
import { InvalidArgumentError, NotFoundError } from './errors.js';
import { RESERVED_PROJECT_ID_LIST } from './scope-policy.js';
import type {
  DbClient,
  MemoryIndexResult,
  RankingMeta,
  SearchMemoriesInput,
  SearchMode,
  SearchQueryContext,
  SearchResultEnvelope,
} from './types.js';

const VALID_SEARCH_MODES: readonly SearchMode[] = ['keyword', 'semantic', 'hybrid'];
const VALID_MEMORY_TYPES: readonly string[] = ['session', 'decision'];
const OBSERVATION_BATCH_LIMIT = 50;
const TIMELINE_DEPTH_LIMIT = 50;
const TIMELINE_MIDDLE_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IndexSearchCandidate {
  result: MemoryIndexResult;
  /** Base relevance score before source weighting. */
  baseScore: number;
  /** Semantic similarity to expose in semantic mode; null for keyword/RRF. */
  semanticScore: number | null;
  /** Stable tie-breaker for same weighted relevance. */
  sourceOrder: number;
}

export interface TimelineResult {
  anchorId: string;
  depthBefore: number;
  depthAfter: number;
  observations: Observation[];
  truncated?: boolean;
}

function validateSearchInput(input: SearchMemoriesInput): {
  requestedMode: SearchMode;
  limit: number;
  querySurface: SearchQueryContext['querySurface'];
} {
  if (typeof input.query !== 'string' || input.query.trim().length === 0) {
    throw new InvalidArgumentError('search query 必須為非空字串', {
      query: typeof input.query,
    });
  }
  if (input.mode !== undefined && !VALID_SEARCH_MODES.includes(input.mode)) {
    throw new InvalidArgumentError('search mode 必須為 keyword | semantic | hybrid', {
      mode: input.mode,
    });
  }
  if (
    input.type !== undefined &&
    input.type !== null &&
    (typeof input.type !== 'string' || !VALID_MEMORY_TYPES.includes(input.type))
  ) {
    throw new InvalidArgumentError('memory type filter 必須為 session | decision', {
      type: input.type,
    });
  }
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new InvalidArgumentError('searchObservationIndexes: limit 必須為非負整數', {
      limit,
    });
  }
  return {
    requestedMode: input.mode ?? 'hybrid',
    limit,
    querySurface: input.querySurface ?? 'mcp',
  };
}

function validateProjectId(projectId: unknown, caller: string): string {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new InvalidArgumentError(`${caller}: projectId must be non-empty`, { projectId });
  }
  return projectId;
}

function validateNonEmptyId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} 必須為非空字串`, { [field]: value });
  }
  return value;
}

function validateUuid(value: unknown, field: string): string {
  const id = validateNonEmptyId(value, field);
  if (!UUID_RE.test(id)) {
    throw new InvalidArgumentError(`${field} 必須為 UUID`, { [field]: value });
  }
  return id;
}

function validateDepth(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > TIMELINE_DEPTH_LIMIT) {
    throw new InvalidArgumentError(
      `${field} 必須為 0-${TIMELINE_DEPTH_LIMIT} 的非負整數`,
      { [field]: value }
    );
  }
  return value;
}

function validateObservationIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    throw new InvalidArgumentError('getObservations: ids 必須為字串陣列', { ids });
  }
  if (ids.length > OBSERVATION_BATCH_LIMIT) {
    throw new InvalidArgumentError(
      `getObservations: ids 一次最多 ${OBSERVATION_BATCH_LIMIT} 筆`,
      { count: ids.length, limit: OBSERVATION_BATCH_LIMIT }
    );
  }
  if (ids.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    throw new InvalidArgumentError('getObservations: ids 必須為非空字串陣列', { ids });
  }
  if (ids.some((id) => !UUID_RE.test(id))) {
    throw new InvalidArgumentError('getObservations: ids 必須為 UUID 字串陣列', { ids });
  }
  return ids;
}

function metadataCapture(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const capture = (metadata as { capture?: unknown }).capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return null;
  return capture as Record<string, unknown>;
}

function captureString(capture: Record<string, unknown> | null, key: string): string | null {
  const value = capture?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function observationExcludeReservedCondition(excludeReserved: boolean): SQL | null {
  return excludeReserved
    ? notInArray(observations.projectId, RESERVED_PROJECT_ID_LIST)
    : null;
}

function observationTypeCondition(type: SearchMemoriesInput['type']): SQL | 'none' | null {
  if (type === undefined || type === null) return null;
  if (type === 'decision') return eq(observations.type, 'decision');
  return 'none';
}

function observationIndexResult(row: Observation): MemoryIndexResult {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: 'observation',
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    sessionId: row.sessionId,
    discoveryTokens: row.discoveryTokens,
    occurredAt: row.observedAt,
  };
}

function observationSearchText(row: Observation): string {
  return [
    row.title,
    row.subtitle ?? '',
    ...(row.facts ?? []),
    ...(row.concepts ?? []),
    ...(row.files ?? []),
    row.narrative,
  ].join(' ').toLowerCase();
}

function rankPositions(length: number): number[] {
  return Array.from({ length }, (_, index) => index + 1);
}

function toEnvelope(
  input: SearchMemoriesInput,
  requestedMode: SearchMode,
  effectiveMode: SearchMode,
  limit: number,
  querySurface: SearchQueryContext['querySurface'],
  candidates: IndexSearchCandidate[]
): SearchResultEnvelope<MemoryIndexResult> {
  const results = candidates.map((candidate) => candidate.result);
  const scores =
    effectiveMode === 'semantic'
      ? candidates.map((candidate) => candidate.semanticScore ?? candidate.baseScore)
      : null;
  const rankingMeta: RankingMeta = {
    rankPositions: rankPositions(results.length),
    scores,
  };
  if (scores !== null && scores.length !== results.length) {
    throw new Error(
      `searchObservationIndexes envelope invariant broken: scores.length=${scores.length} !== results.length=${results.length}`
    );
  }
  return {
    results,
    effectiveMode,
    rankingMeta,
    queryContext: {
      query: input.query,
      requestedMode,
      effectiveMode,
      limit,
      projectId: input.projectId ?? null,
      querySurface,
      filterType: input.type ?? null,
    },
  };
}

function sortCandidates(candidates: IndexSearchCandidate[]): IndexSearchCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
    if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
    return b.result.occurredAt.getTime() - a.result.occurredAt.getTime();
  });
}

function combineHybridCandidates(
  keywordCandidates: IndexSearchCandidate[],
  semanticCandidates: IndexSearchCandidate[],
  limit: number
): IndexSearchCandidate[] {
  const k = 60;
  const combined = new Map<string, IndexSearchCandidate>();

  keywordCandidates.forEach((candidate, rank) => {
    combined.set(candidate.result.id, {
      ...candidate,
      baseScore: 1 / (k + rank + 1),
      semanticScore: null,
    });
  });

  semanticCandidates.forEach((candidate, rank) => {
    const rrf = 1 / (k + rank + 1);
    const existing = combined.get(candidate.result.id);
    if (existing) {
      existing.baseScore += rrf;
    } else {
      combined.set(candidate.result.id, {
        ...candidate,
        baseScore: rrf,
        semanticScore: null,
      });
    }
  });

  return sortCandidates(Array.from(combined.values())).slice(0, limit);
}

export async function keywordObservationIndexCandidates(
  db: DbClient,
  input: SearchMemoriesInput,
  limit: number,
  excludeReserved: boolean
): Promise<IndexSearchCandidate[]> {
  if (limit === 0) return [];
  const typeCondition = observationTypeCondition(input.type);
  if (typeCondition === 'none') return [];

  const conditions: SQL[] = [eq(observations.status, 'active')];
  if (input.projectId) conditions.push(eq(observations.projectId, input.projectId));
  if (typeCondition) conditions.push(typeCondition);
  const reserved = observationExcludeReservedCondition(excludeReserved);
  if (reserved) conditions.push(reserved);

  const rows = (await db
    .select()
    .from(observations)
    .where(and(...conditions))
    .orderBy(desc(observations.observedAt))
    // known limitation：先撈最新 limit*4 再文字過濾，較舊命中可能漏（同 keywordSearchRows 模式；M6 benchmark 後評估推進 SQL）
    .limit(limit * 4)) as Observation[];

  const keywords = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered =
    keywords.length === 0
      ? rows
      : rows.filter((row) => {
          const text = observationSearchText(row);
          return keywords.some((keyword) => text.includes(keyword));
        });

  return filtered.slice(0, limit).map((row) => ({
    result: observationIndexResult(row),
    baseScore: 1,
    semanticScore: null,
    sourceOrder: row.type === 'decision' ? 2 : 3,
  }));
}

export async function semanticObservationIndexCandidates(
  db: DbClient,
  input: SearchMemoriesInput,
  queryEmbedding: number[],
  limit: number,
  excludeReserved: boolean
): Promise<IndexSearchCandidate[]> {
  if (limit === 0) return [];
  const typeCondition = observationTypeCondition(input.type);
  if (typeCondition === 'none') return [];

  const conditions: SQL[] = [
    eq(observations.status, 'active'),
    isNotNull(observations.embedding),
  ];
  if (input.projectId) conditions.push(eq(observations.projectId, input.projectId));
  if (typeCondition) conditions.push(typeCondition);
  const reserved = observationExcludeReservedCondition(excludeReserved);
  if (reserved) conditions.push(reserved);

  const similarity = sql<number>`1 - (${cosineDistance(observations.embedding, queryEmbedding)})`;
  const rows = (await db
    .select({
      id: observations.id,
      projectId: observations.projectId,
      sessionId: observations.sessionId,
      rollupMemoryId: observations.rollupMemoryId,
      type: observations.type,
      title: observations.title,
      subtitle: observations.subtitle,
      facts: observations.facts,
      concepts: observations.concepts,
      files: observations.files,
      narrative: observations.narrative,
      embedding: observations.embedding,
      discoveryTokens: observations.discoveryTokens,
      sourceHook: observations.sourceHook,
      contentHash: observations.contentHash,
      writerHost: observations.writerHost,
      status: observations.status,
      metadata: observations.metadata,
      observedAt: observations.observedAt,
      createdAt: observations.createdAt,
      updatedAt: observations.updatedAt,
      similarity,
    })
    .from(observations)
    .where(and(...conditions))
    .orderBy(desc(similarity))
    .limit(limit)) as Array<Observation & { similarity: number }>;

  return rows.map(({ similarity: score, ...row }) => ({
    result: observationIndexResult(row as Observation),
    baseScore: score,
    semanticScore: score,
    sourceOrder: row.type === 'decision' ? 2 : 3,
  }));
}

export async function searchObservationIndexes(
  db: DbClient,
  input: SearchMemoriesInput
): Promise<SearchResultEnvelope<MemoryIndexResult>> {
  const { requestedMode, limit, querySurface } = validateSearchInput(input);
  const isScoped =
    typeof input.projectId === 'string' && input.projectId.trim().length > 0;
  const excludeReserved = !isScoped && !input.includeReserved;

  const needsEmbedding = requestedMode !== 'keyword';
  let queryEmbedding: number[] | null = null;
  if (needsEmbedding && isEmbeddingEnabled()) {
    queryEmbedding = await generateQueryEmbedding(input.query);
  }
  const effectiveMode: SearchMode =
    needsEmbedding && queryEmbedding === null ? 'keyword' : requestedMode;

  let candidates: IndexSearchCandidate[];
  if (effectiveMode === 'keyword') {
    candidates = await keywordObservationIndexCandidates(db, input, limit, excludeReserved);
  } else if (effectiveMode === 'semantic') {
    candidates = await semanticObservationIndexCandidates(
      db,
      input,
      queryEmbedding!,
      limit,
      excludeReserved
    );
  } else {
    const [keywordCandidates, semanticCandidates] = await Promise.all([
      keywordObservationIndexCandidates(db, input, limit, excludeReserved),
      semanticObservationIndexCandidates(db, input, queryEmbedding!, limit, excludeReserved),
    ]);
    candidates = combineHybridCandidates(keywordCandidates, semanticCandidates, limit);
  }

  return toEnvelope(
    input,
    requestedMode,
    effectiveMode,
    limit,
    querySurface,
    sortCandidates(candidates).slice(0, limit)
  );
}

export async function timeline(
  db: DbClient,
  anchorId: string,
  depthBefore: number,
  depthAfter: number,
  projectId: string
): Promise<TimelineResult> {
  const guardedProjectId = validateProjectId(projectId, 'timeline');
  const guardedAnchorId = validateUuid(anchorId, 'anchorId');
  const beforeDepth = validateDepth(depthBefore, 'depthBefore');
  const afterDepth = validateDepth(depthAfter, 'depthAfter');

  const observationAnchors = (await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.id, guardedAnchorId),
        eq(observations.projectId, guardedProjectId),
        eq(observations.status, 'active')
      )
    )
    .limit(1)) as Observation[];
  const observationAnchor = observationAnchors[0];

  if (observationAnchor) {
    const beforeRows = (await db
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.projectId, guardedProjectId),
          eq(observations.sessionId, observationAnchor.sessionId),
          eq(observations.status, 'active'),
          lt(observations.observedAt, observationAnchor.observedAt)
        )
      )
      .orderBy(desc(observations.observedAt))
      .limit(beforeDepth)) as Observation[];
    const afterRows = (await db
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.projectId, guardedProjectId),
          eq(observations.sessionId, observationAnchor.sessionId),
          eq(observations.status, 'active'),
          gt(observations.observedAt, observationAnchor.observedAt)
        )
      )
      .orderBy(asc(observations.observedAt))
      .limit(afterDepth)) as Observation[];

    return {
      anchorId: guardedAnchorId,
      depthBefore: beforeDepth,
      depthAfter: afterDepth,
      observations: [...beforeRows.reverse(), observationAnchor, ...afterRows],
    };
  }

  const rollupRows = (await db
    .select({ id: projectMemories.id, metadata: projectMemories.metadata })
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.id, guardedAnchorId),
        eq(projectMemories.projectId, guardedProjectId),
        eq(projectMemories.status, 'active')
      )
    )
    .limit(1)) as Array<{ id: string; metadata: unknown }>;
  if (rollupRows.length === 0) {
    throw new NotFoundError(`找不到 observation timeline anchor (ID: ${guardedAnchorId})`, {
      anchorId: guardedAnchorId,
      projectId: guardedProjectId,
    });
  }

  const linkedRows = (await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.projectId, guardedProjectId),
        eq(observations.rollupMemoryId, guardedAnchorId),
        eq(observations.status, 'active')
      )
    )
    .orderBy(asc(observations.observedAt))) as Observation[];
  if (linkedRows.length === 0) {
    throw new NotFoundError(`找不到 rollup anchor 對應的 observations (ID: ${guardedAnchorId})`, {
      anchorId: guardedAnchorId,
      projectId: guardedProjectId,
    });
  }

  const metadataSessionId = captureString(metadataCapture(rollupRows[0].metadata), 'session_id');
  let sessionId = metadataSessionId ?? linkedRows[0].sessionId;
  let linkedInSession = linkedRows.filter((row) => row.sessionId === sessionId);
  if (linkedInSession.length === 0 && metadataSessionId) {
    sessionId = linkedRows[0].sessionId;
    linkedInSession = linkedRows.filter((row) => row.sessionId === sessionId);
  }
  const startAt = linkedInSession[0].observedAt;
  const endAt = linkedInSession[linkedInSession.length - 1].observedAt;

  const beforeRows = (await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.projectId, guardedProjectId),
        eq(observations.sessionId, sessionId),
        eq(observations.status, 'active'),
        lt(observations.observedAt, startAt)
      )
    )
    .orderBy(desc(observations.observedAt))
    .limit(beforeDepth)) as Observation[];
  const middleRows = (await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.projectId, guardedProjectId),
        eq(observations.sessionId, sessionId),
        eq(observations.status, 'active'),
        gte(observations.observedAt, startAt),
        lte(observations.observedAt, endAt)
      )
    )
    .orderBy(asc(observations.observedAt))
    .limit(TIMELINE_MIDDLE_LIMIT + 1)) as Observation[];
  const truncated = middleRows.length > TIMELINE_MIDDLE_LIMIT;
  const visibleMiddleRows = middleRows.slice(0, TIMELINE_MIDDLE_LIMIT);
  const afterRows = (await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.projectId, guardedProjectId),
        eq(observations.sessionId, sessionId),
        eq(observations.status, 'active'),
        gt(observations.observedAt, endAt)
      )
    )
    .orderBy(asc(observations.observedAt))
    .limit(afterDepth)) as Observation[];

  return {
    anchorId: guardedAnchorId,
    depthBefore: beforeDepth,
    depthAfter: afterDepth,
    observations: [...beforeRows.reverse(), ...visibleMiddleRows, ...afterRows],
    ...(truncated ? { truncated: true } : {}),
  };
}

export async function getObservations(
  db: DbClient,
  ids: string[],
  projectId: string
): Promise<Observation[]> {
  const guardedProjectId = validateProjectId(projectId, 'getObservations');
  const normalizedIds = validateObservationIds(ids);
  if (normalizedIds.length === 0) return [];

  const rows = (await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.projectId, guardedProjectId),
        eq(observations.status, 'active'),
        inArray(observations.id, normalizedIds)
      )
    )) as Observation[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return normalizedIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
