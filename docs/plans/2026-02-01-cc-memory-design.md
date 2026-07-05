# CC-memory 設計文件

> **[HISTORICAL（歷史文件）2026-07-05]** v0.1 原始設計。下方「待實作」狀態早已過時——v0.1～v0.3 及 personal-hub 均已交付。僅供溯源；現況入口見 `docs/INDEX.md`。

> 建立日期：2026-02-01
> 狀態：已確認，待實作（← 歷史快照，見上方標記）

## 1. 系統概述

**CC-memory** 是一個 Claude Code 專案記憶系統，讓你在不同裝置、不同 session 間保持專案上下文的連續性。

### 核心價值
- 跨裝置存取同一專案的記憶
- Session 結束時一鍵儲存對話重點
- 下次開啟專案時自動顯示上次進度

### 技術架構
```
Claude Code ←→ MCP Server (CC-memory) ←→ PostgreSQL (Zeabur)
     ↓
  Hooks/Skills（觸發存取）
```

### 使用情境
- 個人跨裝置使用（公司、家裡多台電腦）
- AI 對話延續（不同 Claude Code session 記住之前討論）

### 記憶內容優先順序
1. 決策紀錄 - 為什麼選 A 不選 B
2. 專案狀態 - 目前進度、下一步
3. 對話摘要 - session 討論了什麼
4. 程式碼上下文 - 實作細節（次要）

### 記憶類型
| 類型 | 用途 | 範例 |
|------|------|------|
| `session` | 對話摘要 | 「1/25 實作了登入功能，下一步做權限」 |
| `decision` | 決策紀錄 | 「選 Drizzle 因為輕量、適合 MCP」 |

---

## 2. 資料模型

### Memory 表結構

```sql
CREATE TABLE project_memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 專案識別
  project_id    TEXT NOT NULL,        -- 從 CLAUDE.md / git / 目錄取得
  project_path  TEXT,                 -- 原始路徑（debug 用）

  -- 記憶類型
  type          TEXT NOT NULL,        -- 'session' | 'decision'

  -- 內容
  summary       TEXT NOT NULL,        -- 主要摘要
  keywords      TEXT[] DEFAULT '{}',  -- 搜尋用關鍵字
  decisions     TEXT[] DEFAULT '{}',  -- 決策列表（session 類型用）
  next_steps    TEXT[] DEFAULT '{}',  -- 待辦/下一步

  -- 狀態
  status        TEXT DEFAULT 'active', -- 'active' | 'merged' | 'archived'
  merged_into   UUID,                  -- 合併後指向新記憶

  -- 元資料
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_memories_project ON project_memories(project_id);
CREATE INDEX idx_memories_type ON project_memories(type);
CREATE INDEX idx_memories_keywords ON project_memories USING GIN(keywords);
CREATE INDEX idx_memories_summary_fts ON project_memories
  USING GIN(to_tsvector('english', summary));
```

### 與原 schema 的差異
- 移除 `embedding` 欄位（MVP 不用向量搜尋）
- 新增 `type` 區分 session/decision
- `tech_stack` 改為 `next_steps`（更符合實際用途）
- 新增 `status` 和 `merged_into`（支援未來合併功能）

---

## 3. MCP Tools 設計

### 工具列表

| 工具 | 用途 | 參數 |
|------|------|------|
| `cc_memory_save` | 儲存記憶 | `type`, `summary`, `keywords`, `decisions`, `next_steps` |
| `cc_memory_search` | 搜尋記憶 | `query`, `type?`, `limit?` |
| `cc_memory_list` | 列出記憶 | `limit?`, `offset?`, `type?` |
| `cc_memory_get` | 取得單筆 | `id` |
| `cc_memory_delete` | 刪除記憶 | `id` |
| `cc_memory_stats` | 專案統計 | 無 |

### 專案識別邏輯

優先順序：
1. 讀取當前目錄的 CLAUDE.md，解析 `<!-- cc-memory: project="xxx" -->` 標記
2. 若無標記，嘗試 git remote URL 的 repo 名稱
3. 若無 git，使用目錄名稱

### 搜尋策略

```
cc_memory_search(query="資料庫設計")
  ↓
1. 關鍵字搜尋：keywords @> ARRAY['資料庫', '設計']
2. 全文搜尋：to_tsvector(summary) @@ to_tsquery(query)
3. 合併結果，去重，按時間排序
```

---

## 4. Hooks & Skills 設計

### Session 開始 Hook

檔案：`hooks/session-start.json`

觸發後執行 `/load-memory` skill，自動顯示：
```
📋 專案記憶載入完成 (my-project)

【上次進度】2026-01-25
- 完成了登入功能實作
- 討論了 API 架構設計

【待處理】
- 實作權限控制
- 加入單元測試

【近期決策】
- 選擇 Drizzle 作為 ORM（輕量、適合 MCP）
```

### Session 結束 Hook

檔案：`hooks/session-end.json`

顯示提醒：`💡 輸入 /save-memory 儲存這次的對話記憶`

### /save-memory Skill 流程

```
用戶輸入 /save-memory
    ↓
Claude 分析對話，萃取：
  - summary（3-5 句摘要）
  - keywords（10-15 個關鍵字）
  - decisions（本次決策）
  - next_steps（下一步待辦）
    ↓
顯示預覽，請用戶確認
    ↓
呼叫 cc_memory_save 儲存
```

### /load-memory Skill

- 自動偵測專案 ID
- 呼叫 `cc_memory_list` 取得最近記憶
- 格式化顯示

---

## 5. 目錄結構

```
CC-memory/
├── src/
│   ├── index.ts              # MCP Server 進入點
│   ├── config.ts             # 環境變數、設定
│   ├── db/
│   │   ├── schema.ts         # Drizzle schema 定義
│   │   ├── client.ts         # PostgreSQL 連線
│   │   └── migrations/       # Drizzle migrations
│   ├── tools/
│   │   ├── save.ts           # cc_memory_save
│   │   ├── search.ts         # cc_memory_search
│   │   ├── list.ts           # cc_memory_list
│   │   ├── get.ts            # cc_memory_get
│   │   ├── delete.ts         # cc_memory_delete
│   │   └── stats.ts          # cc_memory_stats
│   └── utils/
│       ├── project-id.ts     # 專案識別邏輯
│       └── search.ts         # 搜尋合併邏輯
├── skills/
│   ├── save-memory.md        # /save-memory skill
│   └── load-memory.md        # /load-memory skill
├── hooks/
│   ├── session-start.json    # 開始時載入
│   └── session-end.json      # 結束時提醒
├── sql/
│   └── schema.sql            # 原始 SQL（參考用）
├── tests/
│   ├── tools/                # 工具單元測試
│   └── utils/                # 工具函數測試
├── docs/
│   ├── setup.md
│   └── usage.md
├── drizzle.config.ts         # Drizzle 設定
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

---

## 6. 實作順序

### Phase 1 - 基礎建設
1. 設定 Drizzle + PostgreSQL 連線
2. 建立 schema 和 migration
3. 在 Zeabur 部署 PostgreSQL

### Phase 2 - 核心工具
4. 實作 `project-id.ts`（專案識別）
5. 實作 `cc_memory_save`
6. 實作 `cc_memory_search`（關鍵字 + 全文）
7. 實作 `cc_memory_list`、`get`、`delete`、`stats`

### Phase 3 - Skills & Hooks
8. 建立 `/save-memory` skill
9. 建立 `/load-memory` skill
10. 設定 session-start、session-end hooks

### Phase 4 - 測試與文件
11. 撰寫工具測試
12. 更新 CLAUDE.md 和文件

---

## 7. 技術選型摘要

| 項目 | 選擇 | 原因 |
|------|------|------|
| 資料庫 | PostgreSQL | 自架、完全控制 |
| 部署 | Zeabur | 雲端託管、跨裝置存取 |
| ORM | Drizzle | 輕量、適合 MCP server |
| 搜尋 | 關鍵字 + 全文 | MVP 先用，保留向量搜尋擴展 |
| 認證 | 連線字串 | 個人使用，簡單即可 |

---

## 8. 未來迭代（MVP 之後）

- [ ] Session 開始自動載入摘要
- [ ] 對話中智慧召回
- [ ] 決策自動偵測
- [ ] 自動合併舊記憶
- [ ] 向量搜尋（多語言模型）
