#!/usr/bin/env node

/**
 * CC-memory MCP Server
 * Claude Code 專案記憶同步系統
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
import { Memory } from './db/schema.js';
import {
  saveMemory,
  searchMemories,
  listMemories,
  getMemory,
  deleteMemory,
  getProjectStats,
} from './tools/index.js';
import { getProjectId } from './utils/project-id.js';

// MCP Tools 定義
const tools: Tool[] = [
  {
    name: 'cc_memory_save',
    description: '儲存專案記憶到資料庫。包含摘要、關鍵字、決策和下一步。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '專案 ID（可選，預設從工作目錄偵測）'
        },
        project_path: {
          type: 'string',
          description: '專案路徑（可選）'
        },
        type: {
          type: 'string',
          enum: ['session', 'decision'],
          description: '記憶類型：session（一般對話）或 decision（重要決策）'
        },
        summary: {
          type: 'string',
          description: '記憶摘要（3-5 句話）'
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '關鍵字列表'
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: '重要決策列表'
        },
        next_steps: {
          type: 'array',
          items: { type: 'string' },
          description: '下一步待辦列表'
        }
      },
      required: ['type', 'summary']
    }
  },
  {
    name: 'cc_memory_search',
    description: '搜尋相關的專案記憶。支援關鍵字搜尋、語義搜尋和混合搜尋。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜尋查詢'
        },
        project_id: {
          type: 'string',
          description: '限定專案（可選）'
        },
        type: {
          type: 'string',
          enum: ['session', 'decision'],
          description: '限定記憶類型（可選）'
        },
        mode: {
          type: 'string',
          enum: ['keyword', 'semantic', 'hybrid'],
          description: '搜尋模式：keyword（關鍵字）、semantic（語義）、hybrid（混合，預設）'
        },
        limit: {
          type: 'number',
          description: '結果數量限制（預設 10）'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'cc_memory_list',
    description: '列出專案的所有記憶',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '專案 ID'
        },
        type: {
          type: 'string',
          enum: ['session', 'decision'],
          description: '限定記憶類型（可選）'
        },
        limit: {
          type: 'number',
          description: '結果數量限制（預設 20）'
        },
        offset: {
          type: 'number',
          description: '分頁偏移（預設 0）'
        }
      },
      required: ['project_id']
    }
  },
  {
    name: 'cc_memory_get',
    description: '取得單一記憶詳情',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '記憶 ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'cc_memory_stats',
    description: '取得專案的記憶統計資訊',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '專案 ID'
        }
      },
      required: ['project_id']
    }
  },
  {
    name: 'cc_memory_delete',
    description: '刪除指定的記憶（軟刪除，標記為 archived）',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '記憶 ID'
        }
      },
      required: ['id']
    }
  }
];

// 格式化記憶顯示
function formatMemory(memory: Memory, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const date = memory.createdAt
    ? new Date(memory.createdAt).toLocaleDateString('zh-TW')
    : 'N/A';
  const type = memory.type === 'decision' ? '🎯' : '📝';

  let result = `${prefix}${type} [${date}] ${memory.summary}`;

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

// 建立 MCP Server
const server = new Server(
  {
    name: 'cc-memory',
    version: '0.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// 註冊 tools 列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// 處理 tool 呼叫
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'cc_memory_save': {
        // 若未提供 project_id，嘗試從 project_path 偵測
        let projectId = args?.project_id as string | undefined;
        const projectPath = args?.project_path as string | undefined;

        if (!projectId && projectPath) {
          projectId = await getProjectId(projectPath);
        }

        if (!projectId) {
          return {
            content: [{
              type: 'text',
              text: '錯誤: 請提供 project_id 或 project_path'
            }],
            isError: true
          };
        }

        const result = await saveMemory(db as any, {
          projectId,
          projectPath,
          type: args?.type as 'session' | 'decision',
          summary: args?.summary as string,
          keywords: args?.keywords as string[] | undefined,
          decisions: args?.decisions as string[] | undefined,
          nextSteps: args?.next_steps as string[] | undefined,
        });

        const embeddingStatus = result.hasEmbedding
          ? '✓ 已生成 embedding'
          : '(無 embedding - 語義搜尋不可用)';

        return {
          content: [{
            type: 'text',
            text: `✓ 記憶已儲存\nID: ${result.id}\n專案: ${projectId}\n${embeddingStatus}`
          }]
        };
      }

      case 'cc_memory_search': {
        const mode = args?.mode as 'keyword' | 'semantic' | 'hybrid' | undefined;
        const results = await searchMemories(db as any, {
          query: args?.query as string,
          projectId: args?.project_id as string | undefined,
          type: args?.type as 'session' | 'decision' | undefined,
          limit: args?.limit as number | undefined,
          mode,
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: '沒有找到相關記憶'
            }]
          };
        }

        const formatted = results.map((r, i) => formatMemory(r, i)).join('\n\n');
        const modeLabel = mode || 'hybrid';

        return {
          content: [{
            type: 'text',
            text: `找到 ${results.length} 筆相關記憶 (${modeLabel} 模式):\n\n${formatted}`
          }]
        };
      }

      case 'cc_memory_list': {
        const projectId = args?.project_id as string;
        const results = await listMemories(db as any, {
          projectId,
          type: args?.type as 'session' | 'decision' | undefined,
          limit: args?.limit as number | undefined,
          offset: args?.offset as number | undefined,
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `專案 "${projectId}" 沒有任何記憶`
            }]
          };
        }

        const formatted = results.map((r, i) => formatMemory(r, i)).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `專案 "${projectId}" 的記憶 (${results.length} 筆):\n\n${formatted}`
          }]
        };
      }

      case 'cc_memory_get': {
        const id = args?.id as string;
        const memory = await getMemory(db as any, id);

        if (!memory) {
          return {
            content: [{
              type: 'text',
              text: `找不到記憶 (ID: ${id})`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: formatMemory(memory)
          }]
        };
      }

      case 'cc_memory_stats': {
        const projectId = args?.project_id as string;
        const stats = await getProjectStats(db as any, projectId);

        const firstDate = stats.firstMemory
          ? new Date(stats.firstMemory).toLocaleDateString('zh-TW')
          : 'N/A';
        const lastDate = stats.lastMemory
          ? new Date(stats.lastMemory).toLocaleDateString('zh-TW')
          : 'N/A';

        return {
          content: [{
            type: 'text',
            text: `專案 "${projectId}" 統計:\n\n` +
              `- 總記憶數: ${stats.totalMemories}\n` +
              `- Session 記憶: ${stats.sessionCount}\n` +
              `- Decision 記憶: ${stats.decisionCount}\n` +
              `- 第一筆記憶: ${firstDate}\n` +
              `- 最後記憶: ${lastDate}`
          }]
        };
      }

      case 'cc_memory_delete': {
        const id = args?.id as string;
        await deleteMemory(db as any, id);

        return {
          content: [{
            type: 'text',
            text: `✓ 記憶已刪除 (ID: ${id})`
          }]
        };
      }

      default:
        return {
          content: [{
            type: 'text',
            text: `未知的工具: ${name}`
          }],
          isError: true
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text',
        text: `錯誤: ${message}`
      }],
      isError: true
    };
  }
});

// 啟動 server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CC-memory MCP server started');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
