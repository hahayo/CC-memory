# CC-memory v0.2 Task Breakdown

> Spec 版本：1.1 · 依 Phase 0-5 拆解 · Gate 未過不進下個 phase

---

## Phase 0 — Schema Alignment（0.5d）

**目標**：`sql/schema.sql` 是死檔舊 Supabase 版，必須砍掉；Drizzle 為唯一真實來源。

- [x] 刪除 `sql/schema.sql`
- [x] 新增 `sql/migrations/` 目錄管理未來 migration
- [x] 從 Drizzle 生成 baseline SQL：`sql/migrations/0000_baseline.sql`（存放但不執行）
- [x] 更新 `drizzle.config.ts` 指向 `./sql/migrations`
- [x] 文件更新 `README.md` 明示 Drizzle 是唯一真實來源，禁止手寫 SQL 維護
- [x] 新增 `docs/schema-alignment.md`（Day 0 紀錄）
- [ ] （選做）CI check：加 script 檢查 `sql/` 目錄下無手寫 `CREATE TABLE project_memories`

### Gate

- `grep -r "project_name\|tech_stack\|session_id" sql/ src/` 無結果（.md 除外）
- `drizzle-kit push` dry-run 無 pending changes

---

## Phase 1 — Schema Migration（1d）

**目標**：`tasks` + `search_feedback` + `bot_user_state` schema；Drizzle migration；測試。

- [x] `src/db/schema.ts` 新增 `tasks` table 定義
- [x] `src/db/schema.ts` 新增 `search_feedback` table 定義
- [x] `src/db/schema.ts` 新增 `bot_user_state` table 定義
- [x] 產出 `sql/migrations/0001_add_tasks_feedback_bot_state.sql`（合併成單一 migration）
- [x] 建立 `tasks_project_status_created_idx` / `tasks_due_date_idx` / `tasks_idempotency_idx` index
- [x] 建立 `search_feedback_created_idx` / `search_feedback_mode_idx` index
- [x] 狀態 CHECK constraint（`status`, `priority`, `source`, `mode`, `query_surface`, `thumbs`）
- [x] `tasks.idempotency_key` UNIQUE + title length 1..500 check
- [x] `scripts/apply-migration.ts`（drizzle-kit push 因既有表 drift 中斷，改走 psql 驅動）
- [x] `scripts/create-missing-indexes.ts` 補建未建的 5 個 index
- [x] `scripts/inspect-schema.ts` 驗證 DB schema 狀態
- [x] TDD：`tests/db/v02-constraints.test.ts`（14 tests all pass）

### Gate

- [x] 3 張新表上線於 Zeabur PG
- [x] 所有 CHECK / UNIQUE / 長度 / index 就位
- [x] `npx vitest run` 全 40 測試綠燈（含 14 v02-constraints + 26 regression）

---

## Phase 2 — Service Layer 抽出（1d）

**目標**：Service layer 抽出；MCP 改 call service；新增 3 個 task MCP tool；既有 6 個 memory tool regression 測試通過。

- [ ] 新增 `src/services/memories.ts`（搬自 `src/tools/*.ts`，純邏輯）
- [ ] 新增 `src/services/tasks.ts`（含狀態轉移驗證，違規 throw `InvalidTransitionError`）
- [ ] 新增 `src/services/projects.ts`（`resolveProjectId` / `listProjects` / `projectExists`）
- [ ] 新增 `src/services/feedback.ts`（`recordFeedback` / `getRetrievalStats`）
- [ ] 搬 `src/utils/project-id.ts` 的 `getProjectId` 進 `services/projects.ts`
- [ ] 搬 `src/tools/search.ts` 的 `hybridSearch` 進 `services/memories.ts`，並回傳 mode/scores/rank
- [ ] `src/index.ts` 改 call `services/*`（不再 import `db` client）
- [ ] 新增 MCP tool：`cc_task_create`
- [ ] 新增 MCP tool：`cc_task_list`
- [ ] 新增 MCP tool：`cc_task_update`
- [ ] 既有 6 個 memory tool 輸入輸出格式不動（向後相容）
- [ ] `src/tools/*.ts` 保留當薄殼
- [ ] Unit tests（vitest）：`services/*` 含狀態轉移 / idempotency
- [ ] Regression tests：既有 memory tool tests 全綠

### Gate

- `npm test` 全綠
- MCP 6 個 memory tool 從 Claude Code 測試全通
- 新 3 個 task tool 測試全通

---

## Phase 3 — HTTP API（1d）

**目標**：HTTP API memories（CRUD）+ tasks（CRUD）+ auth middleware + 雙 token；Zeabur deploy。

- [ ] 加 deps：`hono`, `@hono/node-server`
- [ ] 新增 `src/http/index.ts`（Hono app entry）
- [ ] 新增 `src/http/middleware/auth.ts`（雙 token 分權，設定 `c.var.scope`）
- [ ] 新增 `src/http/middleware/logger.ts`（`hono/logger` 結構化 log）
- [ ] 新增 `src/http/middleware/error.ts`（統一錯誤 envelope）
- [ ] 新增 `src/http/routes/health.ts`（`GET /health`）
- [ ] 新增 `src/http/routes/memories.ts`（GET / POST / GET:id / DELETE:id / DELETE by-idempotency）
- [ ] 新增 `src/http/routes/tasks.ts`（GET / POST / PATCH:id）
- [ ] 新增 `src/http/routes/projects.ts`（GET，admin only）
- [ ] 新增 `src/http/routes/feedback.ts`（POST）
- [ ] Response envelope `{ data, error }` 統一
- [ ] 404 / 409 行為依規格
- [ ] `.env.example` 加 `BOT_API_TOKEN` / `ADMIN_API_TOKEN` / `PORT`
- [ ] Zeabur 新增 `cc-memory-api` service，指定 start command
- [ ] 部署後 smoke test：curl `GET /health`

### Gate

- curl 全部 endpoint（兩種 token 各跑一次）
- bot token 嘗試 admin endpoint 收 403
- Zeabur deploy 成功

---

## Phase 4 — Telegram Bot（1d）

**目標**：Telegram bot 核心指令 + 未選 project 拒寫 + 白名單。

- [ ] 加 deps：`telegraf`
- [ ] 建立 bot 獨立 package / tsconfig path 隔離（不得 import `src/services/*` 或 `src/db/*`，僅允許 `state.ts` 碰 `bot_user_state`）
- [ ] 新增 `src/bot/index.ts`（telegraf entry）
- [ ] 新增 `src/bot/client.ts`（fetch wrapper to HTTP API）
- [ ] 新增 `src/bot/state.ts`（`bot_user_state` DB ops）
- [ ] handler：`/start`（歡迎 + 當前 active project）
- [ ] handler：`/projects`（列出 DB 已存在 project）
- [ ] handler：`/switch <name>`（必須 DB 存在；不存在則拒絕）
- [ ] handler：`/here`（顯示目前 active project）
- [ ] handler：`/search <q>`（限定 active project；`--all` 需 ADMIN token）
- [ ] handler：`/note <text>`（未選 project 拒絕並提示 `/switch`）
- [ ] handler：`/todo <text>`（未選 project 拒絕）
- [ ] handler：`/todos`（列未完成 todo，當前 project；未選拒絕）
- [ ] handler：`/done <id前6>`（完成）
- [ ] handler：`/cancel <id前6>`（取消）
- [ ] 白名單：env `TELEGRAM_ALLOWED_USER_IDS`，非白名單 ignore + log
- [ ] `.env.example` 加 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_USER_IDS` / `API_URL` / `API_TOKEN` / `UNDO_WINDOW_SEC`
- [ ] Zeabur 新增 `cc-memory-bot` service

### Gate

- 手機從 Telegram 發訊息：`/switch X` 無 X → 收錯
- `/note` 無 active → 收錯
- `/note` 有 active → 成功
- 從手機跨電腦能寫讀

---

## Phase 5 — Undo / Feedback / Retrieval Eval（0.5-1d）

**目標**：`search_feedback` + undo flow + `DELETE by-idempotency`；retrieval eval 腳本骨架。

- [ ] 新增 `src/bot/undo.ts`（idempotency key 管理）
- [ ] Bot `/note` / `/todo` 產生 `idempotency_key = uuid` 並 insert
- [ ] Bot 訊息帶 inline `[撤銷]` button，callback data = idempotency_key
- [ ] `project_memories` 的 idempotency_key 存 `metadata.idempotency_key`（不改 schema）
- [ ] `tasks` 靠 `tasks.idempotency_key UNIQUE` 冪等
- [ ] HTTP `DELETE /api/memories/by-idempotency/:key` 實作：10 秒內有效，超過收 403
- [ ] 重複點撤銷同 key：200 no-op
- [ ] `search_feedback` 完整寫入：query / query_surface / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores / selected_id / selected_rank / thumbs
- [ ] HTTP `POST /api/feedback` 能接收 thumbs up/down
- [ ] 新增 `scripts/eval-retrieval.ts`（14 天報告骨架，輸出 markdown）
- [ ] 接受率 / 拒絕率 / Top-1 點擊率 / Mode 勝率 / 每日查詢數 / Write 撤銷率 / Bot silent error 率 統計
- [ ] 新增 `docs/http-api.md`
- [ ] 新增 `docs/telegram-bot.md`
- [ ] 新增 `docs/retrieval-eval.md`
- [ ] 新增 `docs/zeabur-deploy.md`
- [ ] Codex MCP 驗證：`codex mcp add cc-memory` 後能呼叫 `cc_memory_search`

### Gate

- 10 秒內撤銷成功
- 11 秒撤銷收 403
- 重複撤銷同 key 收 200 no-op
- 端對端 demo：bot → HTTP → DB（跨電腦）
- dashboard 能列 feedback（若時間不足可縮為「只收 feedback，不做 dashboard」）

---

## 端對端驗收（跨 Phase）

- [ ] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到
- [ ] Telegram `/todos` 能看到 A 剛建的 task
- [ ] Telegram `/todo X` → A 電腦 `cc_task_list` 能看到
- [ ] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
