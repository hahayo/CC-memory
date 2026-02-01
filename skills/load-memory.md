---
name: load-memory
description: 載入專案記憶並顯示摘要
---

# Load Memory Skill

當用戶執行 `/load-memory` 時，請執行以下步驟：

## 步驟 1: 偵測當前專案

從當前工作目錄推斷專案 ID：
- 優先檢查 CLAUDE.md 中是否有 `<!-- cc-memory: project="xxx" -->` 標記
- 如果沒有，使用目錄名稱

## 步驟 2: 取得專案統計

使用 `cc_memory_stats` 工具取得統計資訊：

```
cc_memory_stats({
  project_id: "{偵測到的專案 ID}"
})
```

## 步驟 3: 取得最近記憶

使用 `cc_memory_list` 工具取得最近的記憶：

```
cc_memory_list({
  project_id: "{偵測到的專案 ID}",
  limit: 5
})
```

## 步驟 4: 取得近期決策

使用 `cc_memory_list` 工具取得近期的重要決策：

```
cc_memory_list({
  project_id: "{偵測到的專案 ID}",
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
- 使用 Zeabur 部署 PostgreSQL
```

---

## 注意事項

- 如果專案沒有任何記憶，提示用戶這是新專案
- 待處理項目從最近記憶的 `next_steps` 欄位取得
- 如果記憶數量很多，只顯示最近的摘要
