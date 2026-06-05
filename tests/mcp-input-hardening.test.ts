// tests/mcp-input-hardening.test.ts
//
// 自動 caller（hermes 等）壞輸入應回乾淨 INVALID_ARGUMENT，不該 bubble 成 INTERNAL
// 或靜默寫入非法值（plan 階段 0 input hardening）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { handleToolCall } from '../src/index.js';
import { connectTestDb, type Sql } from './helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

function errCode(res: Awaited<ReturnType<typeof handleToolCall>>): string {
  return JSON.parse((res.content[0] as { text: string }).text).error.code;
}

describe('input hardening（壞輸入 → INVALID_ARGUMENT，非 INTERNAL）', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testDb: any;
  const tp = `harden-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    testDb = drizzle(postgres(TEST_DB_URL, { max: 1 }));
  });
  afterAll(async () => {
    if (sql) await sql.end();
  });
  afterEach(async () => {
    await sql`DELETE FROM project_memories WHERE project_id = ${tp}`;
  });

  it('cc_memory_list limit 負數 → INVALID_ARGUMENT', async () => {
    const res = await handleToolCall('cc_memory_list', { project_id: tp, limit: -1 }, testDb);
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_list offset 負數 → INVALID_ARGUMENT', async () => {
    const res = await handleToolCall('cc_memory_list', { project_id: tp, offset: -3 }, testDb);
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_search limit 負數 → INVALID_ARGUMENT', async () => {
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'x', project_id: tp, limit: -5, mode: 'keyword' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_save type 非法 → INVALID_ARGUMENT（不靜默寫入）', async () => {
    const res = await handleToolCall(
      'cc_memory_save',
      { project_id: tp, type: 'bogus', summary: 's' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
    const [{ c }] = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM project_memories WHERE project_id = ${tp}
    `;
    expect(c).toBe(0);
  });

  it('cc_memory_save summary 空字串 → INVALID_ARGUMENT', async () => {
    const res = await handleToolCall(
      'cc_memory_save',
      { project_id: tp, type: 'session', summary: '   ' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  // -------------------------------------------------------------------------
  // #7（採納 Codex review）：search / task MCP args malformed → INVALID_ARGUMENT
  //   真 gap（修正前是 INTERNAL 或靜默）：query 型別 / mode / type / tags
  //   lock-in（已驗，應即綠）：status / completed_since_days
  // -------------------------------------------------------------------------

  it('cc_memory_search query 非字串（number）→ INVALID_ARGUMENT（非 INTERNAL）', async () => {
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 123, project_id: tp, mode: 'keyword' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_search query 空白字串 → INVALID_ARGUMENT（不靜默空結果）', async () => {
    const res = await handleToolCall(
      'cc_memory_search',
      { query: '   ', project_id: tp, mode: 'keyword' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_search mode 非法 → INVALID_ARGUMENT（不靜默降級）', async () => {
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'x', project_id: tp, mode: 'bogus' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_search type 非法 → INVALID_ARGUMENT（不靜默空結果）', async () => {
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'x', project_id: tp, type: 'bogus', mode: 'keyword' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_memory_list type 非法 → INVALID_ARGUMENT（不靜默空結果）', async () => {
    const res = await handleToolCall('cc_memory_list', { project_id: tp, type: 'bogus' }, testDb);
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_create tags 含非字串元素 → INVALID_ARGUMENT（非 INTERNAL）', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 't', tags: [1, 2, 3] },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_create tags 非陣列（string）→ INVALID_ARGUMENT', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { project_id: tp, title: 't', tags: 'foo' },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_update tags 含非字串元素 → INVALID_ARGUMENT（fail-fast，先於存在性檢查）', async () => {
    const res = await handleToolCall(
      'cc_task_update',
      { id: randomUUID(), project_id: tp, expected_status: 'open', tags: [1] },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_list status 非法 → INVALID_ARGUMENT（lock-in：已驗）', async () => {
    const res = await handleToolCall('cc_task_list', { project_id: tp, status: 'bogus' }, testDb);
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('cc_task_stats completed_since_days 非整數 → INVALID_ARGUMENT（lock-in：已驗）', async () => {
    const res = await handleToolCall(
      'cc_task_stats',
      { project_id: tp, completed_since_days: 1.5 },
      testDb
    );
    expect(res.isError).toBe(true);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });
});
