# Personal-Hub Implementation Plan

> **當前狀態（2026-06-09）**：Personal-Hub Phase 0 ✅ 已交付（commit `01dd5e4`，306 tests 綠）· Phase 1（reminder）✅ 已實作（schema + `reminders.ts` service + `cc_task_set_reminder`/`cc_task_snooze` MCP tools + `scripts/run-reminders.ts` CLI，測試綠）· Phase 2（read-only）✅ 已實作（`tool-policy.ts` + ListTools/handler 雙層 enforce + `CC_SEARCH_FEEDBACK` 開關，測試綠）· **Phase 3（v0.4 翻案：獨立 personal DB）✅ 已交付（2026-06-10；現 Coolify）** · 跨 repo = roadmap。
>
> 本 plan 對應 `spec.md`。Phase 0 回填已實作行為；Phase 1/2 寫到可直接 TDD 的細節；跨 repo 停在 roadmap-level（介面草案 / Gate / open questions）；Phase 3 章節為交付前規劃原文（✅ 已執行，現況見 `prod-runbook.md`）。
>
> **執行紀律**：每個 Phase 開工前讀 `~/.claude/rules/sdd-workflow.md` 的 `## 每個 Phase 執行紀律`（brainstorm → context7 → TDD → simplify → review → codex-review）。
>
> change log（版本 namespace 註記：本檔 plan.md 走自己的 v0.x 序、spec.md 的 change log 走獨立 v0.4 序，兩檔版號互不對應）：
> - v0.1（2026-06-05）：首版。
> - v0.2（2026-06-09）：**Phase 3 翻案**——從共用 DB + RLS 改為**獨立 personal DB**（`DATABASE_URL_PERSONAL`）。Architecture 圖、instance 拓樸、Files、Rollout、Risks、OQ #6 全段重寫。詳見 [decisions/ADR-001-phase3-separate-db.md](decisions/ADR-001-phase3-separate-db.md)。
> - v0.3（2026-06-10）：Phase 3 code review 修復 cascade——新增 delete script（tx 內 DELETE→驗證→COMMIT，修 P0 MVCC 閘門失效）、0008 反向 CHECK、preflight 拆檔 + mode-prefixed cases（P1-P7/C1-C5/D1-D5）、search_feedback 只刪不搬決策。詳見 ADR-001 補記。

---

## Architecture

```
     ┌──────────────────────────────┐    ┌──────────────────────────────┐
     │  PostgreSQL: project DB       │    │  PostgreSQL: personal DB      │
     │  DATABASE_URL                 │    │  DATABASE_URL_PERSONAL        │
     │  project_memories (專案列)     │    │  project_memories (__personal__ 列)│
     │  tasks (專案列)               │    │  tasks (__personal__ 列)       │
     │  reminder_log (專案列)        │    │  reminder_log (__personal__ 列)│
     │  search_feedback (telemetry)  │    │  search_feedback (telemetry)  │
     │                               │    │  [Phase 3] CHECK project_id   │
     │                               │    │  ='__personal__' on memories/tasks│
     └────────────┬──────────────────┘    └────────────┬──────────────────┘
                  │                                  │
                  │ 一 process 一 scope 一 DB         │
                  │ (無 request-level 切換 DB)        │
                  ▼                                  ▼
     ┌──────────────────────────────┐   ┌──────────────────────────────┐
     │  cc-memory MCP process        │   │  cc-memory MCP process        │
     │  project-mode                 │   │  forced-mode personal         │
     │  (持 DATABASE_URL only)       │   │  (持 DATABASE_URL_PERSONAL    │
     │  src/services/scope-policy ✅ │   │   + CC_FORCE_PROJECT_ID=      │
     │  + memories/tasks/reminders   │   │     __personal__)             │
     │  + [Phase 2] read-only guards │   │  scope-policy + [Phase 2]     │
     └──────────────┬────────────────┘   └──────────────┬────────────────┘
                    │                                   │
         各專案 Claude Code 等           hermes / /hi / Claude Code (個人)
              （deny __personal__）           ↳ [跨 repo] reminder 推 channel
```

**instance 拓樸（v0.4 翻案後，連線 DB 加入維度）**

| instance | env (scope) | env (DB) | scope 行為 | 連接 DB | 用途 |
|---|---|---|---|---|---|
| **forced-mode personal** | `CC_FORCE_PROJECT_ID=__personal__` | `DATABASE_URL_PERSONAL` | 硬鎖 `__personal__`，拒絕跨 project | personal DB | hermes / `/hi` / Claude Code 存個人記憶+待辦 |
| **project-mode** | （皆不設） | `DATABASE_URL`（**禁配** `DATABASE_URL_PERSONAL`） | deny `__personal__`，一般專案隔離 | project DB | 各專案的 Claude Code |
| **read-only personal**（Phase 2） | `CC_READ_ONLY=1` + `CC_FORCE_PROJECT_ID=__personal__` | `DATABASE_URL_PERSONAL` | 疊加在 forced，寫入類 tool 雙層拒絕；`cc_reminders_due` 也歸寫入類拒（claim/update reminder_log） | personal DB（只讀） | `/hi` 注入等只讀消費端 |
| **admin / migration** | （皆不設或視需要） | 同時持 `DATABASE_URL` + `DATABASE_URL_PERSONAL`（preflight 三 mode **含 post-delete** 與 delete script 皆需雙 URL） | maintenance 模式 | 兩邊都連 | preflight / migration / delete / backup |

**強制規則**
- 所有 tool（含 `cc_memory_search` 獨立分支）一律經 `applyScopePolicy()` 決策 scope，不繞過。
- forced-mode 是**應用層**邊界；終極隔離靠 Phase 3 獨立 personal DB + secret 邊界（v0.4 翻案；原 RLS 方案見 [decisions/ADR-001](decisions/ADR-001-phase3-separate-db.md)）。raw postgres / shell / 其他持 `DATABASE_URL` 的 MCP 拿到的只連 project DB；個人資料**根本不在那個 DB**。
- **一 process 一 scope 一 DB**：單一 cc-memory MCP process 啟動鎖定一個 DB；跨 scope 起兩個 process，各持自己的連線字串。
- **啟動期 fail-fast**：forced-mode personal 缺 `DATABASE_URL_PERSONAL` → exit；非 forced personal（project-mode 或 forced 非 personal）偵測到 `DATABASE_URL_PERSONAL` → warn + 拒絕載入該 URL（不 exit）（防誤配）；`CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID` 同設 → exit（檢查在 `src/services/scope-policy.ts`，既有）。

---

## Dependencies

| 套件 | 用途 | 階段 |
|---|---|---|
| `drizzle-orm` / `drizzle-kit` | ORM + migration 唯一真相 | 既有 ✅ |
| `@modelcontextprotocol/sdk` | MCP stdio server | 既有 ✅ |
| `pgvector` (PG extension) | personal embedding 向量欄位 | 既有 ✅ |
| `@google/genai` | Gemini embedding（personal 接受傳 `GEMINI_API_KEY`） | 既有 ✅ / Phase 1+ |
| `vitest` | 測試 | 既有 ✅ |

**Phase 1/2 不加新 npm 套件**：reminder 用既有 Drizzle + PG（`FOR UPDATE SKIP LOCKED` 是 PG 原生）；read-only 是 MCP server 啟動期過濾，純內建邏輯。
**跨 repo 階段相依**（roadmap）：reminder 投遞 channel 屆時可能引入 Telegram client / hermes push SDK——不在本 plan 鎖定。

---

## Data Model

### `tasks` 加 4 欄（Personal-Hub Phase 1，additive）

對齊 `src/db/schema.ts` 既有 `tasks` 定義（v0.2）。Drizzle 欄位：

```ts
// src/db/schema.ts — tasks 表內新增（皆 nullable，不破既有資料）
remindAt:             timestamp('remind_at', { withTimezone: true }),
lastNotifiedAt:       timestamp('last_notified_at', { withTimezone: true }),
snoozeUntil:          timestamp('snooze_until', { withTimezone: true }),
recurrenceIntervalDays: integer('recurrence_interval_days'),  // null=一次性, 1=每日, 7=每週, N=每 N 天
```

table-level CHECK + index（延續 `tasks_*_check` / partial-index 慣例）：

```ts
check('tasks_recurrence_interval_check',
  sql`${table.recurrenceIntervalDays} IS NULL OR ${table.recurrenceIntervalDays} > 0`),

// due 提醒查詢支援索引：直接對映 getDueReminders 的 WHERE predicate。
// partial：只索引「活著且設了提醒」的 row。
index('reminders_due_idx')
  .on(sql`COALESCE(${table.snoozeUntil}, ${table.remindAt})`)
  .where(sql`${table.remindAt} IS NOT NULL AND ${table.status} IN ('open','in_progress')`),
```

等價 SQL（migration `NNNN_add_reminders.sql`——**編號由 `drizzle-kit generate` 依當下 `sql/migrations/` 目錄自動遞增**；disk 現有已到 `0005`，故實際多半是 `0006`+，勿照抄固定編號）：

```sql
ALTER TABLE tasks
  ADD COLUMN remind_at timestamptz,
  ADD COLUMN last_notified_at timestamptz,
  ADD COLUMN snooze_until timestamptz,
  ADD COLUMN recurrence_interval_days integer;

ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_interval_check
  CHECK (recurrence_interval_days IS NULL OR recurrence_interval_days > 0);

CREATE INDEX reminders_due_idx
  ON tasks (COALESCE(snooze_until, remind_at))
  WHERE remind_at IS NOT NULL AND status IN ('open','in_progress');
```

#### `remind_at` vs 既有 `due_date`（語意切分，務必不混用）

| 欄位 | 語意 | 既有 index | 觸發提醒？ |
|---|---|---|---|
| `due_date` | **到期日**：任務該完成的截止點，給排序 / 逾期判斷（`cc_task_stats` 的 overdue） | `tasks_due_date_idx` WHERE `due_date IS NOT NULL AND status <> 'done'` | 否 |
| `remind_at` | **提醒觸發時點**：poller 撈出來投遞提醒的時間 | `reminders_due_idx`（見上） | 是 |

> **為何兩個 index 的 status 條件不同**（防被當不一致誤報）：
> - `tasks_due_date_idx` 用 `status <> 'done'`（含 `cancelled`）——它服務「列出未完成的截止項」，cancelled 即使列出也無害。
> - `reminders_due_idx` 用 `status IN ('open','in_progress')`（**正面表列**，排除 `cancelled`）——**cancelled 任務絕不該再響提醒**，用正面表列確保 done/cancelled 都被排除。
> 兩者差異是刻意的，不是 drift。

### 新表 `reminder_log`（Personal-Hub Phase 1）

去重 + 投遞稽核。`unique(task_id, scheduled_for)` 是去重硬背線（對齊 `project_memories_idempotency_idx` / `tasks_idempotency_*` partial-unique 慣例）。

```ts
// src/db/schema.ts
export const reminderLog = pgTable(
  'reminder_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid('task_id').notNull().references(() => tasks.id),
    // scheduledFor：本次提醒對應的 slot 值（見下「slot 三情況」）。去重的語意鍵。
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    channel: text('channel').notNull().default('unknown'),  // 投遞管道，跨 repo 階段填實際 channel
    writerHost: text('writer_host'),                         // 哪個 poller / 機器投的
  },
  (table) => [
    uniqueIndex('reminder_log_task_slot_uniq').on(table.taskId, table.scheduledFor),
    index('reminder_log_task_idx').on(table.taskId),
  ]
);
export type ReminderLog = typeof reminderLog.$inferSelect;
export type NewReminderLog = typeof reminderLog.$inferInsert;
```

```sql
CREATE TABLE reminder_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  scheduled_for timestamptz NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL DEFAULT 'unknown',
  writer_host text
);
CREATE UNIQUE INDEX reminder_log_task_slot_uniq ON reminder_log (task_id, scheduled_for);
CREATE INDEX reminder_log_task_idx ON reminder_log (task_id);
```

### Slot 推導語意（machine-checkable，三情況各寫死）

`scheduled_for`（slot）= 一筆提醒「這一次」對應的時間鍵；去重以它為準。定義：

```
next_due_at := COALESCE(snooze_until, remind_at)   -- 有效到期觸發時點
slot        := next_due_at（投遞當下取值）          -- 寫入 reminder_log.scheduled_for
```

| 情況 | slot 來源 | 投遞後對 tasks 的更新 | 為何 |
|---|---|---|---|
| **一次性**（`recurrence_interval_days IS NULL`，未 snooze） | `remind_at` | 只更新 `last_notified_at=now()`；`remind_at`/`snooze_until` **不動** | 該 slot 已入 log → 下輪查詢的 `NOT EXISTS reminder_log` **預先排除**它（不進 batch、不佔 LIMIT、不 starve 後續）；保留欄位供稽核，unique 為併發 race backstop |
| **一次性 + snooze** | `snooze_until` | 同上，`snooze_until` **不自動清除** | **關鍵正確性點**：若清除 snooze，`COALESCE` 退回 `remind_at`（仍 `<= now`）→ 重新 due → 重複投遞。保留 snooze_until 讓 `COALESCE` 持續回已 log 的 slot → `NOT EXISTS` 持續排除 |
| **recurrence** | `COALESCE(snooze_until, remind_at)` | advance `remind_at` 到**下一個未來網格 slot**、清 `snooze_until`、`last_notified_at=now()` | 見下方 advance 規則 |

**recurrence advance 規則（避免漂移 + catch-up 不洪水）**：
```
-- 以 remind_at 為「網格錨點」推下一格，不以 last_notified_at（實際投遞時間）推 → 不漂移
next := remind_at
repeat:
  next := next + (recurrence_interval_days * interval '1 day')
until next > now()       -- 漏發多次 → 直接跳到下一未來 slot，只投本次一筆
UPDATE tasks SET remind_at = next, snooze_until = NULL, last_notified_at = now() WHERE id = $id
```
> snooze 對 recurrence 只「延後當次投遞」（slot=snooze_until），**不位移後續網格**：advance 仍從原 `remind_at` 錨點推，故下一格回到原時間軸。

### 終止條件
- `status` ∈ (`done`,`cancelled`) → 不在 `getDueReminders()` 的 WHERE → 不再 due。
- 一次性投遞後該 slot 已入 `reminder_log` → 查詢的 `NOT EXISTS` 預先排除 → 不再進 batch（不只是「不重複投」，而是根本不佔 LIMIT 名額）。
- scope：`getDueReminders` 只撈 `project_id = $projectId` 的 task（forced personal instance 只處理 `__personal__`）。

---

## Canonical Project Identity

沿用既有 `resolveProjectId`（`src/services/projects.ts`）五層優先序 `explicit > env > marker > repo_name > basename`，**外加 Phase 0 的 scope 後處理**：

```
resolveProjectId(args) → rawId
applyScopePolicy(rawId, { config: loadScopeConfig(env), surface }) → finalScope | throw
```

- **forced-mode**：`CC_FORCE_PROJECT_ID` 非 null → 無論 raw 解析結果，鎖定 forced id；顯式帶不同 id → throw。
- **project-mode**：raw 解析到 `__personal__`（任何來源）→ throw；全專案 search → WHERE 排除保留 namespace。
- `PERSONAL_PROJECT_ID = '__personal__'`，`RESERVED_PROJECT_IDS` 可擴充。
- `CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID` 互斥（同設啟動 fail，`loadScopeConfig` 防 config-drift）。

> 細節見已實作的 `src/services/scope-policy.ts`（Phase 0 ✅）。本 plan 不重述演算法，只標 reminder/read-only 如何接上：reminder 的 `getDueReminders()` 在 forced-mode personal instance 跑，撈的就是 `__personal__` 的 task。

---

## Writer Attribution

沿用既有 `resolveWriterHost()`（`src/utils/writer-host.ts`：`CC_MEMORY_WRITER ?? os.hostname()`）。Phase 1 擴充：

- `reminder_log.writer_host`：哪個 poller / 機器投遞的提醒（多機 poller 時辨識來源）。
- 投遞 channel 記在 `reminder_log.channel`（Phase 1 預設 `'unknown'`；跨 repo 階段填 `telegram` / `hermes` 等）。

---

## Environment Variables

| Env | 用途 | 階段 | 預設 / 必要性 |
|---|---|---|---|
| `DATABASE_URL` | PostgreSQL 連線（現 Coolify project DB，SSH tunnel；原 Zeabur） | 既有 | 必填 |
| `DATABASE_URL_PERSONAL` | 獨立 personal DB 連線（Phase 3 v0.4 翻案；見 [ADR-001](decisions/ADR-001-phase3-separate-db.md)） | Phase 3 | forced-mode personal **必填**；project-mode **禁配**（偵測到 warn + 拒絕載入該 URL，不 exit） |
| `CC_FORCE_PROJECT_ID` | **forced-mode**：鎖定單一 namespace（如 `__personal__`），硬性 scope | Phase 0 ✅ | 可選；設了即 forced-mode |
| `CC_MEMORY_PROJECT_ID` | `resolveProjectId` 的 fallback layer | 既有 | 可選；**與 `CC_FORCE_PROJECT_ID` 互斥**（同設 fail） |
| `GEMINI_API_KEY` | Gemini embedding；**personal instance 接受傳入**做 semantic search | Phase 1+ | 可選（未設則 keyword-only 降級） |
| `CC_READ_ONLY` | read-only instance：寫入類 tool 雙層拒絕 | Phase 2 | 可選；`1`=啟用 |
| `CC_TOOL_ALLOWLIST` | 逗號分隔的 tool 白名單，進一步收斂單一 instance 可用 tool | Phase 2 | 可選；未設=不額外限制 |
| `CC_SEARCH_FEEDBACK` | 是否寫 `search_feedback` telemetry（read-only instance 的副作用開關，Codex #9） | Phase 2 | 可選；預設 `on`（read-only 下仍可寫 telemetry） |
| `CC_MEMORY_WRITER` | `writer_host` 來源；預設 `os.hostname()` | 既有 | 可選 |

> **`CC_SEARCH_FEEDBACK` 的存在理由（Codex #9）**：read-only instance 的 `cc_memory_search` 仍會 fire-and-forget 寫 `search_feedback`（retrieval 評估必要的觀測）。這是「telemetry 寫入」非「使用者資料寫入」，不違反 read-only 語意；但為了讓潔癖消費端能完全關掉任何寫，提供此開關。

---

## Testing Strategy

| 層級 | 工具 | 範圍 | 時機 |
|---|---|---|---|
| Unit | vitest | `scope-policy`（已有）、reminder slot 推導 / advance / snooze 純邏輯 | 每次 `npm test` |
| Integration | vitest + Docker test PG | `getDueReminders` 併發 claim（兩 session）、unique 去重、recurrence 跨多 slot、read-only 雙層 | 每次 `npm test` |
| Regression | 既有 306 tests | Phase 0 行為不回歸 | 每次 `npm test` |

**Red-Green-Refactor**：reminder schema 先寫紅（欄位不存在 → 測試失敗）再綠；slot 推導/advance/snooze 各情況先寫紅測。read-only 先寫「ListTools 仍含寫入 tool」紅測 → 實作過濾轉綠 → 再寫「handler 直呼被拒」紅測。

> Phase 執行紀律見 `~/.claude/rules/sdd-workflow.md`。

---

## Service Layer（Signatures）

### `src/services/scope-policy.ts`（Phase 0 ✅ 已實作）

```ts
export const PERSONAL_PROJECT_ID: string;
export const RESERVED_PROJECT_IDS: ReadonlySet<string>;
export function isReservedProjectId(id: string): boolean;
export function loadScopeConfig(env?: Record<string,string|undefined>): ScopeConfig;  // config-drift fail
export function applyScopePolicy(
  resolvedId: string | undefined,
  opts: { config: ScopeConfig; surface: 'scope' | 'search' }
): string | undefined;   // forced/scope/search 三分支共用
```

### `src/services/reminders.ts`（Phase 1 新增）

```ts
export interface DueReminder { task: Task; slot: Date; }

// 撈 due + claim + 去重 + advance，回本次成功 claim 的提醒。
// 一個交易內：FOR UPDATE SKIP LOCKED 選列 → INSERT reminder_log（unique 衝突跳過）
//            → 依 slot 三情況 UPDATE tasks。
export async function getDueReminders(opts: {
  projectId: string;     // ★ 已套 applyScopePolicy 的 scope；WHERE project_id=$projectId。
                         //   forced personal instance 傳 __personal__。缺則破 Phase 0 namespace 邊界。
  now?: Date;            // 測試可注入；預設 now()
  channel: string;       // 寫入 reminder_log.channel
  writerHost?: string;   // 預設 resolveWriterHost()
  limit?: number;        // 單次最多處理筆數
}): Promise<DueReminder[]>;

// 使用者操作（MCP tool 或 CLI 串接）。
// ★ 三者都帶 projectId（已套 applyScopePolicy 的 scope），UPDATE/SELECT 一律 WHERE id=$id AND project_id=$projectId，
//   affected=0 → throw（與既有 updateTask 的 projectId guard 同模式，防跨 namespace 用 task UUID 改別人的 row）。
export async function setReminder(taskId: string, projectId: string, opts: {
  remindAt: Date;
  recurrenceIntervalDays?: number | null;   // null=一次性
}): Promise<Task>;
// ★ setReminder 重設時必須 UPDATE ... SET remind_at=$new, snooze_until=NULL, last_notified_at=NULL：
//   因 snooze_until 投遞後不自動清除（見 slot 表），殘留的舊 snooze 會經 COALESCE 蓋過新 remind_at、
//   或舊 slot 已 log 被 NOT EXISTS 排除 → 新提醒永不 due。清 snooze 是 setReminder 契約的一部分（含測試）。
export async function snoozeReminder(taskId: string, projectId: string, until: Date): Promise<Task>;
export async function clearReminder(taskId: string, projectId: string): Promise<Task>;  // remind_at/snooze/recurrence 清空
```

**`getDueReminders` 演算法（核心，machine-checkable）**：
```sql
-- 1. 篩選 + claim（多 poller 安全 + scope 隔離 + 已投遞 slot 預先排除）
SELECT * FROM tasks t
WHERE t.status IN ('open','in_progress')
  AND t.project_id = $projectId          -- ★ scope 隔離（已套 applyScopePolicy 的 scope；
                                          --   forced personal instance = __personal__）。
                                          --   缺這行 → personal poller 會撈到別專案 task，破 Phase 0 邊界。
  AND t.remind_at IS NOT NULL
  AND COALESCE(t.snooze_until, t.remind_at) <= $now
  AND NOT EXISTS (                        -- ★ 已投遞的 slot 預先排除（在 LIMIT 之前）。
    SELECT 1 FROM reminder_log rl         --   否則一次性已發 row 每輪仍被選中，因 LIMIT 在
    WHERE rl.task_id = t.id               --   unique 去重前套用，舊的已發提醒會塞滿 batch、
      AND rl.scheduled_for = COALESCE(t.snooze_until, t.remind_at)  -- starve 後續新 due 提醒。
  )
ORDER BY COALESCE(t.snooze_until, t.remind_at)
LIMIT $limit
FOR UPDATE SKIP LOCKED;                   -- 只鎖 tasks（reminder_log 在子查詢不被鎖）
```
> **NOT EXISTS（預過濾）vs unique（race backstop）分工**：`NOT EXISTS` 在 `LIMIT` 之前把已投遞的 slot 移出候選集，是「不 starve / 正確終止」的主機制；`reminder_log` 的 `unique(task_id, scheduled_for)` 退居為**併發 race 的最後背線**（兩 poller 同時通過 NOT EXISTS 時，第二個 INSERT 走 `ON CONFLICT DO NOTHING`、`RETURNING` 空 → 跳過，**不丟錯、不 abort 交易**）。兩者皆需要。
對每筆 row（同交易內）：
```
slot := COALESCE(row.snooze_until, row.remind_at)
-- ★ ON CONFLICT DO NOTHING（不可用 catch unique_violation）：plain INSERT 撞 unique 會讓整個交易進
--   aborted state → 後續 UPDATE / 處理其他 row / COMMIT 全失敗。ON CONFLICT 不丟錯，RETURNING 空 = race 沒搶到。
inserted := INSERT INTO reminder_log (task_id, scheduled_for, fired_at, channel, writer_host)
            VALUES (row.id, slot, $now, $channel, $host)
            ON CONFLICT (task_id, scheduled_for) DO NOTHING
            RETURNING id
if inserted IS EMPTY:           -- 同輪併發 race：別的 poller 在本輪 NOT EXISTS 後搶先入此 slot
  continue                      -- 跳過此筆、不 advance、不計回傳（交易仍存活）
-- advance（依 slot 三情況，見 Data Model 表）
if row.recurrence_interval_days IS NULL:
  UPDATE tasks SET last_notified_at=$now WHERE id=row.id      -- 一次性（含 snooze）：保留 remind_at/snooze_until；
                                                              -- 下輪該 slot 已入 log → NOT EXISTS 排除，不再進 batch
else:
  next := row.remind_at; repeat next += interval until next > $now
  UPDATE tasks SET remind_at=next, snooze_until=NULL, last_notified_at=$now WHERE id=row.id
append (row, slot) to result
```

### MCP 層接點（Phase 1/2）

- Phase 1（✅ 已實作）：新增 MCP tool `cc_task_set_reminder` / `cc_task_snooze`（**已決採新 tool**，不動既有 `cc_task_update` 契約；理由：`cc_task_update` 強制 `expected_status`，語意不合「設提醒」）。tool def + handler inline 於 `src/index.ts`。reminder poller 本體（誰呼叫 `getDueReminders`）屬跨 repo 階段的 channel 整合，Phase 1 只交付 service + schema + 可手動驅動的 CLI/腳本。
- Phase 2：MCP server 啟動期讀 `CC_READ_ONLY` / `CC_TOOL_ALLOWLIST`。**兩種獨立限制，各自雙層 enforce**：
  - **read-only**（`CC_READ_ONLY=1`）：限制「寫入類 tool」。ListTools 隱藏寫入 tool + **每個寫入 handler** 入口 `assertWritable()`。
  - **allowlist**（`CC_TOOL_ALLOWLIST`）：限制「集合外的任何 tool（**含 read**）」。ListTools 只露 allowlist 內 tool + **每個 handler**（read+write 皆是）入口 `assertAllowed()`。
  - ⚠️ allowlist 的第二層守衛**不可只加在寫入 handler**——否則被 allowlist 排除的 read tool 雖從 ListTools 消失、卻仍可被 client 直呼，違反「集合外兩層皆拒」Gate（Codex P2）。實作上用 central dispatch 守衛（每個 tool call 進入點統一跑 `assertAllowed` + 寫入再加 `assertWritable`），不靠逐 handler 手動掛。

---

## HTTP REST API

> **本 initiative 的對外介面是 MCP stdio，無 HTTP 服務。** 此章節為 format 完整性保留，並標記跨 repo roadmap 對映——**不複製既有 `docs/plan.md` 已取消的 Phase B HTTP 設計**。

- Personal-Hub Phase 0~2：**不提供 HTTP REST API**。hermes / `/hi` / Claude Code 一律走 MCP stdio（各自起本地 forced-mode / read-only instance 連雲端 PG）。
- 跨 repo 階段（roadmap，憑證/授權未到位前不展開）：若 reminder 投遞或遠端消費需要 HTTP，屆時設計獨立 read-path API（讀 `getDueReminders` 結果推 channel）。介面草案、auth 模型、endpoint 清單待該階段 brainstorm，不在本 plan 鎖定。

---

## Telegram Bot

> 同上，format 完整性保留。Personal-Hub **本身不含 Telegram bot**。

- Telegram 在本 initiative 的角色是 **reminder 的投遞 channel 之一**（對映 `reminder_log.channel='telegram'`），屬跨 repo 階段。
- 投遞流程草案（roadmap）：跨 repo 的 reminder poller 定期呼叫 `getDueReminders({ channel:'telegram' })` → 對回傳的 `DueReminder[]` 推 Telegram 訊息。poller 本體、bot token 管理、互動（snooze 按鈕回呼 `snoozeReminder`）待該階段設計。
- 不重用既有 `docs/plan.md` 已取消的 Phase B bot 規格（那是 memory 查詢 bot，concern 不同）。

---

## Deployment

> 此章節對 personal-hub **是真有內容**：instance 設定與 prod 硬隔離。

### Phase 0~2：instance 設定（無新服務部署）

各裝置本地起 MCP server 連既有雲端 PG（現 Coolify；原 Zeabur），靠 env 區分 instance：

| 消費端 | 啟動 env | 說明 |
|---|---|---|
| hermes / `/hi` / Claude Code（個人） | `CC_FORCE_PROJECT_ID=__personal__` (+ `GEMINI_API_KEY`) | forced-mode，讀寫 `__personal__` |
| 各專案 Claude Code | （不設 force） | project-mode，deny `__personal__` |
| `/hi` 注入消費端（Phase 2） | `CC_READ_ONLY=1` + `CC_FORCE_PROJECT_ID=__personal__` | 只讀個人記憶/待辦 |

- **`.mcp.json` 設定樣板**：各 repo 的 `.mcp.json` 為 cc-memory entry 帶對應 env。
- **Phase -1 前置（跨 repo，v0.4 翻案後降為 strongly recommended）**：AI_Copilot 的 `.mcp.json` 目前掛了 raw postgres MCP。原本是 hard blocker（理由：持 `DATABASE_URL` 可繞過 forced-mode）；Phase 3 v0.4 後個人資料不在 project DB，raw postgres 拿 `DATABASE_URL` 只連 project DB、看不到個人資料。新 Gate：該環境 raw postgres **不持** `DATABASE_URL_PERSONAL` 且無寫入個人 DB 通道（仍建議清理，但已非 hard blocker）。

### Phase 3：prod 獨立 personal DB（✅ 已交付 2026-06-10，現 Coolify——2026-07-01 遷移；v0.4 翻案，原 RLS 方案見 [decisions/ADR-001](decisions/ADR-001-phase3-separate-db.md)）

> 翻案脈絡簡述：原方案 RLS（`personal_rw` / `project_rw_non_personal` / `admin` role + row policy）對 table owner / `BYPASSRLS` role / superuser 預設失效，`USING` / `WITH CHECK` 漏寫即靜默故障，攻擊面寬。改為獨立 personal DB——靠 secret 配發 + 物理切分回應 threat model（任何持 `DATABASE_URL` 的 process）。

- **infra（已執行；當時 Zeabur、現 Coolify）**：開新 PG service `cc-memory-personal`（與既有 project DB 同主機/region 降延遲）；連線字串 = `DATABASE_URL_PERSONAL`。
- **Deployment topology（見上方 instance 拓樸表）**：project-mode **只**配 `DATABASE_URL`；forced-mode personal **只**配 `DATABASE_URL_PERSONAL`；admin/migration 才同時持兩個。
- **`resolveDatabaseUrl()` + fail-fast 矩陣**（`src/db/resolve-url.ts`，config.ts 重接）：依 forced-mode flag 選 URL；forced personal 缺 personal URL → throw；forced personal 兩 URL 同物理 DB → throw；非 forced personal 偵測到 personal URL → warn + 拒絕載入該 URL（不 exit）；forced 非 personal 不 throw。
- **`src/db/client.ts` 單 process 鎖一 DB**：啟動連線一個 DB，無 request-level 切換。
- **Migration 跨 DB 套用**：用 `scripts/apply-migration.ts`（非 `drizzle-kit push`），既有 0000-0006 全套到 personal DB；personal DB 多套 0007（`project_id='__personal__'` CHECK constraint on `project_memories` / `tasks`）；project DB 在 delete COMMIT 後多套 **0008 反向 CHECK**（`project_id <> '__personal__'` + search_feedback 兩 arm，防個人列回流——與 0007 互為鏡像）。**此類 CHECK 不進共用 `src/db/schema.ts`**——schema.ts 是兩 DB 共用 source，若放會污染另一邊；CHECK 是 per-DB 不變量，放 per-DB-only migration SQL。
- **表 inventory 不手寫**：`scripts/lib/inventory.ts` 單一 SoT——`information_schema` query（`column_name='project_id'` + FK 關聯）+ `search_feedback` special-case（無 project_id 欄，混合列 predicate）+ `EXPECTED_INVENTORY` diff 斷言；migrate / preflight / delete 三方共用。
- **Preflight 三 mode**：`scripts/preflight.ts --mode {pre-migration,post-copy,post-delete}`，mode-prefixed cases（P1-P7 / C1-C5 / D1-D5）覆蓋 connection identity（URL 層 host+port+database 比對——user 只進報表不參與判定；DB 活體 advisory-lock probe + 0007/0008 方向檢查）、schema 一致（columns/constraints/indexes + expected-delta allowlist）、inventory assertion、row count + checksum（`to_jsonb` + tx 內 `SET LOCAL TIME ZONE 'UTC'` 的 MD5 string_agg）、CHECK 雙向拒寫（C5 0007 / D4 0008）；ScopePolicy 排除正確性由 shared predicate（`scope-policy.ts` `reservedExclusionCondition`）+ scope-probe integration test（control+treatment）鎖。
- **Delete script**：`scripts/delete-personal-data.ts`——單一 tx 內 LOCK TABLE → 重計數 → checksum 與 personal DB 精確比對 → DELETE → 同 tx 驗證 → COMMIT；dry-run 預設、`--execute` 才真刪、manifest 落盤供 D3 比對（修 P0：MVCC 下「DELETE 後另終端 preflight 再 COMMIT」閘門恆 PASS）。
- **Maintenance window**：Step 0 backup → Step 1 開 personal DB + migration + preflight pre-migration → Step 2 停 writers → Step 3 migrate + preflight post-copy → Step 4 rollback judgement + delete dry-run → Step 5 delete script（tx 內 DELETE→驗證→COMMIT）→ Step 5.5 套 0008 → Step 5.6 preflight post-delete（COMMIT 後最終確認）→ Step 6 env 切換 + 重啟 → Step 7 smoke。任一驗證 fail → ROLLBACK / abort。

---

## Files to Create / Modify

### Personal-Hub Phase 0 ✅（已交付，回填紀錄）

```
src/services/scope-policy.ts   # ✅ forced/project/search 三分支 scope 決策 + config-drift 防護
src/services/tasks.ts          # ✅ cc_task_stats（Asia/Taipei 日界）
src/index.ts                   # ✅ 每個 tool 套 applyScopePolicy；ListTools schema guard
src/services/memories.ts       # ✅ searchMemories WHERE 排除保留 namespace（全專案 search）
CLAUDE.md                      # ✅ 工具清單 + __personal__ namespace 說明 cascade 同步
```

### Personal-Hub Phase 1（reminder）✅ 已落地

```
src/db/schema.ts               # ✅ tasks 加 4 欄 + reminder_log 表 + CHECK + reminders_due_idx（partial functional index）
sql/migrations/0006_add_reminders.sql   # ✅ drizzle-kit generate 產出（COALESCE expression index + CHECK 保真度已 eyeball + pg_indexes 斷言守）
src/services/reminders.ts      # ✅ getDueReminders / setReminder / snoozeReminder / clearReminder（+ updateReminderScoped 共用 guard）
src/services/types.ts          # ✅ DueReminder / SetReminderInput / GetDueRemindersOptions
src/index.ts                   # ✅ cc_task_set_reminder / cc_task_snooze tool def + handler（inline；不另建 src/tools/ 殼）
scripts/run-reminders.ts       # ✅ 手動驅動 getDueReminders 的 CLI（先 applyScopePolicy 解 scope；channel poller 屬跨 repo）
tests/db/reminders-schema.test.ts   # ✅ schema 反射 + integration（unique/CHECK/index indexdef）
tests/services/reminders.test.ts    # ✅ slot/advance/snooze/併發/去重/recurrence/scope
tests/mcp-reminders.test.ts         # ✅ MCP tool happy path + scope guard + forced-mode
```

> **實作偏離說明**：plan 原列 `src/tools/set-reminder.ts` / `src/tools/snooze.ts` 薄殼。實際採 inline 於 `src/index.ts`（tool def 進 `BASE_TOOLS`、handler case 直接呼叫 `services/reminders.ts`）——因 `src/tools/` 是 legacy re-export barrel（CLAUDE.md 明示「新 code 應直接 from '../services/'」），新增純 re-export 殼是 dead code。決定遵循現行 codebase 慣例。

### Personal-Hub Phase 2（read-only）✅ 已落地

```
src/services/tool-policy.ts    # ✅ isWriteTool() + assertWritable()（read-only）+ assertAllowed()（allowlist，含 read）+ loadToolPolicy()
src/services/errors.ts         # ✅ ForbiddenError（code FORBIDDEN）
src/services/types.ts          # ✅ McpError union 加 FORBIDDEN
src/index.ts                   # ✅ buildToolsForMode 加 policy 過濾 + handleToolCall central guard（assertAllowed → assertWritable）+ search telemetry 受 CC_SEARCH_FEEDBACK 控制
tests/services/tool-policy.test.ts   # ✅ 24 tests
tests/mcp-read-only.test.ts          # ✅ 8 tests（ListTools 過濾 + 直呼雙層被拒 + telemetry 開關）
```

### Personal-Hub Phase 3（prod，roadmap；v0.4 翻案：獨立 personal DB）

```
src/db/resolve-url.ts                        # resolveDatabaseUrl() 純函式 + fail-fast 矩陣 + sanitizeUrl（config.ts 重接）
src/db/identity.ts                           # connIdentity/samePhysicalDb + assertDistinctDatabasesLive（advisory probe）
src/constants.ts                             # PERSONAL_PROJECT_ID 單一出處（scope-policy re-export）
src/db/client.ts                             # 用 config.databaseUrl，啟動鎖一 DB
sql/migrations/0007_personal_db_check_constraint.sql   # personal-DB-only CHECK project_id='__personal__'（不進共用 schema.ts）
sql/migrations/0008_project_db_no_personal_check.sql   # project-DB-only 反向 CHECK（delete COMMIT 後套；互為鏡像）
scripts/lib/{inventory,clients,checksum}.ts  # 工具鏈單一 SoT（EXPECTED_INVENTORY/personalWhere/adminClient/to_jsonb checksum）
scripts/preflight.ts + scripts/preflight/*.ts  # 三 mode 拆檔，mode-prefixed cases（P1-P7/C1-C5/D1-D5）
scripts/migrate-personal-data.ts             # copy-only：inventory diff + 活體檢查 + cursor 分頁 + rerun 語意
scripts/delete-personal-data.ts              # tx 內 LOCK→計數→checksum→DELETE→驗證→COMMIT + manifest（dry-run 預設）
scripts/test-db-setup.ts                     # idempotent 雙 test DB + migrations（本地 e2e 用）
tests/scripts/e2e-migration-pipeline.test.ts # 全管線 e2e（staging 演練前移）
docs/personal-hub/decisions/ADR-001-phase3-separate-db.md   # 翻案脈絡 + threat model + deployment topology + 補記
docs/personal-hub/prod-runbook.md            # personal DB backup/restore/monitoring/rollback playbook
```

### 修改（一行，跨 track）

```
docs/spec.md   # 頂部加 v0.4 Phase C deferred status note + pointer 指向本目錄
```

---

## Rollout Order

### Personal-Hub Phase 0 ✅（已交付）

| Phase | 交付 | Gate | 狀態 |
|---|---|---|---|
| **0** | forced-mode ScopePolicy + project-mode deny + `__personal__` 隔離 + `cc_task_stats` + input hardening | 雙向 deny 三路測試綠；config-drift fail 測試綠；306 tests 綠；Codex review gate 過 | ✅ commit `01dd5e4` |

### Personal-Hub Phase 1 — Reliable Reminders（✅ 已完成）

| Step | 交付 | Gate | 狀態 |
|---|---|---|---|
| 1a | schema：tasks 4 欄 + `reminder_log` + CHECK + index + migration `0006_add_reminders` | migration test PG 成功；欄位/表/index 上線；無回歸 | ✅ |
| 1b | `src/services/reminders.ts`（getDueReminders/set/snooze/clear）+ TDD | slot 三情況 / advance 不漂移 / catch-up clamp / snooze 不重複 / 併發 claim 去重 全綠 | ✅ 19 tests |
| 1c | MCP tool（set_reminder / snooze，inline 於 index.ts）+ `scripts/run-reminders.ts` 手動驅動 | 手動跑 CLI 撈出 due + `reminder_log` 去重；MCP tool happy path + scope guard 綠 | ✅ 8 tests |

> reminder 投遞到實際 channel（Telegram/hermes）不在 Phase 1——Phase 1 交付「撈 + 去重 + advance」的 service 與可手動驅動的 CLI，channel 串接屬跨 repo 階段。

### Personal-Hub Phase 2 — Read-only Mode（✅ 已完成）

| Step | 交付 | Gate | 狀態 |
|---|---|---|---|
| 2a | `tool-policy.ts`（isWriteTool / assertWritable / assertAllowed / loadToolPolicy） + TDD | 寫入 tool 判定 + read-only/allowlist 單測綠 | ✅ 24 tests |
| 2b | `src/index.ts` ListTools 過濾 + handler 雙層 enforce | `CC_READ_ONLY=1` ListTools 無寫入 tool；直呼被拒；`CC_TOOL_ALLOWLIST` 子集兩層生效（含 read）；telemetry 開關；原 tests 不回歸 | ✅ 8 tests |

### Personal-Hub Phase 3 — Prod Hardening（✅ 已交付 2026-06-10——當時 Zeabur、2026-07-01 雙 DB 遷至 Coolify，現況見 prod-runbook.md；v0.4 翻案：獨立 personal DB）

| Step | 交付 | Gate |
|---|---|---|
| 3a | A2.1 開 `cc-memory-personal` PG service（當時 Zeabur、現 Coolify）；A2.2 `src/db/resolve-url.ts`（config.ts 重接）+ `src/db/client.ts` + tests；migration 0007 personal-only CHECK + 0008 project-only 反向 CHECK | 既有 npm test 不回歸；fail-fast 矩陣四案皆綠（forced 缺 personal URL exit、非 forced 偵測到 personal URL warn + 拒載入該 URL 不 exit、`CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID` 同設 exit——檢查在 `src/services/scope-policy.ts`、forced 非 personal namespace 不 throw） |
| 3b | A2.3 `scripts/migrate-personal-data.ts` + A2.4 `scripts/preflight.ts` 三 mode（P1-P7/C1-C5/D1-D5）+ A2.5 `scripts/delete-personal-data.ts`（tx 內 DELETE→驗證→COMMIT） | preflight 三 mode 全 PASS；本地全管線 e2e 綠（`tests/scripts/e2e-migration-pipeline.test.ts`，staging 演練前移）；staging 再跑完整 Step 0-7 演練 |
| 3c | A2.6 prod maintenance window 上線（backup → migrate → preflight → delete script → 0008 → post-delete → env 切換）| A2.7 端對端驗收 7 條全綠；rollback rehearsal 通過 |

### 跨 repo roadmap（介面草案 / Gate / OQ 層級，不展開 task）

| 階段 | 目標 | 介面草案 | Gate | Open Questions |
|---|---|---|---|---|
| **-1 前置（v0.4 翻案後 strongly recommended，非 hard blocker）** | AI_Copilot 清理 raw postgres（降攻擊面） | 改 `.mcp.json` | 該環境 raw postgres MCP **不持** `DATABASE_URL_PERSONAL` 且無寫入個人 DB 通道（Phase 3 v0.4 後 project `DATABASE_URL` 已無讀寫個人資料能力） | raw postgres 有無其他依賴方？ |
| **hermes 整合** | hermes 用 personal forced-mode client | hermes 起 cc-memory MCP（`CC_FORCE_PROJECT_ID=__personal__`） | hermes 能讀寫 `__personal__`、讀不到專案 | hermes 的 MCP client 接法 |
| **/hi 整合** | `/hi` 注入個人近況/待辦 | read-only instance（Phase 2）+ `cc_task_stats` | `/hi` 能注入但絕不誤寫 | 注入格式/篇幅 |
| **reminder channel** | due 提醒推實際 channel | poller 呼 `getDueReminders({channel})` → 推送 | 端到端：設提醒 → 到點收到 | 用哪個 channel（Telegram/hermes push）；poller 跑在哪 |
| **Todoist 整合（live REST，Option E）** | agent 群新增 Todoist 待辦 + 追蹤完成 | cc-memory 內建薄 client → `cc_todoist_*`（add/projects/list/complete/completed），token∧forced-personal（__personal__）gated、無 project selector | 真帳號一輪 `projects→add→list→complete→completed`；priority p1↔API 整數比對（`RUN_TODOIST_E2E=1`） | 自動鏡像（Option C webhook reconciliation）留待後續 sync phase；本階段**無自動 sync** |

---

## Risks & Open Questions

### Risks

| 風險 | 影響 | 緩解 |
|---|---|---|
| forced-mode 被 raw postgres / shell 繞過 | 個人資料在持 `DATABASE_URL` 環境可被讀走 | v0.4 翻案後：Phase 3 獨立 personal DB——`DATABASE_URL`（project DB）裡根本沒有個人資料；secret 邊界 `DATABASE_URL_PERSONAL` 只配給 forced-mode personal / admin；project-mode instance 拒絕載入 personal URL；Phase -1 仍先處理 AI_Copilot raw postgres（strongly recommended，降為 non-blocker） |
| 跨 DB 遷移過程個人資料丟 / 雙存 | 部分 row 缺漏或同時存在兩 DB | maintenance window 內順序：migrate copy → preflight post-copy（row count + checksum）通過才往下 → delete script 在同一 tx 內 LOCK + 重計數 + checksum 與 personal DB 精確比對後才 DELETE、同 tx 驗證全過才 COMMIT（任一不符自動 ROLLBACK）→ preflight post-delete 為 COMMIT 後最終確認；checksum 用 `to_jsonb` + UTC 的 MD5 string_agg |
| project-mode instance 誤配 personal URL | 個人資料外洩到 project context | `src/config.ts` 啟動偵測：project-mode instance 看到 `DATABASE_URL_PERSONAL` → warn + 拒絕載入該 URL（不 exit，允許 admin 同持兩 URL） |
| forced-mode personal instance 缺 personal URL 退回 project DB | 個人 instance 寫到錯 DB | `src/config.ts` 啟動 fail-fast：forced + `__personal__` + 缺 `DATABASE_URL_PERSONAL` → exit |
| `cc_reminders_due` 在 read-only instance 被視為純讀 | claim/update reminder_log 仍會寫 | ✅ 已實作（Phase 2）：`src/services/tool-policy.ts:36` 將 `cc_reminders_due` 列入 `WRITE_TOOLS`（含 header comment 說明「名為撈但會認領寫 reminder_log」），雙層 enforce 已涵蓋；tests/services/tool-policy.test.ts + tests/mcp-read-only.test.ts 對應 case 綠 |
| reminder 多 poller 重複投遞 | 同提醒響兩次 | `FOR UPDATE SKIP LOCKED` + `reminder_log` unique 去重雙保險 |
| 已投遞一次性 slot starve 新 due（LIMIT 在去重前）| 新提醒永不被處理 | 查詢 `NOT EXISTS reminder_log` 在 LIMIT 前排除已投遞 slot（Codex P1） |
| reminder poller 撈到別 namespace task | 破 Phase 0 隔離、個人 poller 投遞專案 task | `getDueReminders` / mutation 全帶 scope projectId，`WHERE project_id=$scope`（Codex P1）|
| recurrence 投遞延遲累積漂移 | 每日提醒越來越晚 | 以 `remind_at` 網格錨點推，非實際投遞時間 |
| 漏發大量 slot 洪水補發 | 系統卡住 / 使用者被轟炸 | catch-up clamp 到下一未來 slot，只投一次 |
| 一次性 snooze 清除後重複觸發 | 同提醒響第三次 | snooze_until 投遞後不自動清除（Data Model 已寫死） |
| read-only / allowlist 只靠 ListTools 過濾被繞過 | client 硬呼叫被隱藏 tool 成功 | central dispatch 第二層：`assertAllowed`（含 read）+ 寫入再 `assertWritable`（Codex P2）|
| `due_date` / `remind_at` 被混用 | 提醒邏輯誤判 | 兩 index + 文件明確切分語意 |
| personal 內容送 Gemini 的隱私 | 個人資料離開本機到 Gemini | 使用者已拍板接受；屬知情同意，文件記錄 |

### Open Questions

1. ~~reminder MCP 介面：新 tool（`cc_task_set_reminder`）vs 擴 `cc_task_update` patch 欄位~~ → ✅ 已決：採新 tool `cc_task_set_reminder` / `cc_task_snooze`（`cc_task_update` 強制 `expected_status`，語意不合「設提醒」；保既有契約不動）。
2. reminder poller 跑在哪（cron / hermes 常駐 / `/hi` 觸發）→ 跨 repo 階段決。
3. reminder channel 選型（Telegram / hermes push / 系統通知）→ 跨 repo 階段決。
4. ~~Todoist 匯出格式 → **blocking**，需使用者提供樣本~~ → ✅ 已決：改 **Option E**（cc-memory 內建薄 client、`cc_todoist_*` 直打 Todoist API v1），雙系統並存、無自動 sync；不再需要匯出樣本、不再 blocking。
5. read-only telemetry：`CC_SEARCH_FEEDBACK` 預設 on/off → 暫定 on（評估需要），可調。
6. ~~Phase 3 RLS 對既有 single-connection 部署的影響 → preflight 驗證。~~ → ✅ 已決：v0.4 翻案不採 RLS；改用獨立 personal DB（見 [decisions/ADR-001](decisions/ADR-001-phase3-separate-db.md)）。新 OQ 已內化入 plan：deployment topology env 配發、preflight 三 mode、maintenance window 演練順序——皆已寫入 plan，非開放問題。

---

## 回滾策略

### Phase 0（已交付）
- scope policy 是純決策邏輯；回滾 = revert commit `01dd5e4`，行為退回「無個人 namespace 隔離」。

### Phase 1（reminder）
- schema 全 additive（nullable 欄位 + 新表）；回滾 = 不寫 reminder 欄位 / 不建 `reminder_log`，既有 task 行為完全不受影響。
- service 未被任何 channel poller 呼叫前，等於 dormant 程式碼。

### Phase 2（read-only）
- 不設 `CC_READ_ONLY` → 行為與現在完全相同；回滾 = 移除過濾邏輯。

### Phase 3（prod，v0.4 翻案：獨立 personal DB）
- 風險集中在跨 DB 遷移步驟而非 DB 內部規則；**preflight 三 mode 全過才繼續**；任一 fail → ROLLBACK，maintenance window 結束、保留現狀。
- maintenance window 演練先在 staging 跑完整 Step 0-7（含模擬 fail rollback），prod 才進。
- Rollback playbook：
  - Step 1-4 fail → personal DB drop，project DB 原樣，env 不切換。
  - Step 5（delete script）同 tx 內驗證（計數 / checksum / 歸零）任一不符 → script 自動 ROLLBACK + exit 1，project DB 個人列原樣；preflight post-delete 是 COMMIT 後最終確認（MVCC 下「未 COMMIT 前由另一連線驗證」結構性不可行——其他連線看不到未 COMMIT 的刪除，見 ADR-001 補記）。
  - Step 6 (env 切換) 後若有 prod 異常 → restore project DB backup（Step 0 已開）+ env 切回；personal DB 保留供事後比對。
- 翻案前後對照：原 RLS 方案下「回滾 = DROP POLICY + role grant 還原」；現方案下沒有 policy 要 DROP，回滾窗口集中在「DELETE 是否 COMMIT」+「env 是否切換」兩個原子步驟。
