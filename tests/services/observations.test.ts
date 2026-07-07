// tests/services/observations.test.ts
//
// v0.5 M3 3b — observation retrieval integration tests（真 PG）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, type Sql } from '../helpers/db.js';
import { timeline, getObservations } from '../../src/services/observations.js';
import { InvalidArgumentError, NotFoundError } from '../../src/services/errors.js';

const TEST_PREFIX = `obs-${randomUUID().slice(0, 8)}`;

async function seedRollup(
  sql: Sql,
  input: {
    projectId: string;
    sessionId: string;
    summary?: string;
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
      ${JSON.stringify({
        capture: {
          version: '0.5',
          session_id: input.sessionId,
          observation_ids: [],
          model: 'test',
          spool_offsets: [],
          summarize_count: 1,
          discovery_tokens: 12,
        },
      })}::jsonb,
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
      ${`obs-test-${randomUUID()}`},
      'vitest',
      ${input.status ?? 'active'},
      ${JSON.stringify({ test: 'observations-service' })}::jsonb,
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

describe('observations retrieval service (integration, real PG)', () => {
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

  it('timeline with observation anchor returns same project/session context ordered by observed_at', async () => {
    const projectId = `${TEST_PREFIX}-timeline-obs`;
    const otherProjectId = `${TEST_PREFIX}-timeline-other`;
    const sessionId = `session-${randomUUID()}`;
    const otherSessionId = `session-${randomUUID()}`;

    const before2 = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'before-2',
    });
    const before1 = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:01:00.000Z'),
      title: 'before-1',
    });
    const anchor = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:02:00.000Z'),
      title: 'anchor',
    });
    const after1 = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:03:00.000Z'),
      title: 'after-1',
    });
    const after2 = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:04:00.000Z'),
      title: 'after-2',
    });
    await seedObservation(sql, {
      projectId,
      sessionId: otherSessionId,
      observedAt: new Date('2026-07-07T00:01:30.000Z'),
      title: 'wrong-session',
    });
    await seedObservation(sql, {
      projectId: otherProjectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:02:30.000Z'),
      title: 'wrong-project',
    });

    const result = await timeline(db, anchor, 2, 2, projectId);

    expect(result.anchorId).toBe(anchor);
    expect(result.depthBefore).toBe(2);
    expect(result.depthAfter).toBe(2);
    expect(result.observations.map((row) => row.id)).toEqual([
      before2,
      before1,
      anchor,
      after1,
      after2,
    ]);
  });

  it('timeline with rollup anchor uses metadata capture session and ignores stray linked observations', async () => {
    const projectId = `${TEST_PREFIX}-timeline-rollup`;
    const sessionId = `session-${randomUUID()}`;
    const otherSessionId = `session-${randomUUID()}`;
    const rollupId = await seedRollup(sql, { projectId, sessionId });

    await seedObservation(sql, {
      projectId,
      sessionId: otherSessionId,
      rollupMemoryId: rollupId,
      observedAt: new Date('2026-07-06T23:59:00.000Z'),
      title: 'stray-linked-rollup',
    });
    const before = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'before-rollup',
    });
    const linked1 = await seedObservation(sql, {
      projectId,
      sessionId,
      rollupMemoryId: rollupId,
      observedAt: new Date('2026-07-07T00:01:00.000Z'),
      title: 'linked-1',
    });
    const linked2 = await seedObservation(sql, {
      projectId,
      sessionId,
      rollupMemoryId: rollupId,
      observedAt: new Date('2026-07-07T00:02:00.000Z'),
      title: 'linked-2',
    });
    const after = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:03:00.000Z'),
      title: 'after-rollup',
    });
    await seedObservation(sql, {
      projectId,
      sessionId: otherSessionId,
      observedAt: new Date('2026-07-07T00:01:30.000Z'),
      title: 'wrong-session-rollup',
    });

    const result = await timeline(db, rollupId, 1, 1, projectId);

    expect(result.anchorId).toBe(rollupId);
    expect(result.observations.map((row) => row.id)).toEqual([before, linked1, linked2, after]);
  });

  it('timeline with rollup anchor truncates middle rows at 100 and marks the result', async () => {
    const projectId = `${TEST_PREFIX}-timeline-truncate`;
    const sessionId = `session-${randomUUID()}`;
    const rollupId = await seedRollup(sql, { projectId, sessionId });

    const expectedIds: string[] = [];
    for (let i = 0; i < 101; i += 1) {
      const id = await seedObservation(sql, {
        projectId,
        sessionId,
        rollupMemoryId: rollupId,
        observedAt: new Date(Date.UTC(2026, 6, 7, 0, i, 0)),
        title: `middle-${String(i).padStart(3, '0')}`,
      });
      if (i < 100) expectedIds.push(id);
    }

    const result = await timeline(db, rollupId, 0, 0, projectId);

    expect(result.observations.map((row) => row.id)).toEqual(expectedIds);
    expect(result.observations).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('timeline does not return archived observations and treats archived anchors as not found', async () => {
    const projectId = `${TEST_PREFIX}-timeline-archived`;
    const sessionId = `session-${randomUUID()}`;
    const before = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'before-active',
    });
    const archivedContext = await seedObservation(sql, {
      projectId,
      sessionId,
      status: 'archived',
      observedAt: new Date('2026-07-07T00:01:00.000Z'),
      title: 'archived-context',
    });
    const anchor = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:02:00.000Z'),
      title: 'anchor-active',
    });
    const after = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:03:00.000Z'),
      title: 'after-active',
    });

    const result = await timeline(db, anchor, 2, 2, projectId);

    expect(result.observations.map((row) => row.id)).toEqual([before, anchor, after]);
    await expect(timeline(db, archivedContext, 1, 1, projectId)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('timeline applies project guard to observation anchors', async () => {
    const projectId = `${TEST_PREFIX}-guard`;
    const otherProjectId = `${TEST_PREFIX}-guard-other`;
    const anchor = await seedObservation(sql, {
      projectId: otherProjectId,
      sessionId: `session-${randomUUID()}`,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'other-project-anchor',
    });

    await expect(timeline(db, anchor, 1, 1, projectId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('timeline rejects non-UUID anchor ids before querying PostgreSQL', async () => {
    await expect(
      timeline(db, 'not-a-uuid', 1, 1, `${TEST_PREFIX}-bad-anchor`)
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('getObservations returns active same-project rows in requested order and filters archived/cross-project ids', async () => {
    const projectId = `${TEST_PREFIX}-get`;
    const otherProjectId = `${TEST_PREFIX}-get-other`;
    const sessionId = `session-${randomUUID()}`;
    const active1 = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:00:00.000Z'),
      title: 'active-1',
    });
    const archived = await seedObservation(sql, {
      projectId,
      sessionId,
      status: 'archived',
      observedAt: new Date('2026-07-07T00:01:00.000Z'),
      title: 'archived-get',
    });
    const active2 = await seedObservation(sql, {
      projectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:02:00.000Z'),
      title: 'active-2',
    });
    const otherProject = await seedObservation(sql, {
      projectId: otherProjectId,
      sessionId,
      observedAt: new Date('2026-07-07T00:03:00.000Z'),
      title: 'other-project-get',
    });

    const rows = await getObservations(
      db,
      [active2, archived, otherProject, active1],
      projectId
    );

    expect(rows.map((row) => row.id)).toEqual([active2, active1]);
    expect(rows.map((row) => row.narrative)).toEqual(['narrative active-2', 'narrative active-1']);
  });

  it('getObservations handles empty ids and rejects oversized batches', async () => {
    const projectId = `${TEST_PREFIX}-limits`;

    await expect(getObservations(db, [], projectId)).resolves.toEqual([]);
    await expect(
      getObservations(db, Array.from({ length: 51 }, () => randomUUID()), projectId)
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('getObservations rejects non-UUID ids before querying PostgreSQL', async () => {
    await expect(
      getObservations(db, [randomUUID(), 'not-a-uuid'], `${TEST_PREFIX}-bad-ids`)
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
