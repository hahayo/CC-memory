# Personal-Hub Prod Runbook

> Phase 3 v0.4（ADR-001 獨立 personal DB）上線後的維運手冊。cutover 完成於 2026-06-10。

## 拓樸速覽

| 角色 | 說明 |
|---|---|
| **project DB** | Zeabur project `CC-memory`、service `postgresql` — schema migration 0000-0006 + 0008（反向 CHECK：拒 `__personal__` 寫入）。連線字串：`~/.ccm-prod-url`（mode 600） |
| **personal DB** | 同 Zeabur project、service `cc-memory-personal`（pgvector/pgvector:pg18）— schema 0000-0007（0007 CHECK：只准 `__personal__`）。連線字串：`~/.ccm-personal-url`（mode 600） |
| **forced personal launcher** | `/home/haha/run-cc-memory-personal.sh`（只持 DATABASE_URL_PERSONAL；Claude Code `cc-memory-personal` / Codex / hermes 共用） |
| **read-only launcher** | `/home/haha/run-cc-memory-personal-ro.sh`（+CC_READ_ONLY=1 +CC_SEARCH_FEEDBACK=off；Claude Code `cc-memory-hi`，/hi 注入用） |
| **hermes reminder cron** | job `cc-memory-reminders`（id 8cca281df423，*/5min）→ `~/.hermes/scripts/cc-reminders.sh` → `scripts/hermes-reminder-poll.ts`（⚠️ cron 直接跑本 repo working tree——commit 即上線） |
| **project-mode instance** | Claude Code `cc-memory`（~/.claude.json 持 project DB URL，不變） |

---

## Backup

**政策**：personal DB 每週一次 + 任何 schema 變更前；保留 4 份滾動；存放 `~/backups/cc-memory/`；異地備份由 user 手動。

```bash
# personal DB
docker run --rm postgres:18 pg_dump "$(cat ~/.ccm-personal-url)" -Fc \
  > ~/backups/cc-memory/personal-$(date +%Y%m%d).dump

# project DB
docker run --rm postgres:18 pg_dump "$(cat ~/.ccm-prod-url)" -Fc \
  > ~/backups/cc-memory/project-$(date +%Y%m%d).dump
```

> ⚠️ 本機 `pg_dump` 是 PG16、prod 是 PG18——**必須走 `docker postgres:18`**（本機 image 已存在）。

既有基準備份：`~/backups/cc-memory/cc-memory-prod-20260610.dump`（cutover 前 project DB full dump）

---

## Restore（personal DB 資料事故）

```bash
# Step 1：止血——靜止「所有」personal DB writer（不只 poller；Codex review P1）
hermes cron pause cc-memory-reminders        # 1a. reminder poller
systemctl --user stop hermes-gateway.service # 1b. hermes 對話端（Telegram 寫入路徑）
# 1c. 關閉所有掛 cc-memory-personal 的 Claude Code / Codex session（或確保 restore
#     期間不呼叫其任何 cc_* 工具——MCP stdio instance 只在 tool call 時寫入）
# 1d. 確認無殘留連線（除本機 psql 外應為 0）：
psql "$(cat ~/.ccm-personal-url)" -tAc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();"

# Step 2：還原 dump
docker run --rm -i postgres:18 pg_restore \
  -d "$(cat ~/.ccm-personal-url)" --clean --if-exists \
  < ~/backups/cc-memory/personal-<YYYYMMDD>.dump

# Step 3：驗證 schema + 隔離健康（P6 schema 比對 + P2 0007 方向檢查最關鍵）
DATABASE_URL=$(cat ~/.ccm-prod-url) \
DATABASE_URL_PERSONAL=$(cat ~/.ccm-personal-url) \
  npx tsx scripts/preflight.ts --mode pre-migration

# P1-P7 全 PASS 才算 restore 完成

# Step 4：恢復所有 writer
systemctl --user start hermes-gateway.service
hermes cron resume cc-memory-reminders
```

---

## Monitoring

### Hermes cron 狀態

```bash
# 所有 job 狀態一覽
hermes cron list --all

# 最近幾個 tick 的輸出（空檔 = 無到期提醒）
ls -lt ~/.hermes/cron/output/8cca281df423/ | head -20
cat ~/.hermes/cron/output/8cca281df423/<最新檔名>
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

### MCP instance 健康

```bash
# 三個 instance 均應顯示 Connected
claude mcp list
# 預期：cc-memory ✔  cc-memory-personal ✔  cc-memory-hi ✔
```

### DB 隔離抽查（唯讀，任何時候可跑）

project DB 內 `__personal__` 列應為 0：

```bash
psql "$(cat ~/.ccm-prod-url)" -c \
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
