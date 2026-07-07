#!/usr/bin/env node

/**
 * CC-memory MCP Server（v0.3 Phase A）
 *
 * Phase 2c：改 call `services/*`，不再直接摸 drizzle client 細節。
 * Phase 5-A：`cc_memory_search` 被動 fire-and-forget `recordSearchQuery`。
 *
 * 錯誤回傳統一 JSON：`{ error: { code, message, details? } }`，client 可 parse。
 * 成功回傳仍沿用現有文字格式，但在 list / get / task 類 response 中顯示 writer_host，
 * 讓跨電腦稽核從 API 層就看得到（不用直接查 DB）。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { db } from './db/client.js';
// alias 避免遮蔽 handleToolCall / buildToolsForMode 的 `config: ScopeConfig` 參數
// （否則 config.todoistApiToken 取到 ScopeConfig 上不存在的欄位 → Todoist 永遠不啟用）。
import { config as appConfig } from './config.js';
import type { Memory, Observation, Task } from './db/schema.js';

import {
  saveMemory,
  searchMemoryIndexes,
  listMemories,
  getMemory,
  deleteMemory,
  getProjectStats,
} from './services/memories.js';
import { timeline, getObservations } from './services/observations.js';
import { createTask, listTasks, updateTask, getTaskStats } from './services/tasks.js';
import { setReminder, snoozeReminder, getDueReminders } from './services/reminders.js';
import * as todoist from './services/todoist.js';
import { recordSearchQuery } from './services/feedback.js';
import { resolveProjectId } from './services/projects.js';
import {
  loadScopeConfig,
  applyScopePolicy,
  PERSONAL_PROJECT_ID,
  type ScopeConfig,
} from './services/scope-policy.js';
import {
  loadToolPolicy,
  isWriteTool,
  assertWritable,
  assertAllowed,
  type ToolPolicy,
} from './services/tool-policy.js';
import {
  BaseServiceError,
  NotFoundError,
  InvalidArgumentError,
  ForbiddenError,
} from './services/errors.js';
import type { McpError, TaskStatus, TodoistPriority, TodoistTask } from './services/types.js';
import type { MemoryIndexResult } from './services/types.js';

// ---------------------------------------------------------------------------
// 輔助：cwd / projectId 解析（所有 tool 用同一組 dispatch）
// ---------------------------------------------------------------------------

// 啟動期載入 scope config（讀 CC_FORCE_PROJECT_ID / config drift 防護）。
// import 時讀 process.env：跑 server 時反映啟動 env；測試以 handleToolCall 第 4 參數注入。
const defaultScopeConfig: ScopeConfig = loadScopeConfig();

function resolveCwdAndProjectId(
  args: Record<string, unknown> | undefined,
  config: ScopeConfig = defaultScopeConfig
): {
  cwd: string;
  projectId: string;
} {
  const rawPath = args?.project_path;
  const rawId = args?.project_id;
  // trim 後才視為有效，避免 "   " 這種 whitespace-only 值繞過 fail-fast
  // 再走 resolveProjectId 裡的 nonEmpty() 檢查 → fallback 到 env/marker/git/basename
  // 造成跨 project misroute（codex review round 12 P1）
  const hasPath = typeof rawPath === 'string' && rawPath.trim().length > 0;
  const hasId = typeof rawId === 'string' && rawId.trim().length > 0;

  // 無 selector：交給 ScopePolicy 決定（single source of truth）。
  //   - forced-mode（CC_FORCE_PROJECT_ID）→ 強制套用 forcedProjectId，不 fail-fast。
  //   - project-mode → fail-fast（不 fallback server cwd；訊息含 project_id 或 project_path）。
  // `cc_memory_search` 走自己的分支（surface='search'），允許 undefined = 全專案。
  if (!hasPath && !hasId) {
    const projectId = applyScopePolicy(undefined, { config, surface: 'scope' }) as string;
    return { cwd: process.cwd(), projectId };
  }

  // project_path 驗證 — 僅在「path 會被用來解析 projectId」時執行
  // （有 explicit project_id 時跳過，path 只是附帶資訊）。
  if (hasPath && !hasId) {
    validateProjectPathForResolution(rawPath as string);
  }

  const cwd = hasPath ? (rawPath as string) : process.cwd();
  const explicit = hasId ? (rawId as string).trim() : null;
  // cwdIsExplicit：caller 送 project_path → 跳過 env layer，讓 path 本身 derive
  // project（codex review round 20 P1：env 是 server 不知道自己在哪的 fallback，
  // 不該覆蓋 caller 明示送進來的 path）
  const resolved = resolveProjectId({ explicit, cwd, cwdIsExplicit: hasPath });
  // ScopePolicy：forced-mode 拒絕跨 project；project-mode deny 保留 namespace
  // （涵蓋 project_path / marker / git / basename 解析出 __personal__ 的所有入口）。
  const projectId = applyScopePolicy(resolved, { config, surface: 'scope' }) as string;
  return { cwd, projectId };
}

// ---------------------------------------------------------------------------
// 輔助：錯誤 JSON response（取代 `錯誤: ${msg}` 字串拼接）
// ---------------------------------------------------------------------------

/**
 * 解析 due_date 輸入：null → null（清空）；undefined → undefined（不動）；
 * 字串必須為 ISO 8601 格式且日期合法；否則 → throw InvalidArgumentError。
 *
 * 嚴格驗證（codex review round 4 / 10 累積）：
 *   - Regex 鎖住 ISO 8601 形狀（拒 "2026-04-22 10:00"、"March 1, 2026" 等非 ISO）
 *   - Date-only 輸入額外驗 Y/M/D roundtrip（拒 "2026-02-31" 這種 rollover
 *     到 Mar 3 的無效日期；JS Date 會隱式接受造成 task 截止日漂移）
 *   - 帶 Time 或 TZ 的 ISO 輸入已由 regex 保證形狀，靠 new Date() NaN 檢查剩餘
 */
// 當有 T (timed) 部分時，TZ (Z 或 ±HH:MM) 強制必填（codex review round 11 P2）。
// 沒 TZ 的 "2026-04-22T10:00" 會被 new Date() 用 server local TZ 解析 →
// 不同時區的 server 存到不同 instant，跨機器排序 / 顯示會漂移。
const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function parseDueDate(raw: unknown, fieldName = 'due_date'): Date | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new InvalidArgumentError(`${fieldName} 必須是 ISO 8601 字串或 null`, { [fieldName]: raw });
  }
  // 空字串 / whitespace-only → 拒，不靜默 drop（codex review round 13 P2）。
  // 契約：null = 清空；undefined / 省略 = 不動；ISO 字串 = 設值；空字串 = bad input。
  if (raw.trim().length === 0) {
    throw new InvalidArgumentError(
      `${fieldName} 若提供須為 ISO 8601 字串；若要清空請傳 null`,
      { [fieldName]: raw }
    );
  }
  if (!ISO_8601_REGEX.test(raw)) {
    throw new InvalidArgumentError(
      `${fieldName} 不是有效的 ISO 8601 字串: ${raw}`,
      { [fieldName]: raw, hint: 'YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:MM]' }
    );
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new InvalidArgumentError(`${fieldName} 不是有效日期: ${raw}`, { [fieldName]: raw });
  }
  // 日曆日合法性：驗證寫出的 YYYY-MM-DD（不論 date-only 或帶時間/時區）是真實日期。
  // 防 "2026-02-31" 與 "2026-02-31T10:00:00Z" 被 new Date() 靜默 rollover 成 3/3
  // （對 reminder 是「響在錯的時點」的真實缺陷）。calendar date 一律是字面前 10 字，
  // 用 UTC probe 驗其合法性，與時區偏移無關（偏移只影響 instant，不改寫出的日曆日）。
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const [, ys, ms, ds] = ymd;
    const y = Number(ys);
    const m = Number(ms);
    const dd = Number(ds);
    const probe = new Date(Date.UTC(y, m - 1, dd));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== dd) {
      throw new InvalidArgumentError(`${fieldName} 包含無效日期（如 2026-02-31）: ${raw}`, {
        [fieldName]: raw,
      });
    }
  }
  return d;
}

/**
 * 解析必填 timestamp（reminder 的 remind_at / snooze_until）：
 * 沿用 parseDueDate 的 ISO 8601 嚴格驗證；null / undefined / 缺值 → INVALID_ARGUMENT。
 */
function parseRequiredTimestamp(raw: unknown, field: string): Date {
  const parsed = parseDueDate(raw, field);
  if (parsed === null || parsed === undefined) {
    throw new InvalidArgumentError(`${field} 為必填 ISO 8601 timestamp`, { [field]: raw });
  }
  return parsed;
}

/**
 * 驗證 project_path 可用於解析 projectId：
 *   - 必須是絕對路徑（避免 fallback 到 MCP server 的 cwd）
 *   - 必須是存在的目錄（避免 typo 走 basename fallback 到虛構 project）
 * 不符 → throw InvalidArgumentError。
 */
function validateProjectPathForResolution(path: string): void {
  if (!isAbsolute(path)) {
    throw new InvalidArgumentError(
      'project_path 必須為絕對路徑（相對路徑會落到 MCP server 的 cwd 解析）',
      { project_path: path }
    );
  }
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      throw new InvalidArgumentError('project_path 不是目錄', { project_path: path });
    }
  } catch (err) {
    if (err instanceof InvalidArgumentError) throw err;
    throw new InvalidArgumentError(
      'project_path 不存在或無法讀取',
      { project_path: path, cause: String(err) }
    );
  }
}

function errorResponse(err: unknown): CallToolResult {
  let mcpError: McpError;
  if (err instanceof BaseServiceError) {
    mcpError = {
      code: err.code as McpError['code'],
      message: err.message,
      details: err.details,
    };
  } else if (err instanceof Error) {
    mcpError = { code: 'INTERNAL', message: err.message };
  } else {
    mcpError = { code: 'INTERNAL', message: String(err) };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: mcpError }) }],
    isError: true,
  };
}

/** 結構化 JSON 成功回傳（Todoist 工具用；對齊 cc_task_stats / cc_reminders_due）。 */
function jsonResult(obj: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

/** TodoistTask → wire JSON（snake_case 對外，含 completed_at 供完成追蹤）。 */
function todoistTaskJson(t: TodoistTask): Record<string, unknown> {
  return {
    id: t.id,
    content: t.content,
    project_id: t.projectId,
    priority: t.priority,
    due: t.due,
    completed_at: t.completedAt,
    url: t.url,
  };
}

// ---------------------------------------------------------------------------
// 輔助：文字格式化 — list/get 類 response 要看得到 writer_host
// ---------------------------------------------------------------------------

function formatMemory(memory: Memory, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const date = memory.createdAt
    ? new Date(memory.createdAt).toLocaleDateString('zh-TW')
    : 'N/A';
  const type = memory.type === 'decision' ? '🎯' : '📝';
  const hostStamp = memory.writerHost ? ` ✍️${memory.writerHost}` : '';

  let result = `${prefix}${type} [${date}${hostStamp}] ${memory.summary}`;

  if (memory.keywords && memory.keywords.length > 0) {
    result += `\n   關鍵字: ${memory.keywords.join(', ')}`;
  }
  if (memory.decisions && memory.decisions.length > 0) {
    result += `\n   決策: ${memory.decisions.join('; ')}`;
  }
  if (memory.nextSteps && memory.nextSteps.length > 0) {
    result += `\n   下一步: ${memory.nextSteps.join('; ')}`;
  }
  return result;
}

function formatIndexDate(d: Date): string {
  return new Date(d).toISOString();
}

function formatMemoryIndexResult(result: MemoryIndexResult, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const lines = [
    `${prefix}[${result.kind}/${result.type}] ${result.title}`,
    `   id: ${result.id}`,
    `   project: ${result.projectId}`,
    `   occurred_at: ${formatIndexDate(result.occurredAt)}`,
  ];
  if (result.subtitle) lines.push(`   subtitle: ${result.subtitle}`);
  if (result.sessionId) lines.push(`   session: ${result.sessionId}`);
  if (result.discoveryTokens !== null) {
    lines.push(`   discovery_tokens: ${result.discoveryTokens}`);
  }
  return lines.join('\n');
}

function observationIndexJson(observation: Observation): Record<string, unknown> {
  return {
    id: observation.id,
    project_id: observation.projectId,
    kind: 'observation',
    type: observation.type,
    title: observation.title,
    subtitle: observation.subtitle,
    session_id: observation.sessionId,
    rollup_memory_id: observation.rollupMemoryId,
    discovery_tokens: observation.discoveryTokens,
    observed_at: observation.observedAt.toISOString(),
  };
}

function observationFullJson(observation: Observation): Record<string, unknown> {
  return {
    ...observationIndexJson(observation),
    facts: observation.facts,
    concepts: observation.concepts,
    files: observation.files,
    narrative: observation.narrative,
    source_hook: observation.sourceHook,
    metadata: observation.metadata,
  };
}

/**
 * 格式化 dueDate 為可讀字串：
 *   - UTC 午夜（date-only 語意，例如 YYYY-MM-DD 被 new Date 存為 00:00Z）→ 只顯示 YYYY-MM-DD
 *   - 否則 → 完整 ISO（含 time + Z），保證跨時區 server 顯示一致
 * 避免 toLocaleDateString 在非 UTC server 上把 date-only 顯示成前一天
 * （codex review round 12 P2）。
 */
function formatDueDate(d: Date): string {
  const iso = d.toISOString();
  if (iso.endsWith('T00:00:00.000Z')) {
    return iso.slice(0, 10);
  }
  return iso;
}

function formatTask(task: Task, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const statusEmoji: Record<string, string> =
    { open: '⭕', in_progress: '🔵', done: '✅', cancelled: '❌' };
  const emoji = statusEmoji[task.status] ?? '•';
  const hostStamp = task.writerHost ? ` ✍️${task.writerHost}` : '';
  const shortId = task.id.slice(0, 8);
  const prio = task.priority !== 'normal' ? `[${task.priority}]` : '';
  const due = task.dueDate ? ` (due ${formatDueDate(new Date(task.dueDate))})` : '';
  return `${prefix}${emoji} ${prio}${hostStamp} ${task.title}${due} (#${shortId})`;
}

// ---------------------------------------------------------------------------
// Tool 定義
// ---------------------------------------------------------------------------

const projectPathProp = {
  type: 'string',
  description:
    '客戶端絕對路徑（用於解析 project_id；MCP server 的 process.cwd() 是 server 啟動目錄，非 client cwd）',
};

export const BASE_TOOLS: Tool[] = [
  {
    name: 'cc_memory_save',
    description: '儲存專案記憶到資料庫。包含摘要、關鍵字、決策和下一步。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        project_id: {
          type: 'string',
          description: '專案 ID（與 project_path 擇一必填，優先序最高）',
        },
        project_path: projectPathProp,
        type: {
          type: 'string',
          enum: ['session', 'decision'],
          description: '記憶類型：session（一般對話）或 decision（重要決策）',
        },
        summary: { type: 'string', description: '記憶摘要（3-5 句話）' },
        keywords: { type: 'array', items: { type: 'string' }, description: '關鍵字列表' },
        decisions: { type: 'array', items: { type: 'string' }, description: '重要決策列表' },
        next_steps: {
          type: 'array',
          items: { type: 'string' },
          description: '下一步待辦列表',
        },
        idempotency_key: {
          type: 'string',
          description:
            'Client 冪等鍵（可選）。同 key + 同 payload 回既有 id；同 key + 不同 payload 回 IDEMPOTENCY_CONFLICT。',
        },
      },
      required: ['type', 'summary'],
    },
  },
  {
    name: 'cc_memory_search',
    description: '搜尋相關的專案記憶。支援關鍵字、語義、混合三種搜尋。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜尋查詢' },
        project_id: { type: 'string', description: '限定專案（可選）' },
        project_path: projectPathProp,
        type: {
          type: 'string',
          enum: ['session', 'decision'],
          description: '限定記憶類型（可選）',
        },
        mode: {
          type: 'string',
          enum: ['keyword', 'semantic', 'hybrid'],
          description: '搜尋模式（預設 hybrid；embedding 未啟用時自動降級 keyword）',
        },
        limit: { type: 'number', description: '結果數量限制（預設 10）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cc_memory_timeline',
    description:
      '依 observation 或 capture rollup ID 取得同一專案、同一 session 的前後文索引。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        anchor_id: { type: 'string', description: 'observation ID 或 capture rollup memory ID' },
        depth_before: { type: 'number', description: 'anchor 前方 observation 數量（預設 3）' },
        depth_after: { type: 'number', description: 'anchor 後方 observation 數量（預設 3）' },
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
      },
      required: ['anchor_id'],
    },
  },
  {
    name: 'cc_memory_get_observations',
    description:
      '批次取得 observation 全文（含 narrative/facts/concepts/files）。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Observation ID 陣列（一次最多 50 筆）',
        },
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
      },
      required: ['ids'],
    },
  },
  {
    name: 'cc_memory_list',
    description: '列出專案的所有記憶。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
        type: {
          type: 'string',
          enum: ['session', 'decision'],
          description: '限定記憶類型（可選）',
        },
        limit: { type: 'number', description: '結果數量限制（預設 20）' },
        offset: { type: 'number', description: '分頁偏移（預設 0）' },
      },
    },
  },
  {
    name: 'cc_memory_get',
    description: '取得單一記憶詳情。project_id 與 project_path 擇一必填（scope 保護，避免跨 project 讀取）。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['id', 'project_id'] }, { required: ['id', 'project_path'] }],
      properties: {
        id: { type: 'string', description: '記憶 ID' },
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
      },
      required: ['id'],
    },
  },
  {
    name: 'cc_memory_stats',
    description: '取得專案的記憶統計資訊。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
      },
    },
  },
  {
    name: 'cc_memory_delete',
    description: '刪除指定的記憶（軟刪除，標記為 archived）。project_id 與 project_path 擇一必填（scope 保護，避免跨 project 意外刪除）。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['id', 'project_id'] }, { required: ['id', 'project_path'] }],
      properties: {
        id: { type: 'string', description: '記憶 ID' },
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
      },
      required: ['id'],
    },
  },

  // ---------- Task tools（v0.3 Phase A 新增） ----------
  {
    name: 'cc_task_create',
    description: '建立新任務。project_id 與 project_path 擇一必填；title 1-500 字。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
        title: { type: 'string', minLength: 1, maxLength: 500, description: '任務標題（1-500 字）' },
        description: { type: 'string', description: '任務詳細說明（可選）' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled'],
          description: '初始狀態（預設 open）',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '優先級（預設 normal）',
        },
        due_date: {
          type: 'string',
          description: '截止日 ISO 8601（可選）',
        },
        tags: { type: 'array', items: { type: 'string' } },
        source: {
          type: 'string',
          enum: ['manual', 'telegram', 'claude-code', 'codex', 'mcp'],
          description: '任務來源（預設 mcp）',
        },
        idempotency_key: { type: 'string', description: 'Client 冪等鍵（可選）' },
      },
      required: ['title'],
    },
  },
  {
    name: 'cc_task_list',
    description: '列出專案任務。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
        status: {
          anyOf: [
            { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
            {
              type: 'array',
              items: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
            },
          ],
          description: '單一或多個狀態過濾（未傳時預設排除 cancelled）',
        },
        limit: { type: 'number', description: '結果數量限制（預設 20）' },
        offset: { type: 'number', description: '分頁偏移（預設 0）' },
      },
    },
  },
  {
    name: 'cc_task_update',
    description:
      '更新任務（帶 optimistic locking）。必須提供 project_id / project_path（任一）+ expected_status；違反狀態轉移或同時寫入會收到 CONFLICT / INVALID_TRANSITION。title 若提供須 1-500 字。',
    inputSchema: {
      type: 'object',
      allOf: [
        { anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }] },
      ],
      properties: {
        id: { type: 'string', description: '任務 ID' },
        project_id: {
          type: 'string',
          description: '專案 ID（project_path 和 project_id 擇一必傳，避免跨 project UUID 改動）',
        },
        project_path: projectPathProp,
        expected_status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled'],
          description: 'optimistic locking 用：client 以為的當前 status；不符即 CONFLICT',
        },
        title: { type: 'string', minLength: 1, maxLength: 500 },
        description: { type: 'string' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled'],
          description: '目標 status（須符合狀態轉移矩陣）',
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        due_date: {
          anyOf: [
            { type: 'string', description: 'ISO 8601 字串' },
            { type: 'null', description: '清除 due_date' },
          ],
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'expected_status'],
    },
  },
  {
    name: 'cc_task_stats',
    description:
      '取得專案任務統計（結構化 JSON，供 /hi 與 cron 用，取代 raw postgres）。日界 Asia/Taipei。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
        completed_since_days: {
          type: 'number',
          description: 'completed_recently 視窗天數（預設 7）',
        },
      },
    },
  },
  // ---------- Reminder tools（Personal-Hub Phase 1） ----------
  {
    name: 'cc_task_set_reminder',
    description:
      '為任務設定提醒：remind_at 為觸發時點（與 due_date 截止日語意不同）。recurrence_interval_days 省略=一次性、正整數 N=每 N 天循環。重設會清除既有 snooze。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['id', 'project_id'] }, { required: ['id', 'project_path'] }],
      properties: {
        id: { type: 'string', description: '任務 ID' },
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
        remind_at: {
          type: 'string',
          description: '提醒觸發時點 ISO 8601（必填）',
        },
        recurrence_interval_days: {
          type: 'number',
          description: '循環間隔天數（正整數）；省略=一次性',
        },
      },
      required: ['id', 'remind_at'],
    },
  },
  {
    name: 'cc_task_snooze',
    description: '暫緩任務提醒到指定時點（snooze_until）。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['id', 'project_id'] }, { required: ['id', 'project_path'] }],
      properties: {
        id: { type: 'string', description: '任務 ID' },
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
        snooze_until: {
          type: 'string',
          description: '暫緩到此時點 ISO 8601（必填）',
        },
      },
      required: ['id', 'snooze_until'],
    },
  },
  {
    name: 'cc_reminders_due',
    description:
      '撈出本 scope 到期的提醒並「認領」（寫 reminder_log 去重 + 依 slot 推進 recurrence / 一次性）。供 poller（如 hermes）定期呼叫後自行投遞；回傳結構化 JSON。認領在投遞前發生（at-most-once：撈到後即標記已投，poller 推送失敗不會重發）。project_id 與 project_path 擇一必填。',
    inputSchema: {
      type: 'object',
      anyOf: [{ required: ['project_id'] }, { required: ['project_path'] }],
      properties: {
        project_id: { type: 'string', description: '專案 ID（與 project_path 擇一必填）' },
        project_path: projectPathProp,
        channel: {
          type: 'string',
          description: '投遞管道名，寫入 reminder_log.channel（如 hermes / telegram；省略=unknown）',
        },
        limit: { type: 'number', description: '單次最多處理筆數（預設 50）' },
      },
    },
  },
  // ---------- Todoist tools（個人 Todoist 帳號層級；無 project selector，刻意） ----------
  // 曝光條件：todoistApiToken 已設 且 forced-mode（個人 hub instance）。雙層 enforce。
  {
    name: 'cc_todoist_add',
    description:
      '新增一筆 Todoist 待辦。優先用 project_id 指定清單（先用 cc_todoist_projects 取 id）；project_name 僅 fallback，多重同名不猜會入 Inbox；都沒給/找不到→Inbox（不自動建清單）。priority 用語意值 p1(最緊急)..p4。回傳結構化 JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '待辦內容（必填）' },
        project_id: { type: 'string', description: 'Todoist 清單 ID（優先，去歧義用）' },
        project_name: {
          type: 'string',
          description: '清單名稱（fallback；多重同名不猜、會入 Inbox）',
        },
        due: {
          type: 'string',
          description: '到期：自然語言或日期（如 "tomorrow at 12:00"、"2026-06-30"）',
        },
        priority: {
          type: 'string',
          enum: ['p1', 'p2', 'p3', 'p4'],
          description: 'p1=最緊急 .. p4=最低（對應 Todoist app 的 P1..P4）',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'cc_todoist_projects',
    description:
      'List Todoist 清單（name + id）。供 AI 依內容判斷分類後把 id 傳給 cc_todoist_add 去歧義。fetch-all 分頁、回 next_cursor。回傳結構化 JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          description: '續抓游標：上一輪回傳的 next_cursor（結果超過上限被截斷時用）',
        },
      },
    },
  },
  {
    name: 'cc_todoist_list',
    description:
      '列出未完成的 Todoist 待辦（可選 project_id 過濾）。fetch-all 分頁、回 next_cursor。回傳結構化 JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '只列此清單（省略=全部）' },
        cursor: {
          type: 'string',
          description: '續抓游標：上一輪回傳的 next_cursor（結果超過上限被截斷時用）',
        },
      },
    },
  },
  {
    name: 'cc_todoist_complete',
    description: '把指定 Todoist 待辦標記完成（close）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Todoist task ID（必填）' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cc_todoist_completed',
    description:
      '查詢已完成的 Todoist 待辦（以 completed_at 為準）。預設近 7 天、範圍≤3 個月。可選 since/until(ISO 8601)/project_id。回傳結構化 JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: '起（ISO 8601，含）；省略=now-7d' },
        until: { type: 'string', description: '迄（ISO 8601，不含）；省略=now' },
        project_id: { type: 'string', description: '只查此清單' },
        cursor: {
          type: 'string',
          description: '續抓游標：上一輪回傳的 next_cursor（結果超過上限被截斷時用）',
        },
      },
    },
  },
];

// forced-mode（CC_FORCE_PROJECT_ID）：無 selector → 強制 forced project，因此 selector
// 非必填。移除 top-level anyOf/allOf（selector required 子句）使「廣告的 schema」與
// runtime 一致——否則嚴格驗證 args 的 MCP client 會在送達 handler 前擋掉 no-selector
// 呼叫（採納 Codex review P2）。id / type / title / expected_status 等 base `required`
// 不受影響（仍保留）；property 內層的 anyOf（如 cc_task_list.status）也不受影響。
function relaxSelectorForForcedMode(toolList: Tool[]): Tool[] {
  return toolList.map((t) => {
    const schema = { ...(t.inputSchema as Record<string, unknown>) };
    delete schema.anyOf;
    delete schema.allOf;
    return { ...t, inputSchema: schema as Tool['inputSchema'] };
  });
}

// 啟動期載入 tool policy（read-only / allowlist / search telemetry 開關）。
const defaultToolPolicy: ToolPolicy = loadToolPolicy();

/**
 * Todoist 工具曝光/允許的雙條件（比單看 token 嚴）：
 *   1. todoistApiToken 已設（非空）
 *   2. forced-mode **且鎖定個人 namespace**（forcedProjectId === __personal__）
 * 注意：CC_FORCE_PROJECT_ID 可鎖任意 project id，不必然是 __personal__。若只看
 * `forcedProjectId !== null`，一個鎖非個人 project 的 forced 部署只要繼承了
 * TODOIST_API_TOKEN，就會曝露 + 可寫個人 Todoist 帳號 → 破個人邊界（採納 Codex
 * round-3 P2）。故嚴格綁 PERSONAL_PROJECT_ID（與 __personal__ reserved namespace 同精神）。
 * token 可注入以利測試。
 */
export function resolveTodoistEnabled(
  config: ScopeConfig,
  token: string | undefined = appConfig.todoistApiToken
): boolean {
  return (
    config.forcedProjectId === PERSONAL_PROJECT_ID &&
    typeof token === 'string' &&
    token.trim().length > 0
  );
}

/**
 * 依 scope mode + tool policy 產生 ListTools schema：
 *   - project-mode 維持 selector 必填、forced-mode 放寬（scope 層）。
 *   - todoist 未啟用（token ∧ forced 任一不成立）：濾掉所有 cc_todoist_*。
 *   - read-only：去掉所有寫入類 tool（含 2 個 todoist write）。
 *   - allowlist：只露集合內 tool（含 read 過濾）。
 * 這是雙層 enforce 的第一層（ListTools 隱藏）；第二層在 handleToolCall central guard。
 * `opts.todoistEnabled` 可注入（預設由 config + token 推導）以利測試「有/無 token」。
 */
export function buildToolsForMode(
  config: ScopeConfig,
  policy: ToolPolicy = defaultToolPolicy,
  opts: { todoistEnabled?: boolean } = {}
): Tool[] {
  const todoistEnabled = opts.todoistEnabled ?? resolveTodoistEnabled(config);
  let list = config.forcedProjectId === null ? BASE_TOOLS : relaxSelectorForForcedMode(BASE_TOOLS);
  if (!todoistEnabled) {
    list = list.filter((t) => !t.name.startsWith('cc_todoist_'));
  }
  if (policy.readOnly) {
    list = list.filter((t) => !isWriteTool(t.name));
  }
  if (policy.allowlist !== null) {
    const allow = policy.allowlist;
    list = list.filter((t) => allow.has(t.name));
  }
  return list;
}

// 實際廣告的 tools 反映啟動 mode（defaultScopeConfig / defaultToolPolicy 讀 import 時的 env）。
export const tools: Tool[] = buildToolsForMode(defaultScopeConfig, defaultToolPolicy);

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'cc-memory', version: '0.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

/**
 * MCP handler 主 dispatch。匯出給測試直接呼叫（避免真跑 stdio transport）。
 * `database` 預設使用 src/db/client.ts 的單例 db；測試可注入別的 drizzle client。
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  database: typeof db = db,
  config: ScopeConfig = defaultScopeConfig,
  policy: ToolPolicy = defaultToolPolicy,
  opts: { todoistEnabled?: boolean; todoistToken?: string } = {}
): Promise<CallToolResult> {
  try {
    // central dispatch 守衛（雙層 enforce 的第二層，所有 tool 進入點統一過）：
    //   1. assertAllowed：allowlist 集合外（含 read）→ 拒（不靠 ListTools 過濾單獨足夠）。
    //   2. assertWritable：read-only instance 的寫入 tool → 拒。
    assertAllowed(name, policy);
    assertWritable(name, policy);

    // Todoist gate（第二層 enforce；token/config 可注入以利測試）：
    // 未啟用（token ∧ forced 任一不成立）→ 呼叫 todoist 工具一律 FORBIDDEN。
    const todoistToken = opts.todoistToken ?? appConfig.todoistApiToken;
    const todoistEnabled = opts.todoistEnabled ?? resolveTodoistEnabled(config, todoistToken);
    const requireTodoistToken = (): string => {
      if (!todoistEnabled || typeof todoistToken !== 'string' || todoistToken.trim().length === 0) {
        throw new ForbiddenError(
          'Todoist 工具未啟用（需設 TODOIST_API_TOKEN 且為 forced-mode 個人 hub instance）',
          { tool: name }
        );
      }
      return todoistToken;
    };
    switch (name) {
      // ---------------- Memory ----------------
      case 'cc_memory_save': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const result = await saveMemory(database, {
          projectId,
          projectPath: args.project_path as string | undefined,
          type: args.type as 'session' | 'decision',
          summary: args.summary as string,
          keywords: args.keywords as string[] | undefined,
          decisions: args.decisions as string[] | undefined,
          nextSteps: args.next_steps as string[] | undefined,
          idempotencyKey: args.idempotency_key as string | undefined,
        });
        const embeddingStatus = result.hasEmbedding
          ? '✓ 已生成 embedding'
          : '(無 embedding - 語義搜尋不可用)';
        const idemNote = result.idempotent ? '（冪等命中：payload 同舊 row，回既有 id）' : '';
        return {
          content: [
            {
              type: 'text',
              text: `✓ 記憶已儲存\nID: ${result.id}\n專案: ${projectId}\n${embeddingStatus}${idemNote ? '\n' + idemNote : ''}`,
            },
          ],
        };
      }

      case 'cc_memory_search': {
        // cc_memory_search 保留 cross-project 搜尋能力，但契約嚴格：
        //   - 若 project_id 有傳但空字串 → 拒（client UI 把 unset 序列化成 ""
        //     不應默默廣域搜尋暴露他 project 資料，codex review round 11 P2）
        //   - 明示 project_id 非空 → 用該 id
        //   - 只傳 project_path → 驗絕對路徑後解析 id
        //   - 兩者都沒 → projectId undefined（全專案搜尋，
        //     search_feedback.query_project_id = NULL）
        if (typeof args.project_id === 'string' && args.project_id.trim().length === 0) {
          throw new InvalidArgumentError(
            'project_id 若提供不可為空字串 / 空白（若要全專案搜尋請省略此欄位）',
            { project_id: args.project_id }
          );
        }
        const explicitId =
          typeof args.project_id === 'string' && args.project_id.trim().length > 0
            ? (args.project_id.trim() as string)
            : null;
        // 同步對 project_path 做 trim（codex review round 15 P2）；whitespace-only
        // path 不該 slip through 讓 search 變全專案模式。
        if (typeof args.project_path === 'string' && args.project_path.trim().length === 0 && args.project_path.length > 0) {
          throw new InvalidArgumentError(
            'project_path 若提供不可為空白（若要全專案搜尋請省略此欄位）',
            { project_path: args.project_path }
          );
        }
        const rawPath =
          typeof args.project_path === 'string' && args.project_path.trim().length > 0
            ? (args.project_path as string)
            : null;
        let projectId: string | undefined;
        if (explicitId !== null) {
          // project_id 已提供即為 authoritative；project_path 為多餘欄位，不驗證
          // （codex review round 19 P1：client 同時送兩個欄位時不應被 INVALID_ARGUMENT 擋下）
          projectId = explicitId;
        } else if (rawPath !== null) {
          // 需要 path 做 resolve 時才驗：絕對路徑 + 目錄存在
          // （codex review round 17 P2：cc_memory_search 用自己分支不能漏）
          validateProjectPathForResolution(rawPath);
          // 同 resolveCwdAndProjectId：caller 明示 path → cwdIsExplicit 跳過 env
          // （codex review round 20 P1）
          projectId = resolveProjectId({ cwd: rawPath, cwdIsExplicit: true });
        } else {
          projectId = undefined;
        }
        // ScopePolicy（surface='search'）：
        //   - forced-mode → 強制限定 forcedProjectId（不可全專案，query_project_id 非 null）
        //   - project-mode → deny 顯式/解析到的保留 namespace；undefined = 全專案
        //     （service 層另排除保留 namespace，見 searchMemories）
        projectId = applyScopePolicy(projectId, { config, surface: 'search' });
        const envelope = await searchMemoryIndexes(database, {
          query: args.query as string,
          projectId,
          type: args.type as 'session' | 'decision' | undefined,
          limit: args.limit as number | undefined,
          mode: args.mode as 'keyword' | 'semantic' | 'hybrid' | undefined,
          querySurface: 'mcp',
        });

        // Phase 5-A：fire-and-forget 寫 search_feedback。
        // 失敗 console.error，不影響 search 主流程（避免 unhandled promise rejection 打掛 MCP server）。
        // Phase 2（Codex #9）：CC_SEARCH_FEEDBACK=off 的潔癖消費端可完全關掉此 telemetry 寫入。
        if (policy.searchFeedback) {
          void recordSearchQuery(database, envelope).catch((e) => {
            console.error('[recordSearchQuery failed]', e);
          });
        }

        if (envelope.results.length === 0) {
          return { content: [{ type: 'text', text: '沒有找到相關記憶' }] };
        }
        const formatted = envelope.results.map((r, i) => formatMemoryIndexResult(r, i)).join('\n\n');
        return {
          content: [
            {
              type: 'text',
              text:
                `找到 ${envelope.results.length} 筆相關記憶索引 (${envelope.effectiveMode} 模式):\n\n` +
                formatted,
            },
          ],
        };
      }

      case 'cc_memory_timeline': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const result = await timeline(
          database,
          args.anchor_id as string,
          (args.depth_before as number | undefined) ?? 3,
          (args.depth_after as number | undefined) ?? 3,
          projectId
        );
        return jsonResult({
          anchor_id: result.anchorId,
          depth_before: result.depthBefore,
          depth_after: result.depthAfter,
          count: result.observations.length,
          ...(result.truncated ? { truncated: true } : {}),
          observations: result.observations.map(observationIndexJson),
        });
      }

      case 'cc_memory_get_observations': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const rows = await getObservations(database, args.ids as string[], projectId);
        return jsonResult({
          count: rows.length,
          observations: rows.map(observationFullJson),
        });
      }

      case 'cc_memory_list': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const results = await listMemories(database, {
          projectId,
          type: args.type as 'session' | 'decision' | undefined,
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        });
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `專案 "${projectId}" 沒有任何記憶` }],
          };
        }
        const formatted = results.map((r, i) => formatMemory(r, i)).join('\n\n');
        return {
          content: [
            {
              type: 'text',
              text: `專案 "${projectId}" 的記憶 (${results.length} 筆):\n\n${formatted}`,
            },
          ],
        };
      }

      case 'cc_memory_get': {
        // 強制 project scope（codex review round 18 P2）：避免跨 project 讀取
        const { projectId } = resolveCwdAndProjectId(args, config);
        const id = args.id as string;
        const memory = await getMemory(database, id, projectId);
        if (!memory) {
          throw new NotFoundError(`找不到記憶 (ID: ${id})`, { id });
        }
        return { content: [{ type: 'text', text: formatMemory(memory) }] };
      }

      case 'cc_memory_stats': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const stats = await getProjectStats(database, projectId);
        const firstDate = stats.firstMemory
          ? new Date(stats.firstMemory).toLocaleDateString('zh-TW')
          : 'N/A';
        const lastDate = stats.lastMemory
          ? new Date(stats.lastMemory).toLocaleDateString('zh-TW')
          : 'N/A';
        return {
          content: [
            {
              type: 'text',
              text:
                `專案 "${projectId}" 統計:\n\n` +
                `- 總記憶數: ${stats.totalMemories}\n` +
                `- Session 記憶: ${stats.sessionCount}\n` +
                `- Decision 記憶: ${stats.decisionCount}\n` +
                `- 第一筆記憶: ${firstDate}\n` +
                `- 最後記憶: ${lastDate}`,
            },
          ],
        };
      }

      case 'cc_memory_delete': {
        // 強制 project scope（codex review round 18 P1）：避免跨 project 意外刪除
        const { projectId } = resolveCwdAndProjectId(args, config);
        const id = args.id as string;
        const deleted = await deleteMemory(database, id, projectId);
        if (!deleted) {
          throw new NotFoundError(`找不到記憶 (ID: ${id})`, { id });
        }
        return { content: [{ type: 'text', text: `✓ 記憶已刪除 (ID: ${id})` }] };
      }

      // ---------------- Task ----------------
      case 'cc_task_create': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const parsedDue = parseDueDate(args.due_date);
        const task = await createTask(database, {
          projectId,
          projectPath: args.project_path as string | undefined,
          title: args.title as string,
          description: args.description as string | undefined,
          status: args.status as TaskStatus | undefined,
          priority: args.priority as 'low' | 'normal' | 'high' | undefined,
          dueDate: parsedDue === null ? undefined : parsedDue,
          tags: args.tags as string[] | undefined,
          source:
            (args.source as 'manual' | 'telegram' | 'claude-code' | 'codex' | 'mcp' | undefined) ??
            'mcp',
          idempotencyKey: args.idempotency_key as string | undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: `✓ 任務已建立\n${formatTask(task)}\nID: ${task.id}`,
            },
          ],
        };
      }

      case 'cc_task_list': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const rawStatus = args.status;
        let statusFilter: TaskStatus | TaskStatus[] | undefined;
        if (typeof rawStatus === 'string') statusFilter = rawStatus as TaskStatus;
        else if (Array.isArray(rawStatus)) statusFilter = rawStatus as TaskStatus[];

        const rows = await listTasks(database, {
          projectId,
          status: statusFilter,
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        });
        if (rows.length === 0) {
          return {
            content: [{ type: 'text', text: `專案 "${projectId}" 沒有任務` }],
          };
        }
        const formatted = rows.map((t, i) => formatTask(t, i)).join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `專案 "${projectId}" 的任務 (${rows.length} 筆):\n\n${formatted}`,
            },
          ],
        };
      }

      case 'cc_task_update': {
        // 強制 project scope：cc_task_update 必須傳 project_id 或 project_path，
        // 否則 UUID-only update 可跨 project 亂改（codex round 5 P2）。
        const { projectId } = resolveCwdAndProjectId(args, config);
        const id = args.id as string;
        const expected = args.expected_status as TaskStatus;
        const patch: Record<string, unknown> = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.description !== undefined) patch.description = args.description;
        if (args.status !== undefined) patch.status = args.status;
        if (args.priority !== undefined) patch.priority = args.priority;
        if (args.tags !== undefined) patch.tags = args.tags;
        // dueDate 用 parseDueDate 驗：明示 null 清空；有效 ISO → Date；
        // 無效字串 → throw InvalidArgumentError（不落到 postgres 變 INTERNAL）
        const parsedDue = parseDueDate(args.due_date);
        if (parsedDue !== undefined) patch.dueDate = parsedDue;

        const updated = await updateTask(database, id, patch, {
          expectedStatus: expected,
          projectId,
        });
        return {
          content: [
            {
              type: 'text',
              text: `✓ 任務已更新\n${formatTask(updated)}`,
            },
          ],
        };
      }

      case 'cc_task_stats': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const stats = await getTaskStats(database, projectId, {
          completedSinceDays: args.completed_since_days as number | undefined,
        });
        // 結構化 JSON（snake_case，供 /hi / cron 直接 parse，不解析文字）
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                project_id: stats.projectId,
                today: stats.today,
                overdue: stats.overdue,
                open: stats.open,
                in_progress: stats.inProgress,
                completed_recently: stats.completedRecently,
              }),
            },
          ],
        };
      }

      // ---------------- Reminder ----------------
      case 'cc_task_set_reminder': {
        // 強制 project scope：mutation 必帶 project_id / project_path（防跨 namespace 用 UUID 改別人的 row）。
        const { projectId } = resolveCwdAndProjectId(args, config);
        const id = args.id as string;
        const remindAt = parseRequiredTimestamp(args.remind_at, 'remind_at');
        const task = await setReminder(database, id, projectId, {
          remindAt,
          recurrenceIntervalDays: args.recurrence_interval_days as number | null | undefined,
        });
        const recurNote =
          task.recurrenceIntervalDays !== null
            ? `（每 ${task.recurrenceIntervalDays} 天循環）`
            : '（一次性）';
        return {
          content: [
            {
              type: 'text',
              text: `✓ 提醒已設定 ${recurNote}\n${formatTask(task)}\nremind_at: ${new Date(
                task.remindAt as Date
              ).toISOString()}`,
            },
          ],
        };
      }

      case 'cc_task_snooze': {
        const { projectId } = resolveCwdAndProjectId(args, config);
        const id = args.id as string;
        const until = parseRequiredTimestamp(args.snooze_until, 'snooze_until');
        const task = await snoozeReminder(database, id, projectId, until);
        return {
          content: [
            {
              type: 'text',
              text: `✓ 提醒已暫緩\n${formatTask(task)}\nsnooze_until: ${new Date(
                task.snoozeUntil as Date
              ).toISOString()}`,
            },
          ],
        };
      }

      case 'cc_reminders_due': {
        // poller 入口（hermes）：撈+認領到期提醒。寫入類（見 WRITE_TOOLS）。
        const { projectId } = resolveCwdAndProjectId(args, config);
        const channel =
          typeof args.channel === 'string' && args.channel.trim().length > 0
            ? args.channel.trim()
            : 'unknown';
        const due = await getDueReminders(database, {
          projectId,
          channel,
          limit: args.limit as number | undefined,
        });
        // 結構化 JSON（供 poller parse，不解析文字；對齊 cc_task_stats 設計）
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                project_id: projectId,
                count: due.length,
                reminders: due.map(({ task, slot }) => ({
                  id: task.id,
                  title: task.title,
                  slot: slot.toISOString(),
                  remind_at: task.remindAt ? new Date(task.remindAt).toISOString() : null,
                  recurrence_interval_days: task.recurrenceIntervalDays,
                  priority: task.priority,
                  status: task.status,
                })),
              }),
            },
          ],
        };
      }

      // ---------------- Todoist（個人帳號層級；無 project selector；token∧forced gated） ----------------
      case 'cc_todoist_add': {
        const token = requireTodoistToken();
        const content = args.content as string;
        let projectId =
          typeof args.project_id === 'string' && args.project_id.trim().length > 0
            ? args.project_id.trim()
            : undefined;
        // resolution 紀錄解析路徑，回傳給 agent 自我修正（id / name / inbox-*）。
        let resolution: 'id' | 'name' | 'inbox' | 'inbox-ambiguous' | 'inbox-not-found' = projectId
          ? 'id'
          : 'inbox';
        // project_name 只是 fallback：精確（trim+小寫）比對；單一命中才用，多重/零命中不猜 → Inbox。
        if (
          !projectId &&
          typeof args.project_name === 'string' &&
          args.project_name.trim().length > 0
        ) {
          const wanted = args.project_name.trim().toLowerCase();
          const { projects } = await todoist.listProjects(token);
          const matches = projects.filter((p) => p.name.trim().toLowerCase() === wanted);
          if (matches.length === 1) {
            projectId = matches[0].id;
            resolution = 'name';
          } else if (matches.length > 1) {
            resolution = 'inbox-ambiguous';
          } else {
            resolution = 'inbox-not-found';
          }
        }
        const task = await todoist.addTask(token, {
          content,
          projectId,
          due: typeof args.due === 'string' ? args.due : undefined,
          priority: args.priority as TodoistPriority | undefined,
        });
        return jsonResult({ ...todoistTaskJson(task), project_resolution: resolution });
      }

      case 'cc_todoist_projects': {
        const token = requireTodoistToken();
        const cursor =
          typeof args.cursor === 'string' && args.cursor.trim().length > 0
            ? args.cursor.trim()
            : undefined;
        const { projects, nextCursor } = await todoist.listProjects(token, { cursor });
        return jsonResult({
          count: projects.length,
          projects: projects.map((p) => ({ id: p.id, name: p.name })),
          next_cursor: nextCursor,
        });
      }

      case 'cc_todoist_list': {
        const token = requireTodoistToken();
        const projectId =
          typeof args.project_id === 'string' && args.project_id.trim().length > 0
            ? args.project_id.trim()
            : undefined;
        const cursor =
          typeof args.cursor === 'string' && args.cursor.trim().length > 0
            ? args.cursor.trim()
            : undefined;
        const { tasks, nextCursor } = await todoist.listTasks(token, { projectId, cursor });
        return jsonResult({
          count: tasks.length,
          tasks: tasks.map(todoistTaskJson),
          next_cursor: nextCursor,
        });
      }

      case 'cc_todoist_complete': {
        const token = requireTodoistToken();
        const taskId = args.task_id as string;
        await todoist.completeTask(token, taskId);
        return jsonResult({ ok: true, task_id: taskId });
      }

      case 'cc_todoist_completed': {
        const token = requireTodoistToken();
        const since = args.since !== undefined ? parseRequiredTimestamp(args.since, 'since') : undefined;
        const until = args.until !== undefined ? parseRequiredTimestamp(args.until, 'until') : undefined;
        const projectId =
          typeof args.project_id === 'string' && args.project_id.trim().length > 0
            ? args.project_id.trim()
            : undefined;
        const cursor =
          typeof args.cursor === 'string' && args.cursor.trim().length > 0
            ? args.cursor.trim()
            : undefined;
        const { tasks, nextCursor } = await todoist.listCompletedTasks(token, {
          since,
          until,
          projectId,
          cursor,
        });
        return jsonResult({
          count: tasks.length,
          tasks: tasks.map(todoistTaskJson),
          next_cursor: nextCursor,
        });
      }

      default:
        throw new InvalidArgumentError(`未知的工具: ${name}`, { tool: name });
    }
  } catch (err) {
    return errorResponse(err);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  return handleToolCall(name, args);
});

// ---------------------------------------------------------------------------
// 啟動（被 import 時不跑 main；僅 `node build/index.js` 直接執行時啟動 stdio）
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CC-memory MCP server v0.3 started');
}

// 只有「直接被 node 跑」時啟動 stdio server；測試 import 進來不啟。
// CommonJS 輸出下 require.main === module 是標準檢查；用 `as unknown` 轉型避開 ts-strict。
// eslint-disable-next-line @typescript-eslint/no-require-imports
declare const require: { main?: unknown };
// eslint-disable-next-line @typescript-eslint/no-require-imports
declare const module: unknown;

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
