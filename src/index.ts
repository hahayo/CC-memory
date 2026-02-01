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
} from '@modelcontextprotocol/sdk/types.js';

import { SupabaseStorage } from './storage/supabase.js';
import { Memory } from './storage/types.js';

// 環境變數
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_KEY are required');
  process.exit(1);
}

// 初始化儲存層
const storage = new SupabaseStorage({
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY
});

// MCP Tools 定義
const tools: Tool[] = [
  {
    name: 'cc_memory_save',
    description: '儲存專案記憶到資料庫。包含摘要、關鍵字、決策和技術棧。',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: '專案名稱'
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
        tech_stack: {
          type: 'array',
          items: { type: 'string' },
          description: '技術棧列表'
        },
        embedding: {
          type: 'array',
          items: { type: 'number' },
          description: '向量 embedding（可選）'
        },
        session_id: {
          type: 'string',
          description: 'Session ID（可選）'
        }
      },
      required: ['project_name', 'summary']
    }
  },
  {
    name: 'cc_memory_search',
    description: '搜尋相關的專案記憶。支援語義搜尋（需要 embedding）和關鍵字搜尋。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜尋查詢'
        },
        project: {
          type: 'string',
          description: '限定專案（可選）'
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '關鍵字搜尋（可選）'
        },
        embedding: {
          type: 'array',
          items: { type: 'number' },
          description: '向量搜尋（可選）'
        },
        limit: {
          type: 'number',
          description: '結果數量限制',
          default: 5
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
        project: {
          type: 'string',
          description: '專案名稱'
        },
        limit: {
          type: 'number',
          description: '結果數量限制',
          default: 20
        }
      },
      required: ['project']
    }
  },
  {
    name: 'cc_memory_list_projects',
    description: '列出所有有記憶的專案',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'cc_memory_stats',
    description: '取得專案的記憶統計資訊',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: '專案名稱'
        }
      },
      required: ['project']
    }
  },
  {
    name: 'cc_memory_delete',
    description: '刪除指定的記憶',
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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'cc_memory_save': {
        const memory: Memory = {
          project_name: args.project_name as string,
          summary: args.summary as string,
          keywords: (args.keywords as string[]) || [],
          decisions: (args.decisions as string[]) || [],
          tech_stack: (args.tech_stack as string[]) || [],
          embedding: args.embedding as number[] | undefined,
          session_id: args.session_id as string | undefined
        };

        const result = await storage.saveMemory(memory);

        return {
          content: [{
            type: 'text',
            text: `✓ 記憶已儲存\nID: ${result.id}\n專案: ${memory.project_name}`
          }]
        };
      }

      case 'cc_memory_search': {
        const query = args.query as string;
        const project = args.project as string | undefined;
        const keywords = args.keywords as string[] | undefined;
        const embedding = args.embedding as number[] | undefined;
        const limit = (args.limit as number) || 5;

        let results;

        if (embedding && embedding.length > 0) {
          // 向量搜尋
          results = await storage.searchByVector(embedding, project, limit);
        } else if (keywords && keywords.length > 0) {
          // 關鍵字搜尋
          results = await storage.searchByKeywords(keywords, project, limit);
        } else {
          // 全文搜尋
          results = await storage.searchFulltext(query, project, limit);
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: '沒有找到相關記憶'
            }]
          };
        }

        const formatted = results.map((r, i) => {
          let score = '';
          if (r.similarity !== undefined) {
            score = ` (相似度: ${(r.similarity * 100).toFixed(1)}%)`;
          } else if (r.rank !== undefined) {
            score = ` (相關度: ${r.rank.toFixed(2)})`;
          }

          return `## ${i + 1}. [${r.project_name}]${score}\n${r.summary}\n\n關鍵字: ${r.keywords?.join(', ') || 'N/A'}`;
        }).join('\n\n---\n\n');

        return {
          content: [{
            type: 'text',
            text: `找到 ${results.length} 筆相關記憶:\n\n${formatted}`
          }]
        };
      }

      case 'cc_memory_list': {
        const project = args.project as string;
        const limit = (args.limit as number) || 20;

        const results = await storage.listProjectMemories(project, limit);

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `專案 "${project}" 沒有任何記憶`
            }]
          };
        }

        const formatted = results.map((r, i) => {
          const date = new Date(r.created_at).toLocaleDateString('zh-TW');
          return `${i + 1}. [${date}] ${r.summary.substring(0, 100)}...`;
        }).join('\n');

        return {
          content: [{
            type: 'text',
            text: `專案 "${project}" 的記憶 (${results.length} 筆):\n\n${formatted}`
          }]
        };
      }

      case 'cc_memory_list_projects': {
        const projects = await storage.listProjects();

        if (projects.length === 0) {
          return {
            content: [{
              type: 'text',
              text: '目前沒有任何專案記憶'
            }]
          };
        }

        const formatted = projects.map((p) => {
          const date = new Date(p.last_updated).toLocaleDateString('zh-TW');
          return `- **${p.project_name}**: ${p.memory_count} 筆記憶 (最後更新: ${date})`;
        }).join('\n');

        return {
          content: [{
            type: 'text',
            text: `所有專案:\n\n${formatted}`
          }]
        };
      }

      case 'cc_memory_stats': {
        const project = args.project as string;
        const stats = await storage.getProjectStats(project);

        if (!stats) {
          return {
            content: [{
              type: 'text',
              text: `專案 "${project}" 沒有統計資料`
            }]
          };
        }

        const firstDate = new Date(stats.first_memory).toLocaleDateString('zh-TW');
        const lastDate = new Date(stats.last_memory).toLocaleDateString('zh-TW');

        return {
          content: [{
            type: 'text',
            text: `專案 "${project}" 統計:\n\n` +
              `- 總記憶數: ${stats.total_memories}\n` +
              `- 第一筆記憶: ${firstDate}\n` +
              `- 最後記憶: ${lastDate}\n` +
              `- 熱門關鍵字: ${stats.top_keywords?.join(', ') || 'N/A'}`
          }]
        };
      }

      case 'cc_memory_delete': {
        const id = args.id as string;
        await storage.deleteMemory(id);

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
