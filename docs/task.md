# CC-memory Task Breakdown（v0.3 Phase A ✅ + v0.4 Phase C 規劃）

> **當前狀態**：Phase A 全 Gate 綠 ✅（tag `v0.3-phase-a`，248 tests）· Phase B ❌ 整塊取消 · ~~Phase C 設計完成，pending implementation~~ **Phase C v0.4 已 SUPERSEDED（已被取代，2026-07-05）**——auto-capture 現行載體與任務清單見 `docs/auto-capture-v0.5/{spec,plan,task}.md`
>
> **執行紀律**：每個 Milestone 開工前讀 `~/.claude/rules/sdd-workflow.md` 的 `## 每個 Phase 執行紀律`（brainstorm → context7 → TDD → simplify → review → codex-review）。
>
> **Phase 劃分（2026-04-23 更新）：**
> - **Phase A** ✅：Phase 0 + 1 + 2 + 5-A
> - ~~**Phase B**~~ ❌：Phase 3 / 4 / 5-B 整塊取消（見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §Context）
> - ~~**Phase C — v0.4 自動採集**（pending）：M1 + M2 + M3 + M4 + M5（~7.5 日 + 2 週觀察）~~（**SUPERSEDED 2026-07-05**：現行任務清單見 `docs/auto-capture-v0.5/task.md`）
>
> change log：
> - v1.3.1（2026-04-21）：Phase 2 Gate 加 idempotency 重複 insert 驗證；feedback.ts 拆 `recordSearchQuery`(A) vs `recordFeedback`(延 5-B)
> - **v0.4（2026-04-23）**：Phase B 整塊標取消；新增 Phase C M1~M5；端對端驗收加 Phase C 清單

## Security follow-up（2026-07-16，延後、未阻擋 Employee Dashboard 部署）

- [ ] 輪替 DBHub 唯讀憑證，並確認新憑證仍只具查詢權限。
- [ ] 輪替兩個 GitHub deploy webhook secret，逐一驗證 Coolify 自動部署後再撤銷舊值。
- [ ] 輪替 CC-memory PostgreSQL 密碼，更新所有合法 client 後撤銷舊密碼。
- [ ] 建立不含 `read:sensitive` 的日常 Coolify token；高權限 token 僅作 break-glass 並分開保存。權限差異以 Coolify 官方 [API authorization](https://coolify.io/docs/api-reference/authorization) 為準。

---

# Phase A — 本期交付（MCP only）

## Phase 0 ✅ — Schema Alignment（已完成）

- [x] 刪除 `sql/schema.sql`（死檔）
- [x] 新增 `sql/migrations/` 目錄
- [x] `sql/migrations/0000_baseline.sql` 含 `CREATE EXTENSION IF NOT EXISTS vector`
- [x] 更新 `drizzle.config.ts` 指向 `./sql/migrations`
- [x] `scripts/install.sh` 改用 `DATABASE_URL` + `drizzle-kit push`
- [x] `README.md` + `docs/schema-alignment.md` 明示 Drizzle 為唯一真相

### Phase 0 Gate（已通過）

- [x] `ls sql/migrations/0000_*.sql` 可找到 baseline 檔
- [x] `grep -q "CREATE EXTENSION.*vector" sql/migrations/0000_*.sql` 成功
- [x] `drizzle.config.ts` 內的 `out` 指向 `./sql/migrations`
- [x] `scripts/install.sh` 不再引用已刪除的 `sql/schema.sql`
- [x] `README.md` 明示「Drizzle schema = 唯一真相」

---

## Phase 1 ✅ — 新增 3 張表 + TDD（已完成）

- [x] `src/db/schema.ts` 新增 `tasks` / `search_feedback` / `bot_user_state`
- [x] `sql/migrations/0001_add_tasks_feedback_bot_state.sql`
- [x] Docker test PG + `drizzle.test.config.ts` + 3 輪 red-green TDD
- [x] `tests/db/v02-tdd.test.ts`（14 tests）
- [x] 40/40 test 綠

### Phase 1 Gate（已通過）

- [x] `tests/db/v02-tdd.test.ts` 14 tests 綠（紅→綠→refactor 全跑過）
- [x] `psql $TEST_DATABASE_URL -c "\dt"` 能看到 `project_memories` / `tasks` / `search_feedback` / `bot_user_state` 四表
- [x] `npm test` 在 Phase 1 結束當下 40/40 全綠（regression + TDD 新測合併）
- [x] Zeabur PG 套用 0001 migration 成功

---

## Phase 2 ✅ — Schema 補完 + Service Layer（1.5d）

### 2a Schema 補完（v1.3 新增）

- [x] `src/db/schema.ts`：`projectMemories` 加 `idempotencyKey text` + `writerHost text`
- [x] `src/db/schema.ts`：`tasks` 加 `writerHost text`
- [x] `drizzle-kit generate --name=add_idempotency_and_writer` → `sql/migrations/0002_*.sql`
- [x] Partial unique index `project_memories_idempotency_idx` WHERE idempotency_key IS NOT NULL
- [x] 套用到 test PG + Zeabur PG
- [x] TDD：`tests/db/v03-writer-idempotency.test.ts`
  - [x] RED：不存在欄位 → insert writer_host 失敗 / idempotency_key 無 unique
  - [x] GREEN：schema 上線 → 重複 idempotency_key insert 收 duplicate key error

### 2b Service layer 抽出

> **TDD 順序**：每個 sub-task 先寫紅測跑失敗 → 實作到綠 → refactor。測試覆蓋 audit 見 2d。

- [x] `src/utils/repo-name.ts`（`execFileSync` 無 shell；不是 git repo 回 null）
- [x] `src/utils/writer-host.ts`（env `CC_MEMORY_WRITER` 或 `os.hostname()`）
- [x] `src/services/projects.ts`：`resolveProjectId` 實作 5 層優先序
  `explicit > env > marker > repo_name > basename`
- [x] `src/services/projects.ts`：`listProjects()` union from memories + tasks
- [x] `src/services/projects.ts`：`projectExists(id)`
- [x] `src/services/memories.ts`：搬自 `src/tools/*.ts`，保持 input/output 相容
  - [x] `saveMemory` 自動填 `writer_host`
  - [x] `saveMemory` 支援 optional `idempotency_key`（重複回舊 row id）
  - [x] `deleteByIdempotencyKey(key, maxAgeSec)` 靠 unique index 精準找
- [x] `src/services/tasks.ts`
  - [x] `createTask` 自動填 `writer_host`
  - [x] `updateTask(id, patch, { expectedStatus })` optimistic locking
  - [x] 狀態轉移 table-driven 驗證（違反 throw `InvalidTransitionError`）
  - [x] `resolveTaskByShortId(prefix, projectId)` 0/1/多筆回三態
- [x] `src/services/feedback.ts`：`recordSearchQuery`（Phase A MCP search 被動寫 row，9 欄：query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores；無 thumbs / selected_rank）
- [x] ~~`recordFeedback`（驗 array 長度 + rank，UPDATE thumbs / selected_rank）~~ → **延後到 Phase 5-B**（需 HTTP + Telegram inline button 回寫才有 signal）
- [x] ~~`src/services/botstate.ts`~~ → **延後到 Phase 3**（僅 HTTP bot route 使用，Phase A MCP 用不到）

### 2c MCP 改 call service

> **TDD 順序**：每個新增 tool 先寫紅測跑失敗 → 實作到綠。既有 6 個 memory tool 走 regression。

- [x] `src/index.ts` 改 call `services/*`（不再 import `db` client）
- [x] 新增 MCP tool：`cc_task_create`
- [x] 新增 MCP tool：`cc_task_list`
- [x] 新增 MCP tool：`cc_task_update`（要求帶 `expected_status`）
- [x] `src/tools/*.ts` 保留當薄殼
- [x] 既有 6 個 memory tool 輸入輸出格式不動

### 2d 測試 audit（覆蓋率檢查，測試本身於 2b/2c 邊做邊寫）

- [x] Unit：`services/tasks.ts` 狀態轉移 13 種組合 + optimistic locking
- [x] Unit：`services/projects.ts` 5 層優先序 + `listProjects` union
- [x] Unit：`utils/repo-name.ts` 各 URL 格式解析 + 非 git 目錄
- [x] Unit：`utils/writer-host.ts` env vs hostname
- [x] Integration：idempotency_key 重複 insert 行為
- [x] Regression：既有 9 個測試檔全綠

### Gate
- [x] `npm test` 40+（新增）tests 全綠
- [x] MCP 6 memory tool + 3 task tool 從 Claude Code 測全通
- [x] DB 可查：`SELECT idempotency_key, writer_host FROM project_memories LIMIT 1`
- [x] **DB 層冪等**：raw `INSERT` 兩次同 idempotency_key → 第二次收 unique violation
- [x] **Service 層冪等**：`saveMemory` 第二次帶相同 idempotency_key → 不拋錯、回傳既有 row id（不新增 row）

---

## Phase 5-A ✅ — Retrieval Eval（Phase A，0.5d）

> **TDD 順序**：每個 sub-task 先寫紅測跑失敗 → 實作到綠 → refactor。

- [x] `src/services/feedback.ts`：`recordSearchQuery(input)` — 每次 MCP search 自動 call，寫入 query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores
- [x] `src/index.ts`：`cc_memory_search` handler 呼叫完 search 後 fire-and-forget `recordSearchQuery`
- [x] 選用：`ALTER TABLE search_feedback ADD CONSTRAINT search_feedback_arrays_same_length CHECK (...)`
- [x] `scripts/eval-retrieval.ts`：14 天 markdown 報告（Phase A 指標：每日查詢數 / mode 分佈 / 結果穩定度）
  - [x] 標註 Phase B 才能算的指標（接受率 / Top-1 / 撤銷率）為 "N/A（待 Phase B）"
- [x] 文件：`docs/retrieval-eval.md`
- [x] Codex MCP 驗證：`codex mcp add cc-memory` 後能呼叫 `cc_memory_search`

### 5-A 測試 audit
- [x] Unit：`services/feedback.ts:recordSearchQuery` 9 欄完整 row 斷言
- [x] Integration：MCP `cc_memory_search` 觸發後 `search_feedback` row 存在
- [x] Regression：既有 search / save / list 測試全綠

### Gate
- [x] 跑一次 `cc_memory_search` 後 `SELECT * FROM search_feedback ORDER BY created_at DESC LIMIT 1` 能看到該 row
- [x] `scripts/eval-retrieval.ts` 能產出 markdown 報告，含「每日查詢數」「mode 分佈」「結果穩定度」三個區塊
- [x] 報告含 Phase A 指標數值，能用於 Go/No-Go 判斷：每日查詢數（目標 > 3）、結果穩定度（目標 > 70%）
- [x] Codex MCP：`codex mcp add cc-memory` 後能從 Codex CLI 呼叫 `cc_memory_search`

---

# ~~Phase B — 後續階段（HTTP + Telegram）~~ ❌ 2026-04-23 整塊取消（以下歷史）

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

# Phase C — v0.4 自動採集（pending）

> ⚠️ **SUPERSEDED（已被取代）2026-07-05**：本 Phase C v0.4 task list 已由 `docs/auto-capture-v0.5/{spec,plan,task}.md` 取代；以下內容僅供歷史溯源，不重寫內文。

> 完整設計見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §Rollout Plan + §Success Criteria。
> 每個 Milestone 開工前讀 `~/.claude/rules/sdd-workflow.md` 的 `## 每個 Phase 執行紀律`（brainstorm → context7 → TDD → simplify → review → codex-review）。

## M1 — Schema + Refine Tools MVP（~1d）

- [ ] `src/db/schema.ts`：新增 `sessionSummaries` 表（`vector(1536)` embedding，沿用 `EMBEDDING_DIMENSIONS` 常數 + partial unique index `(project_id, session_id) WHERE status='active' AND session_id IS NOT NULL`）
- [ ] `src/db/schema.ts`：新增 `refineAuditLog` 表
- [ ] `src/db/schema.ts`：`projectMemories` 加 `source_summary_id uuid` REFERENCES `session_summaries(id)`（nullable、**無 ON DELETE CASCADE**；frozen 2026-04-23）
- [ ] 核對 `session_summaries.status` CHECK 僅 `'active' | 'archived'`（無 `merged`；merge 走 archive + `metadata.merged_into`；frozen 2026-04-23）
- [ ] 核對 `sessionSummaries.promoted_to_memory_id` 為 nullable uuid（無 CASCADE；refine delete 手動 nullify 對側）
- [ ] `drizzle-kit generate --name=session_summaries_refine_audit` → `sql/migrations/0006_*.sql`（現最新是 0005，下一編號是 0006；frozen 2026-04-23）
- [ ] 套用 local + Zeabur PG
- [ ] `src/services/refine.ts`：delete / promote / merge / edit 四操作 + audit log 寫入
- [ ] `src/tools/refine-{delete,promote,merge,edit}.ts`：MCP tool 註冊
- [ ] `scripts/refine.ts` CLI：list / delete / promote / merge / edit / audit，`--dry-run` / `--yes` / `--project`
- [ ] Unit + Integration tests（≥ 12 新測）

### M1 Gate

- [ ] migration 在 local PG / Zeabur PG 都成功
- [ ] `project_memories.source_summary_id` 可 FK 到 `session_summaries.id`
- [ ] 四個 refine MCP tool happy path 綠
- [ ] CLI `refine list --where ...` 可讀、`refine audit --since ...` 可讀
- [ ] 原 248 tests 全綠

---

## M2 — Capture Pipeline（~2.5d）

- [ ] `src/llm/claude-cli.ts`：封裝 `spawn('claude', ['-p', ..., '--output-format', 'json', '--model', <m>])` + timeout 60s + retry 3 次指數退避 + stdout parse
- [ ] `src/llm/gemini-embed.ts`：抽 Phase A 既有 embedding 邏輯成獨立模組（介面不變）
- [ ] `src/services/summaries.ts`：`upsertSessionSummary`（首次 INSERT / 二次 UPDATE，`summarize_count++`）+ null session_id 降級
- [ ] `src/tools/save-summary.ts`：MCP `cc_memory_save_summary`
- [ ] `scripts/capture-runner.ts`：
  - [ ] 讀 env（`CLAUDE_SESSION_ID` / `CLAUDE_TRANSCRIPT_PATH` / `CLAUDE_PROJECT_DIR`）
  - [ ] Feature flag `CC_MEMORY_AUTO_CAPTURE=off` 直接 exit
  - [ ] SKIP_TOOLS 過濾（從 transcript 抽本輪 tool list，⊆ 清單則 skip；env `CC_MEMORY_SKIP_TOOLS` 整個覆蓋預設清單，非 union；frozen 2026-04-23）
  - [ ] 雙節流（min-interval 180s + min-delta-tokens 500）
  - [ ] Transcript size cap（head 500KB + tail 1MB）
  - [ ] 算 idempotency_key
  - [ ] Claude CLI call → parse → embed → MCP save-summary
  - [ ] 更新 `~/.cc-memory/state/<session_id>.json`（last_summary_at / last_transcript_hash / summarize_count / last_tools / null_session_streak）
  - [ ] Queue resume + `.dead` 標記（attempts ≥ 5）
  - [ ] `claude-cli-missing.flag` + `quota-exceeded.flag` 機制
- [ ] `hooks/stop-capture.sh`（`set +e` 呼叫 runner）
- [ ] Unit + Integration tests（SKIP_TOOLS / 節流 / upsert / null session / queue resume / flag 機制）

### M2 Gate

- [ ] E2E：模擬 Stop hook 觸發（直接跑 hook wrapper）→ DB 有 row，`writer_host` 正確
- [ ] 同 session 跑兩輪 Stop（transcript 有新增）→ DB 只有一筆 active、`summarize_count=2`
- [ ] 本輪只有 `TodoWrite` → 不摘要（SKIP_TOOLS 生效）
- [ ] 兩輪間隔 < 180s + delta < 500 tokens → 不摘要（節流生效）
- [ ] 斷 DB 連線跑 capture → `~/.cc-memory/capture-queue/` 有一筆 → 恢復連線重觸 hook → queue 清空、DB 有 row
- [ ] `CC_MEMORY_AUTO_CAPTURE=off` → runner exit 無寫入
- [ ] Claude CLI 不存在 integration test 綠（flag 機制）

---

## M3 — Retrieval Integration + 跨專案（~1.5d）

- [ ] `src/services/memories.ts` `searchMemories` 擴展：
  - [ ] 新增 `project_ids?: string[]` 參數（優先於 `project_id`）
  - [ ] `project_ids=['*']` → ALL project（需 explicit）
  - [ ] 跨兩表 query + 加權 rerank（`W_MANUAL=1.0` / `W_PROMOTED=0.85` / `W_AUTO=0.65`）
  - [ ] 結果每筆標 `project_id`
- [ ] `src/db/schema.ts`：`search_feedback` 加 `result_source_breakdown jsonb`
- [ ] `drizzle-kit generate --name=search_feedback_source_breakdown` → `sql/migrations/0007_*.sql`（frozen 2026-04-23）
- [ ] `src/services/feedback.ts` `recordSearchQuery` 填 breakdown
- [ ] env 配置讀取：`CC_MEMORY_WEIGHT_*` / `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH`
- [ ] Unit + Integration tests（加權 / 跨專案 / feature flag off 退回 Phase A 行為）

### M3 Gate

- [ ] manual 和 auto 同 query cosine 差 ≤ 0.15 時，加權後 manual 排前
- [ ] `project_ids=['A','B']` 能回跨兩個 project 的結果，每筆 `project_id` 正確
- [ ] `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off` → 只回 `project_memories`（退回 Phase A）
- [ ] 原 248 tests 不回歸

---

## M4 — SessionStart Re-inject（~1d）

- [ ] `src/tools/recent-summaries.ts`：MCP `cc_memory_recent_summaries(project_id, limit)` read-only
- [ ] `scripts/reinject-runner.ts`：
  - [ ] Feature flag `CC_MEMORY_REINJECT=off` exit
  - [ ] 查近 N 筆 summary（env `CC_MEMORY_REINJECT_SUMMARIES`，預設 `3`；frozen 2026-04-23）
  - [ ] 查近 M 筆 manual / promoted（env `CC_MEMORY_REINJECT_MANUAL`，預設 `2`；frozen 2026-04-23）
  - [ ] 格式化為 Claude Code hook protocol `additionalContext` JSON
  - [ ] stdout 輸出（失敗 / 空結果 → stdout 空）
- [ ] `hooks/session-start-reinject.sh`（matcher 對應 `startup|clear|compact`）
- [ ] 實作前 context7 查 Claude Code 當前 hook protocol 對 `additionalContext` 的要求
- [ ] Unit + Integration tests

### M4 Gate

- [ ] `/clear` 觸發 → 新 context 含近 3 筆 summary + 2 筆 manual（Claude 能 recall 注入內容）
- [ ] `CC_MEMORY_REINJECT=off` → `/clear` 後 context 不含注入
- [ ] 空 project → stdout 空、session 正常啟動（不注入 placeholder）

---

## M5 — Benchmark Harness + 觀察期進入（~0.5d dev）

- [ ] `docs/benchmark/fixtures.md`：固定 5 query fixture（含 expected top-3 manual memory id，人工維護）
- [ ] `scripts/benchmark.ts`：
  - [ ] 接受 `--fixtures <path>` 載固定 query
  - [ ] 從 `search_feedback` 近 7 日 query 抽真實 5 query
  - [ ] 對 CC-memory 與 claude-mem 各跑 top-5
  - [ ] 輸出 `docs/benchmark-YYYY-MM-DD.md`（含交集、rank、錯抓率 placeholder 留人工填）
- [ ] 人工標註 template：`docs/benchmark/manual-template.md`

### M5 Gate

- [ ] `npx tsx scripts/benchmark.ts --fixtures docs/benchmark/fixtures.md` 可跑完、輸出 markdown 報告
- [ ] 進入觀察期（≥ 2 週 + ≥ 30 筆 auto summary）；觀察期結束才評品質閘

---

# 品質閘（Phase C 結束後，決定是否停用 claude-mem）

**不是 M5 Gate，是獨立決策點**。

- [ ] Top-5 交集 ≥ 3 筆（≥ 7/10 組 query 達標）
- [ ] 人工命中度：CC-memory 平均 first-relevant rank ≤ claude-mem
- [ ] 錯抓率：最近 50 筆 auto summary 錯抓 < 10%

三項 AND 滿足 → 產出 `docs/claude-mem-switchoff-decision.md`、停用 claude-mem。
不滿足 → 繼續併用、分析原因、v0.5 調參數再跑。

---

## 端對端驗收

### Phase A（已過）✅

- [x] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到，`writer_host` 顯示 A hostname
- [x] A 電腦 `cc_task_create` → B 電腦 `cc_task_list` 能看到，`writer_host` 顯示 A hostname
- [x] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
- [x] B 電腦 clone 到不同 path → 自動解析到相同 `project_id`（原靠 repo_name；2026-09-02 起改為靠 CLAUDE.md marker 或相同 clone 目錄名，見 DEC-20260902T151857Z）
- [x] MCP `cc_memory_search` 每次呼叫後 `search_feedback` 多一筆（`CC_SEARCH_FEEDBACK` 預設 on 時；設 off 則不寫，見 personal-hub Phase 2）
- [x] `scripts/eval-retrieval.ts` 能產出 markdown 報告

### ~~Phase B（已取消）~~ ❌

### Phase C（v0.4 本期必過）

> ⚠️ **SUPERSEDED（已被取代）2026-07-05**：v0.5 端對端驗收清單見 `docs/auto-capture-v0.5/task.md`；以下為 v0.4 歷史版。

**Capture**
- [ ] A 機器跑一輪對話 → Stop hook → B 機器 `cc_memory_search` 查得到該 session summary，`writer_host`=A
- [ ] 長 session 跑 N 輪 → 只有一筆 active row，`summarize_count=N`（或更少）
- [ ] `CC_MEMORY_AUTO_CAPTURE=off` → DB 無新 row
- [ ] 斷網 capture → queue 有 row → 連網重觸 → queue 清空、DB 有 row

**Re-inject**
- [ ] `/clear` 或 `/compact` 觸發 → 新 context 含近 3 筆 summary + 2 筆 manual
- [ ] `CC_MEMORY_REINJECT=off` → 新 context 不含注入

**Retrieval**
- [ ] `include_auto=true` / `=false` 結果差異符合加權
- [ ] 手動 save + auto 抓同主題 → manual 排前
- [ ] promote 一筆 auto → 該筆排名上升
- [ ] `project_ids=['CC-memory','AI_Copilot']` 跨專案結果每筆標 `project_id`

**Refine**
- [ ] 四個 refine MCP tool 各 happy path + audit log 有一筆
- [ ] CLI `refine list/delete/promote/merge/edit/audit` 都能跑

**Benchmark / 品質閘**
- [ ] `scripts/benchmark.ts` 跑完 10 組 query → 輸出 `docs/benchmark-YYYY-MM-DD.md`
- [ ] 觀察期結束、三指標達標 → 產出 `docs/claude-mem-switchoff-decision.md`
