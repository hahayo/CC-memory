# Hand-back checklist — Personal-Hub A1/A2.1/A2.6/A3 給 user

> 本 session（2026-06-09）已完成的部分屬「離線、in-repo、可 TDD」範圍；以下是**只有 user / prod 環境 / 跨 repo 才能做的**收尾項。  
> 翻案決策 + 設計細節見 [decisions/ADR-001-phase3-separate-db.md](decisions/ADR-001-phase3-separate-db.md)。  
> 跨 repo 階段（A1 / A3a-d）獨立 PR、各自串接，不在 cc-memory repo 內展開。

---

## ✅ 本 session 已交付（cc-memory repo，commit 待 user 確認）

| 項目 | 檔案 / 證據 |
|---|---|
| spec/plan/task cascade 翻案（RLS → 獨立 personal DB） | `docs/personal-hub/{spec,plan,task}.md` |
| ADR-001 翻案脈絡 + threat model + deployment topology（+補記：delete script / search_feedback delete-only / 0008 / advisory probe） | `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md` |
| `resolveDatabaseUrl()` + fail-fast 矩陣（4 案：forced 缺 personal URL throw / 非 forced 偵測到 personal URL warn + 拒載入該 URL（不 exit）/ `CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID` 互斥——檢查在 `src/services/scope-policy.ts` `loadScopeConfig` / forced 非 personal namespace 不 throw） | `src/db/resolve-url.ts`（config.ts 重接）+ `tests/db/resolve-url.test.ts` + `tests/config.test.ts` |
| db/client.ts「一 process 一 scope 一 DB」原則註解 | `src/db/client.ts` |
| migration 0007 personal-DB-only CHECK + **0008 project-DB-only 反向 CHECK**（互為鏡像，防個人列回流） | `sql/migrations/0007_personal_db_check_constraint.sql` / `0008_project_db_no_personal_check.sql` |
| preflight 三 mode 拆檔 + mode-prefixed cases（P1-P7 / C1-C5 / D1-D5） | `scripts/preflight.ts` + `scripts/preflight/*.ts` |
| migrate-personal-data.ts（lib 化：adminClient raw-text 直通 + 活體檢查 + rerun 語意） | `scripts/migrate-personal-data.ts` + `scripts/lib/{inventory,clients,checksum}.ts` |
| **delete-personal-data.ts（P0 修復：tx 內 DELETE → 驗證 → COMMIT；dry-run 預設）** | `scripts/delete-personal-data.ts` + `tests/scripts/delete-personal-data.test.ts` |
| 全管線 e2e 演練（seed → migrate → post-copy → delete → 0008 → post-delete → 拒回流；本地可重複） | `tests/scripts/e2e-migration-pipeline.test.ts` + `scripts/test-db-setup.ts` |
| 完整測試套件全綠 | `npx vitest run`（562 PASS）+ `npm run typecheck`（src+scripts+tests）+ `npm run lint` |

> ⚠️ `.env.example` 的 topology 註解被 harness denylist 攔（`.env*` 在 denylist）。topology 知識完整寫在 ADR-001 + plan.md instance 拓樸表，無需 `.env.example`。

---

## 🔴 A1 — AI_Copilot raw postgres MCP（strongly recommended，不再是 hard blocker）

> Phase 3 v0.4 翻案後嚴重度降為 strongly recommended（personal DB URL 不配給 raw postgres MCP 就基本安全）。仍建議收緊。

- [ ] 進 `AI_Copilot` repo `.mcp.json`
- [ ] 移除 raw postgres MCP，**或**：改 read-only 連線 + **絕對不持** `DATABASE_URL_PERSONAL`
- [ ] Gate：環境內 raw postgres MCP 不存在 / 不可寫 / 不持 personal DB URL

預估：0.5 天

---

## 🔴 A2.1 — Zeabur infra（cc-memory-personal PG service）

> A2.2/A2.3/A2.4 code 已備好，但需要實體 DB URL 才能 deploy。

- [ ] 在 Zeabur 開新 PostgreSQL service：**name = `cc-memory-personal`**，**region 與 project DB 同**（降延遲）
- [ ] 取得 connection string，記為 secret 別名 `DATABASE_URL_PERSONAL`
- [ ] 依 ADR-001 deployment topology 表配發：
  - `forced-mode personal` instance（hermes / `/hi` / Claude Code forced personal）→ 配
  - `project-mode` instance（一般 Claude Code）→ **禁配**
  - `admin / migration` 短期 maintenance → 兩 URL 都配，maintenance 結束撤回
- [ ] 跑 migration 0000-0007 套到 personal DB：
  ```bash
  DATABASE_URL=<PERSONAL_URL> tsx scripts/apply-migration.ts sql/migrations/0000_baseline.sql
  DATABASE_URL=<PERSONAL_URL> tsx scripts/apply-migration.ts sql/migrations/0001_add_tasks_feedback_bot_state.sql
  # …依序 0002…0006
  DATABASE_URL=<PERSONAL_URL> tsx scripts/apply-migration.ts sql/migrations/0007_personal_db_check_constraint.sql
  ```
  ⚠️ **0007 只在 personal DB 套用**；不可在 project DB 跑（會擋住所有專案寫入）。
  ⚠️ **0008 只在 project DB 套用、且必須等 A2.6 Step 5 delete COMMIT 之後**（先套會被既有個人列違反；見 Step 5.5）。
- ⚠️ **部署順序警告 ①**：升級既有 forced personal instance（hermes 等）到新版 repo **之前必須先完成本節 A2.1**——`resolveDatabaseUrl` 的 fail-fast 在 commit 即生效，forced personal 缺 `DATABASE_URL_PERSONAL` 會啟動 throw。

預估：1 天

---

## 🔴 A2.6 — Prod maintenance window 遷移（需 user 操作 + 線上）

> 先在 staging 跑完整 Step 0-7 演練（含模擬 fail rollback），prod 才進。

```
Step 0 backup
  - project DB pg_dumpall 含 globals → 異地存放
  - 空 personal DB backup（建好但無資料時）

Step 1 [A2.1 完成]
  - 跑 migration 0000-0007 到 personal DB
  - DATABASE_URL=<PROJECT> DATABASE_URL_PERSONAL=<PERSONAL> tsx scripts/preflight.ts --mode pre-migration
  - P1-P7 全 PASS 才繼續（URL 層 identity / DB 活體 probe / current_database / resolve 矩陣 / schema / inventory）

Step 2 開 maintenance window 🚧
  - 停 prod cc-memory writers：hermes、reminder poller、Todoist sync
  - 停 Claude Code forced personal instance 寫入（若 long-running）
  - 等 in-flight transactions drain（pg_stat_activity 觀察 30s 無寫入）
  -（防護縱深：即使有 writer 漏停，Step 5 delete script 的 LOCK TABLE 會把它擋在 tx 外）

Step 3 跨 DB 遷移
  - DATABASE_URL=<PROJECT> DATABASE_URL_PERSONAL=<PERSONAL> tsx scripts/migrate-personal-data.ts --dry-run
  - 確認 inventory + 預期 row count 正確
  - 移除 --dry-run 跑實際 copy（可重跑：id 冪等；skipped>0 時內容一致性由 C3 checksum 把關）
  - DATABASE_URL=<PROJECT> DATABASE_URL_PERSONAL=<PERSONAL> tsx scripts/preflight.ts --mode post-copy
  - C1-C5 全 PASS（identity 重跑 / row count match / checksum match / 其他 project_id 0 列 / 0007 CHECK 拒非 personal）才繼續

Step 4 rollback judgement point ⚠️
  - preflight 任一 case fail → ROLLBACK：personal DB drop、project DB 原樣、maintenance 結束
  - PASS → 跑 delete dry-run（dry-run 是預設模式；印計畫 + checksum 預覽，零寫入）：
    DATABASE_URL=<PROJECT> DATABASE_URL_PERSONAL=<PERSONAL> tsx scripts/delete-personal-data.ts

Step 5 刪除 project DB 個人列（delete script：單一 tx 內 DELETE → 驗證 → COMMIT）
  - DATABASE_URL=<PROJECT> DATABASE_URL_PERSONAL=<PERSONAL> \
      tsx scripts/delete-personal-data.ts --execute --manifest-out /tmp/delete-manifest.json
  - script 內部流程（全自動，無人工 COMMIT 判斷點）：
      LOCK TABLE（SHARE ROW EXCLUSIVE，擋漏停 writer）→ lock 後 tx 內重計數
      → copied 三表 checksum 與 personal DB 精確比對 → DELETE（reminder_log → tasks
      → project_memories → search_feedback）→ 同 tx 驗證（DELETE count == 計數、
      個人列歸零）→ 全過 COMMIT + 印 manifest；任一不符自動 ROLLBACK + exit 1
  - search_feedback 拍板「只刪不搬」（privacy 優先，接受個人 retrieval telemetry 損失，
    見 ADR-001 補記）；DELETE 條件：query_project_id='__personal__'
    OR '__personal__'=ANY(result_project_ids)——混合列（query NULL + result 含 personal）一併刪
  - bot_user_state 不遷不刪（user-level state）；既有 active_project_id='__personal__'
    列處置：UPDATE bot_user_state SET active_project_id = NULL
    WHERE active_project_id='__personal__'（或確認 bot 已全走 personal instance 後保留）

Step 5.5 套 0008 反向 CHECK 到 project DB（防個人列回流；與 0007 互為鏡像）
  - DATABASE_URL=<PROJECT> tsx scripts/apply-migration.ts sql/migrations/0008_project_db_no_personal_check.sql
  - ⚠️ 只套 project DB、且必須在 Step 5 COMMIT 之後（先套會被既有個人列違反）

Step 5.6 preflight post-delete（COMMIT 後最終確認；已從「閘門」降級——閘門在 Step 5 tx 內）
  - DATABASE_URL=<PROJECT> DATABASE_URL_PERSONAL=<PERSONAL> \
      tsx scripts/preflight.ts --mode post-delete --manifest /tmp/delete-manifest.json
  - ⚠️ post-delete 需要雙 URL（D1 identity guard + D3 manifest 比對都要 personal 側）
  - D1-D5 全 PASS；D5 需本機 test PG 可達——staging 演練時 D5 不得為 SKIP

Step 6 env 切換 + 重啟 services
  - hermes / forced-mode instance 補 DATABASE_URL_PERSONAL；驗 config 啟動 PASS
  - ⚠️ 部署順序警告 ②（2026-06-10 實證更正）：hermes 的 cron job `cc-memory-reminders`
    （~/.hermes/cron，script cc-reminders.sh）**直接 cd 進本 repo working tree 跑
    scripts/hermes-reminder-poll.ts——commit 即上線，沒有「merge 但不部署」的緩衝**。
    Phase 3 fail-fast 上線當天即把該 cron 弄成每 5 分鐘 throw + Telegram 轟炸，
    已於 2026-06-10 13:31 `hermes cron pause` 止血（__personal__ 當時 0 任務，零影響）。
    本步完成 env 切換（cc-reminders.sh 補 export DATABASE_URL_PERSONAL）後再
    `hermes cron resume cc-memory-reminders`
  - 結束 maintenance window 🚧

Step 7 smoke
  - A2.7 端對端驗收 7 條（見 docs/personal-hub/spec.md Phase 3 端對端驗收）
```

> 💡 staging 演練可先在本地重現：`docker compose -f docker-compose.test.yml up -d`
> → `tsx scripts/test-db-setup.ts` → `npx vitest run tests/scripts/e2e-migration-pipeline.test.ts`
> （全管線 seed → migrate → post-copy → delete → 0008 → post-delete → 拒回流）。

### 附錄 — break-glass 手動 SQL（僅 delete script 完全不可用時）

> 正常情況**一律**用 `scripts/delete-personal-data.ts`。手動 SQL 沒有 LOCK / checksum /
> 計數驗證 / manifest，等於放棄全部安全網；僅當 script 環境壞掉且時間窗緊迫才用：

```sql
BEGIN;
LOCK TABLE project_memories, tasks, reminder_log, search_feedback IN SHARE ROW EXCLUSIVE MODE;
DELETE FROM reminder_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id = '__personal__');
DELETE FROM tasks WHERE project_id = '__personal__';
DELETE FROM project_memories WHERE project_id = '__personal__';
DELETE FROM search_feedback WHERE query_project_id = '__personal__'
   OR '__personal__' = ANY(result_project_ids);
-- 同一 tx 內自行 SELECT COUNT 驗證歸零後才：
COMMIT;  -- 驗證不過改 ROLLBACK
```

預估：4-5 天（staging 演練 2 天 + prod cutover 1 天 + 觀察 1-2 天）

---

## 🟡 A3a — hermes 完整 client（hermes repo）

> 既有 reminder poller 已串；本期擴成完整 read/write personal task + memory。

- [ ] hermes env 補：`CC_FORCE_PROJECT_ID=__personal__` + `DATABASE_URL_PERSONAL`（**不持** `DATABASE_URL`）
- [ ] 完整讀寫個人 task / memory（既有 `dueReminders` poller 已示範模式）
- [ ] Gate：Telegram 訊息 → 個人 task 寫入 personal DB → reminder 到點推回 Telegram

預估：1.5 天

---

## 🟡 A3b — `/hi` 注入（om-daily-cockpit repo）

- [ ] om-daily-cockpit env 補：`CC_READ_ONLY=1` + `CC_FORCE_PROJECT_ID=__personal__` + `DATABASE_URL_PERSONAL`
- [ ] 注入 `cc_task_stats` + `cc_memory_search` 到 `/hi` context
- [ ] Gate（擴大涵蓋面）：
  - [ ] `cc_memory_save` / `cc_task_create` / `cc_task_update` / `cc_task_set_reminder` / `cc_task_snooze` / `cc_memory_delete` 全 FORBIDDEN
  - [ ] `cc_reminders_due` 也 FORBIDDEN（已在 cc-memory 端 `src/services/tool-policy.ts:36` 列入 `WRITE_TOOLS`；A3b 上線時 e2e 驗證 read-only mode 下實際拒絕）
  - [ ] Phase 2 雙層 enforce 在 read-only mode 下實際拒絕（ListTools 不露 + handler 拒）

預估：1 天

> ✅ **cc-memory 端 `cc_reminders_due` 已歸 write tool**（`src/services/tool-policy.ts:25-36` header comment + `WRITE_TOOLS` set；tests/services/tool-policy.test.ts + tests/mcp-read-only.test.ts 對應 case 綠）。Round 5 cascade 對審指出此項已實作，先前「session 未動」描述是事實錯誤，已修正。A3b 唯一新工作是 e2e 場景下驗證該拒絕路徑。

---

## 🟡 A3c — reminder channel 補齊（hermes repo）

- delivery semantics 決定：**at-least-once + dedupe**（不做 exactly-once，個人可接受偶爾雙發）
- dedupe key：`(reminder_id, slot_id)`，client 端（Telegram channel）以此 dedupe
- 設計：`claim → enqueue durable job → worker retry`（durable queue 用既有 PG 表 `reminder_delivery_queue`，需新建）
- retry policy：exponential backoff，max 5 次，總 window 1 hour
- 超出 retry → log + alert（Telegram channel 通知 admin）

預估：2 天

---

## 🟡 A3d — Todoist 自動 sync（cc-memory + hermes repo）

> 本期實作 scope：**Todoist → cc-memory 單向 sync**（反向 sync、複雜 conflict resolution 等留待後續 phase）。

- 同步欄位：`content` / `description` / `due_date` / `priority` / `is_completed`
- 不同步：labels / project（Todoist 端 project 不同步到 cc-memory project_id，固定 `__personal__`）
- 衝突解決：Todoist 為 SOT（source of truth），單向蓋過 cc-memory
- 刪除處理：Todoist 刪 → cc-memory 軟刪除（status='archived'），不真刪
- Loop prevention：cc-memory 端被 sync 寫入的 row 標 `sync_origin='todoist'`，hermes Todoist client 自己改的不會 webhook 回流
- Webhook 主機：**hermes**（已 long-running，不另開 service）
  - Express endpoint `POST /webhooks/todoist`
  - 驗證 Todoist webhook HMAC 簽章
  - Idempotency：webhook event id 去重表
  - Rate limit：local token bucket

預估：5-7 天（Codex 對審上調）

---

## 🟡 A4 — 整合驗證 + 文件收尾

- [ ] 全套 e2e：Claude Code（forced personal）寫 task → hermes 推 Telegram → 從手機回覆完成 → cc-memory 看到 → Todoist 也同步
- [ ] `docs/personal-hub/prod-runbook.md` 更新：personal DB backup / restore / monitoring / rollback playbook
- [ ] README + CLAUDE.md 反映獨立 DB 架構（cascade 收尾）
- [ ] spec.md / plan.md / task.md 端對端驗收 `[ ]` → `[x]`（A2.7 + A3 全 e2e PASS 後）

預估：1 天

---

## 預估時程合計

| 階段 | 工時 | 備註 |
|---|---|---|
| A1 | 0.5 天 | strongly recommended |
| A2.1 | 1 天 | Zeabur 開 PG + migration |
| A2.6 | 4-5 天 | staging 演練 + prod cutover + 觀察 |
| A3a | 1.5 天 | 平行 |
| A3b | 1 天 | 平行（cc-memory 端 `cc_reminders_due` 已歸 write，A3b 只需 e2e 場景驗證） |
| A3c | 2 天 | 平行 |
| A3d | 5-7 天 | 平行（Codex 對審後上調） |
| A4 | 1 天 | 收尾 |
| **關鍵路徑** | **~10-15 天 dev** | A2.1 → A2.6 為線性；A3 子項可平行於 A2.6 後 |

---

## 已記錄的 AI 對審結論

### Round 1 — Codex debate（Phase 3 RLS vs 獨立 DB）
- ✅ 採納選項 4：獨立 personal DB（5 大 RLS 弱點全成立）
- 翻案 spec line 184 Non-goals → 已在本 session 完成

### Round 2 — Codex plan review（路徑 B 第一版）
- 14 條 finding 全採納（0 駁回、單輪結束）
- 修正點散落於本 session 的 A2.2 / A2.3 / A2.6 / A3b / A3d 設計中（plan.md 各條標 `[CR#N]`）
