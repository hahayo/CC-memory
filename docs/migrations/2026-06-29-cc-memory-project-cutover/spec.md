# cc-memory project DB Cutover — Spec

**日期**：2026-06-29
**狀態**：Draft（待 user review）
**範圍**：cc-memory project DB（**不含** `__personal__` namespace；`__personal__` 已於 6/8 完成 cutover）
**Source DB**：Zeabur `43.153.156.125:30156/zeabur`（root user）
**Target DB**：Coolify 同 PG service 內新 database `cc_memory_project`（透過 SSH tunnel `127.0.0.1:15432`）

---

## Why

### 動機

1. **User 決定棄用 Zeabur**：v0.4 計畫對審後拍板（見 2026-06-29 對話）。Zeabur 整體要下線（Step F），但 v0.4 plan 內 Task 1.4 仍假設 prod DB 在 Zeabur → 必須先把 cc-memory project DB 搬到 Coolify，v0.4 schema 改動才有地方落
2. **personal hub 已 cutover (6/8)、project 還沒**：
   - `cc-memory-personal` MCP → Coolify `cc_memory_personal` ✅
   - `cc-memory-hi` MCP → Coolify `cc_memory_personal` (readonly) ✅
   - `cc-memory` (project mode) MCP → **還連 Zeabur** ❌
3. **架構一致性**：兩台機器 onboarding 都走 Coolify path，cc-memory project DB 留 Zeabur 等於兩條 prod 路徑要維護

### 為什麼選「同 PG service 多開 database」（選項 C）

對審後 user 選 C，理由：

| 選項 | 結論 |
|---|---|
| A：Coolify 起獨立 PG service 給 project | 多一個 service 維護成本、多吃 RAM |
| B：合進 `cc_memory_personal` 同 DB by `project_id` | **違反 ADR-001**（forced personal 跟 project 混 DB 有個資外洩風險） |
| **C：同 PG service 內多開 `cc_memory_project` database** | ✅ 不增 service + PG-level isolation + 共享 PG resource |

---

## Goals

1. cc-memory project DB 從 Zeabur 完整搬到 Coolify 新 database `cc_memory_project`
2. `~/.claude.json` `cc-memory` entry 從 direct env 改成 wrapper script（跟 `cc-memory-personal` 對稱），DB secret 不再長期落在 `.claude.json`
3. Cutover 後 `cc_memory_search` / `cc_memory_list` / `cc_memory_stats` 回應跟 Zeabur 一致（同 query 同結果）
4. 為 v0.4 plan Task 1.4 開路：之後新 schema migration 跑在 Coolify `cc_memory_project`
5. Zeabur 保留 read-only（不停 service），等 Step F 才真的下線；本文不負責 Step F

---

## Secret Delivery Decision

**選定**：wrapper script 路徑（跟 `cc-memory-personal` 對稱）

cutover 後 `~/.claude.json` `cc-memory` entry 結構：

| 欄位 | Before | After |
|---|---|---|
| command | `node` | `/home/haha/run-cc-memory-project.sh` |
| args | `["build/index.js"]` | `[]` |
| env.DATABASE_URL | Zeabur URL（含密碼） | 不存在 |
| env.GEMINI_API_KEY | 直接寫 | 不存在（移到 wrapper 內讀） |

新 wrapper `~/run-cc-memory-project.sh` 結構與 `~/run-cc-memory-personal.sh` 對稱：
- 讀 `~/.ccm-project-url`（mode 600，獨立檔）→ `export DATABASE_URL=...`
- 讀 `~/.claude.json` 內 `cc-memory.env.GEMINI_API_KEY`（cutover 完保留這欄即可；rotation 由獨立 task #3 處理）
- `exec node /home/haha/CC_project/CC-memory/build/index.js`

**選擇理由**（Codex 對審共識）：
1. DB secret 不長期落 `.claude.json`（`.claude.json` 是 LLM 配置檔，意外被讀 / 截圖 / cloud sync 風險）
2. Rotation 跟 personal 統一一支 script（未來 `cc-memory-pg-rotate.sh` 改成同時支援 personal + project）
3. 第三台 onboarding 走同一套 wrapper convention

**v0.4 plan 影響**：Task 1.4 內「從 `~/.claude.json` 抓 DATABASE_URL」段已 obsolete，需改成從 `~/.ccm-project-url` 抓——本 cutover plan 的 Files Impact 已涵蓋，但 v0.4 plan drift patch（波 0）會再次驗證。

---

## Non-goals（明確不做）

- ❌ `__personal__` namespace 動任何東西（已 cutover）
- ❌ Step F（Zeabur 真下線）— 獨立 track，本文完成後不一定立即執行
- ❌ Schema 改動（不在本 cutover 範圍，純資料搬遷）— v0.4 M1 才動 schema
- ❌ 第二台同步（第二台沒有 `cc-memory` project entry，不影響）
- ❌ 任何新 feature（純 infrastructure cutover）
- ❌ Embedding 重算（Zeabur 內既有 vector 直接搬，向量值跟 PG vector 擴展版本相容才搬，不相容才重算）

---

## Constraints

1. **Zeabur 不能被誤動**：dump 過程是 read-only；dump 完成前不改 Zeabur 任何 state
2. **`__personal__` namespace 不能受影響**：cutover 期間 personal hub 持續可用（forced personal wrapper 不動）
3. **`~/.claude.json` 改動前必 backup**：含其他 MCP entries（github / n8n / pos-api 等），不能因 cutover 動到別的設定
4. **第二台不需動**：第二台沒裝 `cc-memory` project entry（只裝 `-personal` + `-hi`），confirm 過
5. **失敗可 rollback**：任一步失敗能在 cutover 前狀態 5-10 min 內回到（含 active connection cleanup、Claude Code 重啟、人為操作 buffer；原寫的 < 5 min 低估了）
6. **零 downtime 目標**：cutover 過程 cc-memory project 仍可讀 Zeabur，切換是「改 `.claude.json` + 重啟 Claude Code」原子動作
7. **Cutover 期間 cc-memory 全停**（write + read 都 freeze）：從 Phase 2 (dump) 開始到 Phase 5 (verify) 結束，**不得呼叫任何 `cc_memory_*` tool**（不只是 write，read 也禁；因為 `cc_memory_search` 會自動寫 `search_feedback` log 造成 drift）。User 自律 + **triple drift gate**（Phase 3.6 restore 後 + Task 4.0 Phase 4 開頭 + Task 4.3.5 switch 前最後一刻）。實際操作上 user 一個人 + cutover 預估 < 1.5 hr，自律可行；cutover 期間 user 想記東西用其他工具或紙筆
8. **資料一致性驗證**：cutover 後跑全表 ordered checksum + count + schema-aware timestamp drift gate（每表用對的 timestamp 欄位：`updated_at` / `created_at` / `fired_at` 依 schema 真實對應，見 §App Tables Inventory），所有 app tables 都驗

---

## Pre-conditions（開工前必須滿足）

- [ ] autossh tunnel 活著（`pgrep -x autossh && ss -tln | grep 15432`）
- [ ] `~/.ccm-personal-url` 可讀且 sslmode=disable URL 正確
- [ ] Zeabur DB 還活著（`psql "<zeabur-url>" -c "SELECT 1"`）
- [ ] Coolify PG service `running:healthy`（從 Coolify Dashboard 確認）
- [ ] Pre-flight 確認：Coolify `cc_memory` PG user 有 CREATEDB 權限，或 user 已準備好 Coolify root password 從 Dashboard reveal
- [ ] 本次工作分配 1-2 小時不被打斷（含 dump + restore + verify）

---

## App Tables Inventory（cutover 範圍）

確認自 `src/db/schema.ts`（Drizzle definitions）。每表標 timestamp 欄位以給 drift gate 用：

| 表名 (PG identifier) | 用途 | row 數量級 | drift gate timestamp 欄位 | 必驗 |
|---|---|---|---|---|
| `project_memories` | curated memory（manual save + promoted）| 100s | `updated_at` | ✅ |
| `tasks` | cc_task_* 工具背後表 | 10s | `updated_at` | ✅ |
| `search_feedback` | retrieval feedback log（append-only）| 10s-100s | `created_at`（無 updated_at）| ✅ |
| `reminder_log` | reminder 觸發紀錄（append-only）| 10s | **`fired_at`**（schema 實際欄位，不是 `created_at`；Codex round 3 抓錯）| ✅ |
| `reminder_delivery_queue` | reminder 待遞送 queue（append-only）| < 10 | `created_at`（無 updated_at）| ✅ |
| `sync_state` | sync 進度狀態 | < 10 | `updated_at` | ✅ |
| `bot_user_state` | bot/user 對應狀態 | < 10 | `updated_at` | ✅ |
| `drizzle.__drizzle_migrations` | Drizzle migration history（drizzle schema 內）| 5-10 | n/a（migration 紀錄，cutover 期間不會新增）| ✅（row count 驗）|
| `pg_extension`（vector）| pgvector extension 安裝情況 | 1 | n/a | ✅ extversion 比對 |
| `__personal__` namespace rows | 已在 Coolify cc_memory_personal | n/a | n/a | ❌ 不動 |

**對沒 timestamp 的表**：drift gate 改用 `SELECT COUNT(*)` 對比 baseline；append-only 表理論上不應該在 cutover 期間有新 row（cutover 期間 cc-memory 全停 + drizzle migration 不會自跑）。

**inventory 抓取方式**：cutover 前先 `psql "<zeabur>" -c "\dt"` + `\dt drizzle.*` 列出 source 全表，dump 內含全部、restore 後 target 也應有全部。Phase 3.5 加全表 inventory diff（Codex round 1）。

**pgvector 一致性**：source 跟 target 的 `extversion` 必須相同，否則 embedding query 結果可能因 index opclass / distance function 細節差異而排序不同（Codex Risk）。如果發現 version skew，先升級 Coolify pgvector 對齊 Zeabur 再 restore。

**Ordered checksum 算法**（Codex round 2 OOM 警告）：不能直接 `md5(string_agg(t.*::text, '|' ORDER BY id))`——對含 `vector(1536)` embedding 的全表會撞 1GB text limit。改成兩階段：先 row-by-row `md5(t::text)`，再 `string_agg` hash strings（32 chars each）後 hash。詳見 plan.md Verification Matrix。

---

## Success Criteria

### 功能完備
- [ ] Coolify 新 database `cc_memory_project` 存在且可連（owner = `cc_memory`）
- [ ] Zeabur `zeabur` DB 內**全部 app tables**（見 inventory）搬到 Coolify 新 db
- [ ] **新 wrapper `~/run-cc-memory-project.sh` 存在**（mode 755，跟 `~/run-cc-memory-personal.sh` 對稱）
- [ ] **`~/.claude.json` `cc-memory` entry 改成 wrapper command**（不再含 `env.DATABASE_URL` 明文 secret）
- [ ] `~/.ccm-project-url` 寫好（mode 600，wrapper 讀取的 URL 來源）
- [ ] 重啟 Claude Code 後 `cc-memory` MCP 連線正常

### 資料一致性（強化版，Codex 對審）
- [ ] **全表 row count**：每個 app table 在 Zeabur vs Coolify 數字一致（覆蓋 project_memories / tasks / search_feedback / reminder_log / reminder_delivery_queue / sync_state / bot_user_state / drizzle.__drizzle_migrations）
- [ ] **Schema-aware triple drift gate**：dump 完抓 baseline，每表用真實 timestamp 欄位（`updated_at`：project_memories/tasks/sync_state/bot_user_state；`created_at`：search_feedback/reminder_delivery_queue；`fired_at`：reminder_log；無 timestamp 表用 `COUNT(*)`）。Phase 3.6（restore 後）+ Task 4.0（Phase 4 開頭）+ Task 4.3.5（switch 前最後一刻）三次 gate 都不變 = freeze 守住
- [ ] **每表 OOM-safe ordered checksum**：對每個 app table 做兩階段 `SELECT md5(string_agg(row_hash, '|' ORDER BY <pk>)) FROM (SELECT <pk>, md5(t.*::text) AS row_hash FROM <table> t) sub`（`<pk>` 依 schema 真實 PK：多數表 `id`、sync_state→`resource`、bot_user_state→`telegram_user_id`），Zeabur vs Coolify 應完全相同
- [ ] **PG version + pgvector extversion** 比對 source vs target 一致
- [ ] **Drizzle migration history 表 row** 完整搬遷（決定生產 migration 模式：drizzle-kit migrate vs push）
- [ ] `cc_memory_search` 同 query 在 cutover 前後 top-5 結果完全一樣（順序也一樣）
- [ ] `cc_memory_stats` 回的總筆數一致

### Rollback 可用
- [ ] `~/.claude.json.bak-cutover-<timestamp>` 存在（cutover 前自動 backup，**mode 600**，30 天後刪/rotate）
- [ ] Zeabur PG service 仍 running（沒停）
- [ ] DROP DATABASE cc_memory_project 步驟可一行回退（含 force terminate active connections）

---

## Out of Scope（明確排除）

- claude-mem 資料 import（v0.4 波 6 才做）
- v0.4 任何 schema 改動（cutover 完才動）
- Zeabur 下線（Step F，獨立 track）
- 第二台 cc-memory project entry 安裝（user 沒這需求）

---

## References

- `~/.claude/projects/-home-haha-CC-project-CC-memory/memory/deployment-zeabur-prod.md` — Zeabur 部署狀態（cutover 後要更新加 Coolify migration entry）
- `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md` — 「forced personal 用獨立 DB」的決策依據
- `docs/superpowers/specs/2026-04-22-auto-capture-design.md` — v0.4 spec（依本 cutover 完成）
- `docs/superpowers/plans/2026-04-23-v04-phase-c-implementation.md` — v0.4 plan（含 Task 1.4 的 drift 要改）
- `~/.ccm-personal-url` — Coolify SSH tunnel connection string（personal db）
- `~/.claude/rules/sdd-workflow.md` — 三檔同步紀律
