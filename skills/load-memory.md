---
name: load-memory
description: 載入專案記憶並顯示摘要
---

# Load Memory Skill

當用戶執行 `/load-memory` 時，請執行以下步驟：

## 步驟 1: 偵測當前專案

傳 `project_path`（當前工作目錄絕對路徑）給 MCP tool，server 端會用以下 5 層優先序解析 project_id：

1. 明示的 `project_id` 參數
2. 環境變數 `CC_MEMORY_PROJECT_ID`
3. CLAUDE.md 中的 `<!-- cc-memory: project="xxx" -->` 標記
4. git 根目錄名（往上找到 `.git` 的那層目錄名；2026-09-02 起取代 git origin `owner/repo`，與 capture hooks 一致）
5. basename(project_path)

> v0.3 起 MCP server 的 `process.cwd()` 不可靠（是 server 啟動目錄），
> 因此 skill 必須在每次呼叫都傳 `project_path`。

## 步驟 2: 取得專案統計

使用 `cc_memory_stats` 工具取得統計資訊：

```
cc_memory_stats({
  project_path: "{當前工作目錄絕對路徑}"
})
```

## 步驟 3: 取得最近記憶

使用 `cc_memory_list` 工具取得最近的記憶：

```
cc_memory_list({
  project_path: "{當前工作目錄絕對路徑}",
  limit: 5
})
```

## 步驟 4: 取得近期決策

使用 `cc_memory_list` 工具取得近期的重要決策：

```
cc_memory_list({
  project_path: "{當前工作目錄絕對路徑}",
  type: "decision",
  limit: 3
})
```

## 步驟 5: 格式化顯示

整合上述資訊，以友善的格式顯示：

```
📋 專案記憶載入完成 (project-name)

【統計】12 筆記憶 | 8 session | 4 decision

【上次進度】2026-01-25
- 完成了登入功能實作
- 討論了 API 架構設計

【待處理】
- 實作權限控制
- 加入單元測試

【近期決策】
- 選擇 Drizzle 作為 ORM（輕量、適合 MCP）
- PostgreSQL 部署於 Coolify（2026-07-01 自 Zeabur 遷移）
```

---

## 注意事項

- 如果專案沒有任何記憶，提示用戶這是新專案
- 待處理項目從最近記憶的 `next_steps` 欄位取得
- 如果記憶數量很多，只顯示最近的摘要
