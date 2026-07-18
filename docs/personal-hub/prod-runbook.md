# Personal-Hub Prod Runbook

> Phase 3 v0.4（ADR-001 獨立 personal DB）上線後的維運手冊。personal DB cutover 完成於 2026-06-10。
> **拓樸更新 2026-07-05**：反映 2026-07-01 project DB Zeabur → Coolify cutover（Plan B fresh schema，見 `docs/migrations/2026-06-29-cc-memory-project-cutover/addendum-2026-06-30-plan-b.md`）。兩顆 DB 現皆在 Coolify 同一 Postgres cluster（叢集），本機經 SSH tunnel（通道）`127.0.0.1:15432` 連入。
> **排程更新 2026-07-17**：reminder 與 Todoist 已由 systemd user timers 接手並通過首輪實際執行；原 Hermes jobs 均 paused。

## 拓樸速覽

| 角色 | 說明 |
|---|---|
| **project DB** | **Coolify** Postgres cluster、DB `cc_memory_project`、user `cc_memory` — fresh schema（drizzle-kit push 自 `src/db/schema.ts`，等同最新 full schema）+ 0008 手動套用（反向 CHECK：拒 `__personal__` 寫入）+ **0011/0012（v0.5 observations + 反向 CHECK，2026-07-06）**，pgvector 0.8.3，catalog verify 全綠（2026-07-01、2026-07-06）。連線字串：`~/.ccm-project-url`（mode 600），經 SSH tunnel `127.0.0.1:15432` |
| **personal DB** | **Coolify** 同 cluster、DB `cc_memory_personal`（pgvector/pgvector:pg18）— schema 0000-0007 + 0009 + 0010 + **0011/0013（v0.5 observations + personal-only CHECK，2026-07-06）**（0007 CHECK：只准 `__personal__`；0009 reminder_delivery_queue personal-only；0010 todoist sync）。連線字串：`~/.ccm-personal-url`（mode 600），同一 tunnel |
| **舊 Zeabur project DB** | service 仍 running 但 idle（client 已全部切走）；admin 連線字串 `~/.ccm-prod-url`（mode 600）。**Step F 退役待做**（觀察穩定 1-2 週後停用） |
| **forced personal launcher** | `/home/haha/run-cc-memory-personal.sh`（只持 DATABASE_URL_PERSONAL；Claude Code `cc-memory-personal` / Codex 共用） |
| **read-only launcher** | `/home/haha/run-cc-memory-personal-ro.sh`（+CC_READ_ONLY=1 +CC_SEARCH_FEEDBACK=off；Claude Code `cc-memory-hi`，/hi 注入用） |
| **reminder timer** | `cc-memory-reminders.timer`（每 5 分鐘）→ `cc-memory-reminders.service` → `ops/systemd/run-reminders.sh` → `scripts/hermes-reminder-poll.ts`（歷史檔名；不依賴 Hermes runtime）。獨立 env：`~/.ccm-reminders.env`（0600） |
| **Todoist timer** | `cc-memory-todoist-sync.timer`（每 15 分鐘）→ `cc-memory-todoist-sync.service` → `ops/systemd/run-todoist-sync.sh` → `scripts/todoist-sync-poll.ts`。token：`~/.ccm-todoist-token`（0600） |
| **retired Hermes jobs** | `cc-memory-reminders`（8cca281df423）、`todoist-sync`（b340b1a62e3a）與 `cc-memory-auto-capture`（3fb444d5e112）均於 2026-07-17 確認 paused；不可與 systemd 同時恢復 |
| **project-mode instance** | Claude Code `cc-memory` — 2026-07-01 起改 wrapper（包裝腳本）啟動：`/home/haha/run-cc-memory-project.sh`（讀 `~/.ccm-project-url`，`~/.claude.json` 不再直持 DB URL） |

---

## Migration 套用紀錄（cutover 後手動套用者；cutover 前歷史見各 migration docs）

| 日期 | migration | 側 | operator | 驗證 |
|---|---|---|---|---|
| 2026-07-06 | 0011（observations 共用 schema） | project（`cc_memory_project`）+ personal（`cc_memory_personal`）雙側 | haha（Claude Code 維護窗口，先備份 `*-20260706.dump`） | catalog verify：欄位/index 兩側 diff 一致 |
| 2026-07-06 | 0012（no_personal CHECK） | 只套 project | 同上 | `observations_no_personal_check` 存在且僅 project 側 |
| 2026-07-06 | 0013（personal_only CHECK） | 只套 personal | 同上 | `observations_personal_only_check` 存在且僅 personal 側 |

---

## Backup

**政策**：personal DB 每週一次 + 任何 schema 變更前；保留 4 份滾動；存放 `~/backups/cc-memory/`；異地備份由 user 手動。

```bash
# personal DB
pg_dump "$(cat ~/.ccm-personal-url)" -Fc \
  > ~/backups/cc-memory/personal-$(date +%Y%m%d).dump

# project DB（2026-07-01 起改用 ~/.ccm-project-url；~/.ccm-prod-url 是舊 Zeabur，勿再當備份來源）
pg_dump "$(cat ~/.ccm-project-url)" -Fc \
  > ~/backups/cc-memory/project-$(date +%Y%m%d).dump
```

> ✅ **2026-07-06 更新**：本機已裝 PGDG `postgresql-client-18`（pg_dump 18.4 = prod server 18.4），直接本機跑即可。
> ⚠️ **docker 方案已失效勿用**：舊版寫「走 `docker postgres:18 --network host`」——實測 Docker Desktop（WSL2 backend）的 host network 是 Docker VM 的 namespace（命名空間），不是本 distro，容器內看不到 tunnel 的 `127.0.0.1:15432`（connection refused）。2026-07-05 的「實測確認」註記有誤，2026-07-06 維護窗口實測推翻。

既有基準備份：`~/backups/cc-memory/cc-memory-prod-20260610.dump`（cutover 前 project DB full dump）

---

## Restore（personal DB 資料事故）

```bash
# Step 1：止血——靜止「所有」personal DB writer（不只 poller；Codex review P1）
systemctl --user disable --now cc-memory-reminders.timer
systemctl --user disable --now cc-memory-todoist-sync.timer
systemctl --user stop cc-memory-reminders.service cc-memory-todoist-sync.service
# 若仍另行使用 Hermes personal 工具，亦須停止其 gateway；三個 retired jobs 維持 paused。
# 關閉所有掛 cc-memory-personal 的 Claude Code / Codex session（或確保 restore
#     期間不呼叫其任何 cc_* 工具——MCP stdio instance 只在 tool call 時寫入）
# 確認無殘留連線（除本機 psql 外應為 0）：
psql "$(cat ~/.ccm-personal-url)" -tAc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();"

# Step 2：還原 dump（--network host 理由同 Backup 節）
docker run --rm -i --network host postgres:18 pg_restore \
  -d "$(cat ~/.ccm-personal-url)" --clean --if-exists \
  < ~/backups/cc-memory/personal-<YYYYMMDD>.dump

# Step 3：驗證 schema + 隔離健康（P6 schema 比對 + P2 0007 方向檢查最關鍵）
DATABASE_URL=$(cat ~/.ccm-project-url) \
DATABASE_URL_PERSONAL=$(cat ~/.ccm-personal-url) \
  npx tsx scripts/preflight.ts --mode pre-migration

# P1-P7 全 PASS 才算 restore 完成

# Step 4：恢復所有 writer
systemctl --user enable --now cc-memory-reminders.timer
systemctl --user enable --now cc-memory-todoist-sync.timer
```

---

## Monitoring

### systemd timers 與 services

```bash
systemctl --user list-timers cc-memory-reminders.timer cc-memory-todoist-sync.timer --all
systemctl --user show cc-memory-reminders.service cc-memory-todoist-sync.service \
  --property=Id,Result,ExecMainStatus,InactiveExitTimestamp
journalctl --user -u cc-memory-reminders.service --since '24 hours ago' --no-pager
journalctl --user -u cc-memory-todoist-sync.service --since '24 hours ago' --no-pager

# 退役 jobs 應持續顯示 paused
hermes cron list --all
```

### 最近 24h 提醒投遞紀錄

```bash
psql "$(cat ~/.ccm-personal-url)" -c \
  "SELECT id, task_id, scheduled_for, fired_at, channel
   FROM reminder_log
   WHERE fired_at > NOW() - INTERVAL '24 hours'
   ORDER BY fired_at DESC
   LIMIT 50;"
```

### Todoist sync 健康（A3d）

`cc-memory-todoist-sync.timer` 每 15 分鐘啟動 `cc-memory-todoist-sync.service`；無變動時 journal（服務日誌）保持安靜，有變動時記一行摘要。

```bash
# 最近 tick 輸出
journalctl --user -u cc-memory-todoist-sync.service -n 50 --no-pager

# sync_state 健康：有遠端變更時 updated_at 應隨成功 tick 前進
psql "$(cat ~/.ccm-personal-url)" -c \
  "SELECT resource, updated_at, NOW() - updated_at AS staleness FROM sync_state;"

# todoist 來源任務統計
psql "$(cat ~/.ccm-personal-url)" -c \
  "SELECT status, COUNT(*) FROM tasks WHERE source='todoist' GROUP BY status;"
```

token 失效（401）時 poller exit 1、sync_token 不前進；更新 `~/.ccm-todoist-token`
（mode 600）後下一 tick 自動恢復。

### 投遞佇列健康（at-least-once delivery queue）

```bash
# pending 積壓與 dead-letter（dead > 0 = 有提醒投遞失敗 5 次被放棄，需人工處理）
psql "$(cat ~/.ccm-personal-url)" -c \
  "SELECT status, COUNT(*), MIN(next_attempt_at) AS oldest_next_attempt
   FROM reminder_delivery_queue
   GROUP BY status;"

# dead-letter 明細（payload 含任務標題；同時會出現在 reminder service journal 的 ⚠️ 告警）
psql "$(cat ~/.ccm-personal-url)" -c \
  "SELECT task_id, payload, attempts, last_error, created_at
   FROM reminder_delivery_queue WHERE status = 'dead';"
```

dead 列處理：修復根因（如 Telegram token 失效）後，把該列 `status` 改回 `'pending'`、
`next_attempt_at = NOW()`、`attempts = 0` 即可重新投遞；不需要的直接 DELETE。

### MCP instance 健康

```bash
# 三個 instance 均應顯示 Connected
claude mcp list
# 預期：cc-memory ✔  cc-memory-personal ✔  cc-memory-hi ✔
```

### DB 隔離抽查（唯讀，任何時候可跑）

project DB 內 `__personal__` 列應為 0：

```bash
psql "$(cat ~/.ccm-project-url)" -c \
  "SELECT COUNT(*) AS personal_rows_in_project_db
   FROM project_memories
   WHERE project_id = '__personal__';"
# 預期：0
```

---

## Rollback（罕用：把個人資料併回 project DB）

> ⚠️ **正常情境不應走此節**；資料事故優先走上方 Restore 節。

**前提**：migration 0008 在 project DB 套了反向 CHECK，會擋住所有 `__personal__` 寫入。執行 rollback 前必須先 DROP 三個 constraint：

- `project_memories` 的 `project_memories_no_personal_check`
- `tasks` 的 `tasks_no_personal_check`
- `search_feedback` 的 `search_feedback_no_personal_check`

還原列之後，視情況重套 0008。

完整 cutover 反向程序（含 DROP constraint SQL、資料搬回步驟、判斷點）：
`docs/personal-hub/handback-A2-A4.md`（A2.6 Step 4 rollback judgement point）
