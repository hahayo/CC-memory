# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- cc-memory: project="CC-memory" -->

## 溝通規則（hard reminder，違反立刻 self-correct）

本 repo 強制執行 `~/.claude/rules/communication-style.md`（全域規則）：

- **英文技術名詞／縮寫／術語第一次出現**（chat reply、commit message、PR description、docs、code 周邊解釋文字）**必須立即在括號內附簡短繁中註解**。
- 常見字（repo / commit / hook / agent / push / migration / superuser / implication / schema）也照辦，不要因為「太常見」省略。
- Identifier（程式碼／檔案路徑／指令名稱）本身不加註，只在周邊解釋文字加註。
- 同段同詞不重複加註；精簡 ≠ 失真，註解不能改變條件、限制、風險、責任邊界。

例：`implication (含義／連帶影響)`、`superuser (超級使用者)`、`pgvector (向量擴充模組)`、`push mode (推送模式)`、`per-DB CHECK constraint (每資料庫範圍的檢查約束)`、`drift gate (漂移檢查關卡)`、`fresh schema (全新結構)`。

**Self-correct policy**：發現任一回覆漏註，下一則回覆**前 3 行內**先承認並補註，不要假裝沒事繼續。

## Project Overview

CC-memory 是一個 Claude Code 專案記憶同步系統，透過 MCP (Model Context Protocol) 協議提供跨裝置的專案記憶管理功能。系統使用 Drizzle ORM 連接 PostgreSQL（Coolify 部署，本機經 SSH tunnel 連線；2026-07-01 自 Zeabur 遷移完成），支援關鍵字／語義／混合搜尋和專案隔離。文件導覽入口：`docs/INDEX.md`。

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
主要進入點，實作 18 個 MCP 工具：

Memory（6）：
- `cc_memory_save` - 儲存記憶（summary, keywords, decisions, nextSteps）
- `cc_memory_search` - 關鍵字／語義／混合搜尋（省略 selector = 全專案搜尋，刻意 feature）
- `cc_memory_list` - 列出專案記憶（分頁支援）
- `cc_memory_get` - 取得單一記憶
- `cc_memory_stats` - 取得專案統計
- `cc_memory_delete` - 刪除記憶（軟刪除）

Task（6）：
- `cc_task_create` - 建立任務
- `cc_task_list` - 列出任務（status 過濾、分頁）
- `cc_task_update` - 更新任務（optimistic locking，需 expected_status）
- `cc_task_stats` - 任務統計 JSON（today/overdue/open/in_progress/completed_recently，日界 Asia/Taipei）
- `cc_task_set_reminder` - 設定提醒（remind_at 觸發時點 + 可選 recurrence；Personal-Hub Phase 1）
- `cc_task_snooze` - 暫緩提醒到 snooze_until（Personal-Hub Phase 1）

Reminder（1）：
- `cc_reminders_due` - 撈 + 認領到期提醒（poller 入口；會寫 reminder_log，read-only mode 下歸寫入類拒）

Todoist（5，需 `TODOIST_API_TOKEN` ∧ forced personal）：
- `cc_todoist_add` / `cc_todoist_projects` / `cc_todoist_list` / `cc_todoist_complete` / `cc_todoist_completed`

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
- `DATABASE_URL_PERSONAL` - 獨立 personal DB 連線（Phase 3 v0.4；見 `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md`）。forced personal instance **必填**；非 forced personal instance 偵測到 → warn + 拒絕載入該 URL（不 exit）
- `GEMINI_API_KEY` - 啟用語義搜尋 embedding（未設則自動降級 keyword-only）
- `CC_MEMORY_PROJECT_ID` - resolveProjectId 的 fallback layer（server 不知道自己在哪時用）
- `CC_FORCE_PROJECT_ID` - forced-mode：此 instance 鎖定單一 namespace（如 `__personal__`），所有工具強制 scope、拒絕跨 project；與 `CC_MEMORY_PROJECT_ID` 互斥（同設啟動 fail）。**設 `__personal__` 時必須同設 `DATABASE_URL_PERSONAL`**（缺則啟動 throw）
- `TODOIST_API_TOKEN` - 啟用 cc_todoist_* 工具（需同時 forced personal）
- `CC_READ_ONLY` - read-only mode（Phase 2）：寫入類 tool 在 ListTools 隱藏 + handler 拒絕（雙層 enforce）。給 `/hi` 注入等只讀消費端
- `CC_TOOL_ALLOWLIST` - 逗號分隔 tool 白名單（Phase 2）：只露/允許集合內 tool（含 read）；集合外兩層皆拒
- `CC_SEARCH_FEEDBACK` - search telemetry 開關（Phase 2，預設 on）：`off`/`0`/`false` 關閉 `cc_memory_search` 的 `search_feedback` 寫入

## Key Design Patterns

1. **專案隔離** - 所有查詢透過 `projectId` 過濾
2. **軟刪除** - 刪除操作將 status 設為 'archived'
3. **記憶類型** - session（一般對話）和 decision（重要決策）
4. **類型安全** - TypeScript strict mode + Drizzle ORM
5. **MCP 標準** - 使用 StdioServerTransport 實作
6. **保留 namespace** - `__personal__` 為個人近況/決策/待辦的保留 projectId。forced-mode instance 可讀寫；一般 project-mode instance 一律 deny（含全專案 search 於 WHERE 排除），避免個人資料外洩到專案 context

## 決策文件工作流程

- 在進行重大架構、系統行為或 config（設定）決策前，先讀 `docs/decisions/INDEX.md` 與相關決策卡。
- 只有使用者或負責人明確拍板的決策，才可寫入 `docs/decisions/_draft/`；agent（代理程式）不得自行接受決策。
- 若新討論只與既有決策卡相似，只能標為「未持久化推測」，不得視為已接受的決策。
- `supersedes`（取代）、`depends_on`（依賴）、`conflicts_with`（衝突）與 `related_to`（相關）四種持久化關係都須人工確認，不得由 agent 自動判定。
- 翻案時必須建立新卡，並以 `supersedes` 指向舊卡；不得直接改寫舊卡來掩蓋歷史。
- 決策接受後，須在同一個 commit（提交）更新 `docs/decisions/INDEX.md`，並執行 `npm run decisions:validate`。
