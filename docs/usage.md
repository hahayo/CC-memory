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

### cc_memory_save

儲存記憶到資料庫。

參數：
- `project_id`: 專案 ID（可選，自動偵測）
- `project_path`: 專案路徑（可選）
- `type` (必填): 'session' 或 'decision'
- `summary` (必填): 記憶摘要
- `keywords`: 關鍵字陣列
- `decisions`: 決策陣列
- `next_steps`: 下一步待辦陣列

### cc_memory_search

搜尋相關記憶。

參數：
- `query` (必填): 搜尋查詢
- `project_id`: 限定專案
- `type`: 限定類型
- `limit`: 結果數量（預設 10）

### cc_memory_list

列出專案的記憶。

參數：
- `project_id` (必填): 專案 ID
- `type`: 限定類型
- `limit`: 結果數量（預設 20）
- `offset`: 分頁偏移

### cc_memory_get

取得單一記憶詳情。

參數：
- `id` (必填): 記憶 ID

### cc_memory_stats

取得專案統計。

參數：
- `project_id` (必填): 專案 ID

### cc_memory_delete

刪除指定記憶（軟刪除）。

參數：
- `id` (必填): 記憶 ID

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
