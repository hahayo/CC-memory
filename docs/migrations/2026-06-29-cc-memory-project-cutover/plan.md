# cc-memory project DB Cutover — Plan

> ⚠️ **STATUS: SUPERSEDED-IN-PART (2026-06-30)** — Actual runbook (實際執行藍本) is [`addendum-2026-06-30-plan-b.md`](./addendum-2026-06-30-plan-b.md).
>
> **History**：Plan A (dump+restore) 於 2026-06-30 Phase 0 discovery 後切到 **Plan B (drizzle-kit push from `src/db/schema.ts`)**。Zeabur project mode DB 從沒實質寫過資料 → dump/restore 無意義。
>
> **本檔角色**：reference anchor，保留 Codex 6 輪對審決策歷程。**不是 actual runbook**。
>
> **SUPERSEDED 區塊（精細到 clause 條款）**：
> - `### Phase 2 — Zeabur dump (5-10 min)` — 整段 SKIP，無資料可 dump
> - `### Phase 3 — Coolify restore + 全表一致驗證 (15-25 min)` — 整段 SKIP；replace by addendum 新增的 **Phase 1.5 (drizzle-kit push)** + **Phase 1.5b (補 0008 per-DB CHECK constraint，每資料庫範圍檢查約束)** + **Phase 1.6 (schema verify，結構驗證)**
> - `## Files Impact` > `### 新增` 內「`/tmp/.../zeabur-cc-memory-dump-<timestamp>.sql`（**dump 檔**，scratchpad）」 — Plan B 不產 dump artifact (轉儲產物)，這條 file impact 不會發生
> - `## Verification Matrix` — 跟 checksum (校驗碼) / row count / drift gate (漂移檢查關卡) 相關的列 unapplicable；只保留 schema completeness (結構完整性) / functional check (功能檢查) 列
> - `## Timeline Estimate` — Plan A 估 60-80 min；Plan B 實際估 35-45 min（見 addendum 估時表）
> - `## Open Questions / needs_human` — Q1（Zeabur dump 工具）/ Q2（pgvector binary format (二進位格式) 跨版本相容性）已 unapplicable
>
> **仍 active 區塊（Plan B 照跑）**：Goal / Architecture / Files Impact 之 `### 新增`（不含已 supersede 的 dump 檔項目）+ `### 修改` + `### 不動` + `### 後續觸發` / Phase 0 (Pre-flight) / Phase 1 (CREATE DATABASE + pgvector) / Phase 4 (Switch over wrapper) / Phase 5 (Restart + Verify) / Phase 6 (Mark deprecated) / Rollback Path / Dependencies & Unblocks / References。**新增 Phase 1.5 / 1.5b / 1.6** 見 addendum，取代原 Phase 2/3。
>
> **Cross-ref**：[addendum 全文](./addendum-2026-06-30-plan-b.md)，特別是「Plan B 步驟」（取代 Phase 2/3）+「Plan B 估時」+「仍保留的核心驗證」三節。

---

**Source of truth**：`./spec.md`
**Task breakdown**：`./task.md`
**狀態**：Draft（待 user review）

---

## Goal

> ⚠️ **SUPERSEDED by Plan B (addendum)** — 本段為 Plan A 目標（資料搬遷 + query 等價）。Plan B 改為「Coolify 端建立同名 `cc_memory_project` DB + drizzle-kit push fresh schema + 套 0008 per-DB CHECK constraint + 切換 wrapper，**無資料搬遷**」，預期 `cc_memory_stats` 回 0 筆 + `cc_memory_search` 回 empty (空集)。Plan B 不要求 query 行為跟 Zeabur 一致。詳見 [`addendum-2026-06-30-plan-b.md`](./addendum-2026-06-30-plan-b.md)。

把 cc-memory project DB 從 Zeabur (`43.153.156.125:30156/zeabur`) 搬到 Coolify 同 PG service 內新 database `cc_memory_project`，本機 `~/.claude.json` `cc-memory` MCP entry 切換 connection string，零資料遺失、零 query 行為差異。

---

## Architecture

```
Before
──────
┌─────────────────────┐                  ┌──────────────────────────┐
│ ~/.claude.json      │                  │ Zeabur PG cluster        │
│  mcpServers:        │                  │  43.153.156.125:30156    │
│  • cc-memory        │ ──direct──────▶ │   db=zeabur              │
│      DATABASE_URL=  │                  │   user=root              │
│      zeabur://...   │                  │   (project_memories ...) │
│  • cc-memory-       │                  └──────────────────────────┘
│    personal         │
│      → wrapper      │                  ┌──────────────────────────┐
│      → SSH tunnel   │ ──autossh────▶ │ Coolify PG service       │
│        127.0.0.1:   │   127.0.0.1:    │   (Personal Hub already)  │
│        15432        │   15432         │   db=cc_memory_personal   │
└─────────────────────┘                  │   user=cc_memory          │
                                         └──────────────────────────┘

After (wrapper convention 統一)
──────────────────────────────
┌──────────────────────────┐                ┌──────────────────────────┐
│ ~/.claude.json           │                │ Zeabur PG cluster        │
│  mcpServers:             │                │  (deprecated, read-only) │
│  • cc-memory             │  (no link)     │   db=zeabur              │
│      command=/home/haha/ │                │   ⚠ NOT in use           │
│      run-cc-memory-      │                │     until Step F wipes   │
│      project.sh ⭐        │                └──────────────────────────┘
│      env={} (空, 無 DB    │
│      secret 落 .claude.   │                ┌──────────────────────────┐
│      json)                │                │ Coolify PG service       │
│  • cc-memory-personal    │                │   db=cc_memory_personal  │
│      command=/home/haha/ │                │   db=cc_memory_project ⭐ │
│      run-cc-memory-      │ ──autossh────▶│   user=cc_memory          │
│      personal.sh         │   127.0.0.1:   │                          │
│                          │   15432        └──────────────────────────┘
│  wrapper 讀:              │
│   ~/.ccm-project-url ⭐    │
│   ~/.ccm-personal-url    │
│  (mode 600, 獨立檔)        │
└──────────────────────────┘
```

---

## Files Impact

### 新增

- `docs/migrations/2026-06-29-cc-memory-project-cutover/spec.md`（已建）
- `docs/migrations/2026-06-29-cc-memory-project-cutover/plan.md`（本檔）
- `docs/migrations/2026-06-29-cc-memory-project-cutover/task.md`（next）
- **`~/run-cc-memory-project.sh`**（NEW，wrapper script，mode 755，跟 `~/run-cc-memory-personal.sh` 對稱結構）
- `~/.ccm-project-url`（NEW，project DB connection string，mode 600；wrapper 讀取的 URL 來源）
- `/tmp/.../zeabur-cc-memory-dump-<timestamp>.sql`（dump 檔，scratchpad）

### 修改

- `~/.claude.json` `cc-memory` entry **結構性改動**（Secret Delivery 決策 = wrapper 路徑）：
  - `command`: `node` → `/home/haha/run-cc-memory-project.sh`
  - `args`: `["build/index.js"]` → `[]`
  - `env.DATABASE_URL`: **刪除**（DB secret 不再落 `.claude.json`，移到 `~/.ccm-project-url`）
  - `env.GEMINI_API_KEY`: **保留**（wrapper 讀取，rotation 由獨立 task #3 處理）
  - **必先 backup**：`~/.claude.json.bak-cutover-<timestamp>`（mode 600，30 天後刪/rotate）

### 不動（明確列出避免誤改）

- `~/run-cc-memory-personal.sh` / `~/run-cc-memory-personal-ro.sh`（personal hub wrapper，跟 project DB 無關）
- `~/.ccm-personal-url`（personal hub 連線字串，跟 project DB 無關）
- `~/.ssh/cc-memory-coolify`（第二台 SSH key，跟本機 cutover 無關）
- 第二台 `~/.claude.json`（第二台沒有 cc-memory project entry，不需動）
- `~/.bashrc` autossh guard（tunnel 設定共用，無需改）
- Coolify Dashboard 上 application / service 設定（不動 deployed app）

### 後續觸發（不在本 cutover scope，但會被本 cutover 解鎖）

- `docs/superpowers/plans/2026-04-23-v04-phase-c-implementation.md` Task 1.4 / 1.11 + 開頭 Tech Stack 內 `Zeabur` 字樣 → Coolify（v0.4 波 0 處理）
- `docs/superpowers/specs/2026-04-22-auto-capture-design.md` 開頭 status block（v0.4 波 0 處理）

---

## Phases

> 詳細 atomic task 在 `task.md`，本節是 phase-level overview。

### Phase 0 — Pre-flight（10 min）

- 確認 autossh tunnel 活著
- 確認 Coolify PG 接受連線
- 抽 `cc_memory` PG user CREATEDB 權限（決定後續用 `cc_memory` user 或 root user 跑 CREATE DATABASE）
- 抓 Zeabur connection string from `~/.claude.json`
- **NEW**：比對 source / target `SELECT version()`、`pg_extension.extversion` for `vector`（Codex Risk：version skew 會讓 embedding 排序不同）
- **NEW**：確認 prod 之前是 `drizzle-kit migrate` 還是 `push`（決定 cutover 後 migration history 表怎麼處理）

### Phase 1 — Coolify 建新 database（5-10 min）

- 視 Phase 0 結果用 `cc_memory` user 或 root user 連 Coolify
- `CREATE DATABASE cc_memory_project OWNER cc_memory`
- 確認新 database 內 `\dt` 空表

### Phase 2 — Zeabur dump（5-10 min）

- `pg_dump` Zeabur `zeabur` DB 到本機 scratchpad（含 schema + data + extensions）
- 驗 dump 檔大小、內容含 `project_memories`、`search_feedback` 等預期表

### Phase 3 — Coolify restore + 全表一致驗證（15-25 min）

- `psql` 讀 dump 灌進 `cc_memory_project`（用 `set -euo pipefail` 包，檢查 psql exit code，避免被 pipe 吞錯誤）
- **全表 row count**: 每個 app table（project_memories / tasks / search_feedback / reminder_log / reminder_delivery_queue / sync_state / bot_user_state / drizzle.__drizzle_migrations）Zeabur vs Coolify 一致
- **每表 ordered checksum（兩階段 + per-table PK，避 OOM）**: `SELECT md5(string_agg(row_hash, '|' ORDER BY <pk>)) FROM (SELECT <pk>, md5(t.*::text) AS row_hash FROM <table> t) sub`。`<pk>` 依 schema 真實 PK：多數表 `id`，`sync_state` → `resource`，`bot_user_state` → `telegram_user_id`（Codex round 4 cascade fix）。先 per-row hash（32 chars/row）再 aggregate，避免單表全 text > 1GB（Codex round 2）
- **schema-aware drift gate**: 對比 Task 2.4 baseline；每表用真實 timestamp 欄位：`project_memories/tasks/sync_state/bot_user_state` → `updated_at`；`search_feedback/reminder_delivery_queue` → `created_at`；`reminder_log` → `fired_at`（Codex round 3 fix）；無 timestamp 表用 `COUNT(*)`。baseline 跟 current 必須相等。違反 = cutover 期間有寫入，需重 dump
- PG version + pgvector extversion 比對

### Phase 4 — 寫 wrapper + Switch over `~/.claude.json`（10-15 min）

- **Triple drift gate**（Phase 3.6 restore 後 + Task 4.0 Phase 4 開頭 + Task 4.3.5 switch 前最後一刻）：三次 gate 都跑全表 schema-aware drift loop（per-table timestamp 欄位），合在一起涵蓋 dump → switch 整段時間的 race window（Codex round 4+5 強化）
- backup `~/.claude.json` → `~/.claude.json.bak-cutover-<ts>`（**mode 600**）
- 寫 `~/.ccm-project-url`（從 `~/.ccm-personal-url` 替換 db name 產生，mode 600）
- **NEW：寫 `~/run-cc-memory-project.sh` wrapper**（mode 755，跟 `~/run-cc-memory-personal.sh` 結構對稱，讀 `~/.ccm-project-url` + 讀 `.claude.json` cc-memory entry 的 GEMINI_API_KEY + exec node build/index.js）
- 改 `~/.claude.json` cc-memory entry：`command` → wrapper path，`args` → `[]`，**刪掉 env.DATABASE_URL**（DB secret 不再落 `.claude.json`）
- ⚠️ 改完當下 Claude Code MCP server 還連舊的（cached），不影響運作

### Phase 5 — Restart + Verify（10 min）

- 提醒 user 重啟 Claude Code session（讓 cc-memory MCP 重 spawn 讀新 URL）
- user 跑 `cc_memory_stats` / `cc_memory_search` / `cc_memory_list` 驗 query 結果跟 Phase 3 抽樣一致

### Phase 6 — Mark Zeabur deprecated（5 min）

- 不停 Zeabur PG service（Step F 才做）
- 更新 memory `deployment-zeabur-prod.md` 加 cutover entry（含 dump 檔路徑、cutover 完成 timestamp）
- `~/.claude.json.bak-cutover-<ts>` 保留 30 天（含舊 Zeabur URL）

---

## Rollback Path

任一 Phase 失敗或 verify fail，依嚴重度反向回退：

| 失敗 Phase | Rollback 動作 | 時間 |
|---|---|---|
| 0 (pre-flight) | 無 side-effect，直接 abort | 0 |
| 1 (create db) | `DROP DATABASE cc_memory_project` | < 1 min |
| 2 (dump) | 刪 dump 檔 (Zeabur 純 read，無 side-effect) | < 1 min |
| 3 (restore/inventory diff fail) | 先 force-disconnect active connections（`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cc_memory_project'`），再 `DROP DATABASE cc_memory_project`，重 Phase 1-3 | 3-5 min |
| 4 (switch) | `cp ~/.claude.json.bak-cutover-<ts> ~/.claude.json`（restore command 結構即可，env.DATABASE_URL 也會跟著 restore），**新建檔不必刪**（`~/run-cc-memory-project.sh` / `~/.ccm-project-url` 留著也 OK，下次重試直接覆寫） | 2 min |
| 5 (verify fail) | 同 Phase 4 rollback + 重啟 Claude Code（user 操作）| 3-5 min |
| 6 (deprecation marking) | 純文件，不需 rollback | — |

**最壞情況回到 cutover 前狀態**：**5-10 min**（含 active connection cleanup、Claude Code 重啟、人為操作 buffer）。原文「< 5 min」低估了，已校正（Codex 對審）。

**Drift gate fail 處理**：任一 drift gate（Phase 3.6 / Task 4.0 / Task 4.3.5；schema-aware 每表用真實 timestamp 欄位）fail 表示 cutover 期間有寫入或讀（cc_memory_search 寫 search_feedback log）造成 Zeabur drift（違反 cc-memory 全停紀律）→ rollback Phase 3 + 重 dump + 重 restore，且確認後續 cutover 期間嚴守全停紀律。

---

## Verification Matrix

> ⚠️ **SUPERSEDED-IN-PART by Plan B (addendum)** — 下表內所有 **Phase 2 / Phase 3** row（Dump 檔合理 / 全表 row count / 每表 ordered checksum / Schema-aware triple drift gate / `pgvector extversion` 兩端比對 / Drizzle migration mode 兩端比對）+ **Phase 5 內「同 Zeabur 結果」/「Top-5 search 順序一致」** row，在 Plan B 下 unapplicable (不適用)。Plan B 的 verify 清單見 [addendum](./addendum-2026-06-30-plan-b.md) 內「仍保留的核心驗證」+ `task.md` 新增 Phase 1.5b（套 0008）/ Phase 1.6（驗 3 個 `*_no_personal_check` constraint）。Phase 0 / 1 / 4 / 5 內 schema completeness + functional check + wrapper 結構對稱 + `.claude.json` 結構 + MCP 連通 row 仍 active。

| 驗證項 | 命令 / 方法 | 預期 | 階段 |
|---|---|---|---|
| Tunnel alive | `ss -tln \| grep 15432` | listen | Phase 0 |
| Zeabur 可讀 | `psql "<zeabur>" -c "SELECT 1"` | 1 | Phase 0 |
| Coolify 可寫 | `psql "$(cat ~/.ccm-personal-url)" -c "SELECT 1"` | 1 | Phase 0 |
| `cc_memory` user CREATEDB | `SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user` | `t` or `f` | Phase 0 |
| **PG version** | source vs target `SELECT version()` | major version 一致 | Phase 0 |
| **pgvector extversion** | source vs target `SELECT extversion FROM pg_extension WHERE extname='vector'` | 完全一致 | Phase 0 |
| **Drizzle migration mode** | 確認 prod 是 `drizzle-kit migrate` 還是 `push` | 已知 | Phase 0 |
| 新 db 存在 | `SELECT 1 FROM pg_database WHERE datname='cc_memory_project'` | 1 | Phase 1 |
| Dump 檔合理 | `wc -l <dump.sql>` + 對所有 app tables grep `CREATE TABLE` / `COPY` | non-zero + 每表 ≥1 | Phase 2 |
| **全表 row count** | 每表 `SELECT COUNT(*)` Zeabur vs Coolify（覆蓋 project_memories / tasks / search_feedback / reminder_log / reminder_delivery_queue / sync_state / bot_user_state / drizzle.__drizzle_migrations）| 全表兩值相等 | Phase 3 |
| **每表 ordered checksum**（OOM-safe + per-table PK） | 兩階段：`SELECT md5(string_agg(row_hash, '\|' ORDER BY <pk>)) FROM (SELECT <pk>, md5(t.*::text) AS row_hash FROM <table> t) sub`。多數表 `<pk>=id`；`sync_state`→`resource`、`bot_user_state`→`telegram_user_id`（Codex round 4） | 全表 hash 一致 | Phase 3 |
| **Schema-aware triple drift gate** (write/read freeze 守住) | dump 完抓 baseline，每表用真實 timestamp 欄位：`updated_at`（project_memories/tasks/sync_state/bot_user_state）；`created_at`（search_feedback/reminder_delivery_queue）；`fired_at`（reminder_log）；無 timestamp 用 `COUNT(*)`。**Phase 3.6（restore 後）+ Task 4.0（Phase 4 開頭）+ Task 4.3.5（switch 前最後一刻）三次 gate 都不變**（Codex round 5 cascade fix） | 三次 gate 都不變 | Phase 3 + 4 |
| `.claude.json` 改對 | `python3 inspect_db_routes.py` → cc-memory `command` = wrapper path, `env.DATABASE_URL` 不存在 | 顯示新結構 | Phase 4 |
| **新 wrapper 存在 + 對稱** | `ls -la ~/run-cc-memory-project.sh` mode 755 + `diff` 結構 vs personal wrapper | 存在 + 結構對稱 | Phase 4 |
| MCP query 正常（重啟後）| `cc_memory_stats` / `cc_memory_search` / `cc_memory_list` 三個 tool 都回東西 | 同 Zeabur 結果 | Phase 5 |
| Top-5 search 順序一致 | 3-5 個慣用 query 跑 `cc_memory_search`，前後比對 top-5 順序 | 完全一致 | Phase 5 |

---

## Dependencies / Unblocks

### 本 cutover 依賴
- Coolify PG service `running:healthy`（已驗）
- autossh tunnel 活著（持續）
- `~/.ccm-personal-url` 可讀（已驗）
- 第一台 SSH key (id_ed25519) 仍能 forward port

### 本 cutover unblocks 後續
- v0.4 波 0：plan Task 1.4 / 1.11 文字 patch（cutover 後改 Coolify path）
- v0.4 波 1：M1 schema migration 可以 apply 到 Coolify `cc_memory_project`
- Step F：Zeabur 真下線（觀察期過 + Coolify cc-memory project 穩定 1-2 週後）

---

## Timeline Estimate

| Phase | 預估 | Notes |
|---|---|---|
| 0 | 10 min | Pre-flight + version 比對 + migration mode 確認（多 5 min） |
| 1 | 5-10 min | 視 Phase 0 結果決定用 cc_memory user 還 root |
| 2 | 5-10 min | Dump size 視 Zeabur 內既有資料量；推測 < 100 MB |
| 3 | 15-25 min | Restore + 全表 inventory diff + checksum + drift gate |
| 4 | 10 min | Switch + backup + 寫新 wrapper（額外動作） |
| 5 | 10 min | Restart + user verify（含 top-5 順序比對）|
| 6 | 5 min | Marking |
| **總計** | **60-80 min** | 連續 1-1.5 hr 不被打斷可完成（比原估稍長，含 Codex 對審強化驗證） |

---

## Open Questions / `needs_human`

> Phase 1 user 選擇（cc_memory user 沒 CREATEDB 權限時走 root path）—— task.md Task 0.4 自動分流
>
> URL 寫法（wrapper vs direct env）—— **已 resolved**：選 wrapper 路徑（spec.md §Secret Delivery Decision）

剩下需要 user 在開工時決定：

1. **Phase 6 timing**：cutover 完當下就更新 deployment memory？還是等 1 週 observation period 後再寫（避免太早宣告穩定）？
2. **Drizzle migration history 處理**：若 Phase 0 確認 prod 用 `drizzle-kit migrate`（有 history 表），cutover 後新 db 內的 history 表是「保留 Zeabur 既有歷史 row」還是「reset 從 Coolify 0 開始」？建議保留歷史以便回溯，但 v0.4 後新 migration 加進去時，會接著 Zeabur 最後一筆 migration ID 往下加（無衝突）—— 開工前 user 確認

---

## References

- `./spec.md` — 為什麼、目標、約束
- `./task.md` — TDD checklist (RED verify → GREEN op → VERIFY)
- `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md` — DB isolation 紀律
- `~/.claude/rules/sdd-workflow.md` — Phase 邊界紀律
