# CC-memory v0.2 Task Breakdown

> Spec 版本：**1.3** · 依 Phase 0-5 拆解 · Gate 未過不進下個 phase

---

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
- [ ] `src/services/feedback.ts`：`recordFeedback`（驗 array 長度 + rank）
- [ ] `src/services/botstate.ts`：`getBotUserState` / `setActiveProject`

### 2c MCP 改 call service

- [ ] `src/index.ts` 改 call `services/*`（不再 import `db` client）
- [ ] 新增 MCP tool：`cc_task_create`
- [ ] 新增 MCP tool：`cc_task_list`
- [ ] 新增 MCP tool：`cc_task_update`（要求帶 `expected_status`）
- [ ] `src/tools/*.ts` 保留當薄殼
- [ ] 既有 6 個 memory tool 輸入輸出格式不動

### 2d 測試

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

---

## Phase 3 — HTTP API（1.5d）

### 3a 基礎 + Auth

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
- [ ] `routes/projects.ts`：GET（admin only，union list）
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

### 3d 測試

- [ ] Integration：每個 endpoint 兩種 token 各一次
- [ ] Integration：bot token 呼 admin endpoint 收 403
- [ ] Integration：bot scope 無 `X-Telegram-User-Id` 收 401
- [ ] Integration：bot scope 無 active project 做 mutate 收 403 `SWITCH_REQUIRED`
- [ ] Integration：`GET /api/bot/state/:me` 能讀自己 / 讀別人收 403

### Gate
- [ ] 上述 5 個 integration 全通
- [ ] Zeabur deploy 成功並可公開呼叫

---

## Phase 4 — Telegram Bot（1d）

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
- [ ] `/search <q>` 限 active project；`--all` 需 ADMIN token
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

### Gate
- [ ] 手機發 `/switch X` 無 X → 收錯
- [ ] `/note` 無 active → 收錯
- [ ] `/note` 有 active → 成功；`/todos` 跨電腦一致
- [ ] 撤銷：10 秒內成功 / 11 秒 403 / 重複 200
- [ ] CI grep gate 通過
- [ ] 從手機跨電腦能讀寫

---

## Phase 5 — Retrieval Eval（0.5-1d）

- [ ] `search_feedback` 寫入完整欄位（service 層驗長度 + rank）
- [ ] 選用：`ALTER TABLE search_feedback ADD CONSTRAINT search_feedback_arrays_same_length CHECK (...)`
- [ ] `POST /api/feedback` 實作
- [ ] `scripts/eval-retrieval.ts`：14 天 markdown 報告
  - [ ] 接受率 / 拒絕率 / Top-1 點擊率 / Mode 勝率 / 每日查詢數 / Write 撤銷率 / Bot silent error 率
- [ ] 文件：`docs/http-api.md` / `docs/telegram-bot.md` / `docs/retrieval-eval.md` / `docs/zeabur-deploy.md`
- [ ] Codex MCP 驗證：`codex mcp add cc-memory` 後能呼叫 `cc_memory_search`

### Gate
- [ ] 端對端 demo：bot → HTTP → DB（跨電腦），每筆 row 都有 `writer_host`

---

## 端對端驗收（跨 Phase）

- [ ] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到，`writer_host` 顯示 A
- [ ] Telegram `/todos` 能看到 A 剛建的 task
- [ ] Telegram `/todo X` → A 電腦 `cc_task_list` 能看到，`writer_host` = `telegram-bot`
- [ ] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
- [ ] B 電腦 clone 到不同 path → 自動解析到相同 `project_id`（靠 repo_name）
- [ ] Bot 設 `CC_MEMORY_WRITER=telegram-bot` → 寫入 row 的 `writer_host` 為 `telegram-bot`
- [ ] 未設 active project 的 Telegram user 發 `/note` → 收 `SWITCH_REQUIRED` 提示
