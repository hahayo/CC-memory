# Personal-Hub 剩餘 Roadmap 補完 Implementation Plan（A3b / A4 / A3c / A3d）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Personal-Hub 上線後剩餘的四塊（/hi 唯讀注入、文件收尾、提醒 at-least-once、Todoist 單向 sync）補完，達成 A4 全套 e2e 驗收。

**Architecture:** 沿用既有拓樸——forced personal MCP instance（launcher pattern）+ hermes cron poller + personal DB（Zeabur `cc-memory-personal`）。A3b 走「第二個 read-only launcher + 第二個 MCP 註冊」；A3c 把投遞語意從 at-most-once 改為 at-least-once（PG durable queue + poller 自送 Telegram + backoff retry）；A3d 為 Todoist→cc-memory 單向 sync（有一個公網可達性決策閘，見 Phase 4）。

**Tech Stack:** TypeScript（cc-memory repo，vitest TDD）、bash launcher、hermes cron、Telegram Bot API、PostgreSQL 18（pgvector image）。

**前置狀態（2026-06-10 已完成，本 plan 不重做）：** PR #4 merged；personal DB cutover（A2.1/A2.6/A2.7）；A1 查證結案；A3a e2e 通過（Telegram 記待辦 + 提醒推播雙向通）；hermes SOUL.md 路由規則；`~/.ccm-personal-url`（mode 600）已存在。

**進度更新（2026-06-10 晚）：**
- ✅ **Phase 1（A3b）完成**：ro launcher + `cc-memory-hi` 註冊 + gate 全過；cockpit 0.2.2 已 merge 進 df-plugin main 並 plugin update——**剩 user 實跑 `/hi --quick` 驗收**
- ✅ **Phase 2（A4 docs）完成**：PR #5 merged（prod-runbook 含 Codex P1 修正 + Phase 3 驗收勾選 + handback 標記）
- ✅ **使用者拍板**：Phase 3 同意 poller 讀 hermes Telegram token；Phase 4 選 **方案 A（polling）**，細部 plan 見 `2026-06-10-todoist-sync-polling.md`
- ⏭️ 下個 session 從 **Phase 3（A3c）** 開始執行

**執行紀律：** cc-memory repo 改動一律開 feature branch（不直接 commit main）、/commit skill、完工跑 codex-review。每個 Phase 結束跑 `npm run typecheck && npm run lint && npx vitest run`。

---

## 🙋 需要使用者手動做的事（總表，依時間點）

| 時機 | 動作 | 原因 |
|---|---|---|
| 隨時（30 秒） | **重啟 Codex CLI**（下次用之前） | 它掛的 cc-memory-personal 還是舊 instance（指舊庫，寫入會被 0008 擋） |
| Phase 1 結束 | **實跑一次 `/hi`** 看「個人待辦」區塊有沒有出現、內容對不對 | /hi 是互動式 skill，agent 無法代跑驗收 |
| Phase 3 開工前 | **確認同意 poller 直接持有 hermes 的 Telegram bot token**（讀 `~/.hermes/.env` 既有值，不新增 secret） | at-least-once 需要 poller 自己送 Telegram 才知道成敗；不同意則 A3c 維持現狀 |
| Phase 4 開工前 | **拍板 A3d 同步機制**：A. polling（建議）/ B. webhook + Cloudflare Tunnel | 見 Phase 4 決策閘——hermes 在 WSL 無公網入口，webhook 方案需要額外開隧道 |
| Phase 4 開工前 | **在 Claude Code 外的終端建 `~/.ccm-todoist-token`**（mode 600，內容只有 token 一行） | secret-scan hook 擋 Claude 寫含 token 的檔案（與 `~/.ccm-personal-url` 同 pattern） |
| 任何時候 | **把 `~/backups/cc-memory/cc-memory-prod-20260610.dump` 複製一份到異地**（NAS / 雲端硬碟） | 備份紀律：本機單份不算異地備份。嚴禁放 /mnt/c（hook 會擋 Claude，但你手動可以） |

---

# Phase 1 — A3b：`/hi` 唯讀注入（估 0.5-1 天）

> cc-memory 端 code 已全部 ready（Phase 2 read-only 雙層 enforce + `cc_reminders_due` 已歸 WRITE_TOOLS）。本 Phase 只有「接線 + e2e 驗證拒絕路徑」。

### Task 1.1: 建 read-only launcher

**Files:**
- Create: `/home/haha/run-cc-memory-personal-ro.sh`（repo 外，與既有 launcher 同目錄）

- [ ] **Step 1: 寫 launcher**（複製 `/home/haha/run-cc-memory-personal.sh` 改三行）

```bash
#!/usr/bin/env bash
# CC-memory 個人中樞 READ-ONLY 啟動器（/hi 注入等只讀消費端專用）
# 與 run-cc-memory-personal.sh 差異：+CC_READ_ONLY=1 +CC_SEARCH_FEEDBACK=off
set -euo pipefail

NODE=/usr/bin/node
CLAUDE_JSON=/home/haha/.claude.json
read_from_claude() { "$NODE" -e "try{const e=require('$CLAUDE_JSON').mcpServers['cc-memory'].env||{};process.stdout.write(String(e['$1']||''))}catch(_){}" 2>/dev/null || true; }

if [ ! -f /home/haha/.ccm-personal-url ]; then
  echo "cc-memory ro wrapper: 找不到 /home/haha/.ccm-personal-url" >&2
  exit 1
fi
DATABASE_URL_PERSONAL="$(cat /home/haha/.ccm-personal-url)"
export DATABASE_URL_PERSONAL
export CC_FORCE_PROJECT_ID=__personal__
export CC_READ_ONLY=1
export CC_SEARCH_FEEDBACK=off

GEMINI_API_KEY="$(read_from_claude GEMINI_API_KEY)"
[ -n "${GEMINI_API_KEY:-}" ] && export GEMINI_API_KEY

exec "$NODE" /home/haha/CC_project/CC-memory/build/index.js
```

- [ ] **Step 2: `chmod +x /home/haha/run-cc-memory-personal-ro.sh`**

### Task 1.2: e2e 驗證 read-only 拒絕路徑（A3b Gate 核心）

- [ ] **Step 1: ListTools 層驗證**——寫入工具不露出

```bash
{ printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"gate","version":"0"}}}\n'; sleep 1; printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 2; } \
  | timeout 15 bash /home/haha/run-cc-memory-personal-ro.sh 2>/dev/null \
  | grep -o '"name":"cc_[a-z_]*"' | sort -u
```

Expected：**只有** read 工具（`cc_memory_search` / `cc_memory_list` / `cc_memory_get` / `cc_memory_stats` / `cc_task_list` / `cc_task_stats`）。**不得出現**：`cc_memory_save` / `cc_memory_delete` / `cc_task_create` / `cc_task_update` / `cc_task_set_reminder` / `cc_task_snooze` / `cc_reminders_due` / `cc_todoist_*`。

- [ ] **Step 2: handler 層驗證**——隱藏工具硬呼叫也被拒（雙層 enforce 第二層）

```bash
{ printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"gate","version":"0"}}}\n'; sleep 1; printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cc_task_create","arguments":{"title":"should-be-rejected"}}}\n{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cc_reminders_due","arguments":{}}}\n'; sleep 3; } \
  | timeout 20 bash /home/haha/run-cc-memory-personal-ro.sh 2>/dev/null | tail -2
```

Expected：兩個 call 都回 error（read-only mode 拒絕），且 personal DB `tasks` 表零新列（`psql "$(cat ~/.ccm-personal-url)" -tAc "SELECT count(*) FROM tasks WHERE title='should-be-rejected';"` 回 0）。

### Task 1.3: 註冊到 Claude Code + 接進 cockpit

**Files:**
- Modify: `/home/haha/CC_project/df-plugin/plugins/om-daily-cockpit/skills/cockpit/SKILL.md`（df-plugin repo，獨立 commit）

- [ ] **Step 1: 註冊 MCP**

```bash
claude mcp add cc-memory-hi -s user -- /home/haha/run-cc-memory-personal-ro.sh
claude mcp list | grep cc-memory-hi   # Expected: ✔ Connected
```

- [ ] **Step 2: cockpit SKILL.md 加「個人待辦」段**——在晨間摘要流程（讀完 email/日報之後）插入一節：

```markdown
## Personal Hub 注入（cc-memory-hi，唯讀）

若 session 有 `mcp__cc-memory-hi__*` 工具：
1. 呼 `cc_task_stats`（不帶 project 參數——instance 已 forced `__personal__`）取得 today / overdue / open 統計。
2. overdue > 0 或 today > 0 時，呼 `cc_task_list`（status=open）列出前 5 筆，整理成「📌 個人待辦」小節放在駕駛艙摘要最末。
3. 全部唯讀：本節**禁止**呼叫任何 cc_task_create / update / reminder 類工具；該 instance 本身也會拒絕（雙層保險）。
工具不存在（未註冊／離線）→ 跳過本節，不報錯。
```

- [ ] **Step 3: df-plugin repo 開 branch `feature/cockpit-personal-hub`，commit（/commit skill），plugin version bump（plugin.json 0.2.1 → 0.2.2）**

- [ ] **Step 4（🙋 user）: 實跑 `/hi --quick` 驗收**——看到「📌 個人待辦」區塊（先用 Telegram 記一筆測試待辦讓它有東西可顯示），且 /hi 全程無任何寫入。

---

# Phase 2 — A4 文件收尾（現在就能做的部分；估 0.5 天）

> 全套 e2e（含 Todoist）那一條 checkbox 等 Phase 4 完成才勾；其餘文件現在補。cc-memory repo 開 branch `docs/a4-closeout`。

### Task 2.1: prod-runbook.md

**Files:**
- Create: `docs/personal-hub/prod-runbook.md`

- [ ] **Step 1: 寫 runbook**，內容必含四節（素材都在今天的 cutover 紀錄裡）：

```markdown
# Personal-Hub Prod Runbook

## 拓樸速覽
- project DB: Zeabur `postgresql`（host 見 ~/.ccm-prod-url，mode 600）— schema 0000-0006 + 0008
- personal DB: Zeabur `cc-memory-personal`（host 見 ~/.ccm-personal-url）— schema 0000-0007
- forced personal launcher: /home/haha/run-cc-memory-personal.sh（只持 personal URL）
- read-only launcher: /home/haha/run-cc-memory-personal-ro.sh（/hi 用）
- hermes cron `cc-memory-reminders`（*/5min）→ scripts/hermes-reminder-poll.ts

## Backup
- 指令：docker run --rm postgres:18 pg_dump "$(cat ~/.ccm-personal-url)" -Fc > ~/backups/cc-memory/personal-$(date +%Y%m%d).dump
-（project DB 同式換 ~/.ccm-prod-url）
- 頻率：personal DB 每週一次 + 任何 schema 變更前；保留 4 份滾動
- ⚠️ 本機 pg_dump 是 v16，dump PG18 必須走 docker postgres:18

## Restore（personal DB）
1. hermes cron pause cc-memory-reminders（止血）
2. docker run --rm -i postgres:18 pg_restore -d "$(cat ~/.ccm-personal-url)" --clean --if-exists < <dump>
3. preflight 驗證：DATABASE_URL=$(cat ~/.ccm-prod-url) DATABASE_URL_PERSONAL=$(cat ~/.ccm-personal-url) npx tsx scripts/preflight.ts --mode post-delete --skip-manifest
4. hermes cron resume cc-memory-reminders

## Monitoring
- 提醒投遞：hermes cron 產出檔 ~/.hermes/cron/output/8cca281df423/（每 tick 一檔）
- reminder_log 異常查詢：SELECT * FROM reminder_log WHERE fired_at > now()-interval '1 day' ORDER BY fired_at DESC;
- MCP instance 健康：claude mcp list（cc-memory / cc-memory-personal / cc-memory-hi 三個 ✔）

## Rollback（罕用；個人列回流 project DB）
- 0008 反向 CHECK 會擋住一切 __personal__ 寫入 project DB——rollback 必須先 ALTER TABLE ... DROP CONSTRAINT *_no_personal_check（三表 + search_feedback 兩 arm），再從 personal DB dump 還原列，最後重套 0008
- 正常情境不應 rollback；遇資料事故優先走 Restore 節
```

（上面是骨架與必含命令；實寫時把今天 cutover 的實際檔名/路徑帶入，不留 TBD。）

### Task 2.2: 驗收 checkbox 勾選 + handback 標記完成

**Files:**
- Modify: `docs/personal-hub/task.md`（「Personal-Hub Phase 3（prod）」6 條 `[ ]` → `[x]`，每條附一行證據註記）
- Modify: `docs/personal-hub/spec.md` / `docs/personal-hub/plan.md`（同步對應驗收區）
- Modify: `docs/personal-hub/handback-A2-A4.md`（A1 / A2.1 / A2.6 / A3a 段落頂部加 `> ✅ 2026-06-10 完成` 註記 + 一行證據）

- [ ] **Step 1: 勾 task.md Phase 3 端對端驗收 6 條**，證據對照：

| checkbox | 證據 |
|---|---|
| forced save 寫 personal、project 看不到 | A2.7 smoke（save → personal=1, project=0） |
| forced search 只回 personal | A2.7 smoke search 命中 |
| project-mode 全專案 search 不含 personal | preflight D5 scope tests PASS + 0008 結構保證 |
| project DB raw 查 __personal__ → 0 列 | cutover 後 psql count=0 |
| 0007 / 0008 雙向 CHECK 拒寫 | preflight C5 + D4 全 PASS |
| delete script tx 驗證 + 三 mode preflight 全 PASS | pre 7/7、post-copy 11/11、post-delete 11/11 |

- [ ] **Step 2: 跑 spec-cascade-check**（spec-bearing 改動紀律）：`node ~/.claude/hooks/spec-cascade-check.js --mode detect`，HIGH/MEDIUM 則照 cascade 流程掃 corpus。
- [ ] **Step 3: /commit + PR（title `docs: A4 收尾 — prod-runbook + Phase 3 驗收勾選`）+ codex-review**

---

# Phase 3 — A3c：reminder 投遞 at-least-once（估 2 天）

> 現狀 at-most-once 的根因：poller 先 claim（寫 reminder_log）再印 stdout 交 hermes cron 投遞，**送沒送到 poller 不知道**。改法：claim 時寫入 durable queue（同 tx），poller 自己呼 Telegram Bot API 送、成功才標 delivered，失敗 backoff 重試（max 5 次 / 1h window），耗盡標 dead + 告警。dedupe key =（task_id, scheduled_for）。
>
> 🙋 **開工前 user 確認**：poller 直接讀 hermes 的 Telegram bot token（`~/.hermes/.env` 既有值）。cron job 改為不帶 `--deliver telegram`（送信責任移進 script）。

### Task 3.1: migration 0009 — `reminder_delivery_queue`（只套 personal DB）

**Files:**
- Create: `sql/migrations/0009_add_reminder_delivery_queue.sql`
- Modify: `src/db/schema.ts`（加 drizzle 定義）

- [ ] **Step 1: 寫 migration**

```sql
CREATE TABLE "reminder_delivery_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "scheduled_for" timestamptz NOT NULL,
  "payload" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'telegram',
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz,
  CONSTRAINT "rdq_status_check" CHECK ("status" IN ('pending','delivered','dead')),
  CONSTRAINT "rdq_slot_uniq" UNIQUE ("task_id", "scheduled_for")
);
--> statement-breakpoint
CREATE INDEX "rdq_due_idx" ON "reminder_delivery_queue" ("status", "next_attempt_at");
```

- [ ] **Step 2: schema.ts 加對應 table 定義；`npm run typecheck` 綠**
- [ ] **Step 3: 確認 preflight 不受影響**——P6/P7 schema 與 inventory 比對 scope 是既有四表；若 inventory assertion 掃全 DB 需把 `reminder_delivery_queue` 加進 allowlist（看 `scripts/lib/inventory.ts` 的 `EXPECTED_INVENTORY`）。本機雙 test DB 跑 `npx tsx scripts/test-db-setup.ts && npx vitest run tests/scripts/` 驗證。

### Task 3.2: queue service TDD（`src/services/delivery-queue.ts`）

**Files:**
- Create: `src/services/delivery-queue.ts`
- Test: `tests/services/delivery-queue.test.ts`

介面（先寫測試再實作；全部走注入的 `Sql` client，沿用 `src/services/reminders.ts` 的 pattern）：

```typescript
export interface QueueRow { id: string; taskId: string; payload: string; attempts: number; }
export async function enqueueDue(db: Sql, items: {taskId: string; scheduledFor: Date; payload: string}[]): Promise<number>;  // ON CONFLICT (task_id, scheduled_for) DO NOTHING → 冪等
export async function claimDeliverable(db: Sql, limit: number): Promise<QueueRow[]>;  // status='pending' AND next_attempt_at <= now()，FOR UPDATE SKIP LOCKED
export async function markDelivered(db: Sql, id: string): Promise<void>;
export async function markFailed(db: Sql, id: string, error: string): Promise<'retry' | 'dead'>;
// markFailed backoff：attempts+1；next_attempt_at = now() + (4*2^(attempts-1)) minutes（序列 4,8,16,32 → 累計 60 分，符合 handback「max 5 次 / 總 window 1 hour」）；attempts >= 5 → status='dead'
```

- [ ] **Step 1: 寫失敗測試**（冪等 enqueue / claim 不撈未到期 / backoff 序列 4,8,16,32 分鐘 / 第 5 次失敗轉 dead / delivered 不重撈）
- [ ] **Step 2: `npx vitest run tests/services/delivery-queue.test.ts` → 全 FAIL（module 不存在）**
- [ ] **Step 3: 實作至全綠；commit**

### Task 3.3: poller v2 — 自送 Telegram + drain queue

**Files:**
- Modify: `scripts/hermes-reminder-poll.ts`
- Test: `tests/scripts/hermes-poll-delivery.test.ts`（Telegram API 用 `TELEGRAM_API_BASE` env 指向本機 mock server）

每 tick 流程：

```typescript
// 1. enqueue：getDueReminders(channel='hermes') 的結果（claim 寫 reminder_log）同步 enqueueDue() —— 同一 tx
// 2. drain：claimDeliverable(db, 20) → 逐筆 POST ${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage
//    （chat_id 從 env TELEGRAM_CHAT_ID；fetch timeout 10s）
//    200 → markDelivered；非 200/網路錯 → markFailed
// 3. markFailed 回 'dead' 的筆 → stdout 印「⚠️ 提醒投遞失敗 5 次已放棄: <title>」（hermes cron 仍會把 stdout 推給 admin —— dead-letter 告警靠這條）
// 4. token 來源：env TELEGRAM_BOT_TOKEN（cc-reminders.sh 從 ~/.hermes/.env source）
```

- [ ] **Step 1: 寫 mock Telegram server 測試**（成功 / 500 後重試成功 / 連續失敗轉 dead 印告警）
- [ ] **Step 2: 實作至綠；`npm run typecheck && npm run lint`**
- [ ] **Step 3: 改 `~/.hermes/scripts/cc-reminders.sh`**——加 `set -a; source /home/haha/.hermes/.env; set +a`（取 TELEGRAM_BOT_TOKEN/CHAT_ID），並 `hermes cron edit 8cca281df423` 拿掉 `--deliver telegram`（改純 `--no-agent`，stdout 只剩 dead-letter 告警）
- [ ] **Step 4: prod e2e**——設一筆 1 分鐘後提醒 → 等 cron tick → Telegram 實收 → `reminder_delivery_queue` 該筆 status='delivered'；再以假 token 製造失敗 → 觀察 backoff 排程與 dead 告警
- [ ] **Step 5: /commit + PR + codex-review**（migration + 併發類改動屬高風險類別，依 skill 規則進多輪對審）

---

# Phase 4 — A3d：Todoist → cc-memory 單向 sync（估 5-7 天；先過決策閘）

## ⚖️ 決策閘（🙋 user 拍板後才開工）

handback 原拍板「webhook 主機 = hermes」有一個沒被討論到的前提問題：**hermes 跑在你 WSL 裡，Todoist 雲端的 webhook 打不進來**（無公網 IP/domain）。兩條路：

| 方案 | 白話 | 優點 | 缺點 |
|---|---|---|---|
| **A. Polling（建議）** | 每 5-15 分鐘用 Todoist Sync API 的 incremental sync token 問「上次之後有什麼變動」 | 零公網需求、零新基礎設施、複用 hermes cron pattern、實作量少 2-3 天 | 變動延遲最多一個輪詢間隔（個人待辦可接受） |
| **B. Webhook + Cloudflare Tunnel** | 開一條免費隧道把公網 URL 導進 WSL 的 hermes endpoint | 即時 | 多一個常駐隧道服務要顧（斷線=漏事件，仍需補 polling 兜底→等於兩套都要做）；HMAC/去重/限流全套要實作 |

> 建議 A：webhook 方案「斷線漏事件」的兜底就是 polling，等於做 B 必先做 A——那就先只做 A，真有即時需求再加 B。

## 開工前置（🙋 user）
- 在 Claude Code 外的終端：`printf '%s' '<TODOIST_API_TOKEN>' > ~/.ccm-todoist-token && chmod 600 ~/.ccm-todoist-token`
- 順手解鎖 Claude Code 內的 `cc_todoist_*` 五工具：`run-cc-memory-personal.sh` 加兩行
  `TODOIST_API_TOKEN="$(cat /home/haha/.ccm-todoist-token 2>/dev/null || true)"`、`[ -n "$TODOIST_API_TOKEN" ] && export TODOIST_API_TOKEN`（13 → 18 工具）

## 任務骨架（方案 A 拍板後，需依本 plan 紀律展開成獨立細部 plan：`2026-06-XX-todoist-sync.md`）

- **Task 4.1** migration 0010：`tasks` 加 `sync_origin text`（'todoist' 標記，loop prevention）+ `todoist_id text UNIQUE` 對應欄；`sync_state` 單列表存 incremental sync token
- **Task 4.2** `src/services/todoist-sync.ts` TDD：`pullChanges(syncToken)`（Sync API v1 `/sync` resource_types=["items"]）→ map 欄位（content/description/due/priority/is_completed）→ upsert by todoist_id（Todoist=SOT 單向蓋過）→ Todoist 刪除/完成 → cc-memory `status='archived'`/`'completed'`
- **Task 4.3** poller script `scripts/todoist-sync-poll.ts` + hermes cron job（*/15min，`--no-agent`，pattern 同 cc-reminders.sh）
- **Task 4.4** 防回流驗證：`sync_origin='todoist'` 的列在 `cc_todoist_add`（cc-memory→Todoist 方向）排除；e2e：Todoist app 加任務 → 15 分內出現在 `cc_task_list`；完成/刪除同步
- **Task 4.5** A4 最後一條 e2e + checkbox：Claude Code 寫 task → Telegram 提醒 → 手機回完成 → Todoist 同步 → `docs/personal-hub/task.md` 全套 e2e `[ ]` → `[x]`

---

## 建議執行順序與里程碑

```
Phase 1（A3b，0.5-1d）──┐ 互相獨立，可並行
Phase 2（A4 docs，0.5d）─┘
Phase 3（A3c，2d）── 需 user 確認 token 事項後開工
Phase 4（A3d，5-7d → 方案 A 約 3-4d）── 需 user 拍板 + 建 token 檔後開工，展開獨立 plan
```

每完成一個 Phase：更新本檔 checkbox、跑 `/commit`、PR + codex-review、更新專案 memory（deployment-zeabur-prod.md 的剩餘待辦清單）。
