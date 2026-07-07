// tests/services/refine-delete.test.ts
//
// v0.5 M5 5a — refine_delete RED-phase integration tests（真 PG）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, type Sql } from '../helpers/db.js';
import { timeline, getObservations } from '../../src/services/observations.js';
import { searchMemoryIndexes } from '../../src/services/memories.js';
import { refineDelete } from '../../src/services/refine.js';
import { InvalidArgumentError, NotFoundError } from '../../src/services/errors.js';

const TEST_PREFIX = `refine-${randomUUID().slice(0, 8)}`;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function expectIso8601(value: unknown): asserts value is string {
  expect(typeof value).toBe('string');
  expect(value).toMatch(ISO_8601_RE);
  expect(Number.isNaN(Date.parse(value as string))).toBe(false);
}

async function seedRollupMemory(
  sql: Sql,
  input: {
    projectId: string;
    sessionId: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO project_memories (
      project_id,
      type,
      summary,
      metadata,
      idempotency_key,
      writer_host
    )
    VALUES (
      ${input.projectId},
      'session',
      ${input.summary ?? `rollup ${input.sessionId}`},
      ${JSON.stringify(
        input.metadata ?? {
          capture: {
            version: '0.5',
            session_id: input.sessionId,
            observation_ids: [],
            model: 'test',
            spool_offsets: [],
            summarize_count: 1,
            discovery_tokens: 12,
          },
        }
      )}::jsonb,
      ${`capture:v05:${input.projectId}:${input.sessionId}`},
      'vitest'
    )
    RETURNING id
  `;
  return rows[0].id;
}

async function seedObservation(
  sql: Sql,
  input: {
    projectId: string;
    sessionId: string;
    observedAt: Date;
    rollupMemoryId?: string | null;
    type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
    title?: string;
    status?: 'active' | 'archived';
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const title = input.title ?? `${input.type ?? 'feature'} ${input.observedAt.toISOString()}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO observations (
      project_id,
      session_id,
      rollup_memory_id,
      type,
      title,
      subtitle,
      narrative,
      discovery_tokens,
      source_hook,
      content_hash,
      writer_host,
      status,
      metadata,
      observed_at
    )
    VALUES (
      ${input.projectId},
      ${input.sessionId},
      ${input.rollupMemoryId ?? null},
      ${input.type ?? 'feature'},
      ${title},
      ${`subtitle ${title}`},
      ${`narrative ${title}`},
      7,
      'vitest',
      ${`refine-test-${randomUUID()}`},
      'vitest',
      ${input.status ?? 'active'},
      ${JSON.stringify(input.metadata ?? { test: 'refine-delete-service' })}::jsonb,
      ${input.observedAt.toISOString()}::timestamptz
    )
    RETURNING id
  `;
  return rows[0].id;
}

async function cleanup(sql: Sql): Promise<void> {
  await sql`DELETE FROM observations WHERE project_id LIKE ${TEST_PREFIX + '%'}`;
  await sql`DELETE FROM project_memories WHERE project_id LIKE ${TEST_PREFIX + '%'}`;
}

async function notFoundMessage(action: () => Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await action();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(NotFoundError);
  return (caught as Error).message;
}

describe('refine_delete service (integration, real PG)', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    sql = await connectTestDb();
    db = drizzle(sql);
  });

  afterEach(async () => {
    await cleanup(sql);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  it('archives an active observation and writes audit metadata', async () => {
    const projectId = `${TEST_PREFIX}-obs-delete`;
    const id = await seedObservation(sql, {
      projectId,
      sessionId: `session-${randomUUID()}`,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'delete-active-observation',
    });

    const result = await refineDelete(db, { projectId, target: 'observation', id });

    expect(result.id).toBe(id);
    expect(result.target).toBe('observation');
    expectIso8601(result.archivedAt);
    const rows = await sql<{ status: string; deleted_at: string | null }[]>`
      SELECT status, metadata #>> '{refine,deleted,at}' AS deleted_at
      FROM observations
      WHERE id = ${id}
    `;
    expect(rows[0].status).toBe('archived');
    expectIso8601(rows[0].deleted_at);
  });

  it('archives an active rollup memory and merges audit metadata without overwriting existing keys', async () => {
    const projectId = `${TEST_PREFIX}-memory-delete`;
    const sessionId = `session-${randomUUID()}`;
    const id = await seedRollupMemory(sql, {
      projectId,
      sessionId,
      metadata: {
        capture: {
          version: '0.5',
          session_id: sessionId,
          observation_ids: [],
          model: 'test',
          spool_offsets: [],
          summarize_count: 1,
          discovery_tokens: 12,
        },
      },
    });

    const result = await refineDelete(db, { projectId, target: 'memory', id });

    expect(result.id).toBe(id);
    expect(result.target).toBe('memory');
    expectIso8601(result.archivedAt);
    const rows = await sql<{
      status: string;
      deleted_at: string | null;
      capture_session_id: string | null;
    }[]>`
      SELECT
        status,
        metadata #>> '{refine,deleted,at}' AS deleted_at,
        metadata #>> '{capture,session_id}' AS capture_session_id
      FROM project_memories
      WHERE id = ${id}
    `;
    expect(rows[0].status).toBe('archived');
    expectIso8601(rows[0].deleted_at);
    expect(rows[0].capture_session_id).toBe(sessionId);
  });

  it('does not leak existence across project boundaries', async () => {
    const projectA = `${TEST_PREFIX}-guard-a`;
    const projectB = `${TEST_PREFIX}-guard-b`;
    const foreignId = await seedObservation(sql, {
      projectId: projectB,
      sessionId: `session-${randomUUID()}`,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'foreign-observation',
    });
    const before = (
      await sql<{ status: string; metadata: string }[]>`
        SELECT status, metadata::text AS metadata FROM observations WHERE id = ${foreignId}
      `
    )[0];

    const foreignMessage = await notFoundMessage(() =>
      refineDelete(db, { projectId: projectA, target: 'observation', id: foreignId })
    );
    const missingMessage = await notFoundMessage(() =>
      refineDelete(db, { projectId: projectA, target: 'observation', id: randomUUID() })
    );

    expect(foreignMessage).toBe(missingMessage);
    const after = (
      await sql<{ status: string; metadata: string }[]>`
        SELECT status, metadata::text AS metadata FROM observations WHERE id = ${foreignId}
      `
    )[0];
    expect(after).toEqual(before);
  });

  it('treats already archived observations as not found and leaves data unchanged', async () => {
    const projectId = `${TEST_PREFIX}-archived-repeat`;
    const id = await seedObservation(sql, {
      projectId,
      sessionId: `session-${randomUUID()}`,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'already-archived-observation',
    });
    const sentinel = { sentinel: { keep: `marker-${randomUUID()}` } };
    await sql`
      UPDATE observations
      SET status = 'archived', metadata = ${JSON.stringify(sentinel)}::jsonb
      WHERE id = ${id}
    `;
    const before = (
      await sql<{ status: string; metadata: string }[]>`
        SELECT status, metadata::text AS metadata FROM observations WHERE id = ${id}
      `
    )[0];

    await expect(refineDelete(db, { projectId, target: 'observation', id })).rejects.toBeInstanceOf(
      NotFoundError
    );

    const after = (
      await sql<{ status: string; metadata: string }[]>`
        SELECT status, metadata::text AS metadata FROM observations WHERE id = ${id}
      `
    )[0];
    expect(after).toEqual(before);
  });

  it('rejects non-UUID ids before PostgreSQL casts them', async () => {
    await expect(
      refineDelete(db, {
        projectId: `${TEST_PREFIX}-bad-id`,
        target: 'observation',
        id: 'not-a-uuid',
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('removes archived observations from search, timeline, and getObservations results', async () => {
    const projectId = `${TEST_PREFIX}-retrieval`;
    const sessionId = `session-${randomUUID()}`;
    const keyword = `refine-visible-${randomUUID()}`;
    const deletedId = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: `${keyword} deleted`,
    });
    const survivorId = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:01:00.000Z'),
      title: `${keyword} survivor`,
    });

    await refineDelete(db, { projectId, target: 'observation', id: deletedId });

    const previousInclude = process.env.CC_MEMORY_INCLUDE_OBSERVATIONS;
    process.env.CC_MEMORY_INCLUDE_OBSERVATIONS = 'on';
    try {
      const search = await searchMemoryIndexes(db, {
        query: keyword,
        projectId,
        mode: 'keyword',
        limit: 10,
      });
      expect(search.results.map((row) => row.id)).not.toContain(deletedId);
      expect(search.results.map((row) => row.id)).toContain(survivorId);
    } finally {
      if (previousInclude === undefined) {
        delete process.env.CC_MEMORY_INCLUDE_OBSERVATIONS;
      } else {
        process.env.CC_MEMORY_INCLUDE_OBSERVATIONS = previousInclude;
      }
    }

    const timelineResult = await timeline(db, survivorId, 2, 2, projectId);
    expect(timelineResult.observations.map((row) => row.id)).not.toContain(deletedId);
    expect(timelineResult.observations.map((row) => row.id)).toContain(survivorId);

    const rows = await getObservations(db, [deletedId, survivorId], projectId);
    expect(rows.map((row) => row.id)).toEqual([survivorId]);
  });
});
