// tests/mcp-task-stats.test.ts
//
// cc_task_stats MCP 工具：回結構化 JSON（取代 raw postgres），且為 scope 工具
// （走 ScopePolicy：forced-mode / project-mode deny）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { handleToolCall } from '../src/index.js';
import { loadScopeConfig } from '../src/services/scope-policy.js';
import { connectTestDb, type Sql } from './helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';
const FORCED = loadScopeConfig({ CC_FORCE_PROJECT_ID: '__personal__' });

describe('cc_task_stats MCP 工具', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testDb: any;
  const tp = `tstats-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    testDb = drizzle(postgres(TEST_DB_URL, { max: 1 }));
  });
  afterAll(async () => {
    if (sql) await sql.end();
  });
  afterEach(async () => {
    await sql`DELETE FROM tasks WHERE project_id IN (${tp}, '__personal__')`;
  });

  it('回 JSON：project_id + today/overdue/open 計數正確', async () => {
    await sql`INSERT INTO tasks (project_id, title, status, due_date) VALUES (${tp}, 'due today', 'open', now())`;
    await sql`INSERT INTO tasks (project_id, title, status, due_date) VALUES (${tp}, 'overdue', 'open', now() - interval '2 days')`;

    const res = await handleToolCall('cc_task_stats', { project_id: tp }, testDb);
    expect(res.isError).not.toBe(true);
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.project_id).toBe(tp);
    expect(json.today).toBe(1);
    expect(json.overdue).toBe(1);
    expect(json.open).toBe(2);
    expect(json.in_progress).toBe(0);
  });

  it('無 selector → fail-fast（project-mode）', async () => {
    const res = await handleToolCall('cc_task_stats', {}, testDb);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
  });

  it('forced-mode 無 selector → 統計 __personal__', async () => {
    await sql`INSERT INTO tasks (project_id, title, status) VALUES ('__personal__', 'p', 'open')`;
    const res = await handleToolCall('cc_task_stats', {}, testDb, FORCED);
    expect(res.isError).not.toBe(true);
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.project_id).toBe('__personal__');
    expect(json.open).toBe(1);
  });

  it('project-mode 顯式 __personal__ → 拒絕', async () => {
    const res = await handleToolCall('cc_task_stats', { project_id: '__personal__' }, testDb);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
  });
});
