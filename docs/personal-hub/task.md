# Personal-Hub Task Breakdown

> **當前狀態（2026-06-05）**：Personal-Hub Phase 0 全 Gate 綠 ✅（commit `01dd5e4`，306 tests）· Phase 1（reminder）/ Phase 2（read-only）pending implementation · Phase 3（prod RLS）+ 跨 repo = roadmap。
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

# Personal-Hub Phase 1 — Reliable Reminders（pending，離線可做）

> 對齊 `src/db/schema.ts` 慣例（partial unique index / `check()` / `withTimezone`）。slot 推導/advance/snooze 語意見 `plan.md` Data Model。**每個 sub-task 先紅後綠（TDD）**。

## 1a — Schema（reminder 欄位 + reminder_log 表）

- [ ] `src/db/schema.ts`：`tasks` 加 `remindAt` / `lastNotifiedAt` / `snoozeUntil` / `recurrenceIntervalDays`（皆 nullable）
- [ ] `src/db/schema.ts`：`check('tasks_recurrence_interval_check', recurrence IS NULL OR > 0)`
- [ ] `src/db/schema.ts`：`index('reminders_due_idx')` partial（`COALESCE(snooze_until, remind_at)` WHERE `remind_at IS NOT NULL AND status IN ('open','in_progress')`）
- [ ] `src/db/schema.ts`：新表 `reminderLog`（`taskId` FK→tasks / `scheduledFor` / `firedAt` / `channel` / `writerHost`）
- [ ] `uniqueIndex('reminder_log_task_slot_uniq')` on `(task_id, scheduled_for)`（去重硬背線）
- [ ] `drizzle-kit generate --name=add_reminders` → `sql/migrations/NNNN_*.sql`（編號自動遞增，disk 現有已到 0005）
- [ ] 套用 local test PG
- [ ] TDD：`tests/db/reminders-schema.test.ts`
  - [ ] RED：欄位/表不存在 → insert 失敗
  - [ ] GREEN：schema 上線 → 同 `(task_id, scheduled_for)` 重複 insert 收 unique violation
  - [ ] CHECK：`recurrence_interval_days=0` insert 被 CHECK 擋

## 1b — Service（getDueReminders + set/snooze/clear）

- [ ] `src/services/reminders.ts`：`setReminder(taskId, projectId, { remindAt, recurrenceIntervalDays })`（`WHERE id AND project_id`，affected=0 throw；**reschedule 必清 `snooze_until`+`last_notified_at`**，否則殘留舊 snooze 蓋過新 remind_at）
- [ ] `snoozeReminder(taskId, projectId, until)`（同 scope guard）
- [ ] `clearReminder(taskId, projectId)`（清 remind_at / snooze_until / recurrence；同 scope guard）
- [ ] `getDueReminders({ projectId, now?, channel, writerHost?, limit? })`：
  - [ ] 篩選 SQL：`status IN open/in_progress AND project_id=$projectId AND remind_at NOT NULL AND COALESCE(snooze,remind)<=now AND NOT EXISTS(reminder_log 同 slot)`（**project_id scope + NOT EXISTS 在 LIMIT 前**）
  - [ ] `FOR UPDATE SKIP LOCKED` claim
  - [ ] `INSERT reminder_log ... ON CONFLICT (task_id, scheduled_for) DO NOTHING RETURNING id`（**不可 catch unique_violation——會 abort 交易**；RETURNING 空 → 跳過該筆不 advance、不計回傳；race backstop）
  - [ ] advance：一次性 → 只更新 `last_notified_at`（保留 remind_at/snooze；下輪 NOT EXISTS 排除）；recurrence → 從 `remind_at` 錨點推下一未來 slot、清 snooze、更新 last_notified
- [ ] TDD：`tests/services/reminders.test.ts`
  - [ ] 一次性 due → 撈出 + log 一筆；再跑 → 不重複（NOT EXISTS 排除，不進 batch）
  - [ ] **不 starve**：塞 K（≥limit）筆已投遞一次性 + 1 筆新 due → 新 due 在本批被處理
  - [ ] **scope 隔離**：別 project 的 due task → 不被撈出；`setReminder` 帶別 project task id → throw（affected=0）
  - [ ] **setReminder 清 stale snooze**：對一次性已 snooze 過的 task 重設 remind_at → 新提醒在新時點 due（舊 snooze 不蓋過）
  - [ ] **ON CONFLICT 不 abort 交易**：同交易內模擬 slot 衝突 → 該筆跳過、其餘 row 仍正常處理 + commit（非整批失敗）
  - [ ] 併發兩 session 同 due → 只一筆 `reminder_log`（SKIP LOCKED + unique）
  - [ ] recurrence：第 N 次 `scheduled_for = remind_at + (N-1)*interval`（不漂移）
  - [ ] catch-up：漏發 3 次 → 只一筆 log、`remind_at` clamp 到下一未來 slot
  - [ ] snooze：投在 `snooze_until`、不重複；**一次性 snooze 投遞後不再響**（不清 snooze 的關鍵測）
  - [ ] `done`/`cancelled` task → 不被撈出

## 1c — MCP tool + 手動驅動 CLI

- [ ] `src/tools/set-reminder.ts`：MCP `cc_task_set_reminder`（brainstorm 後若決定併入 `cc_task_update`，改 patch 欄位且不破既有契約）
- [ ] `src/tools/snooze.ts`：MCP `cc_task_snooze`
- [ ] `src/index.ts`：註冊新 tool，套 `applyScopePolicy` 取得 scope projectId → 傳給 `setReminder/snooze`（mutation scope guard）
- [ ] `scripts/run-reminders.ts`：CLI 手動跑 `getDueReminders`，**先 `applyScopePolicy` 解析 scope 再傳 `projectId`**（forced personal instance = `__personal__`）；印出本次投遞清單
- [ ] 既有 task MCP tool 契約不動（regression）

## Phase 1 Gate
- [ ] `npm test` 新增 reminder tests 全綠
- [ ] DB 可查：`SELECT remind_at, recurrence_interval_days FROM tasks LIMIT 1`、`reminder_log` 表存在
- [ ] 去重：raw 兩次 INSERT 同 `(task_id, scheduled_for)` → 第二次 unique violation
- [ ] 不 starve：已投遞一次性塞滿 ≥limit → 新 due 仍被處理（NOT EXISTS 在 LIMIT 前生效）
- [ ] scope：別 project due task 不被個人 instance 撈出；mutation 跨 project 被拒
- [ ] 併發：兩 poller 跑同一 due → 只一筆 `reminder_log`
- [ ] recurrence 不漂移 + catch-up 不洪水 + snooze 不重複 三組行為測試綠
- [ ] 原 306 tests 不回歸

---

# Personal-Hub Phase 2 — Read-only Mode（pending，離線可做）

> read-only 必須**雙層** enforce（ListTools 過濾 + handler 拒絕）。telemetry 副作用（`search_feedback`）由 `CC_SEARCH_FEEDBACK` 控制。

## 2a — Tool policy 核心

- [ ] `src/services/tool-policy.ts`：`isWriteTool(name)`（save/delete/task_create/task_update/set_reminder/snooze/refine… 列為寫入）
- [ ] `loadToolPolicy(env)`：讀 `CC_READ_ONLY` / `CC_TOOL_ALLOWLIST` / `CC_SEARCH_FEEDBACK`
- [ ] `assertWritable(toolName, policy)`：read-only 且為寫入 tool → throw（只管寫入）
- [ ] `assertAllowed(toolName, policy)`：allowlist 非空且 tool 不在集合 → throw（**含 read tool**，與 write/read 無關）
- [ ] TDD：`tests/services/tool-policy.test.ts`（write tool 判定 / read-only 旗標 / allowlist 子集含 read tool 被擋）

## 2b — MCP 雙層 enforce（central dispatch）

- [ ] `src/index.ts` ListTools：依 policy 過濾——read-only 去寫入 tool、allowlist 只露集合內 tool（含 read 過濾）
- [ ] `src/index.ts` **central dispatch 守衛**（每個 tool call 進入點，不只寫入 handler）：先 `assertAllowed`，寫入再 `assertWritable`
- [ ] `cc_memory_search` 的 `recordSearchQuery` 副作用受 `CC_SEARCH_FEEDBACK` 控制（off → 不寫 telemetry）
- [ ] TDD：`tests/mcp/read-only.test.ts`
  - [ ] `CC_READ_ONLY=1` → ListTools 無任何寫入 tool
  - [ ] 直接呼叫被隱藏的 `cc_memory_save` → handler 拒絕
  - [ ] `CC_TOOL_ALLOWLIST=cc_memory_search,cc_task_list` → 集合外兩層皆拒
  - [ ] **allowlist 排除 read tool**（如 `cc_memory_get`）→ ListTools 不露 + 直呼經 `assertAllowed` 被拒
  - [ ] `CC_SEARCH_FEEDBACK=off` → search 不寫 `search_feedback`

## Phase 2 Gate
- [ ] ListTools 過濾 + handler 拒絕雙層測試綠
- [ ] allowlist 子集生效，且**排除的 read tool 直呼也被拒**（assertAllowed 涵蓋 read）
- [ ] read-only telemetry 開關生效
- [ ] 原 tests 不回歸

---

# Personal-Hub Phase 3 — Prod Hardening（roadmap，需 Zeabur prod URL）

> 終極硬隔離：把 Phase 0 應用層邊界升級成 DB role/RLS。**高風險（可能鎖死連線），preflight 必過才 apply。**

## 3a — preflight

- [ ] `scripts/preflight.ts`：驗證目標 PG 可建 role、RLS 不鎖死現有連線、additive 無破壞
- [ ] dry-run 報告

## 3b — DB role + RLS migration

- [ ] `sql/migrations/NNNN_db_roles_rls.sql`（編號接 reminder migration 之後）：`personal_rw` / `project_rw_non_personal` / `admin` role
- [ ] RLS policy on `project_memories` / `tasks` / `reminder_log`（依 role 限 `project_id` 可見性）
- [ ] 設計 DOWN（先驗 down 再 up）
- [ ] forced-mode instance 切 `personal_rw` 連線；project-mode 切 `project_rw_non_personal`

## Phase 3 Gate
- [ ] preflight 通過
- [ ] `project_rw_non_personal` 連線查 `__personal__` → 0 列
- [ ] `personal_rw` 連線查他專案 → 0 列
- [ ] 既有 forced/project instance 功能不回歸

---

# 跨 repo 階段（roadmap，憑證/授權未到位前不展開 task 細節）

> 只列目標 + Gate + blocking OQ。介面草案見 `plan.md` 的 Rollout Order 跨 repo roadmap 表。**不在此展開逐項 task**（過早展開會變猜測）。

## 階段 -1 — AI_Copilot raw postgres 前置
- [ ] 移除/限制 AI_Copilot `.mcp.json` 的 raw postgres
- Gate：該環境無持 `DATABASE_URL` 繞過通道，才在該環境啟用 personal forced-mode

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

## Todoist 匯入
- [ ] 匯入腳本讀 Todoist 匯出檔 → `createTask` 到 `__personal__`
- Gate：匯入後 `cc_task_list` 可見、不重複
- **blocking OQ**：需使用者提供 Todoist 匯出格式樣本

---

## 端對端驗收

### Personal-Hub Phase 0（已過）✅

- [x] project-mode 顯式 / 解析 / 全專案 search 三路皆擋 `__personal__`
- [x] forced-mode 無 selector 套用、顯式不同 project 拒、config 衝突 fail
- [x] `cc_task_stats` 台北日界聚合

### Personal-Hub Phase 1（reminder，本期目標）

- [ ] 設 `remind_at<=now()` open task → `getDueReminders()` 撈出 + `reminder_log` 一筆
- [ ] 同 slot 再跑 → 不重複（NOT EXISTS 排除）
- [ ] 已投遞一次性塞滿 batch + 1 新 due → 新 due 仍被處理（不 starve）
- [ ] 別 project due task → 個人 instance 不撈出；跨 project mutation 被拒
- [ ] 兩 poller 並發同 due → 只一筆 `reminder_log`
- [ ] `recurrence=1` 連跑 → 第 N 次 `scheduled_for = remind_at + (N-1)天`
- [ ] 漏發 3 次 → 補一筆、`remind_at` 跳下一未來 slot
- [ ] snooze → 在 snooze 時點投一次；一次性 snooze 投後不再響
- [ ] task 設 `done` → 不再被撈出

### Personal-Hub Phase 2（read-only，本期目標）

- [ ] `CC_READ_ONLY=1` ListTools 無寫入 tool
- [ ] 直呼 `cc_memory_save` → handler 拒
- [ ] `CC_TOOL_ALLOWLIST` 子集兩層生效；排除的 read tool 直呼也被拒
- [ ] `CC_SEARCH_FEEDBACK=off` → 不寫 telemetry

### Personal-Hub Phase 3（prod，roadmap）

- [ ] `project_rw_non_personal` 查 `__personal__` → 0 列
- [ ] `personal_rw` 查他專案 → 0 列
- [ ] preflight 通過才 apply
