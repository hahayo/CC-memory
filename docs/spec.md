# CC-memory v0.2 Spec

> Spec 版本：**1.3**（Codex plan review + 跨平台補強）· 範圍：路線 A 最保守自建
>
> v1.3 change log：
> - P0-1：bot 絕對不直連 DB。`bot_user_state` 改走 HTTP `/api/bot/state/:user_id`
> - P0-2：`project_memories` 新增 `idempotency_key text UNIQUE`（與 tasks 一致）
> - P0-3：`BOT_API_TOKEN` 需配合 `X-Telegram-User-Id` header；server 查
>   `bot_user_state` 決定 active project；不信任 client 傳來的 `project`
> - P1-2：`project_id` 優先序改為 `explicit > env > marker > repo_name > basename`
> - ➕ 新增 `repo_name` 為 project id 穩定來源（跨電腦同 repo → 同 project）
> - ➕ 兩張寫入表新增 `writer_host text` 欄位追蹤來源電腦

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

### v1.3 修訂重點（詳情見 plan.md）

| 主題 | v1.1 | v1.3 |
|---|---|---|
| bot ↔ DB | bot 允許 `src/bot/state.ts` 直連 DB | bot **完全**不碰 DB，走 `/api/bot/state` HTTP |
| memory 冪等 | 靠 `metadata.idempotency_key` JSONB scan | `project_memories.idempotency_key text UNIQUE` |
| bot ACL | 只靠 client 傳 `project` 參數 | server 讀 `X-Telegram-User-Id` → 查 bot_user_state |
| project_id 優先序 | `marker > env > basename` | `explicit > env > marker > repo_name > basename` |
| 跨電腦穩定 id | 無 | 加入 `git remote get-url origin` 抽 repo name |
| 寫入稽核 | 無 | 兩表加 `writer_host text`（env 或 `os.hostname()`）|

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
- ❌ Web UI / 完整 i18n
- ❌ 任何 LLM 自動抽取 / 摘要 / 結構化
- ❌ Sentry / Datadog（log 夠用）
- ❌ Rate limit 細緻化（MVP 單人使用）

---

## Scope 摘要

| 項目 | 說明 |
|---|---|
| **Day 0 Schema alignment** ✅ | 刪 `sql/schema.sql`，Drizzle 當唯一真實來源 |
| **Schema 擴充 Phase 1** ✅ | `tasks`、`search_feedback`、`bot_user_state` 上線 |
| **Schema 補完 Phase 2** | `project_memories` 加 `idempotency_key` + `writer_host`；`tasks` 加 `writer_host` |
| **Service layer 抽出** | `src/services/` 純業務邏輯，MCP / HTTP 共用（bot 不直接用） |
| **HTTP REST API** | Hono + 雙 token + `X-Telegram-User-Id` header；`/api/bot/state` endpoints |
| **Telegram bot** | `telegraf` 獨立進程，**只 call HTTP**，bot_user_state 也走 HTTP |
| **Canonical project id** | `explicit > env > marker > repo_name > basename` 統一解析 |
| **Writer attribution** | `writer_host` = env `CC_MEMORY_WRITER` ?? `os.hostname()` |
| **Retrieval 評估** | 加強版 `search_feedback`，2 週達標才進路線 B |
| **Codex MCP** | 不寫專用整合；使用者 `codex mcp add cc-memory` 即可複用 |

---

## Design Principles

- **先證明 retrieval 可信 + 手動寫入夠用，再談自動化**
- **架構路徑定死**：`MCP → service` / `HTTP → service` / **`Telegram bot → HTTP only`**
- **bot 不得 import `src/services/*` 或 `src/db/*`**：編譯期強制（tsconfig path 隔離）
- **Server 端不信任 client 傳來的 project 參數**：bot scope 皆由 server 查 bot_user_state
- **Token 分權**：BOT（單用戶 per telegram_user_id）vs ADMIN（跨專案全權）
- **未選 project 一律拒寫**：不做任何 fallback，寧願失敗不要 silent miswrite
- **跨電腦 project_id 穩定**：優先用 git repo name，不同電腦 path 不影響
- **所有寫入留下 writer_host 稽核軌跡**：debugging / audit / 同步除錯時能知道哪台電腦
- **Drizzle 為唯一真實來源**：禁止手寫 SQL 維護 schema
- **Undo 靠資料層 `idempotency_key UNIQUE`**：不靠 timer，不用 JSONB scan
- **向後相容**：現有 6 個 memory MCP tool 輸入輸出格式不動

---

## Success Criteria（Retrieval Evaluation 2 週評估點）

### 指標

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

- ✅ 全達標 → 啟動路線 B（Stop hook 自動抽取）
- ❌ 接受率 < 70% → 檢視 mode breakdown 決定調哪個
- ❌ 撤銷率 > 10% → bot UX 改（confirm 強化）
- 🔁 查詢數 < 3/日 → 延長 2 週

---

## 端對端（多電腦 / 跨工具）驗收

- [ ] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到，`writer_host` 顯示 A
- [ ] Telegram `/todos` 能看到 A 剛建的 task
- [ ] Telegram `/todo X` → A 電腦 `cc_task_list` 能看到
- [ ] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
- [ ] B 電腦 clone 到不同路徑 → 自動解析到相同 `project_id`（repo_name 生效）
- [ ] Bot 設 `CC_MEMORY_WRITER=telegram-bot` → 寫入 row 的 `writer_host` 為 `telegram-bot`
- [ ] 未設 active project 的 Telegram user 發 `/note` → 收 403 + `/switch` 提示
