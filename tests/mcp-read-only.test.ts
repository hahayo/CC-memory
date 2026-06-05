// tests/mcp-read-only.test.ts
//
// Personal-Hub Phase 2b — read-only / allowlist 雙層 enforce + search telemetry 開關。
//   - ListTools 過濾（buildToolsForMode）：read-only 去寫入 tool；allowlist 只露集合內（含 read）
//   - central dispatch 守衛（handleToolCall）：assertAllowed（含 read）+ assertWritable（寫入）
//   - CC_SEARCH_FEEDBACK：off → search 不寫 telemetry

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { handleToolCall, buildToolsForMode } from '../src/index.js';
import type { ToolPolicy } from '../src/services/tool-policy.js';
import type { ScopeConfig } from '../src/services/scope-policy.js';
import { connectTestDb, type Sql } from './helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

const PROJECT_MODE: ScopeConfig = { forcedProjectId: null };
const OPEN: ToolPolicy = { readOnly: false, allowlist: null, searchFeedback: true };

const WRITE_TOOLS = [
  'cc_memory_save',
  'cc_memory_delete',
  'cc_task_create',
  'cc_task_update',
  'cc_task_set_reminder',
  'cc_task_snooze',
];

function names(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name);
}

function errCode(res: Awaited<ReturnType<typeof handleToolCall>>): string | undefined {
  if (res.isError !== true) return undefined;
  return JSON.parse((res.content[0] as { text: string }).text).error.code as string;
}

describe('Phase 2b read-only / allowlist enforce', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testDb: any;
  const tp = `ro-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    testDb = drizzle(postgres(TEST_DB_URL, { max: 2 }));
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM tasks WHERE project_id = ${tp}`;
    await sql`DELETE FROM project_memories WHERE project_id = ${tp}`;
    await sql`DELETE FROM search_feedback WHERE query_project_id = ${tp}`;
  });

  // ---------- ListTools 過濾 ----------

  it('read-only ListTools omits all write tools, keeps read tools', () => {
    const tools = buildToolsForMode(PROJECT_MODE, { ...OPEN, readOnly: true });
    const ns = names(tools);
    for (const w of WRITE_TOOLS) expect(ns).not.toContain(w);
    expect(ns).toContain('cc_memory_search');
    expect(ns).toContain('cc_task_list');
    expect(ns).toContain('cc_task_stats');
  });

  it('allowlist ListTools exposes only allowlisted tools (incl. read filtering)', () => {
    const allowlist = new Set(['cc_memory_search', 'cc_task_list']);
    const tools = buildToolsForMode(PROJECT_MODE, { ...OPEN, allowlist });
    expect(names(tools).sort()).toEqual(['cc_memory_search', 'cc_task_list']);
  });

  // ---------- central dispatch 守衛 ----------

  it('read-only direct call to write tool → FORBIDDEN (second layer)', async () => {
    const res = await handleToolCall(
      'cc_memory_save',
      { project_id: tp, type: 'session', summary: 'x' },
      testDb,
      PROJECT_MODE,
      { ...OPEN, readOnly: true }
    );
    expect(errCode(res)).toBe('FORBIDDEN');
  });

  it('read-only still allows read tools', async () => {
    const res = await handleToolCall(
      'cc_task_list',
      { project_id: tp },
      testDb,
      PROJECT_MODE,
      { ...OPEN, readOnly: true }
    );
    expect(res.isError).not.toBe(true);
  });

  it('allowlist excludes a read tool (cc_memory_get) → ListTools hides + direct call FORBIDDEN', async () => {
    const allowlist = new Set(['cc_memory_search', 'cc_task_list']);
    const policy = { ...OPEN, allowlist };
    // ListTools 不露
    expect(names(buildToolsForMode(PROJECT_MODE, policy))).not.toContain('cc_memory_get');
    // 直呼仍被 assertAllowed 擋（不只擋寫入）
    const res = await handleToolCall(
      'cc_memory_get',
      { id: randomUUID(), project_id: tp },
      testDb,
      PROJECT_MODE,
      policy
    );
    expect(errCode(res)).toBe('FORBIDDEN');
  });

  it('allowlisted tool passes the guard', async () => {
    const allowlist = new Set(['cc_memory_search', 'cc_task_list']);
    const res = await handleToolCall(
      'cc_task_list',
      { project_id: tp },
      testDb,
      PROJECT_MODE,
      { ...OPEN, allowlist }
    );
    expect(res.isError).not.toBe(true);
  });

  // ---------- search telemetry 開關 ----------

  it('CC_SEARCH_FEEDBACK off → search does not write search_feedback', async () => {
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${tp}, 'session', 'alpha beta')`;
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'alpha', project_id: tp, mode: 'keyword' },
      testDb,
      PROJECT_MODE,
      { ...OPEN, searchFeedback: false }
    );
    expect(res.isError).not.toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    const after = (
      await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id = ${tp}`
    )[0].c;
    expect(after).toBe(0);
  });

  it('search telemetry on (default) still writes one row', async () => {
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${tp}, 'session', 'alpha beta')`;
    await handleToolCall(
      'cc_memory_search',
      { query: 'alpha', project_id: tp, mode: 'keyword' },
      testDb,
      PROJECT_MODE,
      OPEN
    );
    await new Promise((r) => setTimeout(r, 150));
    const after = (
      await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM search_feedback WHERE query_project_id = ${tp}`
    )[0].c;
    expect(after).toBe(1);
  });
});
