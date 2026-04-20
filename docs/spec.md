# CC-memory v0.2 Spec

> Spec 版本：1.1（Codex plan review 修訂） · 範圍：路線 A 最保守自建

---

## Context

### 為什麼做這個改動

CC-memory 目前（v0.1）透過 MCP stdio 只對 **Claude Code** 開放。使用者的原始需求是：

1. 跨 session / 跨專案 / 跨電腦 — 現有 PG 雲端已達成
2. **跨工具**：Claude Code + Codex CLI 都能讀寫
3. **Telegram 介面**：隨時查詢記憶、輸入代辦事項

目前架構只能讓 Claude Code 用。缺的是**工具不可知的介面層**與**代辦事項資料模型**。

### 為什麼選路線 A（最保守）

Codex 魔鬼代言人審查指出三個「3-6 個月會重寫」的陷阱：

1. todo 併入 memory 表遲早補第二套 schema
2. Stop hook 自動抽取未驗證 retrieval 可信前就平台化 → 長期記憶汙染
3. Telegram「最後活躍專案」會悄悄錯 project，信任一崩整個 bot 死

路線 A 的核心原則：**先證明 retrieval 可信 + 手動寫入夠用，再談自動化**。

### Spec 1.1 關鍵修訂（來自 Codex plan review）

- ➕ **Day 0：Schema alignment**（`sql/schema.sql` 是死檔舊 Supabase 版，必須砍掉；Drizzle 為唯一真實來源）
- 🔧 **架構路徑定死**：`MCP → service` / `HTTP → service` / **`Telegram bot → HTTP`**（不走後門）
- 🔧 **Token 分權**：`BOT_API_TOKEN`（受限範圍）vs `ADMIN_API_TOKEN`（跨專案讀、刪除）
- 🔧 **未選 project 就拒寫**：不做「最後活躍」fallback，強制顯式
- 🔧 **Undo 改用 `pending_until` + idempotency_key**，不靠 timer
- 🔧 **`search_feedback` 補 6 個欄位**才能做 retrieval 決策
- ➕ **加 rollout 順序與回滾策略**

---

## Goals（使用者原始 3 個需求）

1. 跨 session / 跨專案 / 跨電腦 — 現有 PG 雲端已達成
2. **跨工具**：Claude Code + Codex CLI 都能讀寫
3. **Telegram 介面**：隨時查詢記憶、輸入代辦事項

---

## Non-goals（Out of Scope，明確不做）

- ❌ Stop hook 自動抽取（Layer 1 atom observations）
- ❌ `candidate_memories` 表與 `/promote` 流程
- ❌ provenance / temporal validity 欄位
- ❌ Layer 3 topic compilation
- ❌ 多 bot 平台 / 語音 / 圖片 / 檔案
- ❌ 衝突合併 / conflict resolution
- ❌ 改 `project_memories` 欄位結構
- ❌ Web UI / 完整 i18n
- ❌ 任何 LLM 自動抽取 / 摘要 / 結構化
- ❌ Sentry / Datadog（log 夠用）
- ❌ Rate limit 細緻化（MVP 單人使用）

---

## Scope 摘要

| 項目 | 說明 |
|---|---|
| **Day 0 Schema alignment** | 刪 `sql/schema.sql`（死檔），Drizzle 當唯一真實來源 |
| **Schema 擴充** | 新增 `tasks`、`search_feedback` 表；保留 `project_memories` 不動 |
| **Service layer 抽出** | `src/services/` 純業務邏輯，MCP / HTTP 共用（bot 不直接用） |
| **HTTP REST API** | Hono + 雙 token 分權，部署 Zeabur 與 PG 同處 |
| **Telegram bot** | `telegraf` 獨立進程，**只 call HTTP**，查詢 + 新增 todo + 新增 note |
| **Canonical project id** | 明定優先級 + 未選就拒寫 + 持久化 bot 的 user state |
| **Retrieval 評估** | 加強版 `search_feedback`，2 週達標才進路線 B |
| **Codex MCP** | 不寫專用整合；使用者 `codex mcp add cc-memory` 即可複用現 MCP server |

---

## Design Principles

- **先證明 retrieval 可信 + 手動寫入夠用，再談自動化**
- **架構路徑定死**：`MCP → service` / `HTTP → service` / **`Telegram bot → HTTP`**（不走後門）
- **bot 不得 import `src/services/*` 或 `src/db/*`**，編譯期即檢查
- **Token 分權**：BOT（受限）vs ADMIN（跨專案讀、刪除）
- **未選 project 一律拒寫**：不做任何 fallback，寧願失敗不要 silent miswrite
- **Drizzle 為唯一真實來源**：禁止手寫 SQL 維護 schema
- **Schema migration 單向**（加表，不動舊表）
- **Undo 靠資料層 idempotency_key**，不靠 timer
- **向後相容**：現有 6 個 memory MCP tool 輸入輸出格式不動

---

## Success Criteria（Retrieval Evaluation 2 週評估點）

### 指標（加強版）

| 指標 | 目標 | 來源 |
|---|---|---|
| `/search` 整體接受率 | > 70% | `thumbs='up'` / total |
| 拒絕率 | < 20% | `thumbs='down'` |
| Top-1 點擊率 | > 50% | `selected_rank=1` |
| Mode 勝率 | hybrid > keyword 且 hybrid > semantic | breakdown by `mode` |
| 每日查詢數 | > 3 | count per day |
| Write 撤銷率 | < 10% | undo count / write count |
| Bot silent error 率 | < 5% | error log / total messages |

### Go / No-Go

- ✅ 全達標 → 啟動路線 B
- ❌ 接受率 < 70% → 檢視 mode breakdown 決定調哪個
- ❌ 撤銷率 > 10% → bot UX 改（可能 confirm 要強化）
- 🔁 查詢數 < 3/日 → 延長 2 週

### `scripts/eval-retrieval.ts`

產出 14 天報告，輸出 markdown。

---

## 端對端（多電腦 / 跨工具）驗收

- [ ] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到
- [ ] Telegram `/todos` 能看到 A 剛建的 task
- [ ] Telegram `/todo X` → A 電腦 `cc_task_list` 能看到
- [ ] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
