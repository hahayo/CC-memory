# CC-memory 使用指南

## 基本使用

### 儲存記憶

在 session 結束前，執行：

```
/save-memory
```

Claude 會：
1. 分析對話內容
2. 萃取摘要、關鍵字、決策、下一步
3. 顯示預覽讓你確認
4. 儲存到資料庫

### 載入記憶

開始新 session 時，執行：

```
/load-memory
```

Claude 會：
1. 偵測當前專案
2. 顯示專案統計
3. 顯示最近進度和待處理項目
4. 顯示近期決策

### 搜尋記憶

直接詢問 Claude：

```
搜尋關於 "React component" 的記憶
```

或指定專案：

```
在 CC-memory 專案中搜尋 "Drizzle" 相關的記憶
```

### 列出專案記憶

```
列出 CC-memory 專案的所有記憶
```

### 查看統計

```
顯示 CC-memory 專案的記憶統計
```

## MCP Tools

### Scope selector 契約（重要）

除 `cc_memory_search` 外，**所有工具都必須帶 `project_id` 或 `project_path`（擇一必填）**，否則回 `INVALID_ARGUMENT`（fail-fast，不自動偵測）。

原因：MCP server 的 `process.cwd()` 是 server 啟動目錄，**不是** client 的工作目錄，無法可靠推出你在哪個 project。`skills/{save,load}-memory.md` 已示範 tool call 時傳 `project_path` 為當前工作目錄絕對路徑。

- `project_id`：專案 ID（優先序最高）。
- `project_path`：client 端**絕對路徑**且須為**存在的目錄**（用來解析 project_id；相對路徑 / 不存在的路徑會被拒）。
- 兩者皆給時：以 `project_id` 為準，`project_path` 視為附帶資訊。

> `cc_memory_search` 是刻意例外：省略 selector = 全專案搜尋（feature），詳見下方。

### cc_memory_save

儲存記憶到資料庫。

參數：
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。
- `type` (必填): 'session' 或 'decision'
- `summary` (必填): 記憶摘要
- `keywords`: 關鍵字陣列
- `decisions`: 決策陣列
- `next_steps`: 下一步待辦陣列
- `idempotency_key`: client 冪等鍵（可選）。同 key + 同 payload 回既有 id；同 key + 不同 payload 回 `IDEMPOTENCY_CONFLICT`。

### cc_memory_search

搜尋相關記憶（關鍵字 / 語義 / 混合）。

參數：
- `query` (必填): 搜尋查詢（非空字串）。
- `project_id` / `project_path`：**可選**。省略 = 全專案搜尋（自動排除保留 namespace，見下方）。
- `type`: 限定類型（'session' 或 'decision'）。
- `mode`: 'keyword' | 'semantic' | 'hybrid'（預設 hybrid；embedding 未啟用時自動降級 keyword）。
- `limit`: 結果數量（預設 10）

### cc_memory_list

列出專案的記憶。

參數：
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。
- `type`: 限定類型（'session' 或 'decision'）。
- `limit`: 結果數量（預設 20）
- `offset`: 分頁偏移

### cc_memory_get

取得單一記憶詳情（scope 保護：避免跨 project 讀取）。

參數：
- `id` (必填): 記憶 ID
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。

### cc_memory_stats

取得專案統計。

參數：
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。

### cc_memory_delete

刪除指定記憶（軟刪除，標記為 archived；scope 保護：避免跨 project 意外刪除）。

參數：
- `id` (必填): 記憶 ID
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。

## Task Tools

### cc_task_create

建立新任務。

參數：
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。
- `title` (必填): 任務標題（1-500 字）。
- `description`: 詳細說明（可選）。
- `status`: 'open' | 'in_progress' | 'done' | 'cancelled'（預設 open）。
- `priority`: 'low' | 'normal' | 'high'（預設 normal）。
- `due_date`: 截止日 ISO 8601（可選；`YYYY-MM-DD` 或帶時間 `YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:MM]`）。
- `tags`: 字串陣列（可選）。
- `source`: 'manual' | 'telegram' | 'claude-code' | 'codex' | 'mcp'（預設 mcp）。
- `idempotency_key`: client 冪等鍵（可選）。

### cc_task_list

列出專案任務（預設排除 cancelled）。

參數：
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。
- `status`: 單一狀態字串或狀態陣列過濾。
- `limit`: 結果數量（預設 20）
- `offset`: 分頁偏移

### cc_task_update

更新任務（帶 optimistic locking）。

參數：
- `id` (必填): 任務 ID
- `project_id` / `project_path`：擇一必填（避免跨 project UUID 改動）。
- `expected_status` (必填): client 以為的當前 status；不符即 `CONFLICT`。
- `title` / `description` / `status` / `priority` / `due_date` / `tags`: 欲更新的欄位（可選；`status` 須符合狀態轉移矩陣，否則 `INVALID_TRANSITION`）。

### cc_task_stats

取得專案任務統計（結構化 JSON，供 /hi 與 cron 使用；日界固定 Asia/Taipei）。

參數：
- `project_id` / `project_path`：擇一必填（見上方 scope 契約）。
- `completed_since_days`: completed_recently 視窗天數（預設 7）。

回傳欄位：`today` / `overdue` / `open` / `in_progress` / `completed_recently`。

## 保留 namespace 與 forced-mode

`__personal__` 是個人近況 / 決策 / 待辦的**保留 namespace**：

- **一般 project-mode instance**：一律 deny `__personal__`（含顯式 `project_id`、或 `project_path` / CLAUDE.md marker / git 解析出 `__personal__` 的所有入口），全專案搜尋也在 WHERE 排除——避免個人資料外洩到專案 context。
- **forced-mode instance**（啟動時設 `CC_FORCE_PROJECT_ID`，例如 `__personal__`）：此 instance 鎖定該單一 namespace，所有工具強制 scope、selector 變為可選（無 selector 即套用 forced project），並拒絕跨 project 存取。
- `CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID` **互斥**（同時設定會啟動失敗）。

## 記憶類型

### Session 記憶

一般的工作對話，包含：
- 實作功能
- 除錯修復
- 討論設計
- 程式碼審查

### Decision 記憶

重要的技術決策：
- 選擇技術棧
- 架構決定
- 設計模式選擇
- 重大重構決定

## 最佳實踐

### 1. 定期儲存

每個重要的 session 結束前，執行 `/save-memory`。

### 2. 使用有意義的關鍵字

使用可搜尋的關鍵字，例如：
- 技術名稱：React, TypeScript, PostgreSQL
- 功能：authentication, API, database
- 概念：refactoring, optimization, bug fix

### 3. 記錄決策

重要決策時，選擇 'decision' 類型儲存，方便日後查詢：
- 為什麼選擇這個技術？
- 考慮過哪些替代方案？
- 有什麼 trade-off？

### 4. 利用下一步

記錄下一步待辦，下次 `/load-memory` 時會顯示。

## 進階使用

### 手動儲存記憶

如果想要手動控制儲存的內容：

```
請使用 cc_memory_save 儲存以下記憶：
- 類型：decision
- 摘要：選擇 Drizzle ORM 作為資料庫操作層
- 關鍵字：drizzle, orm, database, typescript
- 決策：Drizzle 比 Prisma 更輕量，適合 MCP server 使用
```

### 跨專案搜尋

不指定專案，搜尋所有記憶：

```
搜尋所有專案中關於 "authentication" 的記憶
```

### 按類型篩選

只列出決策記憶：

```
列出 CC-memory 專案的所有決策記憶
```
