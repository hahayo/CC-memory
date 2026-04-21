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
> - v1.3.1（2026-04-21）：拆分 Phase A (MCP) / Phase B (HTTP + Telegram)；新增 `## Constraints`；Design Principles 拆 Phase A 必守 / Phase B 開工時適用

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

## User Stories

使用者：本專案開發者（單人）。脈絡分兩組介面：

- **Phase A — MCP**（v0.2 本期交付）：終端機（Claude Code / Codex MCP stdio）
- **Phase B — HTTP REST API + Telegram bot**（後續階段 / 可由其他 agent 承接，本期不綁排程）

每個 US 皆對應具體驗收條件與 Goal / Design Principle。

---

### Phase A — MCP（本期 Priority）

#### US-1 — 桌機記的東西，筆電開著就看得到

**作為** 在多台電腦切換工作的開發者，**我希望** A 電腦 `cc_memory_save` 寫入的記憶，B 電腦 `cc_memory_list` 馬上看得到，**以便** 不用靠 git 或手抄同步。

- A save 後 B list 立刻有該筆（PG 雲端單一真實來源）
- 每筆 row `writer_host` 能看出寫入來源電腦
- 對應 Goal 1

#### US-2 — 同 repo 不同電腦 clone 路徑 → 同 project_id

**作為** 會把同一個 repo clone 到 `/home/me/x` 或 `/workspace/x` 的使用者，**我希望** 兩邊 cc-memory 都解析到同一個 `project_id`，**以便** 跨電腦不會被誤判成兩個專案。

- 優先序 `explicit > env > marker > repo_name > basename`
- `repo_name` 從 `git remote get-url origin` 抽取（https / ssh 兩種格式）
- 非 git 或無 remote → fallback basename
- 對應 Goal 1 + Design Principle「跨電腦 project_id 穩定」

#### US-3 — Claude Code 和 Codex CLI 同一份記憶

**作為** Claude Code + Codex CLI 都會用的開發者，**我希望** 兩個 MCP client 看到同一份資料，**以便** 不用切工具就清掉 context。

- `codex mcp add cc-memory` 即可複用，無須寫專屬整合
- 兩邊寫入、讀取共用一個 PG；MCP tool 格式向後相容
- 對應 Goal 2

---

### Phase B — HTTP + Telegram（可延後 / 交給其他 agent）

> 本期先實作 Phase A 的 MCP 與 service layer 抽出，HTTP API 與 Telegram bot 皆延後到 Phase B。資料面支援（`idempotency_key`、`writer_host`、`bot_user_state`、`search_feedback`）在 Phase A 已準備好，確保之後串接時不需再改 schema 或重跑 migration。

#### US-4 — 手機也能查記憶 / 記 TODO

**作為** 離開電腦時會想查或新增的人，**我希望** 用 Telegram bot `/search`、`/note`、`/todo`、`/todos`，**以便** 不用每次都回去開電腦。

- `/search <q>` 限 active project（無 active 時拒絕，提示 `/switch`；跨專案查詢改由 admin HTTP API `/api/memories?project=X` 提供）
- `/note`、`/todo` 寫入後桌機 `cc_memory_list` / `cc_task_list` 即時可見
- `/todos` 列當前 project 未完成任務；`/done <id前6>` / `/cancel <id前6>` 完成或取消
- 對應 Goal 3

#### US-5 — Telegram bot 寫入約束（server 不信任 client）

**作為** 會把 bot 放在 Telegram 的使用者，**我希望** 任何來自 bot 的寫入都必須通過三重檢查：白名單 user id、合法 active project、只能動自己的 state，**以便** 不會被陌生人塞垃圾訊息、不會 silent miswrite、不會跨 user 互相污染。

**白名單**
- 非白名單 telegram user → bot silent ignore + log（不回應）
- HTTP bot scope 無 `X-Telegram-User-Id` → 401

**沒選 project 一律拒寫（silent miswrite 防線）**
- 無 active project 時任何 write → 403 `SWITCH_REQUIRED`
- `/switch <name>` 僅接受 `listProjects()` 中已存在的 id；不存在不自動建立
- Server 端不信任 client 傳來的 `project` 參數（由 server 查 `bot_user_state`）

**身分隔離**
- Bot scope 只能讀寫自己 `telegram_user_id` 的 `bot_user_state`（跨身分讀寫 → 403）

對應 Design Principle「未選 project 一律拒寫」「Server 不信任 client 傳來的 project」「Token 分權」。

#### US-6 — 打錯字能撤銷

**作為** 手機輸入容易打錯的使用者，**我希望** 剛送出的 `/note`、`/todo` 10 秒內能按 `[撤銷]` 收回，**以便** 不用去 DB 手動刪。

- 10 秒內撤銷 → 刪除該筆（靠 `idempotency_key UNIQUE` 精準找）
- 超過 10 秒 → 403（不靠 in-memory timer，靠 `created_at` 差）
- 重複按撤銷 / 重送同訊息 → no-op（第二次 DELETE 同 key 回 200 / 第二次 POST 同 key 回舊 id）
- 對應 Design Principle「Undo 靠資料層 idempotency_key UNIQUE」

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

| 項目 | 階段 | 說明 |
|---|---|---|
| **Day 0 Schema alignment** ✅ | Phase A | 刪 `sql/schema.sql`，Drizzle 當唯一真實來源 |
| **Schema 擴充 Phase 1** ✅ | Phase A | `tasks`、`search_feedback`、`bot_user_state` 上線 |
| **Schema 補完 Phase 2** | Phase A | `project_memories` 加 `idempotency_key` + `writer_host`；`tasks` 加 `writer_host` |
| **Service layer 抽出** | Phase A | `src/services/` 純業務邏輯，MCP 直接使用；HTTP / bot 屆時共用 |
| **Canonical project id** | Phase A | `explicit > env > marker > repo_name > basename` 統一解析 |
| **Writer attribution** | Phase A | `writer_host` = env `CC_MEMORY_WRITER` ?? `os.hostname()` |
| **MCP task tools** | Phase A | `cc_task_create` / `cc_task_list` / `cc_task_update`（optimistic locking） |
| **Retrieval 評估（被動記錄 + 離線腳本）** | Phase A | MCP `cc_memory_search` 自動寫 `search_feedback`；`scripts/eval-retrieval.ts` 跑報告 |
| **Codex MCP** | Phase A | 不寫專用整合；使用者 `codex mcp add cc-memory` 即可複用 |
| **HTTP REST API** | Phase B | Hono + 雙 token + `X-Telegram-User-Id` header；`/api/bot/state` endpoints |
| **Telegram bot** | Phase B | `telegraf` 獨立進程，**只 call HTTP**，bot_user_state 也走 HTTP |
| **Feedback 回寫（thumbs / selected）** | Phase B | `POST /api/feedback` + Telegram inline button |

---

## Constraints

- **技術**：必須沿用現有 Drizzle ORM + PostgreSQL (Zeabur)；不得引入新 DB 或 ORM
- **時間**：Phase A 本期交付；Phase B 無硬排程，可由其他 agent 承接
- **預算**：單人開發；不接 Sentry / Datadog 等付費可觀測性服務，log 夠用即可
- **相容性**：現有 6 個 memory MCP tool 輸入輸出格式不得變更（向後相容）
- **安全**：SQL 一律 parameterized query（Drizzle ORM 保證）；所有 shell call 用 `execFileSync`；API key 用環境變數
- **規模**：MVP 單人使用，不做細緻 rate limit；bot 限白名單 telegram_user_id
- **架構隔離**：bot 進程不得直連 DB，只能透過 HTTP API；service layer 為唯一業務邏輯層

---

## Design Principles

### Phase A 必守

- **先證明 retrieval 可信 + 手動寫入夠用，再談自動化**
- **跨電腦 project_id 穩定**：優先用 git repo name，不同電腦 path 不影響
- **所有寫入留下 writer_host 稽核軌跡**：debugging / audit / 同步除錯時能知道哪台電腦
- **Drizzle 為唯一真實來源**：禁止手寫 SQL 維護 schema
- **Undo 靠資料層 `idempotency_key UNIQUE`**：不靠 timer，不用 JSONB scan
- **向後相容**：現有 6 個 memory MCP tool 輸入輸出格式不動
- **Phase A 的 schema / service 設計不得阻斷 Phase B 落地下述 runtime invariant**（idempotency_key UNIQUE、bot_user_state 表、9 欄 search_feedback 皆 Phase A 就位）

### Phase B 開工時適用

- **架構路徑定死**：`MCP → service` / `HTTP → service` / **`Telegram bot → HTTP only`**
- **bot 不得 import `src/services/*` 或 `src/db/*`**：編譯期強制（tsconfig path 隔離）
- **Server 端不信任 client 傳來的 project 參數**：bot scope 皆由 server 查 `bot_user_state`（runtime invariant，需 HTTP middleware + header + server state，Phase A 無實作對象）
- **未選 project 一律拒寫**：bot scope 任何 mutating route 若 active project 為 null → 403 `SWITCH_REQUIRED`（runtime invariant，需 HTTP scope 判斷）
- **Token 分權**：BOT（單用戶 per telegram_user_id）vs ADMIN（跨專案全權）

---

## Success Criteria（Retrieval Evaluation 2 週評估點）

### Phase A 指標（MCP-only 可量測）

| 指標 | 目標 | 來源 |
|---|---|---|
| 每日查詢數 | > 3 | `search_feedback` count per day |
| Mode 分佈 | semantic / keyword / hybrid 各有 signal | breakdown by `mode` |
| 結果穩定度 | 同 query 兩次結果重疊 > 70% | result_ids 交集 / 併集 |

Phase A 靠 MCP `cc_memory_search` 被動寫入 `search_feedback`（query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores），但**無 thumbs / selected_rank**（沒有 bot inline button，MCP client 無互動回饋層）。

### Phase B 指標（需 HTTP / Telegram 才有 signal）

| 指標 | 目標 | 來源 |
|---|---|---|
| `/search` 整體接受率 | > 70% | `thumbs='up'` / total |
| 拒絕率 | < 20% | `thumbs='down'` |
| Top-1 點擊率 | > 50% | `selected_rank=1` |
| Mode 勝率 | hybrid > keyword 且 hybrid > semantic | breakdown by `mode` |
| Write 撤銷率 | < 10% | undo count / write count |
| Bot silent error 率 | < 5% | error log / total messages |

### Go / No-Go（Phase B 全指標達標才啟動路線 B）

- ✅ 全達標 → 啟動路線 B（Stop hook 自動抽取）
- ❌ 接受率 < 70% → 檢視 mode breakdown 決定調哪個
- ❌ 撤銷率 > 10% → bot UX 改（confirm 強化）
- 🔁 查詢數 < 3/日 → 延長 2 週

---

## 端對端（多電腦 / 跨工具）驗收

### Phase A（本期必過）

- [ ] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到，`writer_host` 顯示 A hostname
- [ ] A 電腦 `cc_task_create` → B 電腦 `cc_task_list` 能看到，`writer_host` 顯示 A hostname
- [ ] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
- [ ] B 電腦 clone 到不同路徑 → 自動解析到相同 `project_id`（repo_name 生效）
- [ ] MCP `cc_memory_search` 每次呼叫後 `search_feedback` 多一筆（含 query / mode / result_ids）

### Phase B（後續階段才驗證）

- [ ] Telegram `/todos` 能看到 A 剛建的 task
- [ ] Telegram `/todo X` → A 電腦 `cc_task_list` 能看到
- [ ] Bot 設 `CC_MEMORY_WRITER=telegram-bot` → 寫入 row 的 `writer_host` 為 `telegram-bot`
- [ ] 未設 active project 的 Telegram user 發 `/note` → 收 403 + `/switch` 提示
- [ ] Telegram 10 秒內撤銷成功、超時 403、重複按 no-op
