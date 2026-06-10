// tests/services/todoist-sync.test.ts
//
// A3d — Todoist → cc-memory 單向 sync（mock fetch + 真 test DB）。
//
// 覆蓋（plan Task 2 Step 1 + Task 3）：
//   1. 首次 full sync（token='*'）upsert 3 筆（project_id='__personal__', source='todoist'）
//   2. 重跑同批 items 冪等（ON CONFLICT (todoist_id) 不長重複列）
//   3. checked=true → status='done' + completed_at 非 null
//   4. is_deleted=true → status='cancelled'（軟刪）
//   5. priority 4/3/2/1 → high/normal/normal/low
//   6. content >500 字 → title 截 500（title length CHECK）
//   7. sync_token 寫回 sync_state；下次呼叫帶上次 token
//   8. API 401 / 429 / 5xx → throw（不吞錯），sync_token 不前進
//   9. due.date → due_date；無 due → NULL
//  10. loop prevention：只打 /sync 一個 endpoint，無任何 Todoist 寫入端點

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectTestDb, type Sql } from '../helpers/db.js';
import { pullAndApply } from '../../src/services/todoist-sync.js';
import { ForbiddenError, RateLimitError, TodoistApiError } from '../../src/services/errors.js';

const TOKEN = 'test-todoist-token';

interface MockItem {
  id: string;
  content: string;
  description: string;
  priority: number;
  due: { date: string } | null;
  checked: boolean;
  is_deleted: boolean;
  completed_at: string | null;
}

function item(over: Partial<MockItem> = {}): MockItem {
  return {
    id: `td-${Math.random().toString(36).slice(2, 10)}`,
    content: 'Test task',
    description: '',
    priority: 1,
    due: null,
    checked: false,
    is_deleted: false,
    completed_at: null,
    ...over,
  };
}

function syncResponse(items: MockItem[], syncToken = 'tok-next', fullSync = true): Response {
  return new Response(JSON.stringify({ items, full_sync: fullSync, sync_token: syncToken }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function queueFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('services/todoist-sync', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = await connectTestDb();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM reminder_delivery_queue`;
    await sql`DELETE FROM reminder_log`;
    await sql`DELETE FROM tasks WHERE source = 'todoist'`;
    await sql`DELETE FROM sync_state`;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function rows(): Promise<
    { todoist_id: string; title: string; description: string | null; status: string; priority: string;
      due_date: Date | null; completed_at: Date | null; project_id: string; source: string }[]
  > {
    return sql`
      SELECT todoist_id, title, description, status, priority, due_date, completed_at, project_id, source
      FROM tasks WHERE source = 'todoist' ORDER BY todoist_id`;
  }

  // =========================================================================
  // 基本 upsert
  // =========================================================================

  it('首次 full sync：token=* 打 /sync，3 筆 upsert（__personal__ / source=todoist）', async () => {
    const fn = queueFetch([
      syncResponse([
        item({ id: 'td-a', content: 'A' }),
        item({ id: 'td-b', content: 'B' }),
        item({ id: 'td-c', content: 'C' }),
      ]),
    ]);

    const result = await pullAndApply(sql, TOKEN);

    expect(result.upserted).toBe(3);
    expect(result.newSyncToken).toBe('tok-next');

    // request 斷言：唯一一次 call、/sync、sync_token=*、resource_types=["items"]
    expect(fn).toHaveBeenCalledTimes(1);
    const url = String(fn.mock.calls[0][0]);
    expect(url).toBe('https://api.todoist.com/api/v1/sync');
    const init = fn.mock.calls[0][1] as RequestInit;
    const body = String(init.body);
    expect(body).toContain('sync_token=*');
    expect(body).toContain(encodeURIComponent('["items"]'));

    const r = await rows();
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.title)).toEqual(['A', 'B', 'C']);
    for (const row of r) {
      expect(row.project_id).toBe('__personal__');
      expect(row.source).toBe('todoist');
      expect(row.status).toBe('open');
    }
  });

  it('冪等：同批 items 重跑兩次 → 仍 3 列，內容更新不重複', async () => {
    const items = [
      item({ id: 'td-a', content: 'A' }),
      item({ id: 'td-b', content: 'B' }),
      item({ id: 'td-c', content: 'C' }),
    ];
    queueFetch([syncResponse(items, 'tok-1'), syncResponse(
      items.map((x) => ({ ...x, content: x.content + ' v2' })), 'tok-2')]);

    await pullAndApply(sql, TOKEN);
    await pullAndApply(sql, TOKEN);

    const r = await rows();
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.title)).toEqual(['A v2', 'B v2', 'C v2']);
  });

  // =========================================================================
  // 欄位對應
  // =========================================================================

  it('checked=true → status=done + completed_at 非 null', async () => {
    queueFetch([syncResponse([item({ id: 'td-done', checked: true })])]);

    const result = await pullAndApply(sql, TOKEN);

    expect(result.completed).toBe(1);
    const r = await rows();
    expect(r[0].status).toBe('done');
    expect(r[0].completed_at).not.toBeNull();
  });

  it('is_deleted=true → status=cancelled（軟刪，不真刪）', async () => {
    queueFetch([syncResponse([item({ id: 'td-del', is_deleted: true })])]);

    const result = await pullAndApply(sql, TOKEN);

    expect(result.archived).toBe(1);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe('cancelled');
  });

  it('priority 4/3/2/1 → high/normal/normal/low', async () => {
    queueFetch([
      syncResponse([
        item({ id: 'td-p4', priority: 4 }),
        item({ id: 'td-p3', priority: 3 }),
        item({ id: 'td-p2', priority: 2 }),
        item({ id: 'td-p1', priority: 1 }),
      ]),
    ]);

    await pullAndApply(sql, TOKEN);

    const r = await rows();
    const byId = Object.fromEntries(r.map((x) => [x.todoist_id, x.priority]));
    expect(byId['td-p4']).toBe('high');
    expect(byId['td-p3']).toBe('normal');
    expect(byId['td-p2']).toBe('normal');
    expect(byId['td-p1']).toBe('low');
  });

  it('content >500 字 → title 截 500', async () => {
    queueFetch([syncResponse([item({ id: 'td-long', content: 'x'.repeat(600) })])]);

    await pullAndApply(sql, TOKEN);

    const r = await rows();
    expect(r[0].title).toHaveLength(500);
  });

  it('due.date → due_date；無 due → NULL', async () => {
    queueFetch([
      syncResponse([
        item({ id: 'td-due', due: { date: '2026-06-15' } }),
        item({ id: 'td-nodue', due: null }),
      ]),
    ]);

    await pullAndApply(sql, TOKEN);

    const r = await rows();
    const byId = Object.fromEntries(r.map((x) => [x.todoist_id, x.due_date]));
    expect(byId['td-due']).not.toBeNull();
    expect(byId['td-nodue']).toBeNull();
  });

  // =========================================================================
  // sync_token 生命週期
  // =========================================================================

  it('sync_token 寫回 sync_state；下次呼叫帶上次 token', async () => {
    const fn = queueFetch([syncResponse([item()], 'tok-round1'), syncResponse([], 'tok-round2')]);

    await pullAndApply(sql, TOKEN);
    const st1 = await sql`SELECT sync_token FROM sync_state WHERE resource = 'todoist'`;
    expect(st1[0].sync_token).toBe('tok-round1');

    await pullAndApply(sql, TOKEN);
    const body2 = String((fn.mock.calls[1][1] as RequestInit).body);
    expect(body2).toContain(`sync_token=${encodeURIComponent('tok-round1')}`);
    const st2 = await sql`SELECT sync_token FROM sync_state WHERE resource = 'todoist'`;
    expect(st2[0].sync_token).toBe('tok-round2');
  });

  // =========================================================================
  // 錯誤：throw 不吞錯，token 不前進
  // =========================================================================

  it.each([
    [401, ForbiddenError],
    [429, RateLimitError],
    [500, TodoistApiError],
  ])('API %i → throw，sync_state 不前進', async (status, errClass) => {
    queueFetch([
      new Response(JSON.stringify({ error: 'boom' }), {
        status,
        headers: { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '30' } : {}) },
      }),
    ]);

    await expect(pullAndApply(sql, TOKEN)).rejects.toThrow(errClass);

    const st = await sql`SELECT sync_token FROM sync_state WHERE resource = 'todoist'`;
    expect(st).toHaveLength(0); // 從未成功過 → 無 row（token 不前進）
    expect(await rows()).toHaveLength(0); // 也無半套用的列
  });

  // =========================================================================
  // loop prevention（Task 3）
  // =========================================================================

  it('loop prevention：整個 sync 只打 /sync 一個 endpoint，無任何 Todoist 寫入端點', async () => {
    const fn = queueFetch([
      syncResponse([
        item({ id: 'td-a' }),
        item({ id: 'td-b', checked: true }),
        item({ id: 'td-c', is_deleted: true }),
      ]),
    ]);

    await pullAndApply(sql, TOKEN);

    // 唯一的 HTTP call 是 /sync——upsert 不觸發 /tasks、/tasks/{id}/close 等寫入端點
    expect(fn).toHaveBeenCalledTimes(1);
    for (const call of fn.mock.calls) {
      expect(String(call[0])).toBe('https://api.todoist.com/api/v1/sync');
    }
  });
});
