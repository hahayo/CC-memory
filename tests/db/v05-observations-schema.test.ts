// tests/db/v05-observations-schema.test.ts
//
// CC-memory v0.5 M1 — observations schema contract.
//
// RED expectation before M1 migrations are wired:
//   npx vitest run tests/db/v05-observations-schema.test.ts
// should fail because public.observations does not exist in the test DBs,
// not because this test imports a missing Drizzle export.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  connectDb,
  TEST_DB_URL,
  TEST_PERSONAL_DB_URL,
  type Sql,
} from '../helpers/db.js';

type ColumnInfo = {
  name: string;
  formatted_type: string;
  not_null: boolean;
};

type ConstraintInfo = {
  conname: string;
  definition: string;
};

type IndexInfo = {
  indexname: string;
  indexdef: string;
};

const EXPECTED_COLUMNS = [
  'id',
  'project_id',
  'session_id',
  'rollup_memory_id',
  'type',
  'title',
  'subtitle',
  'facts',
  'concepts',
  'files',
  'narrative',
  'embedding',
  'discovery_tokens',
  'source_hook',
  'content_hash',
  'writer_host',
  'status',
  'metadata',
  'observed_at',
  'created_at',
  'updated_at',
] as const;

const EXPECTED_TYPES: Record<(typeof EXPECTED_COLUMNS)[number], string> = {
  id: 'uuid',
  project_id: 'text',
  session_id: 'text',
  rollup_memory_id: 'uuid',
  type: 'text',
  title: 'text',
  subtitle: 'text',
  facts: 'text[]',
  concepts: 'text[]',
  files: 'text[]',
  narrative: 'text',
  embedding: 'vector(1536)',
  discovery_tokens: 'integer',
  source_hook: 'text',
  content_hash: 'text',
  writer_host: 'text',
  status: 'text',
  metadata: 'jsonb',
  observed_at: 'timestamp with time zone',
  created_at: 'timestamp with time zone',
  updated_at: 'timestamp with time zone',
};

async function columns(sql: Sql): Promise<ColumnInfo[]> {
  return sql<ColumnInfo[]>`
    SELECT
      a.attname AS name,
      format_type(a.atttypid, a.atttypmod) AS formatted_type,
      a.attnotnull AS not_null
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'observations'
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
}

async function checks(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<ConstraintInfo[]>`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.observations'::regclass
      AND contype = 'c'
  `;
  return new Map(rows.map((row) => [row.conname, row.definition]));
}

async function indexes(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<IndexInfo[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'observations'
  `;
  return new Map(rows.map((row) => [row.indexname, row.indexdef]));
}

async function insertObservation(sql: Sql, projectId: string, contentHash: string): Promise<void> {
  await sql`
    INSERT INTO observations (
      project_id,
      session_id,
      type,
      title,
      subtitle,
      facts,
      concepts,
      files,
      narrative,
      discovery_tokens,
      source_hook,
      content_hash,
      writer_host,
      observed_at
    )
    VALUES (
      ${projectId},
      ${`session-${randomUUID()}`},
      'decision',
      'M1 routing check probe',
      'probe',
      ${['fact']}::text[],
      ${['testing']}::text[],
      ${['tests/db/v05-observations-schema.test.ts']}::text[],
      'probe narrative',
      1,
      'post-tool-use',
      ${contentHash},
      'vitest',
      now()
    )
  `;
}

async function expectInsertRejectedBy(
  sql: Sql,
  projectId: string,
  constraintName: string
): Promise<void> {
  const contentHash = `route-${randomUUID()}`;
  let inserted = false;
  try {
    await insertObservation(sql, projectId, contentHash);
    inserted = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain(constraintName);
    return;
  } finally {
    if (inserted) {
      await sql`DELETE FROM observations WHERE content_hash = ${contentHash}`;
    }
  }
  throw new Error(`expected ${constraintName} to reject project_id=${projectId}`);
}

describe('v0.5 observations schema (project/personal test DB)', () => {
  let projectSql: Sql;
  let personalSql: Sql;

  beforeAll(async () => {
    projectSql = await connectDb(TEST_DB_URL);
    personalSql = await connectDb(TEST_PERSONAL_DB_URL);
  });

  afterAll(async () => {
    if (projectSql) await projectSql.end();
    if (personalSql) await personalSql.end();
  });

  it('creates observations table in both project and personal test DBs', async () => {
    for (const sql of [projectSql, personalSql]) {
      await sql`SELECT id FROM observations LIMIT 0`;
    }
  });

  it('keeps project and personal observations column sets identical', async () => {
    const projectColumns = await columns(projectSql);
    const personalColumns = await columns(personalSql);

    expect(projectColumns.map((col) => col.name)).toEqual([...EXPECTED_COLUMNS]);
    expect(personalColumns.map((col) => col.name)).toEqual([...EXPECTED_COLUMNS]);
    expect(personalColumns).toEqual(projectColumns);
  });

  it('uses the expected column types, including embedding vector(1536)', async () => {
    const projectColumns = await columns(projectSql);
    const types = Object.fromEntries(projectColumns.map((col) => [col.name, col.formatted_type]));
    expect(types).toEqual(EXPECTED_TYPES);
  });

  it('enforces type/status/discovery_tokens CHECK constraints', async () => {
    const projectChecks = await checks(projectSql);

    expect(projectChecks.get('observations_type_check')).toBeDefined();
    for (const value of ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']) {
      expect(projectChecks.get('observations_type_check')).toContain(value);
    }

    expect(projectChecks.get('observations_status_check')).toContain('active');
    expect(projectChecks.get('observations_status_check')).toContain('archived');

    const discoveryCheck = projectChecks.get('observations_discovery_tokens_check');
    expect(discoveryCheck).toBeDefined();
    expect(discoveryCheck?.replace(/\s+/g, ' ')).toMatch(/discovery_tokens.+> 0/);
  });

  it('creates content partial unique index and retrieval indexes', async () => {
    const projectIndexes = await indexes(projectSql);

    const contentUnique = projectIndexes.get('observations_content_uniq')?.toLowerCase();
    expect(contentUnique).toContain('create unique index');
    expect(contentUnique).toContain('project_id');
    expect(contentUnique).toContain('session_id');
    expect(contentUnique).toContain('content_hash');
    expect(contentUnique).toContain('where');
    expect(contentUnique).toContain("status = 'active'");

    expect(projectIndexes.get('observations_embedding_idx')?.toLowerCase()).toContain('using hnsw');
    expect(projectIndexes.get('observations_project_active_idx')?.toLowerCase()).toContain(
      'project_id'
    );
    expect(projectIndexes.get('observations_session_idx')?.toLowerCase()).toContain('session_id');
    expect(projectIndexes.get('observations_status_idx')?.toLowerCase()).toContain('status');
  });

  it('project test DB rejects __personal__ observations through 0012', async () => {
    await expectInsertRejectedBy(projectSql, '__personal__', 'observations_no_personal_check');
  });

  it('personal test DB rejects non-personal observations through 0013', async () => {
    await expectInsertRejectedBy(
      personalSql,
      `project-${randomUUID()}`,
      'observations_personal_only_check'
    );
  });
});
