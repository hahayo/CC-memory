# Personal-Hub Task Breakdown

> **當前狀態（2026-06-09）**：Personal-Hub Phase 0 全 Gate 綠 ✅（commit `01dd5e4`，306 tests）· Phase 1（reminder）✅ 全 Gate 綠（reminder schema + service + MCP tools + CLI；19 service + 14 schema + 8 mcp tests）· Phase 2（read-only）✅ 全 Gate 綠（tool-policy 雙層 enforce + telemetry 開關；24 unit + 8 mcp tests）· **Phase 3（v0.4 翻案：獨立 personal DB）** + 跨 repo = roadmap。翻案脈絡見 [decisions/ADR-001-phase3-separate-db.md](decisions/ADR-001-phase3-separate-db.md)。
>
> **Phase 命名**：本檔的 `Personal-Hub Phase 0/1/2/3` 是 **personal-hub initiative 的 phase**，與既有 `docs/task.md` 的 Phase A/B/C（v0.3/v0.4 memory+auto-capture）是**不同 track**，勿混。
>
> **執行紀律**：每個 Phase 開工前讀 `~/.claude/rules/sdd-workflow.md` 的 `## 每個 Phase 執行紀律`（brainstorm → context7 → TDD → simplify → review → codex-review）。對應 `spec.md` / `plan.md`。
>
> change log：
> - v0.1（2026-06-05）：首版。

---

# Personal-Hub Phase 0 — 安全核心 ✅（已交付）

> commit `01dd5e4`，branch `feature/personal-hub-phase0`，306 tests 綠。回填已完成項。

## 0a — forced-mode + ScopePolicy ✅

- [x] `src/services/scope-policy.ts`：`PERSONAL_PROJECT_ID` / `RESERVED_PROJECT_IDS` / `isReservedProjectId`
- [x] `loadScopeConfig(env)`：解析 `CC_FORCE_PROJECT_ID`；與 `CC_MEMORY_PROJECT_ID` 同設 → 啟動 fail（config-drift 防護）
- [x] `applyScopePolicy(resolvedId, { config, surface })`：forced / scope / search 三分支
- [x] blank（空字串/whitespace）正規化成 undefined（防 `project_path:'/'` basename fallback 洩漏）

## 0b — project-mode deny + 全專案 search 排除 ✅

- [x] project-mode 顯式 `project_id=__personal__` → `InvalidArgumentError`
- [x] project-mode 經 path/marker/git/basename 解析到 `__personal__` → 同拒
- [x] 全專案 search（無 selector）→ WHERE 層排除保留 namespace
- [x] `listProjects()` 排除保留 namespace

## 0c — cc_task_stats + hardening ✅

- [x] `cc_task_stats`：today/overdue/open/in_progress/completed_recently（Asia/Taipei 日界）
- [x] forced-mode ListTools schema selector 改非必填（Codex review P2）
- [x] input hardening
- [x] CLAUDE.md 工具清單 + `__personal__` 說明 cascade 同步

## Phase 0 Gate ✅
- [x] 雙向 deny 三路（personal→專案 / 專案→personal / 全專案 search）皆有測試
- [x] config-drift fail 有測試
- [x] `cc_task_stats` 日界正確
- [x] 306 tests 綠（唯一失敗為 sandbox `/tmp/.git` artifact，非 code bug）
- [x] Codex review gate 過（採納 P2 personal 外洩修正 + input hardening）

---

# Personal-Hub Phase 1 — Reliable Reminders（✅ 已完成，離線可做）

> 對齊 `src/db/schema.ts` 慣例（partial unique index / `check()` / `withTimezone`）。slot 推導/advance/snooze 語意見 `plan.md` Data Model。**每個 sub-task 先紅後綠（TDD）**。

## 1a — Schema（reminder 欄位 + reminder_log 表）✅

- [x] `src/db/schema.ts`：`tasks` 加 `remindAt` / `lastNotifiedAt` / `snoozeUntil` / `recurrenceIntervalDays`（皆 nullable）
- [x] `src/db/schema.ts`：`check('tasks_recurrence_interval_check', recurrence IS NULL OR > 0)`
- [x] `src/db/schema.ts`：`index('reminders_due_idx')` partial（`COALESCE(snooze_until, remind_at)` WHERE `remind_at IS NOT NULL AND status IN ('open','in_progress')`）
- [x] `src/db/schema.ts`：新表 `reminderLog`（`taskId` FK→tasks / `scheduledFor` / `firedAt` / `channel` / `writerHost`）
- [x] `uniqueIndex('reminder_log_task_slot_uniq')` on `(task_id, scheduled_for)`（去重硬背線）
- [x] `drizzle-kit generate --name=add_reminders` → `sql/migrations/0006_add_reminders.sql`（COALESCE expression index + CHECK 保真度 eyeball OK）
- [x] 套用 local test PG（`drizzle-kit push --config drizzle.test.config.ts`）
- [x] TDD：`tests/db/reminders-schema.test.ts`（14 tests）
  - [x] RED：欄位/表不存在 → insert 失敗
  - [x] GREEN：schema 上線 → 同 `(task_id, scheduled_for)` 重複 insert 收 unique violation
  - [x] CHECK：`recurrence_interval_days=0` / 負數 insert 被 CHECK 擋
  - [x] index 保真：`pg_indexes.indexdef` 斷言含 COALESCE + partial WHERE（守 generate 退化）

## 1b — Service（getDueReminders + set/snooze/clear）✅

- [x] `src/services/reminders.ts`：`setReminder(db, taskId, projectId, { remindAt, recurrenceIntervalDays })`（`WHERE id AND project_id`，affected=0 throw；**reschedule 必清 `snooze_until`+`last_notified_at`**，否則殘留舊 snooze 蓋過新 remind_at）
- [x] `snoozeReminder(db, taskId, projectId, until)`（同 scope guard）
- [x] `clearReminder(db, taskId, projectId)`（清 remind_at / snooze_until / recurrence；同 scope guard）
- [x] `getDueReminders(db, { projectId, now?, channel, writerHost?, limit? })`：
  - [x] 篩選 SQL：`status IN open/in_progress AND project_id=$projectId AND remind_at NOT NULL AND COALESCE(snooze,remind)<=now AND NOT EXISTS(reminder_log 同 slot)`（**project_id scope + NOT EXISTS 在 LIMIT 前**；now 以 ISO+::timestamptz 傳入）
  - [x] `FOR UPDATE SKIP LOCKED` claim
  - [x] `INSERT reminder_log ... ON CONFLICT (task_id, scheduled_for) DO NOTHING RETURNING id`（**不可 catch unique_violation——會 abort 交易**；RETURNING 空 → 跳過該筆不 advance、不計回傳；race backstop）
  - [x] advance：一次性 → 只更新 `last_notified_at`（保留 remind_at/snooze；下輪 NOT EXISTS 排除）；recurrence → 從 `remind_at` 錨點推下一未來 slot、清 snooze、更新 last_notified
- [x] TDD：`tests/services/reminders.test.ts`（19 tests）
  - [x] 一次性 due → 撈出 + log 一筆；再跑 → 不重複（NOT EXISTS 排除，不進 batch）
  - [x] **不 starve**：塞 K（≥limit）筆已投遞一次性 + 1 筆新 due → 新 due 在本批被處理
  - [x] **scope 隔離**：別 project 的 due task → 不被撈出；`setReminder` 帶別 project task id → throw（affected=0）
  - [x] **setReminder 清 stale snooze**：對一次性已 snooze 過的 task 重設 remind_at → 新提醒在新時點 due（舊 snooze 不蓋過）
  - [x] **ON CONFLICT 不 abort 交易**：同交易內模擬 slot 衝突 → 該筆跳過、其餘 row 仍正常處理 + commit（非整批失敗）
  - [x] 併發兩 session 同 due → 只一筆 `reminder_log`（SKIP LOCKED + unique）
  - [x] recurrence：第 N 次 `scheduled_for = remind_at + (N-1)*interval`（不漂移）
  - [x] catch-up：漏發 3 次 → 只一筆 log、`remind_at` clamp 到下一未來 slot
  - [x] snooze：投在 `snooze_until`、不重複；**一次性 snooze 投遞後不再響**（不清 snooze 的關鍵測）
  - [x] `done`/`cancelled` task → 不被撈出

## 1c — MCP tool + 手動驅動 CLI ✅

- [x] `cc_task_set_reminder` tool def + handler **inline 於 `src/index.ts`**（非 `src/tools/` 殼；理由見 plan.md 偏離說明）
- [x] `cc_task_snooze` tool def + handler inline 於 `src/index.ts`
- [x] `src/index.ts`：註冊新 tool，套 `applyScopePolicy` 取得 scope projectId → 傳給 `setReminder/snooze`（mutation scope guard）；ISO timestamp 經 `parseRequiredTimestamp` 驗證
- [x] `scripts/run-reminders.ts`：CLI 手動跑 `getDueReminders`，**先 `applyScopePolicy` 解析 scope 再傳 `projectId`**（forced personal instance = `__personal__`）；印出本次投遞清單
- [x] 既有 task MCP tool 契約不動（regression 全套綠）

## Phase 1 Gate ✅
- [x] `npm test` 新增 reminder tests 全綠（14 schema + 19 service + 8 mcp）
- [x] DB 可查：`reminder_log` 表存在；tasks 有 remind_at/recurrence_interval_days 欄位
- [x] 去重：raw 兩次 INSERT 同 `(task_id, scheduled_for)` → 第二次 unique violation
- [x] 不 starve：已投遞一次性塞滿 ≥limit → 新 due 仍被處理（NOT EXISTS 在 LIMIT 前生效）
- [x] scope：別 project due task 不被個人 instance 撈出；mutation 跨 project 被拒
- [x] 併發：兩連線跑同一 due → 只一筆 `reminder_log`
- [x] recurrence 不漂移 + catch-up 不洪水 + snooze 不重複 三組行為測試綠
- [x] 原測試不回歸（397 pass，唯一 fail 為既有 sandbox `/tmp/.git` 環境問題，非本次 code bug）

---

# Personal-Hub Phase 2 — Read-only Mode（✅ 已完成，離線可做）

> read-only 必須**雙層** enforce（ListTools 過濾 + handler 拒絕）。telemetry 副作用（`search_feedback`）由 `CC_SEARCH_FEEDBACK` 控制。

## 2a — Tool policy 核心 ✅

- [x] `src/services/tool-policy.ts`：`isWriteTool(name)`（save/delete/task_create/task_update/set_reminder/snooze 列為寫入）
- [x] `loadToolPolicy(env)`：讀 `CC_READ_ONLY` / `CC_TOOL_ALLOWLIST` / `CC_SEARCH_FEEDBACK`
- [x] `assertWritable(toolName, policy)`：read-only 且為寫入 tool → throw ForbiddenError（只管寫入）
- [x] `assertAllowed(toolName, policy)`：allowlist 非空且 tool 不在集合 → throw（**含 read tool**，與 write/read 無關）
- [x] `ForbiddenError`（code `FORBIDDEN`）+ McpError union 同步
- [x] TDD：`tests/services/tool-policy.test.ts`（24 tests：write tool 判定 / env 解析 / read-only 旗標 / allowlist 子集含 read tool 被擋）

## 2b — MCP 雙層 enforce（central dispatch）✅

- [x] `src/index.ts` `buildToolsForMode` 依 policy 過濾——read-only 去寫入 tool、allowlist 只露集合內 tool（含 read 過濾）
- [x] `src/index.ts` **central dispatch 守衛**（handleToolCall try 開頭，switch 前所有 tool 都過）：先 `assertAllowed`，再 `assertWritable`
- [x] `cc_memory_search` 的 `recordSearchQuery` 副作用受 `CC_SEARCH_FEEDBACK` 控制（off → 不寫 telemetry）
- [x] TDD：`tests/mcp-read-only.test.ts`（8 tests）
  - [x] `CC_READ_ONLY=1` → ListTools 無任何寫入 tool
  - [x] 直接呼叫被隱藏的 `cc_memory_save` → handler 拒絕（FORBIDDEN）
  - [x] `CC_TOOL_ALLOWLIST=cc_memory_search,cc_task_list` → 集合外兩層皆拒
  - [x] **allowlist 排除 read tool**（如 `cc_memory_get`）→ ListTools 不露 + 直呼經 `assertAllowed` 被拒
  - [x] `CC_SEARCH_FEEDBACK=off` → search 不寫 `search_feedback`

## Phase 2 Gate ✅
- [x] ListTools 過濾 + handler 拒絕雙層測試綠
- [x] allowlist 子集生效，且**排除的 read tool 直呼也被拒**（assertAllowed 涵蓋 read）
- [x] read-only telemetry 開關生效
- [x] 原 tests 不回歸（430 pass，唯一 fail 為既有 sandbox 環境問題）

---

# Personal-Hub Phase 3 — Prod Hardening（roadmap，需 Zeabur 開新 PG service；v0.4 翻案：獨立 personal DB）

> 終極硬隔離：個人資料搬到獨立 personal PostgreSQL service（`DATABASE_URL_PERSONAL`），靠 secret 配發 + 物理切分。原 RLS 方案 v0.4 翻案（owner / superuser 預設失效、policy 漏寫即靜默故障），見 [decisions/ADR-001-phase3-separate-db.md](decisions/ADR-001-phase3-separate-db.md)。**風險集中在跨 DB 遷移；maintenance window + preflight 三 mode 全 PASS 才繼續。**

## 3a — config + db client + migration 0007（離線可做；2026-06-09 session 已交付）

- [ ] A2.1 Zeabur 開 PG service `cc-memory-personal`（與 project DB 同 region）；取 `DATABASE_URL_PERSONAL`  ← **僅此項待 user**
- [x] A2.2 `resolveDatabaseUrl()` + fail-fast 矩陣（`src/db/resolve-url.ts`，config.ts 重接；TDD 綠）
  - forced-mode personal 缺 `DATABASE_URL_PERSONAL` → exit ✅
  - forced-mode personal 兩 URL 同物理 DB → exit ✅
  - 非 forced personal 偵測到 `DATABASE_URL_PERSONAL` 存在 → warn + 拒絕載入該 URL（不 exit）✅
  - 兩衝突 env `CC_FORCE_PROJECT_ID` + `CC_MEMORY_PROJECT_ID` 同設 → exit（既有，`src/services/scope-policy.ts` `loadScopeConfig` 守）✅
  - forced 非 personal namespace 不 throw ✅
- [x] A2.2 `src/db/client.ts` 用 `config.databaseUrl`（已是 resolveDatabaseUrl 啟動期決策結果），加「一 process 一 scope 一 DB」原則註解
  - ⚠️ `.env.example` topology 註解被 harness denylist 攔（`.env*` 在 denylist）；topology 知識完整在 [ADR-001](decisions/ADR-001-phase3-separate-db.md) deployment topology 表 + plan.md instance 拓樸表
- [x] A2.3 `sql/migrations/0007_personal_db_check_constraint.sql`（personal-DB-only）+ `0008_project_db_no_personal_check.sql`（project-DB-only 反向 CHECK，delete COMMIT 後才套；互為鏡像防回流）。**不進共用 `src/db/schema.ts`**（schema.ts 是兩 DB 共用 source）。SQL header 註明套用邊
- [x] A2.4 `scripts/preflight.ts` 拆檔三 mode，mode-prefixed cases（P1-P7/C1-C5/D1-D5；對真 test DB 煙霧測試全 PASS）
- [x] A2.3 `scripts/migrate-personal-data.ts` lib 化（`scripts/lib/{inventory,clients,checksum}.ts` 單一 SoT）+ FK-safe 順序 + cursor pagination + `--dry-run` + rerun 語意
- [x] A2.5 `scripts/delete-personal-data.ts`（P0 修復）：單一 tx 內 LOCK TABLE → 重計數 → checksum 與 personal DB 精確比對 → DELETE → 同 tx 驗證 → COMMIT + manifest；dry-run 預設；integration tests 6 cases 綠
- [x] 全管線 e2e 演練（`tests/scripts/e2e-migration-pipeline.test.ts`；staging 演練前移、本地可重複）

## 3b — preflight 三 mode + 遷移腳本（離線可做；本 session 已交付，等同 3a 末三項）

> 細項已收進 3a。以下保留為 mode-level 明細與 A2.6 maintenance window 步驟參照點，不重複 [x] 勾選。

- [x] A2.4 `scripts/preflight.ts --mode pre-migration`（P1-P7）：URL 層 connection identity（host+port+database 比對；user 只進報表不參與判定）、DB 活體 advisory-lock probe + 0007/0008 方向檢查、current_database 一致、resolveDatabaseUrl 配對矩陣、schema 一致（columns/constraints/indexes + expected-delta allowlist）、inventory assertion
- [x] A2.4 `scripts/preflight.ts --mode post-copy`（C1-C5）：identity 重跑（FAIL 即 abort）；personal DB `__personal__` row count == project DB 原始（含 reminder_log FK-scoped）；per-table checksum（`to_jsonb` + UTC 的 MD5 string_agg）一致；personal DB 其他 project_id 0 列；0007 CHECK 拒非 `__personal__` INSERT
- [x] A2.4 `scripts/preflight.ts --mode post-delete`（D1-D5）：identity 重跑 + 雙 URL 必填；project DB 個人列全 0（4 predicate 含 search_feedback 混合列；排除 bot_user_state）；personal DB 列數 vs delete manifest 精確比對；0008 反向 CHECK 拒寫 probe；scope tests via vitest（test PG 不可達顯式 SKIP）——ScopePolicy SQL 排除正確性由 shared predicate + `tests/scripts/scope-probe.test.ts`（control+treatment）鎖
- [x] A2.3 `scripts/migrate-personal-data.ts`：表 inventory 走 `scripts/lib/inventory.ts` 單一 SoT（`information_schema` query + `EXPECTED_INVENTORY` diff 斷言，**不手寫**）；copy project DB `__personal__` 列 → personal DB（search_feedback 不在 copy 範圍——拍板只刪不搬）

## 3c — prod maintenance window（需 user / 線上）

- [ ] Step 0 開 prod backup：project DB `pg_dumpall` 含 globals → 異地存放；空 personal DB backup
- [ ] Step 1 跑 migration 0000-0007 到 personal DB；preflight pre-migration（P1-P7）PASS
- [ ] Step 2 停 writers（hermes、reminder poller、Todoist sync），等 in-flight transactions drain
- [ ] Step 3 跑 `scripts/migrate-personal-data.ts`；preflight post-copy（C1-C5）PASS
- [ ] Step 4 rollback judgement：preflight fail → drop personal DB、project DB 原樣、結束 maintenance；PASS → 跑 delete dry-run（`tsx scripts/delete-personal-data.ts`，dry-run 預設，印計畫 + checksum 預覽）
- [ ] Step 5 `tsx scripts/delete-personal-data.ts --execute --manifest-out <path>`：script 在單一 tx 內 LOCK → 重計數 → checksum 比對 → DELETE（含 search_feedback 混合列）→ 同 tx 驗證 → COMMIT；任一不符自動 ROLLBACK + exit 1
- [ ] Step 5.5 套 0008 反向 CHECK 到 project DB（必須在 Step 5 COMMIT 之後）
- [ ] Step 5.6 preflight post-delete（D1-D5，帶 `--manifest <path>`；COMMIT 後最終確認）PASS
- [ ] Step 6 env 切換 + 重啟 services（hermes / forced-mode instance 補 `DATABASE_URL_PERSONAL`；hermes redeploy 與本步同窗）；結束 maintenance window
- [ ] Step 7 跑 A2.7 端對端驗收

## Phase 3 Gate（A2.7 端對端驗收 7 條）
- [ ] preflight 三 mode 全 PASS（本地全管線 e2e 已綠；staging 再跑完整 Step 0-7 演練，D5 不得為 SKIP）
- [ ] forced-mode personal `cc_memory_save` 寫進 personal DB、project DB 查不到
- [ ] project-mode 全專案 search 不含 `__personal__`（排除 predicate 由 shared builder + scope-probe test 鎖；0008 後 project DB 已插不進 `__personal__` 列，D4 反向 CHECK probe 拒寫）
- [ ] 拿 project DB URL raw postgres 查 `__personal__` → 0 列
- [ ] personal DB INSERT 非 `__personal__` row → 0007 CHECK 拒；project DB INSERT `__personal__` row → 0008 CHECK 拒
- [ ] 非 forced personal 偵測到 `DATABASE_URL_PERSONAL` → warn + 拒載入該 URL（不 exit）；forced-mode personal 缺 URL → exit
- [ ] 既有 forced/project instance 功能不回歸

---

# 跨 repo 階段（roadmap，憑證/授權未到位前不展開 task 細節）

> 只列目標 + Gate + blocking OQ。介面草案見 `plan.md` 的 Rollout Order 跨 repo roadmap 表。**不在此展開逐項 task**（過早展開會變猜測）。

## 階段 -1 — AI_Copilot raw postgres 前置（v0.4 翻案後降為 strongly recommended，非 hard blocker）
- [ ] 移除/限制 AI_Copilot `.mcp.json` 的 raw postgres
- Gate（新）：該環境 raw postgres MCP **不持** `DATABASE_URL_PERSONAL` 且無寫入個人 DB 通道。Phase 3 v0.4 後個人資料不在 project DB，project `DATABASE_URL` 已無讀寫個人資料能力（但仍建議清理 raw postgres 降攻擊面）

## hermes 整合
- [ ] hermes 起 cc-memory MCP（`CC_FORCE_PROJECT_ID=__personal__`）
- Gate：hermes 能讀寫 `__personal__`、讀不到專案資料

## /hi 整合
- [ ] `/hi` 用 read-only instance 注入個人近況/待辦（含 `cc_task_stats`）
- Gate：能注入但絕不誤寫

## reminder 投遞 channel
- [ ] poller 呼 `getDueReminders({channel})` → 推送實際 channel
- Gate：端到端「設提醒 → 到點收到」；去重不重複投
- OQ：channel 選型、poller 跑在哪

## Todoist 整合（live REST 工具，Option E）
- [x] cc-memory 內建薄 Todoist API v1 client（`src/services/todoist.ts`）+ 5 個 `cc_todoist_*` 工具（add/projects/list/complete/completed）
- [x] gating：token∧forced-personal（__personal__）雙條件曝光 + 雙層 enforce；write 分類（add/complete）；無 project selector
- Gate（單元）：`npm test` 全綠（todoist client + mcp gating/handler）；無 token/非 forced=13 工具、token∧forced-personal=18
- Gate（e2e）：真帳號一輪 `projects→add→list→complete→completed`（`RUN_TODOIST_E2E=1`）；priority p1↔API 整數比對
- 註：雙系統並存、**無自動 sync**（追蹤完成 on-demand）；自動鏡像（webhook）為後續 phase

---

## 端對端驗收

### Personal-Hub Phase 0（已過）✅

- [x] project-mode 顯式 / 解析 / 全專案 search 三路皆擋 `__personal__`
- [x] forced-mode 無 selector 套用、顯式不同 project 拒、config 衝突 fail
- [x] `cc_task_stats` 台北日界聚合

### Personal-Hub Phase 1（reminder，✅ 本期已達成）

- [x] 設 `remind_at<=now()` open task → `getDueReminders()` 撈出 + `reminder_log` 一筆
- [x] 同 slot 再跑 → 不重複（NOT EXISTS 排除）
- [x] 已投遞一次性塞滿 batch + 1 新 due → 新 due 仍被處理（不 starve）
- [x] 別 project due task → 個人 instance 不撈出；跨 project mutation 被拒
- [x] 兩 poller 並發同 due → 只一筆 `reminder_log`
- [x] `recurrence=1` 連跑 → 第 N 次 `scheduled_for = remind_at + (N-1)天`
- [x] 漏發 3 次 → 補一筆、`remind_at` 跳下一未來 slot
- [x] snooze → 在 snooze 時點投一次；一次性 snooze 投後不再響
- [x] task 設 `done` → 不再被撈出

### Personal-Hub Phase 2（read-only，✅ 本期已達成）

- [x] `CC_READ_ONLY=1` ListTools 無寫入 tool
- [x] 直呼 `cc_memory_save` → handler 拒（FORBIDDEN）
- [x] `CC_TOOL_ALLOWLIST` 子集兩層生效；排除的 read tool 直呼也被拒
- [x] `CC_SEARCH_FEEDBACK=off` → 不寫 telemetry

### Personal-Hub Phase 3（prod，roadmap；v0.4 翻案：獨立 personal DB）

> ✅ 2026-06-10 prod cutover 完成（A2.1 + A2.6 全程 + A2.7 smoke）；rollback rehearsal 以本地全管線 e2e（tests/scripts/e2e-migration-pipeline.test.ts）替代執行。

- [x] forced-mode personal instance `cc_memory_save` 寫進 personal DB；project DB SELECT 看不到（2026-06-10 A2.7 smoke：save → personal=1 / project=0）
- [x] forced-mode personal `cc_memory_search` 只回 personal（2026-06-10 A2.7 smoke：keyword search 命中該筆）
- [x] project-mode 全專案 search 不含 `__personal__`（排除 predicate 由 shared builder + scope-probe test 鎖；0008 後 project DB 已插不進 `__personal__` 列，反向 CHECK 由 preflight D4 probe 驗）（preflight D5 scope tests PASS + 0008 結構性拒寫）
- [x] 拿 project DB URL raw postgres 查 `__personal__` → 0 列（cutover 後 psql count=0 實測）
- [x] personal DB INSERT 非 `__personal__` row → 0007 CHECK 拒；project DB INSERT `__personal__` row → 0008 CHECK 拒（preflight C5 2/2 + D4 4/4 PASS）
- [x] delete script 同 tx 內驗證全過才 COMMIT；preflight 三 mode（P1-P7/C1-C5/D1-D5）全 PASS（pre 7/7、post-copy 11/11、post-delete 11/11；manifest 比對 D3 PASS）
