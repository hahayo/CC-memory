// tests/mcp-todoist.test.ts
//
// Todoist MCP 層：gating（雙條件 token ∧ forced）、ListTools 露出/隱藏 + 數量、
// write 分類（read-only 砍 add/complete）、handler 路徑（mock fetch；用可注入 opts）。
//
// 關鍵設計（plan「Scope / gating」）：
//   - Todoist 工具無 project selector（不走 resolveCwdAndProjectId）。
//   - 曝光 = todoistApiToken 已設 且 forced-mode（forcedProjectId !== null）。雙層 enforce。
//   - 可注入 buildToolsForMode(..., { todoistEnabled }) 與 handleToolCall(..., { todoistEnabled, todoistToken })。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleToolCall, buildToolsForMode, resolveTodoistEnabled } from '../src/index.js';
import type { ScopeConfig } from '../src/services/scope-policy.js';
import type { ToolPolicy } from '../src/services/tool-policy.js';

const OPEN: ToolPolicy = { readOnly: false, allowlist: null, searchFeedback: true };
const PROJECT_MODE: ScopeConfig = { forcedProjectId: null };
const FORCED: ScopeConfig = { forcedProjectId: '__personal__' };
// forced-mode 但鎖非個人 project（CC_FORCE_PROJECT_ID 可為任意 id）→ 不可曝露個人 Todoist。
const FORCED_NON_PERSONAL: ScopeConfig = { forcedProjectId: 'some-project' };

const TODOIST_NAMES = [
  'cc_todoist_add',
  'cc_todoist_projects',
  'cc_todoist_list',
  'cc_todoist_complete',
  'cc_todoist_completed',
];

function names(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name);
}
function errCode(res: Awaited<ReturnType<typeof handleToolCall>>): string | undefined {
  if (res.isError !== true) return undefined;
  return JSON.parse((res.content[0] as { text: string }).text).error.code as string;
}
function okJson(res: Awaited<ReturnType<typeof handleToolCall>>): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text);
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
// handler 走 todoist 路徑時不碰 DB；用 sentinel 確保「真的沒用到 db」。
const NO_DB = {} as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveTodoistEnabled (real derivation — 雙條件：token ∧ forced-personal)', () => {
  it('token + forced-personal → true', () => expect(resolveTodoistEnabled(FORCED, 'tok')).toBe(true));
  it('token + project-mode → false', () => expect(resolveTodoistEnabled(PROJECT_MODE, 'tok')).toBe(false));
  it('token + forced NON-personal → false（個人 Todoist 不漏進專案 forced 部署，Codex round-3 P2）', () =>
    expect(resolveTodoistEnabled(FORCED_NON_PERSONAL, 'tok')).toBe(false));
  it('no token + forced-personal → false', () => expect(resolveTodoistEnabled(FORCED, undefined)).toBe(false));
  it('blank token + forced-personal → false', () => expect(resolveTodoistEnabled(FORCED, '   ')).toBe(false));
  it('no token + project-mode → false', () =>
    expect(resolveTodoistEnabled(PROJECT_MODE, undefined)).toBe(false));
});

describe('ListTools gating + 數量（Verification #1）', () => {
  it('project-mode / no todoist：15 工具，無 cc_todoist_*', () => {
    const t = buildToolsForMode(PROJECT_MODE, OPEN, { todoistEnabled: false });
    expect(names(t).filter((n) => n.startsWith('cc_todoist_'))).toEqual([]);
    expect(t.length).toBe(15);
  });

  it('forced + todoist enabled：20 工具含 5 個 cc_todoist_*', () => {
    const t = buildToolsForMode(FORCED, OPEN, { todoistEnabled: true });
    for (const n of TODOIST_NAMES) expect(names(t)).toContain(n);
    expect(t.length).toBe(20);
  });

  it('default derivation (無 opts)：forced + 測試環境無 token → 0 個 todoist 工具', () => {
    // 涵蓋 production 實走的 `opts.todoistEnabled ?? resolveTodoistEnabled(config)` seam
    // （其餘 count 測試都注入 todoistEnabled，會繞過此 ?? 路徑）。
    const ns = names(buildToolsForMode(FORCED, OPEN));
    expect(ns.filter((n) => n.startsWith('cc_todoist_'))).toEqual([]);
    expect(ns.length).toBe(15);
  });

  it('forced + todoist + read-only：砍 add/complete，保留 projects/list/completed', () => {
    const ns = names(buildToolsForMode(FORCED, { ...OPEN, readOnly: true }, { todoistEnabled: true }));
    expect(ns).not.toContain('cc_todoist_add');
    expect(ns).not.toContain('cc_todoist_complete');
    expect(ns).toContain('cc_todoist_projects');
    expect(ns).toContain('cc_todoist_list');
    expect(ns).toContain('cc_todoist_completed');
  });
});

describe('handler gating（第二層 enforce）', () => {
  it('todoist 未啟用 → cc_todoist_projects 直呼 FORBIDDEN', async () => {
    const res = await handleToolCall('cc_todoist_projects', {}, NO_DB, FORCED, OPEN, {
      todoistEnabled: false,
    });
    expect(errCode(res)).toBe('FORBIDDEN');
  });

  it('forced NON-personal + token → cc_todoist_projects 直呼 FORBIDDEN（namespace 邊界）', async () => {
    const res = await handleToolCall('cc_todoist_projects', {}, NO_DB, FORCED_NON_PERSONAL, OPEN, {
      todoistToken: 'tok',
    });
    expect(errCode(res)).toBe('FORBIDDEN');
  });

  it('read-only + cc_todoist_add 直呼 → FORBIDDEN（write guard）', async () => {
    const res = await handleToolCall(
      'cc_todoist_add',
      { content: 'x' },
      NO_DB,
      FORCED,
      { ...OPEN, readOnly: true },
      { todoistEnabled: true, todoistToken: 'tok' }
    );
    expect(errCode(res)).toBe('FORBIDDEN');
  });
});

describe('handler success paths（mock fetch）', () => {
  it('cc_todoist_projects → 結構化 JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [{ id: 'P1', name: 'Work' }], next_cursor: null }))
    );
    const res = await handleToolCall('cc_todoist_projects', {}, NO_DB, FORCED, OPEN, {
      todoistEnabled: true,
      todoistToken: 'tok',
    });
    expect(res.isError).not.toBe(true);
    const out = okJson(res);
    expect(out.count).toBe(1);
    expect(out.projects).toEqual([{ id: 'P1', name: 'Work' }]);
  });

  it('cc_todoist_add 映射 priority p1→4 並回 task JSON', async () => {
    const fn = vi.fn(async () => jsonResponse({ id: 'T1', content: 'x', project_id: null, priority: 4 }));
    vi.stubGlobal('fetch', fn);
    const res = await handleToolCall(
      'cc_todoist_add',
      { content: 'x', priority: 'p1' },
      NO_DB,
      FORCED,
      OPEN,
      { todoistEnabled: true, todoistToken: 'tok' }
    );
    expect(res.isError).not.toBe(true);
    const sentBody = JSON.parse(String(fn.mock.calls[0][1].body));
    expect(sentBody.priority).toBe(4);
    expect(okJson(res).id).toBe('T1');
  });

  it('cc_todoist_add 用 project_name 單一匹配 → 解析成 id', async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(jsonResponse({ results: [{ id: 'P7', name: 'Work' }], next_cursor: null }));
    fn.mockResolvedValueOnce(jsonResponse({ id: 'T1', content: 'x', project_id: 'P7' }));
    vi.stubGlobal('fetch', fn);
    const res = await handleToolCall(
      'cc_todoist_add',
      { content: 'x', project_name: 'Work' },
      NO_DB,
      FORCED,
      OPEN,
      { todoistEnabled: true, todoistToken: 'tok' }
    );
    const addBody = JSON.parse(String(fn.mock.calls[1][1].body));
    expect(addBody.project_id).toBe('P7');
    expect(okJson(res).project_resolution).toBe('name');
  });

  it('cc_todoist_add 用 project_name 多重同名 → 不猜、入 Inbox', async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(
      jsonResponse({ results: [{ id: 'P1', name: 'Work' }, { id: 'P2', name: 'Work' }], next_cursor: null })
    );
    fn.mockResolvedValueOnce(jsonResponse({ id: 'T2', content: 'x', project_id: null }));
    vi.stubGlobal('fetch', fn);
    const res = await handleToolCall(
      'cc_todoist_add',
      { content: 'x', project_name: 'Work' },
      NO_DB,
      FORCED,
      OPEN,
      { todoistEnabled: true, todoistToken: 'tok' }
    );
    const addBody = JSON.parse(String(fn.mock.calls[1][1].body));
    expect(addBody.project_id).toBeUndefined();
    expect(okJson(res).project_resolution).toBe('inbox-ambiguous');
  });

  it('cc_todoist_complete → POST /tasks/{id}/close', async () => {
    const fn = vi.fn(async () => jsonResponse(null));
    vi.stubGlobal('fetch', fn);
    const res = await handleToolCall('cc_todoist_complete', { task_id: 'T9' }, NO_DB, FORCED, OPEN, {
      todoistEnabled: true,
      todoistToken: 'tok',
    });
    expect(res.isError).not.toBe(true);
    expect(String(fn.mock.calls[0][0])).toContain('/tasks/T9/close');
    expect(okJson(res).ok).toBe(true);
  });

  it('cc_todoist_completed 預設近 7 天 + 結構化 JSON', async () => {
    const fn = vi.fn(async () =>
      jsonResponse({ results: [{ id: 'C1', content: 'done', completed_at: '2026-06-07T10:00:00Z' }], next_cursor: null })
    );
    vi.stubGlobal('fetch', fn);
    const res = await handleToolCall('cc_todoist_completed', {}, NO_DB, FORCED, OPEN, {
      todoistEnabled: true,
      todoistToken: 'tok',
    });
    expect(res.isError).not.toBe(true);
    const out = okJson(res);
    expect(out.count).toBe(1);
    expect((out.tasks as { completed_at: string }[])[0].completed_at).toBe('2026-06-07T10:00:00Z');
  });

  it('cc_todoist_list 把 cursor 參數穿到 Todoist 請求（resume 大結果集）', async () => {
    const fn = vi.fn(async () => jsonResponse({ results: [], next_cursor: null }));
    vi.stubGlobal('fetch', fn);
    const res = await handleToolCall('cc_todoist_list', { cursor: 'page2' }, NO_DB, FORCED, OPEN, {
      todoistEnabled: true,
      todoistToken: 'tok',
    });
    expect(res.isError).not.toBe(true);
    expect(String(fn.mock.calls[0][0])).toContain('cursor=page2');
  });

  it('cc_todoist_completed 把 cursor 參數穿到 Todoist 請求', async () => {
    const fn = vi.fn(async () => jsonResponse({ results: [], next_cursor: null }));
    vi.stubGlobal('fetch', fn);
    const res = await handleToolCall(
      'cc_todoist_completed',
      { cursor: 'cpage2' },
      NO_DB,
      FORCED,
      OPEN,
      { todoistEnabled: true, todoistToken: 'tok' }
    );
    expect(res.isError).not.toBe(true);
    expect(String(fn.mock.calls[0][0])).toContain('cursor=cpage2');
  });

  it('429 rate limit 經 handler → RATE_LIMIT 錯誤', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'TOO_MANY', error_extra: { retry_after: 5 } }, 429))
    );
    const res = await handleToolCall('cc_todoist_list', {}, NO_DB, FORCED, OPEN, {
      todoistEnabled: true,
      todoistToken: 'tok',
    });
    expect(errCode(res)).toBe('RATE_LIMIT');
  });
});
