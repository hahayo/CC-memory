// src/services/todoist.ts
//
// Todoist unified API v1 薄 client（Option E：cc-memory 自打 Todoist API，不靠第三方 MCP）。
//
// 設計重點（plan「API 基準」）：
//   1. 一律 unified API v1：base = https://api.todoist.com/api/v1。
//      不碰 deprecated /rest/v1（行為不同：close 在 v1 是 /tasks/{id}/close 回 2xx）。
//   2. fetch-all pagination：projects/tasks/completed 皆 cursor 分頁（>50 筆會漏）。
//      逐頁抓到 next_cursor=null 或達 FETCH_ALL_CAP；達 cap 仍有下一頁 → 回非 null next_cursor。
//   3. priority 語意映射：工具收 p1..p4，service 映射成 API 整數（見 PRIORITY_TO_API 註解）。
//   4. 完成判定以 completed endpoint + completed_at 為準（active list 本就只回 active）。
//   5. global fetch + AbortController timeout（Node 18+ 內建 fetch）。
//   6. 錯誤：429 → RateLimitError（帶 retry_after）；其餘非 2xx → TodoistApiError（映射既有碼）。

import {
  ForbiddenError,
  InvalidArgumentError,
  NotFoundError,
  RateLimitError,
  TodoistApiError,
} from './errors.js';
import type {
  AddTodoistTaskInput,
  ListCompletedTasksOptions,
  ListTodoistTasksOptions,
  TodoistPriority,
  TodoistProject,
  TodoistTask,
} from './types.js';

const BASE_URL = 'https://api.todoist.com/api/v1';
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Todoist 單頁上限為 200（GET /tasks limit 0..200）。 */
export const PAGE_LIMIT = 200;
/** fetch-all 安全上限：超過即停、回 next_cursor 讓 caller 知道還有更多。 */
export const FETCH_ALL_CAP = 1000;

const DAY_MS = 86_400_000;
/** completed endpoint 官方限制「最多 3 個月」；取 92 天作為保守上界。 */
const THREE_MONTHS_MS = 92 * DAY_MS;

/**
 * priority 語意 → Todoist API 整數。
 *
 * ASSUMPTION（方向待 e2e 最終驗證）：Todoist API priority 4 = urgent（UI 紅色 P1），
 * 1 = normal（UI 無標記 P4）。依據：官方 Python SDK 明示 `priority=4  # 1=normal, 4=very urgent`
 * + TS SDK。注意 v1 REST 文件散文曾寫「1 is highest」（與 SDK 相反、疑為 paraphrase 誤植），
 * 故方向以「建立 p1 任務 → 讀回 → 比對整數」的真帳號 e2e 為準（plan Verification #3）。
 * 若 e2e 推翻，只需翻轉此一處常數。
 */
const PRIORITY_TO_API: Record<TodoistPriority, number> = {
  p1: 4,
  p2: 3,
  p3: 2,
  p4: 1,
};

// ---------------------------------------------------------------------------
// 底層 HTTP（global fetch + AbortController timeout + 錯誤映射）
// ---------------------------------------------------------------------------

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  token: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

async function todoistRequest(spec: RequestSpec): Promise<unknown> {
  const url = new URL(BASE_URL + spec.path);
  if (spec.query) {
    for (const [k, v] of Object.entries(spec.query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: spec.method,
      headers: {
        Authorization: `Bearer ${spec.token}`,
        ...(spec.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
      throw new TodoistApiError('INTERNAL', `Todoist 請求逾時（>${timeoutMs}ms）`, { timeoutMs });
    }
    throw new TodoistApiError('INTERNAL', `Todoist 請求失敗：${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    await throwForStatus(res);
  }

  // close 等端點可能回空 body；其餘回 JSON。
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function throwForStatus(res: Response): Promise<never> {
  let parsed: Record<string, unknown> | null = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  const errorTag = parsed?.error_tag;
  const httpCode = parsed?.http_code ?? res.status;
  const message =
    (typeof parsed?.error === 'string' && parsed.error) ||
    (typeof parsed?.error_message === 'string' && parsed.error_message) ||
    res.statusText ||
    'Todoist API error';

  if (res.status === 429) {
    const extra = parsed?.error_extra as { retry_after?: number } | undefined;
    const hdr = res.headers.get('Retry-After');
    const retryAfter = extra?.retry_after ?? (hdr != null ? Number(hdr) : null);
    throw new RateLimitError('Todoist rate limit（請稍後重試）', {
      retry_after: retryAfter,
      error_tag: errorTag,
      http_code: httpCode,
    });
  }

  // 映射到既有 error 類別（instanceof 穩定 + errorResponse 取 .code）；
  // 無對應的（5xx / 未知）落到 TodoistApiError('INTERNAL') 並保留 details。
  const fullMessage = `Todoist API ${res.status}: ${message}`;
  const details = { error_tag: errorTag, http_code: httpCode };
  if (res.status === 400) throw new InvalidArgumentError(fullMessage, details);
  if (res.status === 401 || res.status === 403) throw new ForbiddenError(fullMessage, details);
  if (res.status === 404) throw new NotFoundError(fullMessage, details);
  throw new TodoistApiError('INTERNAL', fullMessage, details);
}

/**
 * cursor 分頁 fetch-all：逐頁累積到 next_cursor=null 或 FETCH_ALL_CAP。
 * by_completion_date 回 {results}；by_due_date 回 {items} → 兩者皆容（plan：results ?? items）。
 */
async function fetchAllPages(
  token: string,
  path: string,
  query: Record<string, string | undefined>
): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const all: unknown[] = [];
  let cursor: string | undefined;
  let nextCursor: string | null = null;

  while (all.length < FETCH_ALL_CAP) {
    const data = (await todoistRequest({
      method: 'GET',
      path,
      token,
      query: { ...query, cursor, limit: String(PAGE_LIMIT) },
    })) as { results?: unknown[]; items?: unknown[]; next_cursor?: string | null } | null;

    const batch = data?.results ?? data?.items ?? [];
    all.push(...batch);
    nextCursor = data?.next_cursor ?? null;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return { items: all, nextCursor };
}

// ---------------------------------------------------------------------------
// 正規化（snake_case raw → 結構化）
// ---------------------------------------------------------------------------

function normalizeTask(raw: unknown): TodoistTask {
  const r = (raw ?? {}) as Record<string, unknown>;
  const due = r.due as { date?: string; datetime?: string; string?: string } | null | undefined;
  const dueStr = due
    ? (due.datetime ?? due.date ?? due.string ?? null)
    : ((r.due_date as string) ?? null);
  return {
    id: String(r.id ?? ''),
    content: (r.content as string) ?? '',
    projectId: (r.project_id as string) ?? (r.projectId as string) ?? null,
    priority: typeof r.priority === 'number' ? r.priority : null,
    due: dueStr ?? null,
    completedAt: (r.completed_at as string) ?? (r.completedAt as string) ?? null,
    url: (r.url as string) ?? null,
  };
}

function normalizeProject(raw: unknown): TodoistProject {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { id: String(r.id ?? ''), name: (r.name as string) ?? '' };
}

// ---------------------------------------------------------------------------
// 公開 API（5 functions；token 由 caller 注入＝handler 傳 config.todoistApiToken）
// ---------------------------------------------------------------------------

export async function addTask(token: string, input: AddTodoistTaskInput): Promise<TodoistTask> {
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new InvalidArgumentError('content 不可為空');
  }
  const body: Record<string, unknown> = { content: input.content };
  if (input.projectId) body.project_id = input.projectId;
  if (input.due) body.due_string = input.due;
  // priority 防護（Codex P2）：MCP schema enum 非 runtime 保證。未知值不可靜默 drop
  // 成預設優先級 → fail-fast，避免使用者要 urgent 卻建成低優先。
  if (input.priority !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(PRIORITY_TO_API, input.priority)) {
      throw new InvalidArgumentError('priority 必須為 p1 | p2 | p3 | p4', {
        priority: input.priority,
      });
    }
    body.priority = PRIORITY_TO_API[input.priority];
  }

  const raw = await todoistRequest({ method: 'POST', path: '/tasks', token, body });
  return normalizeTask(raw);
}

export async function listProjects(
  token: string
): Promise<{ projects: TodoistProject[]; nextCursor: string | null }> {
  const { items, nextCursor } = await fetchAllPages(token, '/projects', {});
  return { projects: items.map(normalizeProject), nextCursor };
}

export async function listTasks(
  token: string,
  opts: ListTodoistTasksOptions = {}
): Promise<{ tasks: TodoistTask[]; nextCursor: string | null }> {
  const query: Record<string, string | undefined> = {};
  if (opts.projectId) query.project_id = opts.projectId;
  const { items, nextCursor } = await fetchAllPages(token, '/tasks', query);
  return { tasks: items.map(normalizeTask), nextCursor };
}

export async function completeTask(token: string, taskId: string): Promise<void> {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new InvalidArgumentError('task_id 不可為空');
  }
  // 任何 2xx 視為成功（body 可能為 null 或 {result:true}，文件分歧）。
  await todoistRequest({
    method: 'POST',
    path: `/tasks/${encodeURIComponent(taskId)}/close`,
    token,
  });
}

export async function listCompletedTasks(
  token: string,
  opts: ListCompletedTasksOptions = {}
): Promise<{ tasks: TodoistTask[]; nextCursor: string | null }> {
  const now = opts.now ?? new Date();
  const until = opts.until ?? now;
  const since = opts.since ?? new Date(now.getTime() - 7 * DAY_MS);

  if (since.getTime() > until.getTime()) {
    throw new InvalidArgumentError('completed: since 不可晚於 until', {
      since: since.toISOString(),
      until: until.toISOString(),
    });
  }
  if (until.getTime() - since.getTime() > THREE_MONTHS_MS) {
    throw new InvalidArgumentError('completed 查詢範圍最多 3 個月（請縮小 since/until 或分段）', {
      since: since.toISOString(),
      until: until.toISOString(),
    });
  }

  const query: Record<string, string | undefined> = {
    since: since.toISOString(),
    until: until.toISOString(),
  };
  if (opts.projectId) query.project_id = opts.projectId;

  const { items, nextCursor } = await fetchAllPages(
    token,
    '/tasks/completed/by_completion_date',
    query
  );
  return { tasks: items.map(normalizeTask), nextCursor };
}
