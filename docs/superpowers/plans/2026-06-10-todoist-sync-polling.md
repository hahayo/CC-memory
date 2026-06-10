# A3d：Todoist → cc-memory 單向 sync（方案 A：polling）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todoist app 裡的任務變動（新增/改/完成/刪除）在 ≤15 分鐘內自動反映到 cc-memory personal DB。

**Architecture:** hermes cron 每 15 分鐘跑 poller → Todoist Sync API incremental sync（sync_token 存 DB）→ 逐筆 upsert 到 `tasks`（Todoist = SOT 單向蓋過）。Loop prevention 靠 `source='todoist'` 標記 + `cc_todoist_add` 方向排除。沿用既有三層 pattern：migration → service TDD → poller script + cron。

**Tech Stack:** TypeScript / vitest / postgres.js / Todoist unified API v1（`https://api.todoist.com/api/v1`，與既有 `src/services/todoist.ts` 同 base）/ hermes cron。

**拍板紀錄（2026-06-10）：** 方案 A polling（webhook 因 WSL 無公網入口否決）；單向 Todoist→cc-memory；Todoist=SOT；刪除→軟刪；labels/project 不同步（project_id 固定 `__personal__`）。

**前置（🙋 user，開工前）：**
- 在 Claude Code 外的終端：`printf '%s' '<TODOIST_API_TOKEN>' > ~/.ccm-todoist-token && chmod 600 ~/.ccm-todoist-token`
- cc-memory repo 開 branch `feature/todoist-sync`

**執行紀律：** context7 先查 Todoist Sync API 現行文件（endpoint / sync_token 語意 / item 欄位名）再動手；TDD；/commit；完工 codex-review（migration + 外部 API 屬高風險類別）。

---

### Task 1: migration 0010 — sync 欄位 + sync_state 表（只套 personal DB）

**Files:**
- Create: `sql/migrations/0010_add_todoist_sync.sql`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: 寫 migration**

```sql
ALTER TABLE "tasks" ADD COLUMN "todoist_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_todoist_id_uniq" ON "tasks" ("todoist_id") WHERE "todoist_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_source_check";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_check"
  CHECK ("source" IN ('manual','telegram','claude-code','codex','mcp','todoist'));
--> statement-breakpoint
CREATE TABLE "sync_state" (
  "resource" text PRIMARY KEY,
  "sync_token" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
```

> ⚠️ 既有 `tasks_source_check` 枚舉無 'todoist'——必須 DROP/ADD 換約束（上面已含）。
> ⚠️ 0010 只套 personal DB（同 0007 紀律）；migration 編號先 `ls sql/migrations/` 確認 0009 是否已被 A3c 用掉，被用掉就順移 0011。

- [ ] **Step 2: schema.ts 同步**（tasks 加 `todoistId: text('todoist_id')`；新 `syncState` pgTable；source check 枚舉加 'todoist'）
- [ ] **Step 3: 本機雙 test DB 重建 + 既有全套測試綠**：`npx tsx scripts/test-db-setup.ts && npx vitest run`
- [ ] **Step 4: 檢查 preflight inventory**——`scripts/lib/inventory.ts` 的 EXPECTED_INVENTORY 若斷言全表清單，加 `sync_state` + 新欄位；`npx vitest run tests/scripts/` 綠
- [ ] **Step 5: commit**

### Task 2: `src/services/todoist-sync.ts` TDD

**Files:**
- Create: `src/services/todoist-sync.ts`
- Test: `tests/services/todoist-sync.test.ts`（mock fetch，沿用 tests/services/todoist.test.ts 的 pattern）

介面：

```typescript
// Sync API：POST {BASE}/sync  body: {sync_token: string|'*', resource_types: '["items"]'}
// 回 {items: TodoistItem[], full_sync: boolean, sync_token: string}
// （實作前 context7 查證 endpoint 與欄位名——unified API v1 的 sync 路徑與 item shape）
export interface SyncResult { upserted: number; completed: number; archived: number; newSyncToken: string; }
export async function pullAndApply(db: Sql, token: string, opts?: {baseUrl?: string}): Promise<SyncResult>;
```

欄位對應（Todoist item → tasks row）：

| Todoist | tasks | 規則 |
|---|---|---|
| id | todoist_id | upsert key（ON CONFLICT (todoist_id) DO UPDATE） |
| content | title | 截 500 字（title check） |
| description | description | 原樣 |
| due.date / due.datetime | due_date | 無 due → NULL |
| priority 4/3/2/1 | high/normal/normal/low | Todoist 4=最高 |
| checked=true | status='done' + completed_at=now() | |
| is_deleted=true | status='cancelled' | 軟刪，不真刪 |
| （固定值） | project_id='__personal__', source='todoist' | |

- [ ] **Step 1: 失敗測試**：首次 full sync（token='*'）upsert 3 筆／重跑同 token 冪等／checked→done／is_deleted→cancelled／priority 對應／title >500 截斷／sync_token 寫回 sync_state／API 401・429・5xx → throw（不吞錯，poller 下輪重試，sync_token 不前進）
- [ ] **Step 2: 跑測試確認 FAIL → 實作至全綠 → commit**

### Task 3: loop prevention 驗證

**Files:**
- Test: 加進 `tests/services/todoist-sync.test.ts`

- [ ] **Step 1: 確認 `cc_todoist_add`（cc-memory→Todoist 方向）不會把 source='todoist' 的列再推回 Todoist**——讀 `src/services/todoist.ts` 與 MCP handler：`cc_todoist_add` 是顯式呼叫（非自動鏡像），本身無回流路徑；寫一個說明性測試鎖住「sync upsert 不觸發任何 Todoist API 寫入」（mock fetch 斷言只有 /sync 一個 endpoint 被打）
- [ ] **Step 2: commit**

### Task 4: poller script + hermes cron

**Files:**
- Create: `scripts/todoist-sync-poll.ts`（鏡像 `scripts/hermes-reminder-poll.ts` 生命週期：自建 client → pullAndApply → client.end() → 自然退出，不用 process.exit）
- Create: `~/.hermes/scripts/cc-todoist-sync.sh`（repo 外；鏡像 cc-reminders.sh：讀 ~/.ccm-personal-url → export DATABASE_URL_PERSONAL + CC_FORCE_PROJECT_ID；token 讀 ~/.ccm-todoist-token → export TODOIST_API_TOKEN；cd repo；exec npx tsx scripts/todoist-sync-poll.ts）

- [ ] **Step 1: poller script**——stdout 原則：無變動=空 stdout（靜默）；有變動印一行摘要 `✅ todoist sync: +N ~M ✓C`；錯誤 exit 1 印 stderr
- [ ] **Step 2: wrapper script**（⚠️ home 根目錄 .sh 會被 block-home-dump hook 攔 Write——放 ~/.hermes/scripts/ 沒這問題）
- [ ] **Step 3: 手動跑一次 wrapper 對真 Todoist 帳號 smoke**（先在 Todoist app 建一筆測試任務）→ 驗證 personal DB 出現該筆、sync_state 有 token
- [ ] **Step 4: 建 cron**：`hermes cron create --name todoist-sync --schedule '*/15 * * * *' --script cc-todoist-sync.sh --no-agent`（flags 先 `hermes cron create --help` 確認，不要猜）
- [ ] **Step 5: e2e**：Todoist app 改標題 + 完成一筆 → 等下一 tick → `cc_task_list` 反映；Todoist 刪一筆 → status='cancelled'
- [ ] **Step 6: /commit + PR + codex-review**

### Task 5: 收尾

- [ ] launcher `/home/haha/run-cc-memory-personal.sh` 加 TODOIST_API_TOKEN export（讀 ~/.ccm-todoist-token）→ Claude Code 露出 cc_todoist_* 五工具（13→18）
- [ ] `docs/personal-hub/task.md` A4 全套 e2e 跑通後勾最後一條（Claude Code 寫 task → Telegram 提醒 → 手機回完成 → Todoist 同步）；handback A3c/A3d 標 ✅
- [ ] prod-runbook.md 補 todoist-sync cron 監控節（cron output 目錄 + sync_state 健康 SQL）
- [ ] 更新專案 memory（deployment-zeabur-prod.md）
