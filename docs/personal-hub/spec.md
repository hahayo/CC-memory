# Personal-Hub Spec（CC-memory 升格跨工具個人記憶+待辦中樞）

> **當前狀態（2026-06-05）**：Personal-Hub Phase 0 安全核心 ✅ 已交付（commit `01dd5e4`，306 tests 綠）。Phase 1（reliable reminders）✅ 已實作（reminder schema + `reminder_log` + `getDueReminders`/set/snooze/clear service + `cc_task_set_reminder`/`cc_task_snooze` MCP tools + `scripts/run-reminders.ts` CLI，測試綠）。Phase 2（read-only mode）✅ 已實作（`CC_READ_ONLY` / `CC_TOOL_ALLOWLIST` 經 ListTools + handler central guard 雙層 enforce + `CC_SEARCH_FEEDBACK` telemetry 開關）。Phase 3（prod RLS）+ 跨 repo 階段為 roadmap-level（憑證/授權未到位前不展開 task 細節）。
>
> **與既有 `docs/{spec,plan,task}.md` 的關係**：既有三件套是 CC-memory v0.3/v0.4（memory + auto-capture）的歷史 SSOT，**不被本 initiative 污染**。Personal-Hub 是不同 concern（個人記憶中樞 + 隱私邊界 + 可靠提醒），獨立 track。v0.4 Phase C auto-capture 已在 `docs/spec.md` 頂部標 deferred 並指向本目錄。
>
> change log：
> - v0.1（2026-06-05）：首版。回填 Phase 0 已交付安全核心、寫定 reminder（Phase 1）/ read-only（Phase 2）完整規格、prod + 跨 repo roadmap。
> - v0.2（2026-06-05）：Phase 1 reminders 實作落地，狀態與端對端驗收 checkbox 同步。
> - v0.3（2026-06-05）：Phase 2 read-only mode（雙層 enforce + telemetry 開關）實作落地，狀態與驗收同步。

---

## Context

### 為什麼做這個改動

CC-memory 原本（v0.1~v0.3）只是 **Claude Code 專案記憶同步系統**：透過 MCP stdio，按 `project_id` 隔離，存各專案的 session / decision 記憶與 task。

使用者的新需求是把它**升格成跨工具的個人記憶 + 待辦中樞**：

1. **hermes**（個人背景 agent）、**ai_copilot `/hi`**（每日駕駛艙）、**Claude Code** 三者共用同一份「個人近況 / 決策 / 待辦」。
2. 這份個人資料存在保留 namespace `__personal__`，與一般專案記憶**物理同表、邏輯隔離**。
3. 個人待辦要能**可靠提醒**（不是被動查詢，是主動觸發），支援簡易週期。
4. 跨裝置（多台電腦 / 手機 channel）一致。

### 兩條反向 drift（為什麼要寫這份 SDD）

本 initiative 的藍圖原本只活在脆弱載體：memory `personal-hub-phase0.md` + 一次性 plan + `docs/usage.md`，**不在 repo 的 SDD**。使用者核心場景是跨裝置/跨工具，這種存放點最扛不住 handoff。同時專案有兩條反向 drift：

| Drift | 現象 | 風險 |
|---|---|---|
| **(a) v0.4 Phase C** | SDD 三件套完整，但 code 零實作（spec 跑在 code 前） | 規格腐化、實作時偏離 |
| **(b) Personal-Hub** | Phase 0 code 已 commit（`01dd5e4`），但 SDD 沒寫（code 跑在 spec 前） | 藍圖只在 memory，handoff 即失憶 |

本 SDD 修正 drift (b)：把已實作的 Phase 0 行為 + 後續 Phase 規格固化成 in-repo single source of truth。

### Phase 0 已交付什麼（回填）

`feature/personal-hub-phase0` 已通過 Codex review gate，交付**應用層隱私邊界 + 任務統計**：

- **forced-mode**（`CC_FORCE_PROJECT_ID`）：instance 鎖定單一 namespace，硬性拒絕跨 project。
- **project-mode deny**：一般 instance 顯式或經 path/marker 解析到 `__personal__` 一律拒絕；全專案 search 於 WHERE 層排除保留 namespace。
- **`ScopePolicy`**（`src/services/scope-policy.ts`）：所有 tool（含 search 分支）共用的單一 scope 決策核心 + config-drift 防護。
- **`cc_task_stats`**：任務統計（today/overdue/open/in_progress/completed_recently，Asia/Taipei 日界）。
- input hardening、listProjects 排除保留 namespace、CLAUDE.md 工具清單 cascade 同步。

---

## Goals

### Personal-Hub Phase 0（已達成）

1. **跨工具共用個人 namespace**：hermes / `/hi` / Claude Code 透過 forced-mode instance 讀寫 `__personal__`，一般專案 instance 一律 deny。
2. **隱私雙向邊界（應用層）**：
   - 方向 1（personal → 專案外洩）：forced-mode 鎖 scope，漏傳 selector 不會靜默變全專案撈到別專案內容。
   - 方向 2（專案 → personal 外洩）：project-mode deny 保留 namespace，任何 client 顯式 / path / marker 都讀不到個人資料。
3. **任務統計可用**：`cc_task_stats` 提供 today/overdue/open 等聚合（取代 raw postgres 直查）。

### Personal-Hub Phase 1+（規劃中）

4. **可靠待辦提醒 + 簡易週期**（Phase 1）：reminder schema（`remind_at` / `last_notified_at` / `snooze_until` / `recurrence_interval_days`）+ `reminder_log` 去重稽核，併發安全的 `getDueReminders()`，支援 interval recurrence（null=一次性 / 1=每日 / 7=每週 / N=每 N 天）。
5. **read-only instance**（Phase 2）：`CC_READ_ONLY` + `CC_TOOL_ALLOWLIST`，ListTools + handler **雙層** enforce，給只讀消費端（如 `/hi` 注入）一個不會誤寫的 instance。
6. **personal semantic search**（Phase 1+，已拍板）：personal instance 接受傳 `GEMINI_API_KEY`；個人內容的 embedding 存進**既有 `project_memories.embedding`**（`__personal__` 列，與一般 memory 同欄）。「不另分表」= 用既有 `project_memories`，不開 personal 專表；**`search_feedback` 維持純 retrieval telemetry，不存內容向量**（修正原 memory 決策措辭的 slip）。
7. **終極硬隔離**（Phase 3，prod）：DB role / RLS（`personal_rw` / `project_rw_non_personal` / `admin`），把應用層邊界升級成資料庫層保證。

---

## User Stories

使用者：本專案開發者（單人），跨 hermes / ai_copilot / Claude Code / 手機 channel 切換。每個 US 對應驗收條件與 Goal / Design Principle。User Stories 按 Personal-Hub Phase 分組。

---

### Personal-Hub Phase 0 — 安全核心 ✅（已交付）

#### US-P0-1 — 個人資料不會漏進專案 context

**作為** 在多專案間切換、也存個人近況的使用者，**我希望** 一般專案的 Claude Code instance **絕對讀不到** `__personal__` 的內容，**以便** 個人決策/待辦不會意外出現在某專案的對話裡。

- project-mode instance 顯式帶 `project_id=__personal__` → `INVALID_ARGUMENT` 拒絕。
- project-mode instance 經 `project_path` / CLAUDE.md marker / git / basename 解析到 `__personal__` → 同樣拒絕（deny 不只擋顯式 id）。
- 全專案 search（省略 selector）→ WHERE 層排除保留 namespace，結果不含個人列。
- 對應 Goal 2 方向 2。

#### US-P0-2 — 個人 instance 不會手滑寫到別專案

**作為** 跑 forced-mode 個人 instance 的使用者，**我希望** 漏傳 selector 時不會靜默變成全專案操作，**以便** 不會把個人記憶寫到 / 撈到錯的 project。

- forced-mode instance 無 selector → 強制套用 `CC_FORCE_PROJECT_ID`（含 search，不可全專案）。
- forced-mode instance 顯式帶**不同** project → 拒絕。
- `CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID`（fallback layer）同時設定 → 啟動 fail（config-drift 防護，避免「以為強制、實際只是 fallback」的軟邊界）。
- 對應 Goal 2 方向 1。

#### US-P0-3 — 一眼看出今天/逾期/進行中的任務量

**作為** 用 CC-memory 管個人待辦的使用者，**我希望** 一個工具直接回 today/overdue/open/in_progress/completed_recently 數字，**以便** `/hi` 駕駛艙不用自己跑 raw postgres 聚合。

- `cc_task_stats` 回 JSON，日界用 Asia/Taipei。
- 對應 Goal 3。

---

### Personal-Hub Phase 1 — Reliable Reminders（✅ 已實作，離線可做）

#### US-P1-1 — 待辦到點會主動提醒，不是等我去查

**作為** 會忘記待辦的使用者，**我希望** 設了 `remind_at` 的 task 到點被 poller 撈出來投遞提醒，**以便** 不用主動 `cc_task_list` 才想起來。

- `remind_at <= now()` 且 status ∈ (`open`,`in_progress`) 且**屬本 instance scope**（`project_id = 已解析 scope`）的 task 會被 `getDueReminders()` 撈出。
- 每個 slot 只投遞一次：查詢以 `NOT EXISTS reminder_log` 預先排除已投遞 slot（在 LIMIT 前，避免舊提醒 starve 新提醒），`unique(task_id, scheduled_for)` 為併發 race backstop。
- `done` / `cancelled` 的 task 不再被提醒（status 篩掉）。
- 對應 Goal 4。

#### US-P1-2 — 提醒可以「稍後再說」

**作為** 收到提醒但當下不想處理的使用者，**我希望** 設 `snooze_until` 延後觸發，**以便** 提醒在我指定的更晚時間再響一次。

- `snooze_until` 非 null 時優先於 `remind_at`（`next_due_at = COALESCE(snooze_until, remind_at)`）。
- snooze 後在 `snooze_until` 投遞，`reminder_log.scheduled_for = snooze_until`，同 slot 不重複。
- 對應 Goal 4。

#### US-P1-3 — 週期任務不會漂移、也不會洪水補發

**作為** 設每日/每週重複待辦的使用者，**我希望** 重複提醒以原始 `remind_at` 為網格錨點推算下一格，**以便** 不會因為某次延遲投遞而讓整串時間往後漂；漏發多次時只補發一次、不洪水。

- `recurrence_interval_days`：null=一次性 / 1=每日 / 7=每週 / N=每 N 天（CHECK `> 0`）。
- 下一格從 `remind_at` 網格錨點推（非 `last_notified_at`），避免延遲累積漂移。
- 漏發多次 → advance 到下一個未來 slot，只投一次（catch-up 不洪水）。
- 對應 Goal 4。

#### US-P1-4 — 多個 poller 同時跑也不會重複投遞

**作為** 可能在多台機器/多進程跑 reminder poller 的使用者，**我希望** 併發 claim 安全，**以便** 同一個 due 提醒不會被兩個 poller 同時投兩次。

- claim 用 `SELECT ... FOR UPDATE SKIP LOCKED`（多 poller 不互卡、不重撈）。
- 去重兩道：`NOT EXISTS reminder_log` 預先排除已投遞 slot（主機制）+ `unique(task_id, scheduled_for)` 配 `INSERT ... ON CONFLICT DO NOTHING RETURNING`（同輪別人搶先 → RETURNING 空跳過，不丟錯、不 abort 交易；race backstop）。
- 對應 Goal 4 + Design Principle「去重靠資料層 NOT EXISTS + unique，不靠 in-memory timer」。

---

### Personal-Hub Phase 2 — Read-only Mode（✅ 已實作，離線可做）

#### US-P2-1 — 注入用的 instance 永遠不會誤寫

**作為** 把 CC-memory 接到 `/hi` 注入 / 唯讀消費端的使用者，**我希望** 那個 instance 只能讀、寫入類 tool 直接不存在，**以便** 自動化流程絕無可能改到我的記憶/待辦。

- `CC_READ_ONLY=1` → 寫入類 tool（save/delete/task_create/task_update/refine…）在 **ListTools 不出現**（消費端看不到）。
- 即使 client 硬呼叫寫入 tool → handler 層**第二層** enforce 拒絕（不信任 ListTools 過濾單獨足夠）。
- `CC_TOOL_ALLOWLIST` 可進一步收斂單一 instance 可用 tool 集合——**被排除的 tool（含 read）兩層皆拒**（ListTools 隱藏 + 每個 handler 的 `assertAllowed`），不可只擋寫入 tool。
- 對應 Goal 5。

---

### Personal-Hub Phase 3 — Prod Hardening（roadmap，需 Zeabur prod URL）

#### US-P3-1 — 隱私邊界由資料庫保證，不只靠應用層

**作為** 在多個持有 `DATABASE_URL` 的工具（raw postgres MCP / shell）環境工作的使用者，**我希望** 個人資料的隔離由 DB role / RLS 保證，**以便** 應用層被繞過時個人資料仍然安全。

- DB role：`personal_rw`（只能動 `__personal__`）/ `project_rw_non_personal`（不能碰 `__personal__`）/ `admin`。
- RLS policy 對應上述 role 限制 row 可見性。
- preflight：migration 套用前驗證（Codex #11）。
- 對應 Goal 7。**這是把 Phase 0 應用層邊界升級成 DB 層硬隔離的終局。**

---

### 跨 repo 階段（roadmap，憑證/授權未到位前不展開）

> 詳見 `plan.md` 的 `## Rollout Order` 跨 repo roadmap 區。介面草案 + Gate + open questions 層級，**不展開 task 細節**。

- **Phase -1 前置**：AI_Copilot `.mcp.json` 的 raw postgres 是硬前置——該環境若保留 raw postgres，forced-mode 隱私邊界形同虛設，需先處理才在該環境啟用個人 instance。
- **hermes 整合**：personal forced-mode MCP client 串接。
- **ai_copilot `/hi` 整合**：read-only instance 注入個人近況/待辦。
- **reminder 投遞 channel**：把 `getDueReminders()` 接到實際 channel（Telegram / hermes push）。
- **Todoist 整合（live REST 工具，Option E）**：cc-memory 內建薄 Todoist API v1 client，提供 `cc_todoist_*` 工具（add / projects / list / complete / completed）讓 agent 群（Hermes / Claude Code / Codex / AI_Copilot）新增待辦 + 追蹤完成。**雙系統並存、無自動 sync**（追蹤完成為 on-demand）。token∧forced-mode 雙條件 gated、不碰 cc-memory DB。取代舊「一次性匯入」方向 → 不再 blocked on 匯出樣本。自動鏡像（webhook reconciliation）留待後續 sync phase。

---

## Non-goals（Out of Scope，明確不做）

### Personal-Hub 全期

- ❌ **個人資料用獨立資料庫 / 獨立表**：沿用同一張 `project_memories` / `tasks`，靠 `__personal__` namespace + scope policy 隔離（Phase 3 再加 RLS）。
- ❌ **跨 user 多租戶**：單人使用，不做帳號系統。
- ❌ **reminder 的複雜排程語意**：不做 cron 表達式、不做「每月最後一個週五」這類規則；只有 interval（N 天）。
- ❌ **reminder 投遞失敗的重試佇列**（Phase 1）：Phase 1 只保證「撈出 due + 去重 claim」；實際 channel 投遞 + 重試屬跨 repo 階段。
- ❌ **read-only mode 的細粒度欄位級權限**：只有 instance 級「能不能寫」，不做「能改 title 不能改 status」這種。
- ❌ **應用層邊界當成終極安全保證**：明示 forced-mode 可被 raw postgres / shell 繞過，終極隔離在 Phase 3 DB RLS。

### 與既有 SDD 重疊部分

- ❌ 本 SDD **不重寫** v0.3/v0.4 的 memory / auto-capture 設計（見 `docs/spec.md`）。
- ❌ 不在本 initiative 內實作 v0.4 Phase C auto-capture（deferred，獨立 track）。

---

## Scope 摘要

| 項目 | 階段 | 深度 | 說明 |
|---|---|---|---|
| forced-mode + ScopePolicy | Personal-Hub Phase 0 ✅ | 完整（已實作） | `CC_FORCE_PROJECT_ID` 硬鎖 scope + config-drift 防護 |
| project-mode deny 保留 namespace | Personal-Hub Phase 0 ✅ | 完整（已實作） | 顯式/解析/全專案 search 三路都擋 `__personal__` |
| `cc_task_stats` | Personal-Hub Phase 0 ✅ | 完整（已實作） | Asia/Taipei 日界聚合 |
| reminder schema + `getDueReminders()` | Personal-Hub Phase 1 | **完整 SDD** | `tasks` 加 4 欄 + `reminder_log` 表 + 併發/去重/recurrence/snooze 語意 |
| personal Gemini embedding | Personal-Hub Phase 1+ | 完整（決策已拍板） | personal instance 傳 `GEMINI_API_KEY`；embedding 存 `project_memories.embedding`（`__personal__` 列），`search_feedback` 僅 telemetry |
| read-only mode | Personal-Hub Phase 2 | **完整 SDD** | `CC_READ_ONLY` + `CC_TOOL_ALLOWLIST`，ListTools + handler 雙層 |
| DB role / RLS + preflight | Personal-Hub Phase 3 | roadmap | 需 Zeabur prod URL；終極硬隔離 |
| Todoist 整合（live REST 工具，Option E） | 跨 repo（已實作 client + 5 工具） | additive 工具 | `cc_todoist_*` 直打 Todoist API v1；token∧forced gated；雙系統並存、無自動 sync |
| hermes / `/hi` 整合、reminder channel | 跨 repo 階段 | roadmap | 介面草案層級，憑證/授權未到位 |

---

## Constraints

### 技術
- 沿用現有 Drizzle ORM + PostgreSQL（Zeabur）；不引入新 DB / ORM / 排程框架。
- reminder schema 變更一律 **additive**（`ALTER TABLE ADD COLUMN` nullable + 新表），回滾 = 不寫入即可，不破既有資料。
- 對齊 `src/db/schema.ts` 慣例：partial unique index、`check()`、`timestamp(..., { withTimezone: true })`、`<table>_<purpose>_check` 命名。
- SQL 一律 parameterized（Drizzle 保證）；不字串拼接。

### 安全 / 隱私
- **forced-mode 是應用層邊界**：明確記錄它可被 raw postgres / shell / 其他持 `DATABASE_URL` 的 MCP 繞過；終極隔離需 Phase 3 DB role/RLS。
- `__personal__` 為唯一保留 namespace（`RESERVED_PROJECT_IDS`，未來可擴充）；deny 規則作用在「已解析出的 projectId」上，涵蓋所有解析來源。
- **reminder 也受 scope 約束**：`getDueReminders` 與 setReminder/snooze/clear 一律帶已解析 scope 的 `project_id`，查詢/更新 `WHERE project_id=$scope`——Phase 0 namespace 邊界延伸到 reminder，個人 poller 不會撈到/改到別專案 task。
- read-only / allowlist enforce 必須**雙層**（ListTools 過濾 + handler 拒絕），不可只靠 ListTools；allowlist 守衛須涵蓋 read tool。

### 相容性
- 既有 memory / task MCP tool 輸入輸出格式不得 breaking change（reminder 欄位為 task 的 optional 擴充）。
- Phase 0 已上線行為（forced-mode / deny / cc_task_stats）為既成契約，後續 Phase 不得回歸。

### 規模 / 預算
- 單人使用；reminder poller 不做高頻、不做分散式鎖服務（`FOR UPDATE SKIP LOCKED` 足夠）。
- 不接 Sentry / Datadog，log 夠用。

---

## Design Principles

### Personal-Hub Phase 0 必守（已落地）

- **隱私邊界雙向對稱**：personal→專案、專案→personal 兩個方向都要堵，由單一 `ScopePolicy` 核心統一決策（避免兩套規則漂移）。
- **deny 作用在解析後的 projectId**：不只擋顯式 `project_id`，path/marker/git/basename 解析出保留 namespace 一律涵蓋。
- **config-drift fail-fast**：語意衝突的 env（強制 vs fallback）同設即啟動 fail，不讓邊界退化成軟邊界。
- **應用層邊界誠實標示**：文件與註解明寫「這是應用層、可被繞過」，不營造虛假安全感。

### Personal-Hub Phase 1 必守（reminder）

- **去重靠資料層 `NOT EXISTS` + unique，不靠 in-memory timer**：查詢 `NOT EXISTS reminder_log`（LIMIT 前）排除已投遞 slot 是主機制（兼防 starve）；`reminder_log (task_id, scheduled_for)` UNIQUE 配 `INSERT ... ON CONFLICT DO NOTHING`（不可 catch unique_violation，會 abort 交易）為併發 race backstop（對齊既有 idempotency partial-unique 慣例）。
- **reminder 操作受 scope 約束**：撈取與變更一律帶已解析 scope `project_id`，把 Phase 0 namespace 邊界延伸到 reminder。
- **slot 語意三情況寫死**：一次性 / recurrence / snoozed 各自的 `scheduled_for` 來源明定（見 plan.md Data Model），不留隱含。
- **recurrence 以網格錨點推，不以實際投遞時間推**：避免延遲累積漂移；catch-up 只補一次。
- **snooze_until 不自動清除（但 setReminder 重設時必清）**：投遞後保留 snooze 讓同 slot 去重生效（避免清除後 `remind_at` 重新 due 造成重複發送，一次性的關鍵正確性點）；**但** `setReminder` reschedule 時必須清 `snooze_until`+`last_notified_at`，否則殘留舊 snooze 經 COALESCE 蓋過新 `remind_at`、新提醒永不 due。
- **`remind_at` ≠ `due_date`**：`due_date` 是「到期日」（既有，給排序/逾期判斷），`remind_at` 是「提醒觸發時點」，兩者語意獨立、不混用。

### Personal-Hub Phase 2 必守（read-only）

- **雙層 enforce**：ListTools 隱藏 + handler 拒絕，任一層被繞過另一層仍守得住。
- **allowlist 涵蓋 read tool**：`CC_TOOL_ALLOWLIST` 的第二層守衛（`assertAllowed`）作用在**每個** handler（含 read），不可只掛寫入 handler——否則被排除的 read tool 從 ListTools 消失卻仍可直呼。read-only 的 `assertWritable` 與 allowlist 的 `assertAllowed` 是兩道獨立檢查，皆走 central dispatch。
- **read-only 副作用誠實**：read-only instance 的 `cc_memory_search` **預設仍會寫** `search_feedback`（telemetry 副作用，Codex #9）——明示這不違反 read-only 語意（它是 retrieval 評估必要的觀測，非使用者資料寫入）。但提供 `CC_SEARCH_FEEDBACK=off` 讓潔癖消費端完全關閉此寫入（設 off 時不寫）。

### Personal-Hub Phase 3 必守（prod）

- **DB 層才是終局**：RLS / role 是真正的隔離保證，應用層邊界是縱深防禦的第一層、非唯一層。

---

## Success Criteria

### Personal-Hub Phase 0 指標（已達成）

| 指標 | 目標 | 狀態 |
|---|---|---|
| 雙向 deny 測試覆蓋 | personal→專案 / 專案→personal / 全專案 search 三路皆有測 | ✅ 306 tests 綠 |
| config-drift fail | 兩衝突 env 同設啟動 fail 有測 | ✅ |
| `cc_task_stats` 日界 | Asia/Taipei 日界聚合正確 | ✅ |

### Personal-Hub Phase 1 指標（reminder）

| 指標 | 目標 |
|---|---|
| 去重 | 同 `(task_id, scheduled_for)` 投遞兩次 → 第二次被 `NOT EXISTS`/unique 擋；併發兩 poller 同 due 只一筆 `reminder_log` |
| 不 starve | 累積 K 筆已投遞一次性提醒 + 1 筆新 due（K ≥ limit）→ 新 due 仍在本批被處理（`NOT EXISTS` 已排除舊的，不佔 LIMIT） |
| scope 隔離 | 別專案有 due task → 個人 instance `getDueReminders` **不**撈出；mutation 帶錯 project_id → affected=0 throw |
| recurrence 不漂移 | 第 N 次 slot = `remind_at + (N-1)*interval`（以錨點推，與實際投遞延遲無關） |
| catch-up 不洪水 | 漏發 k 次 → 只新增一筆 `reminder_log`、`remind_at` clamp 到下一未來 slot |
| snooze 正確性 | snooze 後在 `snooze_until` 投一次、不重複；一次性 snooze 不會清除後重複觸發 |
| 終止條件 | `done`/`cancelled` task 不再被 `getDueReminders()` 撈出 |

### Personal-Hub Phase 2 指標（read-only）

| 指標 | 目標 |
|---|---|
| ListTools 過濾 | `CC_READ_ONLY=1` → ListTools 不含任何寫入類 tool |
| handler enforce | 直接呼叫被隱藏的寫入 tool → handler 拒絕（403/INVALID） |
| allowlist 涵蓋 read | `CC_TOOL_ALLOWLIST` 指定子集 → 集合外 tool（**含 read**）ListTools 不露 + 直呼經 `assertAllowed` 被拒（兩層） |

### Personal-Hub Phase 3 指標（prod，roadmap）

| 指標 | 目標 |
|---|---|
| RLS 隔離 | `project_rw_non_personal` role 連線查不到 `__personal__` row；`personal_rw` 查不到其他專案 row |
| preflight | migration 套用前驗證通過才 apply |

---

## 端對端驗收

### Personal-Hub Phase 0（已過）✅

- [x] project-mode instance 顯式 `project_id=__personal__` → 拒絕
- [x] project-mode instance `project_path` 解析到 `__personal__` → 拒絕
- [x] project-mode 全專案 search → 結果不含 `__personal__` 列
- [x] forced-mode instance 無 selector → 套用 `CC_FORCE_PROJECT_ID`（search 不全專案）
- [x] forced-mode instance 顯式不同 project → 拒絕
- [x] `CC_FORCE_PROJECT_ID` + `CC_MEMORY_PROJECT_ID` 同設 → 啟動 fail
- [x] `cc_task_stats` 回 today/overdue/open/in_progress/completed_recently（台北日界）

### Personal-Hub Phase 1（reminder，✅ 本期已達成）

- [x] 設 `remind_at <= now()` 的 open task → `getDueReminders()` 撈出且 `reminder_log` 多一筆
- [x] 同 task 同 slot 再跑 → 第二次不投遞（`NOT EXISTS` 排除，根本不進 batch）
- [x] 塞 K（≥limit）筆已投遞一次性 + 1 筆新 due → 新 due 仍被處理（不被舊的 starve）
- [x] 別專案有 due task → 個人 instance `getDueReminders` 不撈出；`setReminder` 帶別專案 task id → 拒絕（affected=0）
- [x] 兩個 poller 並發跑同一筆 due → 只有一筆 `reminder_log`（`FOR UPDATE SKIP LOCKED` + unique）
- [x] `recurrence_interval_days=1` 連跑數日 → 第 N 次 `scheduled_for = remind_at + (N-1)天`
- [x] 人工把時鐘快轉漏發 3 次 → 只補一筆、`remind_at` 跳到下一未來 slot
- [x] 設 `snooze_until` → 在 snooze 時點投一次、不重複；一次性任務 snooze 投遞後不再響
- [x] 把 task 設 `done` → 不再被撈出

### Personal-Hub Phase 2（read-only，✅ 本期已達成）

- [x] `CC_READ_ONLY=1` instance ListTools → 無 save/delete/task_create/task_update/set_reminder/snooze
- [x] 對該 instance 直接呼叫 `cc_memory_save` → handler 拒絕（FORBIDDEN）
- [x] `CC_TOOL_ALLOWLIST=cc_memory_search,cc_task_list` → 只這兩個可用，其餘兩層皆拒
- [x] allowlist 排除某 **read** tool（如 `cc_memory_get`）→ ListTools 不露 + 直呼經 `assertAllowed` 被拒（驗證 allowlist 不只擋寫入）
- [x] `CC_SEARCH_FEEDBACK=off` → search 不寫 `search_feedback` telemetry

### Personal-Hub Phase 3（prod，roadmap）

- [ ] `project_rw_non_personal` 連線 `SELECT ... WHERE project_id='__personal__'` → 0 列（RLS）
- [ ] `personal_rw` 連線查其他 project → 0 列
- [ ] preflight 腳本通過後才 apply migration
