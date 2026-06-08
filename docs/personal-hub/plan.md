# Personal-Hub Implementation Plan

> **當前狀態（2026-06-05）**：Personal-Hub Phase 0 ✅ 已交付（commit `01dd5e4`，306 tests 綠）· Phase 1（reminder）✅ 已實作（schema + `reminders.ts` service + `cc_task_set_reminder`/`cc_task_snooze` MCP tools + `scripts/run-reminders.ts` CLI，測試綠）· Phase 2（read-only）✅ 已實作（`tool-policy.ts` + ListTools/handler 雙層 enforce + `CC_SEARCH_FEEDBACK` 開關，測試綠）· Phase 3（prod RLS）+ 跨 repo = roadmap。
>
> 本 plan 對應 `spec.md`。Phase 0 回填已實作行為；Phase 1/2 寫到可直接 TDD 的細節；Phase 3 + 跨 repo 停在 roadmap-level（介面草案 / Gate / open questions）。
>
> **執行紀律**：每個 Phase 開工前讀 `~/.claude/rules/sdd-workflow.md` 的 `## 每個 Phase 執行紀律`（brainstorm → context7 → TDD → simplify → review → codex-review）。
>
> change log：
> - v0.1（2026-06-05）：首版。

---

## Architecture

```
                ┌────────────────────────────────────────────┐
                │  PostgreSQL (Zeabur, 既有單一真實來源)        │
                │  project_memories   ── __personal__ 列與專案列同表  │
                │  tasks              ── + remind_at/snooze/recurrence (Phase 1) │
                │  reminder_log       ── 新表 (Phase 1, 去重稽核)     │
                │  project_memories.embedding ── personal 內容向量（__personal__ 列）│
                │  search_feedback    ── retrieval telemetry（不存內容向量）│
                │  [Phase 3] DB role/RLS: personal_rw / project_rw_non_personal / admin │
                └───────────────────────┬────────────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │  src/services/            │  ← DB 存取唯一通道
                          │  scope-policy (Phase 0 ✅) │     所有 tool 共用 scope 決策
                          │  memories / tasks /       │
                          │  reminders (Phase 1)      │
                          └──────────────┬────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │  MCP stdio server (src/index)│
                          │  scope policy 套用每個 tool   │
                          │  [Phase 2] read-only 雙層 enforce │
                          └──┬────────────┬─────────────┬┘
                             │            │             │
          forced-mode instance      project-mode      read-only instance
          CC_FORCE_PROJECT_ID       (一般專案)         CC_READ_ONLY (Phase 2)
          = __personal__            deny __personal__   注入消費端
                │                                          │
        ┌───────┴────────┐                        ┌────────┴─────────┐
        │ hermes / /hi / │                        │ /hi 注入 (跨 repo)│
        │ Claude Code    │                        │                  │
        │ (個人 namespace)│                        └──────────────────┘
        └────────────────┘
                │
       [跨 repo 階段] reminder 投遞 channel (Telegram / hermes push)
```

**instance 拓樸（兩種 + 一種 Phase 2）**

| instance | env | scope 行為 | 用途 |
|---|---|---|---|
| **forced-mode** | `CC_FORCE_PROJECT_ID=__personal__` | 硬鎖 `__personal__`，拒絕跨 project | hermes / `/hi` / Claude Code 存個人記憶+待辦 |
| **project-mode** | （皆不設） | deny `__personal__`，一般專案隔離 | 各專案的 Claude Code |
| **read-only**（Phase 2） | `CC_READ_ONLY=1` (+ 上述其一) | 疊加在上面，寫入類 tool 雙層拒絕 | `/hi` 注入等只讀消費端 |

**強制規則**
- 所有 tool（含 `cc_memory_search` 獨立分支）一律經 `applyScopePolicy()` 決策 scope，不繞過。
- forced-mode 是**應用層**邊界；終極隔離靠 Phase 3 DB role/RLS。raw postgres / shell / 其他持 `DATABASE_URL` 的 MCP 可繞過應用層（已知、誠實標示）。

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
| `DATABASE_URL` | PostgreSQL 連線（Zeabur） | 既有 | 必填 |
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

各裝置本地起 MCP server 連既有 Zeabur PG，靠 env 區分 instance：

| 消費端 | 啟動 env | 說明 |
|---|---|---|
| hermes / `/hi` / Claude Code（個人） | `CC_FORCE_PROJECT_ID=__personal__` (+ `GEMINI_API_KEY`) | forced-mode，讀寫 `__personal__` |
| 各專案 Claude Code | （不設 force） | project-mode，deny `__personal__` |
| `/hi` 注入消費端（Phase 2） | `CC_READ_ONLY=1` + `CC_FORCE_PROJECT_ID=__personal__` | 只讀個人記憶/待辦 |

- **`.mcp.json` 設定樣板**：各 repo 的 `.mcp.json` 為 cc-memory entry 帶對應 env。
- **⚠️ Phase -1 前置（跨 repo）**：AI_Copilot 的 `.mcp.json` 目前掛了 raw postgres MCP——持有 `DATABASE_URL` 可繞過應用層 scope policy。在該環境啟用 personal forced-mode 前，**必須先移除/限制 raw postgres**，否則隱私邊界形同虛設。

### Phase 3：prod DB 硬隔離（roadmap，需 Zeabur prod URL）

- **DB role**：
  - `personal_rw`：只能 `SELECT/INSERT/UPDATE` `project_id='__personal__'` 的 row。
  - `project_rw_non_personal`：不能碰 `__personal__` 的 row。
  - `admin`：全權（migration / 維運）。
- **RLS policy**：對 `project_memories` / `tasks` / `reminder_log` 啟用 row-level security，policy 依 `current_user` role 限制 `project_id` 可見性。
- **preflight（Codex #11）**：migration apply 前跑驗證腳本（確認 role 存在、RLS 不會把現有連線鎖死、additive 欄位無破壞）。
- forced-mode instance 改用 `personal_rw` 連線字串、project-mode 用 `project_rw_non_personal` → 應用層邊界被繞過時，DB 層仍擋。

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

### Personal-Hub Phase 3（prod，roadmap）

```
sql/migrations/NNNN_db_roles_rls.sql   # personal_rw / project_rw_non_personal / admin + RLS policy（編號接 reminder migration 之後）
scripts/preflight.ts                   # migration apply 前驗證
docs/personal-hub/prod-runbook.md      # role 連線字串配置、RLS 驗證步驟
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

### Personal-Hub Phase 3 — Prod Hardening（roadmap，需 Zeabur prod URL）

| Step | 交付 | Gate |
|---|---|---|
| 3a | preflight 腳本 | 驗證 role/RLS 不鎖死現有連線 |
| 3b | RLS migration（role + RLS，編號接 reminder 之後）apply | `project_rw_non_personal` 查 `__personal__` 回 0 列；`personal_rw` 查他專案 0 列 |

### 跨 repo roadmap（介面草案 / Gate / OQ 層級，不展開 task）

| 階段 | 目標 | 介面草案 | Gate | Open Questions |
|---|---|---|---|---|
| **-1 前置** | AI_Copilot 移除/限制 raw postgres | 改 `.mcp.json` | 該環境無持 `DATABASE_URL` 的繞過通道 | raw postgres 有無其他依賴方？ |
| **hermes 整合** | hermes 用 personal forced-mode client | hermes 起 cc-memory MCP（`CC_FORCE_PROJECT_ID=__personal__`） | hermes 能讀寫 `__personal__`、讀不到專案 | hermes 的 MCP client 接法 |
| **/hi 整合** | `/hi` 注入個人近況/待辦 | read-only instance（Phase 2）+ `cc_task_stats` | `/hi` 能注入但絕不誤寫 | 注入格式/篇幅 |
| **reminder channel** | due 提醒推實際 channel | poller 呼 `getDueReminders({channel})` → 推送 | 端到端：設提醒 → 到點收到 | 用哪個 channel（Telegram/hermes push）；poller 跑在哪 |
| **Todoist 整合（live REST，Option E）** | agent 群新增 Todoist 待辦 + 追蹤完成 | cc-memory 內建薄 client → `cc_todoist_*`（add/projects/list/complete/completed），token∧forced gated、無 project selector | 真帳號一輪 `projects→add→list→complete→completed`；priority p1↔API 整數比對（`RUN_TODOIST_E2E=1`） | 自動鏡像（Option C webhook reconciliation）留待後續 sync phase；本階段**無自動 sync** |

---

## Risks & Open Questions

### Risks

| 風險 | 影響 | 緩解 |
|---|---|---|
| forced-mode 被 raw postgres / shell 繞過 | 個人資料在持 `DATABASE_URL` 環境可被讀走 | 誠實標示為應用層邊界；Phase 3 DB RLS 終極隔離；Phase -1 先處理 AI_Copilot raw postgres |
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
6. Phase 3 RLS 對既有 single-connection 部署的影響 → preflight 驗證。

---

## 回滾策略

### Phase 0（已交付）
- scope policy 是純決策邏輯；回滾 = revert commit `01dd5e4`，行為退回「無個人 namespace 隔離」。

### Phase 1（reminder）
- schema 全 additive（nullable 欄位 + 新表）；回滾 = 不寫 reminder 欄位 / 不建 `reminder_log`，既有 task 行為完全不受影響。
- service 未被任何 channel poller 呼叫前，等於 dormant 程式碼。

### Phase 2（read-only）
- 不設 `CC_READ_ONLY` → 行為與現在完全相同；回滾 = 移除過濾邏輯。

### Phase 3（prod RLS）
- 高風險（可能鎖死連線）；**preflight 必過才 apply**；回滾 = `DROP POLICY` + role 還原 grant，schema 不變。
- RLS migration 設計成可 `DOWN`（先驗 down 再 up）。
