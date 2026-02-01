# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- cc-memory: project="CC-memory" -->

## Project Overview

CC-memory 是一個 Claude Code 專案記憶同步系統，透過 MCP (Model Context Protocol) 協議提供跨裝置的專案記憶管理功能。系統使用 Drizzle ORM 連接 PostgreSQL（Zeabur 部署），支援關鍵字搜尋和專案隔離。

## Build Commands

```bash
npm run build    # 編譯 TypeScript 到 build/ 目錄
npm run dev      # Watch 模式編譯
npm start        # 啟動 MCP server
npm test         # 執行 vitest 測試
npm run lint     # ESLint 檢查 src/**/*.ts
npm run clean    # 清除 build/ 目錄
```

## Architecture

### MCP Server (src/index.ts)
主要進入點，實作 6 個 MCP 工具：
- `cc_memory_save` - 儲存記憶（summary, keywords, decisions, nextSteps）
- `cc_memory_search` - 關鍵字搜尋
- `cc_memory_list` - 列出專案記憶（分頁支援）
- `cc_memory_get` - 取得單一記憶
- `cc_memory_stats` - 取得專案統計
- `cc_memory_delete` - 刪除記憶（軟刪除）

### Database Layer (src/db/)
- `schema.ts` - Drizzle schema 定義（projectMemories 表）
- `client.ts` - 資料庫連線設定

### Tools (src/tools/)
- `save.ts` - 儲存記憶
- `search.ts` - 搜尋記憶
- `list.ts` - 列出記憶
- `get.ts` - 取得記憶
- `delete.ts` - 刪除記憶
- `stats.ts` - 統計資訊
- `index.ts` - 匯出所有工具

### Utils (src/utils/)
- `project-id.ts` - 專案 ID 偵測（從 CLAUDE.md 標記或目錄名稱）

### Skills (skills/)
- `save-memory.md` - `/save-memory` 指令，分析對話並儲存記憶
- `load-memory.md` - `/load-memory` 指令，載入專案記憶上下文

### Hooks (hooks/)
- `session-end.json` - Session 結束提醒儲存記憶
- `session-start.json` - Session 開始載入記憶（預設關閉）

## Environment Variables

必要環境變數：
- `DATABASE_URL` - PostgreSQL 連線字串

## Key Design Patterns

1. **專案隔離** - 所有查詢透過 `projectId` 過濾
2. **軟刪除** - 刪除操作將 status 設為 'archived'
3. **記憶類型** - session（一般對話）和 decision（重要決策）
4. **類型安全** - TypeScript strict mode + Drizzle ORM
5. **MCP 標準** - 使用 StdioServerTransport 實作
