// tests/services/todoist.test.ts
//
// Todoist unified API v1 薄 client 單元測試（mock global fetch + 真 Response）。
//
// 覆蓋（plan TDD step 2）：
//   1. request 組裝鎖死 base = https://api.todoist.com/api/v1（不得碰 deprecated /rest/v1）
//   2. priority 語意映射 p1..p4 → API 整數（4=urgent；e2e 最終驗向，見常數註解）
//   3. fetch-all pagination（>1 頁合併、cursor 傳遞、cap 後回 next_cursor）
//   4. completeTask：POST /tasks/{id}/close，任何 2xx 皆視為成功（body null 或 {result:true}）
//   5. completed：預設近 7 天視窗（注入 now）、>3 個月拒絕
//   6. 錯誤映射：401→FORBIDDEN、429→RATE_LIMIT(retry_after)、timeout→逾時、空頁→空陣列

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTask,
  listProjects,
  listTasks,
  completeTask,
  listCompletedTasks,
  DEFAULT_TIMEOUT_MS,
  FETCH_ALL_CAP,
  PAGE_LIMIT,
} from '../../src/services/todoist.js';
import { RateLimitError, ForbiddenError, InvalidArgumentError } from '../../src/services/errors.js';

const TOKEN = 'test-token-xyz';

/** 把一組依序回傳的 Response 排入 fetch mock；回傳 mock 以便斷言 call 細節。 */
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

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

function lastCall(fn: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const call = fn.mock.calls[fn.mock.calls.length - 1];
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('todoist client: request assembly (lock /api/v1)', () => {
  it('addTask POSTs to https://api.todoist.com/api/v1/tasks with Bearer auth', async () => {
    const fn = queueFetch([json(200, { id: '1', content: 'buy milk', project_id: null, priority: 1 })]);
    await addTask(TOKEN, { content: 'buy milk' });
    const { url, init } = lastCall(fn);
    expect(url).toBe('https://api.todoist.com/api/v1/tasks');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(url).not.toContain('/rest/');
  });

  it('addTask omits project_id when not given (→ Inbox)', async () => {
    const fn = queueFetch([json(200, { id: '1', content: 'x' })]);
    await addTask(TOKEN, { content: 'x' });
    const body = JSON.parse(String(lastCall(fn).init.body));
    expect(body.content).toBe('x');
    expect(body.project_id).toBeUndefined();
  });

  it('addTask sends project_id + due_string when given', async () => {
    const fn = queueFetch([json(200, { id: '1', content: 'x', project_id: 'P1' })]);
    await addTask(TOKEN, { content: 'x', projectId: 'P1', due: 'tomorrow' });
    const body = JSON.parse(String(lastCall(fn).init.body));
    expect(body.project_id).toBe('P1');
    expect(body.due_string).toBe('tomorrow');
  });

  it('completeTask POSTs to /tasks/{id}/close', async () => {
    const fn = queueFetch([json(200, null)]); // 200 null body
    await completeTask(TOKEN, 'task-42');
    const { url, init } = lastCall(fn);
    expect(url).toBe('https://api.todoist.com/api/v1/tasks/task-42/close');
    expect(init.method).toBe('POST');
  });

  it('completeTask treats {result:true} body as success too', async () => {
    queueFetch([json(200, { result: true })]);
    await expect(completeTask(TOKEN, 'task-99')).resolves.toBeUndefined();
  });
});

describe('todoist client: priority mapping (p1=urgent=API 4)', () => {
  it.each([
    ['p1', 4],
    ['p2', 3],
    ['p3', 2],
    ['p4', 1],
  ] as const)('maps %s → API integer %i', async (sem, apiInt) => {
    const fn = queueFetch([json(200, { id: '1', content: 'x' })]);
    await addTask(TOKEN, { content: 'x', priority: sem });
    const body = JSON.parse(String(lastCall(fn).init.body));
    expect(body.priority).toBe(apiInt);
  });

  it('rejects an unknown priority value instead of silently dropping it (Codex P2)', async () => {
    // 沒 mock fetch：合法路徑會打 fetch，但這裡應在打 API 前就 throw（不可靜默建低優先任務）。
    await expect(
      // @ts-expect-error 故意傳 schema 外的值（client 可能繞過 enum）
      addTask(TOKEN, { content: 'x', priority: 'urgent' })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('todoist client: normalization', () => {
  it('addTask normalizes snake_case response (project_id, due object)', async () => {
    queueFetch([
      json(200, {
        id: '123',
        content: 'buy milk',
        project_id: 'P9',
        priority: 4,
        due: { date: '2026-06-30', string: 'Jun 30' },
      }),
    ]);
    const task = await addTask(TOKEN, { content: 'buy milk' });
    expect(task).toMatchObject({
      id: '123',
      content: 'buy milk',
      projectId: 'P9',
      priority: 4,
      due: '2026-06-30',
    });
  });
});

describe('todoist client: pagination (fetch-all)', () => {
  it('listProjects merges multiple pages and passes cursor', async () => {
    const fn = queueFetch([
      json(200, { results: [{ id: 'a', name: 'Work' }], next_cursor: 'c1' }),
      json(200, { results: [{ id: 'b', name: 'Home' }], next_cursor: null }),
    ]);
    const { projects, nextCursor } = await listProjects(TOKEN);
    expect(projects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(nextCursor).toBeNull();
    // 第二次請求帶上 cursor=c1
    expect(fn).toHaveBeenCalledTimes(2);
    expect(lastCall(fn).url).toContain('cursor=c1');
  });

  it('listTasks scopes by project_id and returns null cursor when exhausted', async () => {
    const fn = queueFetch([json(200, { results: [{ id: 't1', content: 'a' }], next_cursor: null })]);
    const { tasks, nextCursor } = await listTasks(TOKEN, { projectId: 'P1' });
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
    expect(nextCursor).toBeNull();
    expect(lastCall(fn).url).toContain('project_id=P1');
  });

  it('stops at FETCH_ALL_CAP and returns the last next_cursor (signals more)', async () => {
    // 每頁回 PAGE_LIMIT 筆 + 永遠有 next_cursor → 應在 cap 處停、回非 null cursor
    const fullPage = (cur: string) =>
      json(200, {
        results: Array.from({ length: PAGE_LIMIT }, (_, k) => ({ id: `${cur}-${k}`, content: 'x' })),
        next_cursor: `next-${cur}`,
      });
    const fn = queueFetch(Array.from({ length: 20 }, (_, k) => fullPage(`p${k}`)));
    const { tasks, nextCursor } = await listTasks(TOKEN, {});
    expect(tasks.length).toBe(FETCH_ALL_CAP);
    expect(nextCursor).not.toBeNull();
    // 抓的頁數 = cap / page size，不多抓
    expect(fn).toHaveBeenCalledTimes(FETCH_ALL_CAP / PAGE_LIMIT);
  });

  it('empty page → empty array', async () => {
    queueFetch([json(200, { results: [], next_cursor: null })]);
    const { tasks } = await listTasks(TOKEN, {});
    expect(tasks).toEqual([]);
  });

  it('listTasks resumes from a caller-supplied cursor (first request carries it)', async () => {
    const fn = queueFetch([json(200, { results: [{ id: 't9', content: 'x' }], next_cursor: null })]);
    await listTasks(TOKEN, { cursor: 'resume-me' });
    expect(lastCall(fn).url).toContain('cursor=resume-me');
  });

  it('listProjects resumes from a caller-supplied cursor', async () => {
    const fn = queueFetch([json(200, { results: [{ id: 'p1', name: 'W' }], next_cursor: null })]);
    await listProjects(TOKEN, { cursor: 'pc' });
    expect(lastCall(fn).url).toContain('cursor=pc');
  });
});

describe('todoist client: completed window', () => {
  it('defaults to last 7 days (since/until from injected now)', async () => {
    const now = new Date('2026-06-08T00:00:00.000Z');
    const fn = queueFetch([json(200, { results: [], next_cursor: null })]);
    await listCompletedTasks(TOKEN, { now });
    const url = new URL(lastCall(fn).url);
    expect(url.pathname).toBe('/api/v1/tasks/completed/by_completion_date');
    expect(url.searchParams.get('until')).toBe('2026-06-08T00:00:00.000Z');
    expect(url.searchParams.get('since')).toBe('2026-06-01T00:00:00.000Z');
  });

  it('parses results (by_completion_date) and falls back to items', async () => {
    queueFetch([json(200, { items: [{ id: 'c1', content: 'done', completed_at: '2026-06-07T10:00:00Z' }], next_cursor: null })]);
    const { tasks } = await listCompletedTasks(TOKEN, { now: new Date('2026-06-08T00:00:00Z') });
    expect(tasks[0]).toMatchObject({ id: 'c1', completedAt: '2026-06-07T10:00:00Z' });
  });

  it('rejects a range wider than 3 months', async () => {
    const since = new Date('2026-01-01T00:00:00Z');
    const until = new Date('2026-06-01T00:00:00Z'); // ~5 months
    await expect(listCompletedTasks(TOKEN, { since, until })).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('todoist client: error mapping', () => {
  it('401 → ForbiddenError', async () => {
    queueFetch([json(401, { error: 'AUTH_INVALID_TOKEN', error_tag: 'AUTH_INVALID_TOKEN', http_code: 401 })]);
    await expect(listProjects(TOKEN)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('429 → RateLimitError carrying retry_after', async () => {
    queueFetch([
      json(429, { error: 'TOO_MANY_REQUESTS', error_extra: { retry_after: 42 } }, { 'Retry-After': '42' }),
    ]);
    await expect(addTask(TOKEN, { content: 'x' })).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      details: { retry_after: 42 },
    });
    expect(RateLimitError).toBeTruthy();
  });

  it('request timeout → throws (AbortController fires after DEFAULT_TIMEOUT_MS)', async () => {
    vi.useFakeTimers();
    // fetch 永不自然 resolve；只在 signal abort 時 reject（模擬真實逾時）
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      })
    );
    const p = listProjects(TOKEN);
    const assertion = expect(p).rejects.toThrowError(/逾時|timeout/i);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 10);
    await assertion;
    vi.useRealTimers();
  });
});
