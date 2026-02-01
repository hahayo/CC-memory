---
name: extract-memory
description: 萃取當前 session 的記憶並存入資料庫
---

# Extract Memory Skill

當用戶執行 `/extract-memory` 時，請執行以下步驟：

## 步驟 1: 分析當前對話

回顧這個 session 的所有對話，分析並萃取以下資訊：

1. **摘要** (summary): 用 3-5 句話總結這個 session 做了什麼
2. **關鍵字** (keywords): 10-15 個相關的關鍵字或短語
3. **決策** (decisions): 列出做出的重要決策
4. **技術棧** (tech_stack): 使用或討論的技術、工具、框架

## 步驟 2: 確定專案名稱

從當前工作目錄推斷專案名稱：
- 如果在 `/workspaces/AI_Project/xxx` 下，專案名稱為 `xxx`
- 如果在其他目錄，使用目錄名稱

## 步驟 3: 儲存記憶

使用 `cc_memory_save` 工具儲存記憶：

```
cc_memory_save({
  project_name: "推斷的專案名稱",
  summary: "你分析出的摘要",
  keywords: ["關鍵字1", "關鍵字2", ...],
  decisions: ["決策1", "決策2", ...],
  tech_stack: ["技術1", "技術2", ...]
})
```

## 步驟 4: 確認結果

告訴用戶記憶已儲存，並顯示摘要。

---

## 輸出範例

```
✅ Session 記憶已萃取並儲存

📁 專案: CC-memory
📝 摘要: 建立了 CC-memory 專案，這是一個 Claude Code 記憶同步系統。
        實作了 Supabase 儲存層和 MCP Server，支援向量搜尋和專案隔離。

🏷️ 關鍵字: MCP, Supabase, PostgreSQL, pgvector, TypeScript, 記憶系統

📋 決策:
  - 使用 TypeScript 開發
  - 使用 Supabase 作為後端
  - 採用 MCP 標準協議

🛠️ 技術棧: TypeScript, Node.js, Supabase, PostgreSQL, pgvector, MCP SDK
```

---

## 注意事項

- 如果這個 session 沒有實質內容（只是閒聊或簡單問答），可以跳過萃取
- 摘要應該聚焦在**做了什麼**和**為什麼**，而不是對話的細節
- 關鍵字應該是可搜尋的詞彙
- 決策應該是有價值的資訊，未來可以參考
