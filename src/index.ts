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

import { db } from './db/client.js';
import type { Memory, Task } from './db/schema.js';

import {
  saveMemory,
  searchMemories,
  listMemories,
  getMemory,
  deleteMemory,
  getProjectStats,
} from './services/memories.js';
import { createTask, listTasks, updateTask } from './services/tasks.js';
import { recordSearchQuery } from './services/feedback.js';
import { resolveProjectId } from './services/projects.js';
import { BaseServiceError, NotFoundError, InvalidArgumentError } from './services/errors.js';
import type { McpError, TaskStatus } from './services/types.js';

// ---------------------------------------------------------------------------
// 輔助：cwd / projectId 解析（所有 tool 用同一組 dispatch）
// ---------------------------------------------------------------------------

function resolveCwdAndProjectId(args: Record<string, unknown> | undefined): {
  cwd: string;
  projectId: string;
} {
  const rawPath = args?.project_path;
  const rawId = args?.project_id;
  const hasPath = typeof rawPath === 'string' && rawPath.length > 0;
  const hasId = typeof rawId === 'string' && rawId.length > 0;

  // MCP stdio server 的 process.cwd() 是 server 啟動目錄，不是 client 端的專案目錄。
  // 任一 tool 若 caller 不傳 project_id 也不傳 project_path，fail-fast 不 fallback；
  // 不然舊 client 會默默寫錯 project（codex review round 3 P1）。
  // `cc_memory_search` 可以兩者都無（= 跨專案搜尋），所以那個分支在自己的 case 裡處理。
  if (!hasPath && !hasId) {
    throw new InvalidArgumentError(
      '需提供 project_id 或 project_path（MCP server 的 process.cwd() 非 client cwd，無法可靠解析 project）',
      { hint: 'skills/{save,load}-memory.md 已示範：tool call 時傳 project_path 為當前工作目錄絕對路徑' }
    );
  }

  const cwd = hasPath ? (rawPath as string) : process.cwd();
  const explicit = hasId ? (rawId as string) : null;
  const projectId = resolveProjectId({ explicit, cwd });
  return { cwd, projectId };
}

// ---------------------------------------------------------------------------
// 輔助：錯誤 JSON response（取代 `錯誤: ${msg}` 字串拼接）
// ---------------------------------------------------------------------------

/**
 * 解析 due_date 輸入：null → null（清空）；undefined → undefined（不動）；
 * 字串 → Date，但驗證非 NaN；其他或無效字串 → throw InvalidArgumentError。
 * Codex review round 4 finding：不驗會讓 postgres-js 序列化失敗回 INTERNAL。
 */
function parseDueDate(raw: unknown): Date | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new InvalidArgumentError('due_date 必須是 ISO 8601 字串或 null', { due_date: raw });
  }
  if (raw.length === 0) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new InvalidArgumentError(`due_date 不是有效的 ISO 8601 字串: ${raw}`, {
      due_date: raw,
    });
  }
  return d;
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

function formatTask(task: Task, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const statusEmoji: Record<string, string> =
    { open: '⭕', in_progress: '🔵', done: '✅', cancelled: '❌' };
  const emoji = statusEmoji[task.status] ?? '•';
  const hostStamp = task.writerHost ? ` ✍️${task.writerHost}` : '';
  const shortId = task.id.slice(0, 8);
  const prio = task.priority !== 'normal' ? `[${task.priority}]` : '';
  const due = task.dueDate ? ` (due ${new Date(task.dueDate).toLocaleDateString('zh-TW')})` : '';
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

const tools: Tool[] = [
  {
    name: 'cc_memory_save',
    description: '儲存專案記憶到資料庫。包含摘要、關鍵字、決策和下一步。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '專案 ID（可選，優先序最高；未提供時用 project_path 5 層解析）',
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
    name: 'cc_memory_list',
    description: '列出專案的所有記憶',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '專案 ID（可選）' },
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
    description: '取得單一記憶詳情',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '記憶 ID' },
        project_path: projectPathProp,
      },
      required: ['id'],
    },
  },
  {
    name: 'cc_memory_stats',
    description: '取得專案的記憶統計資訊',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '專案 ID（可選）' },
        project_path: projectPathProp,
      },
    },
  },
  {
    name: 'cc_memory_delete',
    description: '刪除指定的記憶（軟刪除，標記為 archived）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '記憶 ID' },
        project_path: projectPathProp,
      },
      required: ['id'],
    },
  },

  // ---------- Task tools（v0.3 Phase A 新增） ----------
  {
    name: 'cc_task_create',
    description: '建立新任務',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '專案 ID（可選）' },
        project_path: projectPathProp,
        title: { type: 'string', description: '任務標題（1-500 字）' },
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
    description: '列出專案任務',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '專案 ID（可選）' },
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
      '更新任務（帶 optimistic locking）。必須提供 expected_status；違反狀態轉移或同時寫入會收到 CONFLICT / INVALID_TRANSITION。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任務 ID' },
        project_path: projectPathProp,
        expected_status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled'],
          description: 'optimistic locking 用：client 以為的當前 status；不符即 CONFLICT',
        },
        title: { type: 'string' },
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
];

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
  database: typeof db = db
): Promise<CallToolResult> {
  try {
    switch (name) {
      // ---------------- Memory ----------------
      case 'cc_memory_save': {
        const { projectId } = resolveCwdAndProjectId(args);
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
        // cc_memory_search 保留 cross-project 搜尋能力：
        //   - 明示 project_id 非空 → 用該 id
        //   - 只傳 project_path → 解析 id
        //   - 兩者都沒 → projectId undefined（全專案搜尋，search_feedback.query_project_id = NULL）
        const explicitId = typeof args.project_id === 'string' && args.project_id.length > 0
          ? (args.project_id as string)
          : null;
        const rawPath = typeof args.project_path === 'string' && args.project_path.length > 0
          ? (args.project_path as string)
          : null;
        let projectId: string | undefined;
        if (explicitId !== null) {
          projectId = explicitId;
        } else if (rawPath !== null) {
          projectId = resolveProjectId({ cwd: rawPath });
        } else {
          projectId = undefined;
        }
        const envelope = await searchMemories(database, {
          query: args.query as string,
          projectId,
          type: args.type as 'session' | 'decision' | undefined,
          limit: args.limit as number | undefined,
          mode: args.mode as 'keyword' | 'semantic' | 'hybrid' | undefined,
          querySurface: 'mcp',
        });

        // Phase 5-A：fire-and-forget 寫 search_feedback。
        // 失敗 console.error，不影響 search 主流程（避免 unhandled promise rejection 打掛 MCP server）。
        void recordSearchQuery(database, envelope).catch((e) => {
          console.error('[recordSearchQuery failed]', e);
        });

        if (envelope.results.length === 0) {
          return { content: [{ type: 'text', text: '沒有找到相關記憶' }] };
        }
        const formatted = envelope.results.map((r, i) => formatMemory(r, i)).join('\n\n');
        return {
          content: [
            {
              type: 'text',
              text: `找到 ${envelope.results.length} 筆相關記憶 (${envelope.effectiveMode} 模式):\n\n${formatted}`,
            },
          ],
        };
      }

      case 'cc_memory_list': {
        const { projectId } = resolveCwdAndProjectId(args);
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
        const id = args.id as string;
        const memory = await getMemory(database, id);
        if (!memory) {
          throw new NotFoundError(`找不到記憶 (ID: ${id})`, { id });
        }
        return { content: [{ type: 'text', text: formatMemory(memory) }] };
      }

      case 'cc_memory_stats': {
        const { projectId } = resolveCwdAndProjectId(args);
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
        const id = args.id as string;
        await deleteMemory(database, id);
        return { content: [{ type: 'text', text: `✓ 記憶已刪除 (ID: ${id})` }] };
      }

      // ---------------- Task ----------------
      case 'cc_task_create': {
        const { projectId } = resolveCwdAndProjectId(args);
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
        const { projectId } = resolveCwdAndProjectId(args);
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
        const { projectId } = resolveCwdAndProjectId(args);
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
