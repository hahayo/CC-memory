// tests/db/v03-writer-idempotency.test.ts
//
// Stage 0.1 DB integration test（連 test PG，驗 migration 實際生效）
//
// 涵蓋：
//   - project_memories.writer_host 可寫讀
//   - project_memories.idempotency_key partial unique index（NULL 可重複、非 NULL 不可）
//   - project_memories.content_hash 欄位存在
//   - tasks.writer_host 可寫讀
//   - search_feedback_arrays_same_length CHECK

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectTestDb, type Sql } from '../helpers/db.js';

describe('v0.3 DB integration — writer_host / idempotency / CHECK', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = await connectTestDb();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    // 只清本測試用的 scope（避免打到同資料庫的其他測試資料）
    await sql`DELETE FROM project_memories WHERE project_id LIKE 'v03-%'`;
    await sql`DELETE FROM tasks WHERE project_id LIKE 'v03-%'`;
    await sql`DELETE FROM search_feedback WHERE query_project_id LIKE 'v03-%'`;
  });

  describe('project_memories.writer_host', () => {
    it('persists writer_host string', async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO project_memories (id, project_id, type, summary, writer_host)
        VALUES (${id}, 'v03-p', 'session', 's', 'host-A')
      `;
      const rows = await sql<{ writer_host: string }[]>`
        SELECT writer_host FROM project_memories WHERE id = ${id}
      `;
      expect(rows[0].writer_host).toBe('host-A');
    });
  });

  describe('project_memories.idempotency_key partial unique index', () => {
    it('rejects duplicate non-null idempotency_key', async () => {
      const key = `v03-idem-${randomUUID()}`;
      await sql`
        INSERT INTO project_memories (project_id, type, summary, idempotency_key)
        VALUES ('v03-p', 'session', 's1', ${key})
      `;
      await expect(
        sql`
          INSERT INTO project_memories (project_id, type, summary, idempotency_key)
          VALUES ('v03-p', 'session', 's2', ${key})
        `
      ).rejects.toThrow(/project_memories_idempotency_idx|duplicate key/);
    });

    it('allows multiple NULL idempotency_key rows (partial index)', async () => {
      await sql`
        INSERT INTO project_memories (project_id, type, summary, idempotency_key)
        VALUES ('v03-p', 'session', 's1', NULL)
      `;
      await sql`
        INSERT INTO project_memories (project_id, type, summary, idempotency_key)
        VALUES ('v03-p', 'session', 's2', NULL)
      `;
      const rows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM project_memories WHERE project_id = 'v03-p'
      `;
      expect(rows[0].c).toBe(2);
    });
  });

  describe('project_memories.content_hash', () => {
    it('persists content_hash string', async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO project_memories (id, project_id, type, summary, content_hash)
        VALUES (${id}, 'v03-p', 'session', 's', 'abc123')
      `;
      const rows = await sql<{ content_hash: string }[]>`
        SELECT content_hash FROM project_memories WHERE id = ${id}
      `;
      expect(rows[0].content_hash).toBe('abc123');
    });
  });

  describe('tasks.writer_host', () => {
    it('persists writer_host string', async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO tasks (id, project_id, title, writer_host)
        VALUES (${id}, 'v03-p', 't', 'host-B')
      `;
      const rows = await sql<{ writer_host: string }[]>`
        SELECT writer_host FROM tasks WHERE id = ${id}
      `;
      expect(rows[0].writer_host).toBe('host-B');
    });
  });

  describe('search_feedback_arrays_same_length CHECK', () => {
    it('rejects when rank_positions length != result_ids length', async () => {
      const id = randomUUID();
      await expect(
        sql`
          INSERT INTO search_feedback
            (id, query, query_surface, query_project_id, mode, "limit",
             result_ids, result_project_ids, rank_positions)
          VALUES
            (${id}, 'q', 'mcp', 'v03-p', 'keyword', 5,
             ${[randomUUID(), randomUUID()]}::uuid[],
             ${['v03-p', 'v03-p']},
             ${[1]}::int[])
        `
      ).rejects.toThrow(/search_feedback_arrays_same_length/);
    });

    it('rejects when result_project_ids length != result_ids length', async () => {
      const id = randomUUID();
      await expect(
        sql`
          INSERT INTO search_feedback
            (id, query, query_surface, query_project_id, mode, "limit",
             result_ids, result_project_ids, rank_positions)
          VALUES
            (${id}, 'q', 'mcp', 'v03-p', 'keyword', 5,
             ${[randomUUID(), randomUUID()]}::uuid[],
             ${['v03-p']},
             ${[1, 2]}::int[])
        `
      ).rejects.toThrow(/search_feedback_arrays_same_length/);
    });

    it('rejects when scores is non-null and length != result_ids length', async () => {
      const id = randomUUID();
      await expect(
        sql`
          INSERT INTO search_feedback
            (id, query, query_surface, query_project_id, mode, "limit",
             result_ids, result_project_ids, rank_positions, scores)
          VALUES
            (${id}, 'q', 'mcp', 'v03-p', 'keyword', 5,
             ${[randomUUID(), randomUUID()]}::uuid[],
             ${['v03-p', 'v03-p']},
             ${[1, 2]}::int[],
             ${[0.1]}::real[])
        `
      ).rejects.toThrow(/search_feedback_arrays_same_length/);
    });

    it('allows scores = NULL even when result_ids non-empty', async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO search_feedback
          (id, query, query_surface, query_project_id, mode, "limit",
           result_ids, result_project_ids, rank_positions, scores)
        VALUES
          (${id}, 'q', 'mcp', 'v03-p', 'keyword', 5,
           ${[randomUUID(), randomUUID()]}::uuid[],
           ${['v03-p', 'v03-p']},
           ${[1, 2]}::int[],
           NULL)
      `;
      const rows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM search_feedback WHERE id = ${id}
      `;
      expect(rows[0].c).toBe(1);
    });

    it('accepts 3-element aligned arrays', async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO search_feedback
          (id, query, query_surface, query_project_id, mode, "limit",
           result_ids, result_project_ids, rank_positions, scores)
        VALUES
          (${id}, 'q', 'mcp', 'v03-p', 'hybrid', 10,
           ${[randomUUID(), randomUUID(), randomUUID()]}::uuid[],
           ${['v03-p', 'v03-p', 'v03-p']},
           ${[1, 2, 3]}::int[],
           ${[0.9, 0.8, 0.7]}::real[])
      `;
      const rows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM search_feedback WHERE id = ${id}
      `;
      expect(rows[0].c).toBe(1);
    });
  });
});
