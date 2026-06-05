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
主要進入點，實作 10 個 MCP 工具：

Memory（6）：
- `cc_memory_save` - 儲存記憶（summary, keywords, decisions, nextSteps）
- `cc_memory_search` - 關鍵字／語義／混合搜尋（省略 selector = 全專案搜尋，刻意 feature）
- `cc_memory_list` - 列出專案記憶（分頁支援）
- `cc_memory_get` - 取得單一記憶
- `cc_memory_stats` - 取得專案統計
- `cc_memory_delete` - 刪除記憶（軟刪除）

Task（4）：
- `cc_task_create` - 建立任務
- `cc_task_list` - 列出任務（status 過濾、分頁）
- `cc_task_update` - 更新任務（optimistic locking，需 expected_status）
- `cc_task_stats` - 任務統計 JSON（today/overdue/open/in_progress/completed_recently，日界 Asia/Taipei）

> 除 `cc_memory_search` 外，所有工具皆 fail-fast：必須帶 `project_id` 或 `project_path`（MCP server 的 cwd 非 client cwd，無法可靠解析）。ScopePolicy（`src/services/scope-policy.ts`）統一決策 forced-mode / project-mode deny。

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

可選環境變數：
- `GEMINI_API_KEY` - 啟用語義搜尋 embedding（未設則自動降級 keyword-only）
- `CC_MEMORY_PROJECT_ID` - resolveProjectId 的 fallback layer（server 不知道自己在哪時用）
- `CC_FORCE_PROJECT_ID` - forced-mode：此 instance 鎖定單一 namespace（如 `__personal__`），所有工具強制 scope、拒絕跨 project；與 `CC_MEMORY_PROJECT_ID` 互斥（同設啟動 fail）

## Key Design Patterns

1. **專案隔離** - 所有查詢透過 `projectId` 過濾
2. **軟刪除** - 刪除操作將 status 設為 'archived'
3. **記憶類型** - session（一般對話）和 decision（重要決策）
4. **類型安全** - TypeScript strict mode + Drizzle ORM
5. **MCP 標準** - 使用 StdioServerTransport 實作
6. **保留 namespace** - `__personal__` 為個人近況/決策/待辦的保留 projectId。forced-mode instance 可讀寫；一般 project-mode instance 一律 deny（含全專案 search 於 WHERE 排除），避免個人資料外洩到專案 context
