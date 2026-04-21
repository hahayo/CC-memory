// tests/mcp-handler.test.ts
//
// Stage 2.3 — MCP handler dispatch 測試：
//   1. project_path contract（handler 讀 project_path 餵 resolveProjectId）
//   2. 成功 response 的 list / get / task 類要看得到 writer_host（text 裡顯示 ✍️host）
//   3. cc_memory_search 觸發 search_feedback 寫一筆（mode = effectiveMode）
//   4. JSON error response（BaseServiceError 被 map 成 McpError 結構；isError: true）
//   5. cc_task_update expected_status 不符 → { error: { code: 'CONFLICT', ... } }
//
// 測試 import handleToolCall 時 index.ts 自動偵測 `require.main !== module` 不會啟動 stdio server。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { handleToolCall } from '../src/index.js';
import { connectTestDb, type Sql } from './helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

describe('MCP handler (Stage 2)', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testDb: any;
  const tp = `mcp-h-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    testDb = drizzle(postgres(TEST_DB_URL, { max: 1 }));
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM project_memories WHERE project_id = ${tp}`;
    await sql`DELETE FROM tasks WHERE project_id = ${tp}`;
    await sql`DELETE FROM search_feedback WHERE query_project_id = ${tp}`;
  });

  // ---------- success response shape ----------

  it('cc_memory_list response text 含 writer_host（✍️ 標記）', async () => {
    await sql`
      INSERT INTO project_memories (project_id, type, summary, writer_host)
      VALUES (${tp}, 'session', 'hello world', 'laptop-A')
    `;
    const res = await handleToolCall('cc_memory_list', { project_id: tp }, testDb);
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('laptop-A');
    expect(text).toContain('✍️');
    expect(text).toContain('hello world');
  });

  it('cc_task_list response text 含 writer_host', async () => {
    await sql`
      INSERT INTO tasks (project_id, title, writer_host)
      VALUES (${tp}, 'do something', 'host-B')
    `;
    const res = await handleToolCall('cc_task_list', { project_id: tp }, testDb);
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('host-B');
    expect(text).toContain('do something');
  });

  // ---------- Phase 5-A wire-up ----------

  it('cc_memory_search 觸發後 search_feedback 多一筆，mode = effectiveMode', async () => {
    // 先塞一筆 memory 讓 search 有結果可排序（非必要但順便驗 end-to-end）
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${tp}, 'session', 'alpha beta')`;

    const before = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id = ${tp}
    `)[0].c;

    // keyword 模式確定不依賴 embedding
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'alpha', project_id: tp, mode: 'keyword' },
      testDb
    );
    expect(res.isError).not.toBe(true);

    // fire-and-forget 是 setImmediate 後才落庫；等一小段時間
    await new Promise((r) => setTimeout(r, 150));

    const rows = await sql<{ mode: string; query: string }[]>`
      SELECT mode, query FROM search_feedback WHERE query_project_id = ${tp} ORDER BY created_at DESC LIMIT 1
    `;
    const after = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id = ${tp}
    `)[0].c;
    expect(after).toBe(before + 1);
    expect(rows[0].mode).toBe('keyword');
    expect(rows[0].query).toBe('alpha');
  });

  // ---------- JSON error response ----------

  it('未知 tool 回 { error: { code: "INVALID_ARGUMENT" } }', async () => {
    const res = await handleToolCall('cc_nonexistent_tool', {}, testDb);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain('未知的工具');
  });

  it('cc_task_update expected_status 不符 → JSON error code=CONFLICT', async () => {
    const id = randomUUID();
    await sql`INSERT INTO tasks (id, project_id, title, status) VALUES (${id}, ${tp}, 't', 'in_progress')`;

    const res = await handleToolCall(
      'cc_task_update',
      {
        id,
        expected_status: 'open', // 與實際 in_progress 不符
        status: 'done',
      },
      testDb
    );

    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe('CONFLICT');
    expect(parsed.error.message).toMatch(/Task status/i);
    expect(parsed.error.details).toEqual(
      expect.objectContaining({ current: 'in_progress', expected: 'open' })
    );
  });

  it('cc_task_update 合法狀態轉移成功回 Task text', async () => {
    const id = randomUUID();
    await sql`INSERT INTO tasks (id, project_id, title, status) VALUES (${id}, ${tp}, 'abc', 'open')`;

    const res = await handleToolCall(
      'cc_task_update',
      { id, expected_status: 'open', status: 'in_progress' },
      testDb
    );
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('已更新');
    expect(text).toContain('abc');
  });

  it('cc_task_update 違反狀態轉移 → JSON error code=INVALID_TRANSITION', async () => {
    const id = randomUUID();
    await sql`INSERT INTO tasks (id, project_id, title, status) VALUES (${id}, ${tp}, 'abc', 'done')`;

    const res = await handleToolCall(
      'cc_task_update',
      { id, expected_status: 'done', status: 'in_progress' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_TRANSITION');
  });

  // ---------- project_path contract ----------

  it('cc_memory_list 傳 project_path 但不傳 project_id → resolveProjectId 走 basename 解析', async () => {
    const uniqueBase = `basename-test-${randomUUID().slice(0, 6)}`;
    const cwd = `/tmp/${uniqueBase}`;
    // basename(cwd) 會是 uniqueBase；insert 一筆對應的 project_id 驗證 handler 真的用了
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${uniqueBase}, 'session', 's')`;

    const res = await handleToolCall('cc_memory_list', { project_path: cwd }, testDb);
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain(uniqueBase);

    // cleanup
    await sql`DELETE FROM project_memories WHERE project_id = ${uniqueBase}`;
  });
});
