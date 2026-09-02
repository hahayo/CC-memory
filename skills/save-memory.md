---
name: save-memory
description: 儲存當前 session 的記憶到資料庫
---

# Save Memory Skill

當用戶執行 `/save-memory` 時，請執行以下步驟：

## 步驟 1: 分析當前對話

回顧這個 session 的所有對話，分析並萃取以下資訊：

1. **類型** (type): 判斷是 `session`（一般對話）還是 `decision`（重要決策）
2. **摘要** (summary): 用 3-5 句話總結這個 session 做了什麼
3. **關鍵字** (keywords): 10-15 個相關的關鍵字或短語
4. **決策** (decisions): 列出做出的重要決策（如果有）
5. **下一步** (next_steps): 列出待辦事項或下一步計畫（如果有）

## 步驟 2: 顯示預覽

在儲存前，先顯示萃取結果讓用戶確認：

```
📝 記憶預覽

【類型】Session 記憶
【摘要】
今天實作了 Drizzle ORM 連線設定，建立了 project_memories 表的 schema...

【關鍵字】drizzle, orm, postgresql, schema, migration

【決策】
- 選擇 Drizzle 而非 Prisma（輕量、適合 MCP）

【下一步】
- 實作搜尋功能
- 加入測試

確認儲存？(Y/n)
```

## 步驟 3: 儲存記憶

如果用戶確認，使用 `cc_memory_save` 工具儲存記憶：

```
cc_memory_save({
  project_path: "{當前工作目錄的絕對路徑}",  // 必填：v0.3 起，MCP server 依此解析 project_id
  type: "session",
  summary: "你分析出的摘要",
  keywords: ["關鍵字1", "關鍵字2", ...],
  decisions: ["決策1", "決策2", ...],
  next_steps: ["下一步1", "下一步2", ...]
})
```

> **重要 (v0.3)**：`project_path` 必須傳入當前工作目錄。MCP server 的 `process.cwd()`
> 是 server process 啟動目錄而非 client 端，若不傳 server 無法讀 CLAUDE.md marker
> 或找 git 根目錄。若明確已知 `project_id`，可改傳 `project_id` 參數跳過解析。

## 步驟 4: 確認結果

告訴用戶記憶已儲存，並顯示 ID。

---

## 判斷記憶類型

- **session**: 一般的工作對話，包含實作、除錯、討論等
- **decision**: 重要的技術決策，例如：
  - 選擇技術棧
  - 架構決定
  - 設計模式選擇
  - 重大重構決定

如果對話中包含重要決策，建議儲存為 `decision` 類型。

---

## 注意事項

- 如果這個 session 沒有實質內容（只是閒聊或簡單問答），可以跳過儲存
- 摘要應該聚焦在**做了什麼**和**為什麼**，而不是對話的細節
- 關鍵字應該是可搜尋的詞彙
- 決策應該是有價值的資訊，未來可以參考
