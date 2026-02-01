# CC-memory 使用指南

## 基本使用

### 萃取記憶

在 session 結束前，執行：

```
/extract-memory
```

Claude 會自動分析對話內容，萃取摘要、關鍵字、決策和技術棧，並儲存到資料庫。

### 搜尋記憶

直接詢問 Claude：

```
搜尋關於 "React component" 的記憶
```

或指定專案：

```
在 CC-memory 專案中搜尋 "Supabase" 相關的記憶
```

### 列出專案

```
列出所有有記憶的專案
```

### 查看專案記憶

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
- `project_name` (必填): 專案名稱
- `summary` (必填): 記憶摘要
- `keywords`: 關鍵字陣列
- `decisions`: 決策陣列
- `tech_stack`: 技術棧陣列
- `embedding`: 向量 embedding

### cc_memory_search

搜尋相關記憶。

參數：
- `query` (必填): 搜尋查詢
- `project`: 限定專案
- `keywords`: 關鍵字搜尋
- `embedding`: 向量搜尋
- `limit`: 結果數量

### cc_memory_list

列出專案的所有記憶。

參數：
- `project` (必填): 專案名稱
- `limit`: 結果數量

### cc_memory_list_projects

列出所有有記憶的專案。

### cc_memory_stats

取得專案統計。

參數：
- `project` (必填): 專案名稱

### cc_memory_delete

刪除指定記憶。

參數：
- `id` (必填): 記憶 ID

## 最佳實踐

### 1. 定期萃取

每個重要的 session 結束前，執行 `/extract-memory`。

### 2. 專案命名一致

確保同一個專案使用一致的名稱，方便搜尋和管理。

### 3. 有意義的摘要

萃取時，確保摘要包含：
- 做了什麼
- 為什麼這樣做
- 重要的決策

### 4. 善用關鍵字

使用可搜尋的關鍵字，例如：
- 技術名稱：React, TypeScript, PostgreSQL
- 功能：authentication, API, database
- 概念：refactoring, optimization, bug fix

## 進階使用

### 手動儲存記憶

如果想要手動控制儲存的內容：

```
請使用 cc_memory_save 儲存以下記憶：
- 專案：my-project
- 摘要：實作了用戶認證功能，使用 JWT token
- 關鍵字：authentication, JWT, security
- 決策：選擇 JWT 而不是 session-based auth
- 技術棧：Node.js, jsonwebtoken, bcrypt
```

### 向量搜尋

如果有 embedding，可以進行語義搜尋：

```
使用向量搜尋找到與 "用戶登入流程" 語義相近的記憶
```

### 跨專案搜尋

不指定專案，搜尋所有記憶：

```
在所有專案中搜尋 "database migration" 相關的記憶
```
