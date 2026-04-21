// tests/db/v02-tdd.test.ts
//
// Phase 1 strict TDD：對 docker test PG 進行 red-green-refactor。
// 測試期望：
//   RED 階段 — schema.ts 只有 projectMemories，三張新表不存在，所有斷言失敗
//   GREEN 階段 — 加入 tasks / search_feedback / bot_user_state 後全通過
//
// 執行（本機）：
//   docker compose -f docker-compose.test.yml up -d
//   npx drizzle-kit push --config drizzle.test.config.ts
//   npx vitest run tests/db/v02-tdd.test.ts
//
// 執行（CI / 自訂 PG）：
//   export TEST_DATABASE_URL=postgres://user:pass@host:port/db
//   npx vitest run tests/db/v02-tdd.test.ts
//
// 設計：test PG 不可用時 **fail-loud**，不 silent skip。
// 原因：這組 integration tests 是 Phase 1 schema contract 的守門員；
//       skip 會讓 schema 退化（CHECK / UNIQUE / length constraint）看起來「測試全綠」。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

describe('v0.2 schema TDD (docker test DB)', () => {
  let sql: ReturnType<typeof postgres>;
  const createdTaskIds: string[] = [];
  const createdFeedbackIds: string[] = [];
  const createdBotUserIds: bigint[] = [];

  beforeAll(async () => {
    // Fail-loud probe：無法連上 test PG 就丟明確指示，不要 silent skip。
    try {
      const probe = postgres(TEST_DB_URL, { max: 1, idle_timeout: 2, connect_timeout: 2 });
      await probe`SELECT 1`;
      await probe.end();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `\nTest PostgreSQL is not reachable at ${TEST_DB_URL}.\n` +
        `這組 integration tests 守護 Phase 1 schema contract（tasks / search_feedback / bot_user_state），不可 silent skip。\n\n` +
        `啟動本機 test DB：\n` +
        `  docker compose -f docker-compose.test.yml up -d\n` +
        `  npx drizzle-kit push --config drizzle.test.config.ts\n\n` +
        `或指定現有 test PG（例如 CI）：\n` +
        `  export TEST_DATABASE_URL=postgres://user:pass@host:port/db\n\n` +
        `原始錯誤：${cause}`
      );
    }
    sql = postgres(TEST_DB_URL, { max: 1 });
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    if (createdTaskIds.length) {
      await sql`DELETE FROM tasks WHERE id = ANY(${createdTaskIds}::uuid[])`;
      createdTaskIds.length = 0;
    }
    if (createdFeedbackIds.length) {
      await sql`DELETE FROM search_feedback WHERE id = ANY(${createdFeedbackIds}::uuid[])`;
      createdFeedbackIds.length = 0;
    }
    if (createdBotUserIds.length) {
      for (const id of createdBotUserIds) {
        await sql`DELETE FROM bot_user_state WHERE telegram_user_id = ${id}`;
      }
      createdBotUserIds.length = 0;
    }
  });

  describe('tasks', () => {
    it('accepts minimal valid task with defaults', async () => {
      const id = randomUUID();
      await sql`INSERT INTO tasks (id, project_id, title) VALUES (${id}, 'p', 'hello')`;
      createdTaskIds.push(id);
      const rows = await sql<{ status: string; priority: string; source: string }[]>`
        SELECT status, priority, source FROM tasks WHERE id = ${id}
      `;
      expect(rows[0]).toMatchObject({ status: 'open', priority: 'normal', source: 'manual' });
    });

    it('rejects invalid status via CHECK constraint', async () => {
      const id = randomUUID();
      await expect(
        sql`INSERT INTO tasks (id, project_id, title, status) VALUES (${id}, 'p', 't', 'bogus')`
      ).rejects.toThrow(/tasks_status_check/);
    });

    it('rejects invalid priority via CHECK constraint', async () => {
      const id = randomUUID();
      await expect(
        sql`INSERT INTO tasks (id, project_id, title, priority) VALUES (${id}, 'p', 't', 'urgent')`
      ).rejects.toThrow(/tasks_priority_check/);
    });

    it('rejects invalid source via CHECK constraint', async () => {
      const id = randomUUID();
      await expect(
        sql`INSERT INTO tasks (id, project_id, title, source) VALUES (${id}, 'p', 't', 'slack')`
      ).rejects.toThrow(/tasks_source_check/);
    });

    it('rejects empty title via length CHECK', async () => {
      const id = randomUUID();
      await expect(
        sql`INSERT INTO tasks (id, project_id, title) VALUES (${id}, 'p', '')`
      ).rejects.toThrow(/tasks_title_length_check/);
    });

    it('rejects 501-char title via length CHECK', async () => {
      const id = randomUUID();
      const long = 'x'.repeat(501);
      await expect(
        sql`INSERT INTO tasks (id, project_id, title) VALUES (${id}, 'p', ${long})`
      ).rejects.toThrow(/tasks_title_length_check/);
    });

    it('enforces UNIQUE idempotency_key', async () => {
      const key = `idem-${randomUUID()}`;
      const id1 = randomUUID();
      const id2 = randomUUID();
      await sql`INSERT INTO tasks (id, project_id, title, idempotency_key) VALUES (${id1}, 'p', 't1', ${key})`;
      createdTaskIds.push(id1);
      await expect(
        sql`INSERT INTO tasks (id, project_id, title, idempotency_key) VALUES (${id2}, 'p', 't2', ${key})`
      ).rejects.toThrow(/tasks_idempotency_key_unique|duplicate key/);
    });
  });

  describe('search_feedback', () => {
    it('accepts valid feedback row', async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO search_feedback
          (id, query, query_surface, mode, "limit", result_ids, result_project_ids, rank_positions)
        VALUES
          (${id}, 'q', 'telegram', 'hybrid', 5,
           ${[randomUUID(), randomUUID()]}::uuid[],
           ${['p', 'p']}, ${[1, 2]})
      `;
      createdFeedbackIds.push(id);
    });

    it('rejects invalid query_surface', async () => {
      const id = randomUUID();
      await expect(
        sql`INSERT INTO search_feedback (id, query, query_surface, mode, "limit", result_ids, result_project_ids, rank_positions)
            VALUES (${id}, 'q', 'slack', 'hybrid', 5, '{}'::uuid[], '{}'::text[], '{}'::int[])`
      ).rejects.toThrow(/search_feedback_surface_check/);
    });

    it('rejects invalid mode', async () => {
      const id = randomUUID();
      await expect(
        sql`INSERT INTO search_feedback (id, query, query_surface, mode, "limit", result_ids, result_project_ids, rank_positions)
            VALUES (${id}, 'q', 'mcp', 'fuzzy', 5, '{}'::uuid[], '{}'::text[], '{}'::int[])`
      ).rejects.toThrow(/search_feedback_mode_check/);
    });

    it('rejects invalid thumbs', async () => {
      const id = randomUUID();
      await expect(
        sql`INSERT INTO search_feedback (id, query, query_surface, mode, "limit", result_ids, result_project_ids, rank_positions, thumbs)
            VALUES (${id}, 'q', 'mcp', 'keyword', 5, '{}'::uuid[], '{}'::text[], '{}'::int[], 'meh')`
      ).rejects.toThrow(/search_feedback_thumbs_check/);
    });

    it('allows NULL, up, down for thumbs', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await sql`INSERT INTO search_feedback (id, query, query_surface, mode, "limit", result_ids, result_project_ids, rank_positions)
                VALUES (${ids[0]}, 'q', 'mcp', 'keyword', 5, '{}'::uuid[], '{}'::text[], '{}'::int[])`;
      await sql`INSERT INTO search_feedback (id, query, query_surface, mode, "limit", result_ids, result_project_ids, rank_positions, thumbs)
                VALUES (${ids[1]}, 'q', 'mcp', 'keyword', 5, '{}'::uuid[], '{}'::text[], '{}'::int[], 'up')`;
      await sql`INSERT INTO search_feedback (id, query, query_surface, mode, "limit", result_ids, result_project_ids, rank_positions, thumbs)
                VALUES (${ids[2]}, 'q', 'mcp', 'keyword', 5, '{}'::uuid[], '{}'::text[], '{}'::int[], 'down')`;
      createdFeedbackIds.push(...ids);
    });
  });

  describe('bot_user_state', () => {
    it('upserts active_project_id', async () => {
      const userId = BigInt(Date.now());
      await sql`INSERT INTO bot_user_state (telegram_user_id, active_project_id) VALUES (${userId}, 'proj-a')`;
      createdBotUserIds.push(userId);
      await sql`UPDATE bot_user_state SET active_project_id = 'proj-b', updated_at = now()
                WHERE telegram_user_id = ${userId}`;
      const rows = await sql<{ active_project_id: string }[]>`
        SELECT active_project_id FROM bot_user_state WHERE telegram_user_id = ${userId}
      `;
      expect(rows[0].active_project_id).toBe('proj-b');
    });

    it('rejects duplicate primary key', async () => {
      const userId = BigInt(Date.now()) + 1n;
      await sql`INSERT INTO bot_user_state (telegram_user_id) VALUES (${userId})`;
      createdBotUserIds.push(userId);
      await expect(
        sql`INSERT INTO bot_user_state (telegram_user_id) VALUES (${userId})`
      ).rejects.toThrow(/bot_user_state_pkey|duplicate key/);
    });
  });
});
