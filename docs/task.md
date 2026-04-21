# CC-memory v0.2 Task Breakdown

> Spec 版本：**1.3** · 依 Phase 0-5 拆解 · Gate 未過不進下個 phase
>
> **Phase 劃分（2026-04-21 修訂）：**
>
> **執行紀律**：每個 Phase 開工前讀 `~/.claude/rules/sdd-workflow.md` 的
> `## 每個 Phase 執行紀律`（brainstorm → context7 → TDD → simplify → review → codex-review）。
>
> - **Phase A — 本期交付**：Phase 0 ✅ + Phase 1 ✅ + Phase 2 + Phase 5-A
> - **Phase B — 後續階段**：Phase 3 (HTTP) + Phase 4 (Telegram) + Phase 5-B
> - v1.3.1（2026-04-21）：Phase 2 Gate 加 idempotency 重複 insert 驗證；Phase 5-A Gate 指定三區塊；feedback.ts 拆 `recordSearchQuery`(A) vs `recordFeedback`(延 5-B)

---

# Phase A — 本期交付（MCP only）

## Phase 0 — Schema Alignment ✅（已完成）

- [x] 刪除 `sql/schema.sql`（死檔）
- [x] 新增 `sql/migrations/` 目錄
- [x] `sql/migrations/0000_baseline.sql` 含 `CREATE EXTENSION IF NOT EXISTS vector`
- [x] 更新 `drizzle.config.ts` 指向 `./sql/migrations`
- [x] `scripts/install.sh` 改用 `DATABASE_URL` + `drizzle-kit push`
- [x] `README.md` + `docs/schema-alignment.md` 明示 Drizzle 為唯一真相

---

## Phase 1 — 新增 3 張表 + TDD ✅（已完成）

- [x] `src/db/schema.ts` 新增 `tasks` / `search_feedback` / `bot_user_state`
- [x] `sql/migrations/0001_add_tasks_feedback_bot_state.sql`
- [x] Docker test PG + `drizzle.test.config.ts` + 3 輪 red-green TDD
- [x] `tests/db/v02-tdd.test.ts`（14 tests）
- [x] 40/40 test 綠

---

## Phase 2 — Schema 補完 + Service Layer（1.5d）

### 2a Schema 補完（v1.3 新增）

- [ ] `src/db/schema.ts`：`projectMemories` 加 `idempotencyKey text` + `writerHost text`
- [ ] `src/db/schema.ts`：`tasks` 加 `writerHost text`
- [ ] `drizzle-kit generate --name=add_idempotency_and_writer` → `sql/migrations/0002_*.sql`
- [ ] Partial unique index `project_memories_idempotency_idx` WHERE idempotency_key IS NOT NULL
- [ ] 套用到 test PG + Zeabur PG
- [ ] TDD：`tests/db/v03-writer-idempotency.test.ts`
  - [ ] RED：不存在欄位 → insert writer_host 失敗 / idempotency_key 無 unique
  - [ ] GREEN：schema 上線 → 重複 idempotency_key insert 收 duplicate key error

### 2b Service layer 抽出

> **TDD 順序**：每個 sub-task 先寫紅測跑失敗 → 實作到綠 → refactor。測試覆蓋 audit 見 2d。

- [ ] `src/utils/repo-name.ts`（`execFileSync` 無 shell；不是 git repo 回 null）
- [ ] `src/utils/writer-host.ts`（env `CC_MEMORY_WRITER` 或 `os.hostname()`）
- [ ] `src/services/projects.ts`：`resolveProjectId` 實作 5 層優先序
  `explicit > env > marker > repo_name > basename`
- [ ] `src/services/projects.ts`：`listProjects()` union from memories + tasks
- [ ] `src/services/projects.ts`：`projectExists(id)`
- [ ] `src/services/memories.ts`：搬自 `src/tools/*.ts`，保持 input/output 相容
  - [ ] `saveMemory` 自動填 `writer_host`
  - [ ] `saveMemory` 支援 optional `idempotency_key`（重複回舊 row id）
  - [ ] `deleteByIdempotencyKey(key, maxAgeSec)` 靠 unique index 精準找
- [ ] `src/services/tasks.ts`
  - [ ] `createTask` 自動填 `writer_host`
  - [ ] `updateTask(id, patch, { expectedStatus })` optimistic locking
  - [ ] 狀態轉移 table-driven 驗證（違反 throw `InvalidTransitionError`）
  - [ ] `resolveTaskByShortId(prefix, projectId)` 0/1/多筆回三態
- [ ] `src/services/feedback.ts`：`recordSearchQuery`（Phase A MCP search 被動寫 row，9 欄：query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores；無 thumbs / selected_rank）
- [ ] ~~`recordFeedback`（驗 array 長度 + rank，UPDATE thumbs / selected_rank）~~ → **延後到 Phase 5-B**（需 HTTP + Telegram inline button 回寫才有 signal）
- [ ] ~~`src/services/botstate.ts`~~ → **延後到 Phase 3**（僅 HTTP bot route 使用，Phase A MCP 用不到）

### 2c MCP 改 call service

> **TDD 順序**：每個新增 tool 先寫紅測跑失敗 → 實作到綠。既有 6 個 memory tool 走 regression。

- [ ] `src/index.ts` 改 call `services/*`（不再 import `db` client）
- [ ] 新增 MCP tool：`cc_task_create`
- [ ] 新增 MCP tool：`cc_task_list`
- [ ] 新增 MCP tool：`cc_task_update`（要求帶 `expected_status`）
- [ ] `src/tools/*.ts` 保留當薄殼
- [ ] 既有 6 個 memory tool 輸入輸出格式不動

### 2d 測試 audit（覆蓋率檢查，測試本身於 2b/2c 邊做邊寫）

- [ ] Unit：`services/tasks.ts` 狀態轉移 13 種組合 + optimistic locking
- [ ] Unit：`services/projects.ts` 5 層優先序 + `listProjects` union
- [ ] Unit：`utils/repo-name.ts` 各 URL 格式解析 + 非 git 目錄
- [ ] Unit：`utils/writer-host.ts` env vs hostname
- [ ] Integration：idempotency_key 重複 insert 行為
- [ ] Regression：既有 9 個測試檔全綠

### Gate
- [ ] `npm test` 40+（新增）tests 全綠
- [ ] MCP 6 memory tool + 3 task tool 從 Claude Code 測全通
- [ ] DB 可查：`SELECT idempotency_key, writer_host FROM project_memories LIMIT 1`
- [ ] **DB 層冪等**：raw `INSERT` 兩次同 idempotency_key → 第二次收 unique violation
- [ ] **Service 層冪等**：`saveMemory` 第二次帶相同 idempotency_key → 不拋錯、回傳既有 row id（不新增 row）

---

## Phase 5-A — Retrieval Eval（Phase A，0.5d）

> **TDD 順序**：每個 sub-task 先寫紅測跑失敗 → 實作到綠 → refactor。

- [ ] `src/services/feedback.ts`：`recordSearchQuery(input)` — 每次 MCP search 自動 call，寫入 query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores
- [ ] `src/index.ts`：`cc_memory_search` handler 呼叫完 search 後 fire-and-forget `recordSearchQuery`
- [ ] 選用：`ALTER TABLE search_feedback ADD CONSTRAINT search_feedback_arrays_same_length CHECK (...)`
- [ ] `scripts/eval-retrieval.ts`：14 天 markdown 報告（Phase A 指標：每日查詢數 / mode 分佈 / 結果穩定度）
  - [ ] 標註 Phase B 才能算的指標（接受率 / Top-1 / 撤銷率）為 "N/A（待 Phase B）"
- [ ] 文件：`docs/retrieval-eval.md`
- [ ] Codex MCP 驗證：`codex mcp add cc-memory` 後能呼叫 `cc_memory_search`

### 5-A 測試 audit
- [ ] Unit：`services/feedback.ts:recordSearchQuery` 9 欄完整 row 斷言
- [ ] Integration：MCP `cc_memory_search` 觸發後 `search_feedback` row 存在
- [ ] Regression：既有 search / save / list 測試全綠

### Gate
- [ ] 跑一次 `cc_memory_search` 後 `SELECT * FROM search_feedback ORDER BY created_at DESC LIMIT 1` 能看到該 row
- [ ] `scripts/eval-retrieval.ts` 能產出 markdown 報告，含「每日查詢數」「mode 分佈」「結果穩定度」三個區塊
- [ ] 報告含 Phase A 指標數值，能用於 Go/No-Go 判斷：每日查詢數（目標 > 3）、結果穩定度（目標 > 70%）
- [ ] Codex MCP：`codex mcp add cc-memory` 後能從 Codex CLI 呼叫 `cc_memory_search`

---

# Phase B — 後續階段（HTTP + Telegram，可由其他 agent 承接）

> 本期不實作，資料面支援（`idempotency_key`、`writer_host`、`bot_user_state` 表）在 Phase A 已就位。以下保留規劃但不排程。

---

## Phase 3 — HTTP API（Phase B，1.5d）

> **TDD 順序**：每個 middleware / endpoint 先寫紅測（integration test 預期 4xx）跑失敗 → 實作到綠。3d 為最終覆蓋率 audit。

### 3a 基礎 + Auth

- [ ] `src/services/botstate.ts`：`getBotUserState` / `setActiveProject`（從 Phase 2 延後來的）
- [ ] 加 deps：`hono`, `@hono/node-server`
- [ ] `src/http/index.ts`（Hono app entry）
- [ ] `src/http/middleware/auth.ts`：
  - [ ] 驗 `Authorization: Bearer` → 設 `scope`
  - [ ] bot scope 要求 `X-Telegram-User-Id` header（missing → 401）
  - [ ] bot scope 查 `bot_user_state` → `c.var.activeProjectId`
- [ ] `src/http/middleware/logger.ts`（結構化 log 含 scope / path / duration / project_id / telegram_user_id）
- [ ] `src/http/middleware/error.ts`（統一 envelope `{ data, error: { code, message } }`）
- [ ] `src/http/routes/health.ts`

### 3b Endpoints

- [ ] `routes/memories.ts`：GET / POST / GET:id / DELETE:id (admin) / DELETE by-idempotency
  - [ ] bot scope 強制 `project = c.var.activeProjectId`
- [ ] `routes/tasks.ts`：GET / POST / PATCH:id（需 `expected_status`）
- [ ] `routes/projects.ts`：GET（bot + admin，bot scope 回 `listProjects()` union list，不接受跨專案特權參數）
- [ ] `routes/feedback.ts`：POST（service 驗 array 長度 + rank）
- [ ] `routes/botstate.ts`：`GET|PUT /api/bot/state/:telegram_user_id`
  - [ ] 只能讀寫 header 對得上的 user id（否則 403）
  - [ ] PUT 帶 `active_project_id` 時驗 `projectExists`
- [ ] HTTP 錯誤碼：400 / 401 / 403 / 404 / 409 / 422 依規格

### 3c 建置 + 部署

- [ ] `package.json` 加 `build:api` / `start:api` / `build:bot` / `start:bot`
- [ ] `tsconfig.api.json`（include `src/http/**` + `src/services/**` + `src/db/**` + `src/utils/**`）
- [ ] `.env.example`：`BOT_API_TOKEN` / `ADMIN_API_TOKEN` / `PORT`
- [ ] Zeabur 新增 `cc-memory-api` service，設 start command
- [ ] Deploy 後 smoke：`curl /health`

### 3d 測試 audit（cross-cutting 覆蓋率檢查，每個 route 單測於 3b 邊做邊寫）

- [ ] Integration：每個 endpoint 兩種 token 各一次
- [ ] Integration：bot token 呼 admin endpoint 收 403
- [ ] Integration：bot scope 無 `X-Telegram-User-Id` 收 401
- [ ] Integration：bot scope 無 active project 做 mutate 收 403 `SWITCH_REQUIRED`
- [ ] Integration：`GET /api/bot/state/:me` 能讀自己 / 讀別人收 403

### Gate
- [ ] 上述 5 個 integration 全通
- [ ] Zeabur deploy 成功並可公開呼叫

---

## Phase 4 — Telegram Bot（Phase B，1d）

> **TDD 順序**：每個 command handler / undo 邏輯先 mock `bot/client.ts` 寫紅測跑失敗 → 實作到綠。

### 4a 基礎

- [ ] 加 deps：`telegraf`
- [ ] 建立 bot 獨立 tsconfig：`tsconfig.bot.json`（`include` 只含 `src/bot/**`，禁用 path alias 指向 `src/services` / `src/db`）
- [ ] CI grep gate：`! grep -rnE "from ['\"](\\.\\./)?(db|services)/" src/bot/`
- [ ] `src/bot/index.ts`（telegraf entry）
- [ ] `src/bot/client.ts`（fetch wrapper，所有 request 帶 `Authorization` + `X-Telegram-User-Id`）
- [ ] 白名單：env `TELEGRAM_ALLOWED_USER_IDS`，非白名單 ignore + log
- [ ] env：`TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_USER_IDS` / `API_URL` / `API_TOKEN` / `CC_MEMORY_WRITER=telegram-bot` / `UNDO_WINDOW_SEC`

### 4b Commands

- [ ] `/start` 歡迎 + 當前 active project（查 `GET /api/bot/state/:me`）
- [ ] `/projects` 列 `listProjects()`
- [ ] `/switch <name>` `PUT /api/bot/state/:me`（API 驗 exists）
- [ ] `/here` 顯示當前 active
- [ ] `/search <q>` 限 active project（無 active 時拒絕，提示 `/switch`；跨專案查詢改由 admin HTTP API 提供）
- [ ] `/note <text>` 帶 `idempotency_key` POST memories
- [ ] `/todo <text>` 帶 `idempotency_key` POST tasks
- [ ] `/todos` 列未完成 todo
- [ ] `/done <id前6>` + `/cancel <id前6>`：call `resolveTaskByShortId` 行為
  - [ ] 0 筆 → 「找不到」
  - [ ] 1 筆 → 執行（PATCH 帶 expected_status）
  - [ ] 多筆 → 列候選要求更長 prefix

### 4c Undo

- [ ] `src/bot/undo.ts` 管理 idempotency_key
- [ ] inline `[撤銷]` button
- [ ] 10 秒內 `DELETE /api/memories/by-idempotency/:key`
- [ ] 超時收 403；重複撤銷 200 no-op

### 4d 部署

- [ ] Zeabur 新增 `cc-memory-bot` service

### 4e 測試 audit
- [ ] Unit：`bot/client.ts` headers 帶 Authorization + X-Telegram-User-Id
- [ ] Unit：command handler 對無 active project 時回正確錯誤訊息
- [ ] Unit：`/done` / `/cancel` 呼叫 `resolveTaskByShortId` 的 0 筆 / 1 筆 / 多筆三分支
- [ ] Integration：白名單拒絕、undo 10 秒內 / 超時 / 重複 三 case
- [ ] CI grep gate：`src/bot/` 無 `from '..?/(db|services)/`

### Gate
- [ ] 手機發 `/switch X` 無 X → 收錯
- [ ] `/note` 無 active → 收錯
- [ ] `/note` 有 active → 成功；`/todos` 跨電腦一致
- [ ] 撤銷：10 秒內成功 / 11 秒 403 / 重複 200
- [ ] CI grep gate 通過
- [ ] 從手機跨電腦能讀寫

---

## Phase 5-B — Feedback 回寫 + 部署文件（Phase B，0.5d）

> **TDD 順序**：feedback endpoint 與 eval 擴充指標先寫紅測跑失敗 → 實作到綠。

- [ ] `POST /api/feedback` 實作（service 層驗長度 + rank；寫入時 UPDATE 對應 search_feedback row 的 selected_id / selected_rank / thumbs）
- [ ] Telegram bot 搜尋後附 inline button [👍][👎][#1][#2][#3]，callback 打 `POST /api/feedback`
- [ ] `scripts/eval-retrieval.ts`：補上 Phase B 指標計算（接受率 / 拒絕率 / Top-1 / Mode 勝率 / 撤銷率 / Bot silent error）
- [ ] 文件：`docs/http-api.md` / `docs/telegram-bot.md` / `docs/zeabur-deploy.md`

### 5-B 測試 audit
- [ ] Unit：`services/feedback.ts:recordFeedback` array 長度 / rank out of range validation
- [ ] Integration：inline button callback → feedback row 有 thumbs + selected_rank
- [ ] Regression：eval script 在新指標擴充後不破舊輸出

### Gate
- [ ] 端對端 demo：bot → HTTP → DB（跨電腦），每筆 row 都有 `writer_host`
- [ ] Phase B 指標全部有 signal（接受率 / 撤銷率等不是 N/A）
- [ ] Undo：10 秒內撤銷成功；超時 403；重複撤銷 no-op

---

## 端對端驗收

### Phase A（本期必過）

- [ ] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到，`writer_host` 顯示 A hostname
- [ ] A 電腦 `cc_task_create` → B 電腦 `cc_task_list` 能看到，`writer_host` 顯示 A hostname
- [ ] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
- [ ] B 電腦 clone 到不同 path → 自動解析到相同 `project_id`（靠 repo_name）
- [ ] MCP `cc_memory_search` 每次呼叫後 `search_feedback` 多一筆（含 query / mode / result_ids / rank_positions / scores）
- [ ] `scripts/eval-retrieval.ts` 能產出 markdown 報告（Phase A 指標）

### Phase B（後續階段）

- [ ] Telegram `/todos` 能看到 A 剛建的 task
- [ ] Telegram `/todo X` → A 電腦 `cc_task_list` 能看到，`writer_host` = `telegram-bot`
- [ ] Bot 設 `CC_MEMORY_WRITER=telegram-bot` → 寫入 row 的 `writer_host` 為 `telegram-bot`
- [ ] 未設 active project 的 Telegram user 發 `/note` → 收 `SWITCH_REQUIRED` 提示
- [ ] Telegram 10 秒內撤銷成功、超時 403、重複按 no-op
- [ ] Phase B 指標（接受率 / Top-1 / 撤銷率）不再是 N/A
