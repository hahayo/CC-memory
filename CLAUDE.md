# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CC-memory 是一個 Claude Code 專案記憶同步系統，透過 MCP (Model Context Protocol) 協議提供跨裝置的專案記憶管理功能。系統使用 Supabase (PostgreSQL + pgvector) 作為後端儲存，支援向量搜尋、關鍵字搜尋和全文搜尋。

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
- `cc_memory_save` - 儲存記憶（summary, keywords, decisions, tech_stack）
- `cc_memory_search` - 多策略搜尋（vector/keyword/fulltext）
- `cc_memory_list` - 列出專案記憶（分頁支援）
- `cc_memory_list_projects` - 列出所有專案
- `cc_memory_stats` - 取得專案統計
- `cc_memory_delete` - 刪除記憶

### Storage Layer (src/storage/)
- `supabase.ts` - SupabaseStorage 類別封裝所有資料庫操作
- `types.ts` - TypeScript 介面定義（Memory, SearchResult, ProjectStats 等）

### Database (sql/schema.sql)
- 表格 `project_memories` 使用 `VECTOR(384)` 欄位支援語意搜尋
- 包含 IVFFlat 向量索引、GIN 陣列索引、全文搜尋索引
- PostgreSQL 函數處理搜尋邏輯

### Skills (skills/)
- `extract-memory.md` - `/extract-memory` 指令，分析對話並萃取記憶

## Environment Variables

必要環境變數：
- `SUPABASE_URL` - Supabase 專案 URL
- `SUPABASE_KEY` - Supabase service role key

## Key Design Patterns

1. **專案隔離** - 所有查詢透過 `project_name` 過濾
2. **多策略搜尋** - 優雅降級：向量 → 關鍵字 → 全文
3. **類型安全** - TypeScript strict mode 啟用
4. **MCP 標準** - 使用 StdioServerTransport 實作
