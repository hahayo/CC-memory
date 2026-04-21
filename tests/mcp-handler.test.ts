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
        project_id: tp,
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
      { id, project_id: tp, expected_status: 'open', status: 'in_progress' },
      testDb
    );
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('已更新');
    expect(text).toContain('abc');
  });

  // --------- Codex review round 5 P2：cc_task_update 必須提供 project scope ---------
  it('cc_task_update 跨 project 嘗試改 UUID → NOT_FOUND（不洩露存在性）', async () => {
    const id = randomUUID();
    const otherProject = `${tp}-other`;
    await sql`INSERT INTO tasks (id, project_id, title, status) VALUES (${id}, ${otherProject}, 'cross', 'open')`;

    const res = await handleToolCall(
      'cc_task_update',
      { id, project_id: tp, expected_status: 'open', status: 'done' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('NOT_FOUND');

    // 驗證 other project 的 task 沒被改動
    const rows = await sql<{ status: string }[]>`SELECT status FROM tasks WHERE id = ${id}`;
    expect(rows[0].status).toBe('open');

    await sql`DELETE FROM tasks WHERE project_id = ${otherProject}`;
  });

  it('cc_task_update 違反狀態轉移 → JSON error code=INVALID_TRANSITION', async () => {
    const id = randomUUID();
    await sql`INSERT INTO tasks (id, project_id, title, status) VALUES (${id}, ${tp}, 'abc', 'done')`;

    const res = await handleToolCall(
      'cc_task_update',
      { id, project_id: tp, expected_status: 'done', status: 'in_progress' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_TRANSITION');
  });

  // ---------- Codex review round 1 fixes ----------

  it('cc_memory_search 不傳 project_id 也不傳 project_path → cross-project 搜尋（search_feedback.query_project_id = NULL）', async () => {
    // 在兩個不同 projectId 下各寫一筆
    const p1 = `${tp}-xp1`;
    const p2 = `${tp}-xp2`;
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${p1}, 'session', 'alpha in p1')`;
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${p2}, 'session', 'alpha in p2')`;

    const beforeCount = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id IS NULL
    `)[0].c;

    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'alpha', mode: 'keyword' }, // 注意：無 project_id / project_path
      testDb
    );
    expect(res.isError).not.toBe(true);

    await new Promise((r) => setTimeout(r, 150));

    const feedbackRows = await sql<{ query_project_id: string | null }[]>`
      SELECT query_project_id FROM search_feedback
      ORDER BY created_at DESC LIMIT 1
    `;
    // 最新一筆 feedback 的 query_project_id 應為 NULL（跨專案搜尋）
    expect(feedbackRows[0].query_project_id).toBeNull();

    const afterCount = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id IS NULL
    `)[0].c;
    expect(afterCount).toBeGreaterThan(beforeCount);

    // cleanup
    await sql`DELETE FROM project_memories WHERE project_id IN (${p1}, ${p2})`;
  });

  it('cc_memory_get 找不到 id → JSON error code=NOT_FOUND（非 INTERNAL）', async () => {
    const fakeId = randomUUID();
    const res = await handleToolCall('cc_memory_get', { id: fakeId }, testDb);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.details).toEqual(expect.objectContaining({ id: fakeId }));
  });

  it('cc_task_create 重複 idempotency_key → JSON error code=IDEMPOTENCY_CONFLICT（非 INTERNAL）', async () => {
    const key = `idem-mcp-${randomUUID()}`;
    const res1 = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 'first', idempotency_key: key },
      testDb
    );
    expect(res1.isError).not.toBe(true);

    const res2 = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 'second', idempotency_key: key },
      testDb
    );
    expect(res2.isError).toBe(true);
    const parsed = JSON.parse((res2.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(parsed.error.details).toEqual(
      expect.objectContaining({ idempotencyKey: key })
    );
  });

  // --------- Codex review round 4 finding #1：due_date 驗證 ---------
  it('cc_task_create 傳無效 due_date → JSON error INVALID_ARGUMENT（非 INTERNAL）', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 'bad due', due_date: 'tomorrow' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
    expect(parsed.error.message).toMatch(/due_date/);
  });

  it('cc_task_update 傳無效 due_date → JSON error INVALID_ARGUMENT', async () => {
    const id = randomUUID();
    await sql`INSERT INTO tasks (id, project_id, title, status) VALUES (${id}, ${tp}, 'ok', 'open')`;

    const res = await handleToolCall(
      'cc_task_update',
      { id, project_id: tp, expected_status: 'open', due_date: '2026-99-99' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_create 傳 Feb 31 → JSON error INVALID_ARGUMENT（不靜默 rollover 到 Mar 3）', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 'bad date', due_date: '2026-02-31' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
    expect(parsed.error.message).toMatch(/2026-02-31/);
  });

  it('cc_task_create 傳 space-separated datetime → INVALID_ARGUMENT', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 'bad date', due_date: '2026-04-22 10:00' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_create 傳英文長日期格式 → INVALID_ARGUMENT', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 'bad date', due_date: 'March 1, 2026' },
      testDb
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_create 傳合法 ISO due_date → 成功', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      {
        project_id: tp,
        title: 'valid due',
        due_date: '2026-12-31T23:59:59Z',
      },
      testDb
    );
    expect(res.isError).not.toBe(true);
  });

  // --------- Codex review round 3 finding #1：fail-fast if no project selector ---------
  it('cc_memory_list 無 project_id 也無 project_path → JSON error INVALID_ARGUMENT（不 fallback process.cwd()）', async () => {
    const res = await handleToolCall('cc_memory_list', {}, testDb);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
    expect(parsed.error.message).toMatch(/project_id 或 project_path/);
  });

  it('cc_task_create 無 project selector → JSON error INVALID_ARGUMENT', async () => {
    const res = await handleToolCall('cc_task_create', { title: 'orphan' }, testDb);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_search 仍允許無 project selector（= 跨專案搜尋，特例）', async () => {
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'any', mode: 'keyword' },
      testDb
    );
    expect(res.isError).not.toBe(true);
  });

  it('未知 tool → JSON error code=INVALID_ARGUMENT（非 INTERNAL）', async () => {
    const res = await handleToolCall('cc_nonexistent_tool_v2', {}, testDb);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
    expect(parsed.error.message).toContain('未知的工具');
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
