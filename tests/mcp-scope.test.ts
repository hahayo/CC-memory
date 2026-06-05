// tests/mcp-scope.test.ts
//
// ScopePolicy 在 MCP handler 的整合行為（DB-backed）。
//
// forced-mode（CC_FORCE_PROJECT_ID=__personal__）：
//   - 無 selector 寫入 → 落在 __personal__（不 fail-fast）
//   - 傳別的 project_id → 拒絕（不允許跨 project）
//   - cc_memory_search 無 selector → 強制限定 __personal__（不可全專案）
// project-mode（未設）：
//   - 顯式 project_id=__personal__（任一工具）→ 拒絕（deny 保留 namespace）
//   - 全專案 search → 結果排除 __personal__（WHERE 層）

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { handleToolCall } from '../src/index.js';
import { loadScopeConfig } from '../src/services/scope-policy.js';
import { resolveProjectId } from '../src/services/projects.js';
import { connectTestDb, type Sql } from './helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

const FORCED = loadScopeConfig({ CC_FORCE_PROJECT_ID: '__personal__' });
const PROJECT = loadScopeConfig({}); // forcedProjectId null

function parsedError(res: Awaited<ReturnType<typeof handleToolCall>>) {
  return JSON.parse((res.content[0] as { text: string }).text).error;
}

describe('ScopePolicy MCP integration', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testDb: any;
  const tp = `scope-${randomUUID().slice(0, 8)}`;
  const KW = `zqkw${randomUUID().slice(0, 8)}`; // 唯一 keyword，避免撞其他測試資料

  beforeAll(async () => {
    sql = await connectTestDb();
    testDb = drizzle(postgres(TEST_DB_URL, { max: 1 }));
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM project_memories WHERE project_id IN (${tp}, '__personal__')`;
    await sql`DELETE FROM tasks WHERE project_id IN (${tp}, '__personal__')`;
    await sql`DELETE FROM search_feedback WHERE query_project_id IN (${tp}, '__personal__')`;
  });

  // ---------------- forced-mode ----------------

  it('forced-mode：cc_task_create 無 selector → 落在 __personal__', async () => {
    const res = await handleToolCall('cc_task_create', { title: 'personal todo' }, testDb, FORCED);
    expect(res.isError).not.toBe(true);
    const id = (res.content[0] as { text: string }).text.match(/ID: ([0-9a-f-]{36})/)![1];
    const [row] = await sql<{ project_id: string }[]>`
      SELECT project_id FROM tasks WHERE id = ${id}
    `;
    expect(row.project_id).toBe('__personal__');
  });

  it('forced-mode：cc_memory_save 無 selector → 落在 __personal__', async () => {
    const res = await handleToolCall(
      'cc_memory_save',
      { type: 'session', summary: 'personal note' },
      testDb,
      FORCED
    );
    expect(res.isError).not.toBe(true);
    const [row] = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM project_memories WHERE project_id = '__personal__'
    `;
    expect(row.c).toBe(1);
  });

  it('forced-mode：傳別的 project_id → 拒絕（INVALID_ARGUMENT）', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { title: 'x', project_id: 'AI_Copilot' },
      testDb,
      FORCED
    );
    expect(res.isError).toBe(true);
    expect(parsedError(res).code).toBe('INVALID_ARGUMENT');
  });

  it('forced-mode：cc_memory_search 無 selector → 只回 __personal__（不全專案）', async () => {
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES ('__personal__', 'session', ${'mine ' + KW})`;
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${tp}, 'session', ${'theirs ' + KW})`;
    const res = await handleToolCall(
      'cc_memory_search',
      { query: KW, mode: 'keyword' },
      testDb,
      FORCED
    );
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('mine');
    expect(text).not.toContain('theirs');
  });

  // ---------------- project-mode deny ----------------

  it('project-mode：cc_memory_save project_id=__personal__ → 拒絕', async () => {
    const res = await handleToolCall(
      'cc_memory_save',
      { project_id: '__personal__', type: 'session', summary: 's' },
      testDb,
      PROJECT
    );
    expect(res.isError).toBe(true);
    expect(parsedError(res).code).toBe('INVALID_ARGUMENT');
  });

  it('project-mode：cc_task_create project_id=__personal__ → 拒絕', async () => {
    const res = await handleToolCall(
      'cc_task_create',
      { project_id: '__personal__', title: 't' },
      testDb,
      PROJECT
    );
    expect(res.isError).toBe(true);
    expect(parsedError(res).code).toBe('INVALID_ARGUMENT');
  });

  it('project-mode：cc_memory_search project_id=__personal__ → 拒絕', async () => {
    const res = await handleToolCall(
      'cc_memory_search',
      { query: 'q', project_id: '__personal__' },
      testDb,
      PROJECT
    );
    expect(res.isError).toBe(true);
    expect(parsedError(res).code).toBe('INVALID_ARGUMENT');
  });

  it('project-mode：全專案 search 結果排除 __personal__', async () => {
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES ('__personal__', 'session', ${'secret ' + KW})`;
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${tp}, 'session', ${'public ' + KW})`;
    const res = await handleToolCall(
      'cc_memory_search',
      { query: KW, mode: 'keyword' },
      testDb,
      PROJECT
    );
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('public');
    expect(text).not.toContain('secret');
  });

  // ---------------- codex review P2：blank-resolving selector 不得漏排 __personal__ ----------------

  // precondition：證明 project_path:'/' 確實 basename-fallback 解析成 ''（blank）。
  // 若此前提不成立，下面的 leak regression 測試會變 vacuous（沒走到漏洞路徑）。
  it('precondition：project_path 解析空字串路徑（/）→ blank projectId（漏洞前提真實可達）', () => {
    expect(resolveProjectId({ cwd: '/', cwdIsExplicit: true })).toBe('');
  });

  it('project-mode：cc_memory_search project_path=/（解析成 blank）→ 仍排除 __personal__（codex P2）', async () => {
    // 修正前：blank id '' 經 applyScopePolicy 回 ''，searchMemories 的
    // excludeReserved=(''===undefined)=false → 不排除保留 namespace；但 keyword helper
    // 的 if(projectId) 又跳過 project 過濾 → 變「全專案且含 __personal__」的洩漏。
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES ('__personal__', 'session', ${'secret ' + KW})`;
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${tp}, 'session', ${'public ' + KW})`;
    const res = await handleToolCall(
      'cc_memory_search',
      { query: KW, project_path: '/', mode: 'keyword' },
      testDb,
      PROJECT
    );
    expect(res.isError).not.toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('public'); // 搜尋確實有跑並回傳非保留 project（非 vacuous）
    expect(text).not.toContain('secret'); // __personal__ 不得外洩
  });
});
