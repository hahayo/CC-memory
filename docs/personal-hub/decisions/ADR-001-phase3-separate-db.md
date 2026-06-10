# ADR-001 — Phase 3 隔離策略：RLS → 獨立 Personal DB（翻案）

> Status：Accepted（2026-06-09）
>
> 改動規模：Personal-Hub Phase 3 整段重寫；spec.md Non-goals「個人資料用獨立資料庫」條目翻案（翻轉為 Goals）；plan.md / task.md Phase 3 章節重寫。
>
> Cascade：本 ADR 為 SSOT；spec.md / plan.md / task.md 引用本檔。

---

## Context

Personal-Hub Phase 0/1/2 已交付（Zeabur prod，397 tests 綠）。Phase 3「終極硬隔離」原規劃靠 PostgreSQL Row-Level Security（RLS） — 在共用 DB 上加 role（`personal_rw` / `project_rw_non_personal` / `admin`）+ row policy，讓 raw postgres / shell 拿到 `DATABASE_URL` 也無法跨界讀寫。

### 為什麼這次翻案

**Threat model 的真實對手**不是「應用 client 寫錯 query」，而是「任何持 `DATABASE_URL` 的 process」（raw postgres MCP、psql、其他 MCP server、被入侵的工具）。在共用 DB 內擋對手，靠的是「DB 內部規則」這層；這層在我們的部署條件下無法做硬。

**Codex 對審（plan review round 1）指出 5 個 RLS 弱點**，五點全成立：

| 弱點 | 細節 |
|---|---|
| Table owner / superuser 預設 BYPASSRLS | Postgres `BYPASSRLS` attribute 預設給 table owner；migration / admin 連線本來就是 owner，policy 對其失效 |
| `FORCE ROW LEVEL SECURITY` 漏寫即靜默故障 | 不顯式 `FORCE`，owner connection 跑 query 不會被 policy 過濾；review 階段不會報錯 |
| `USING` vs `WITH CHECK` 必須兩邊都寫 | 漏寫 `WITH CHECK` 仍可寫入錯 row；測試只測讀容易漏 |
| 多表/多 policy 攻擊面寬 | `project_memories` / `tasks` / `reminder_log` 各自一組 policy；任何一張表 / 一條 policy 漏寫=外洩破口 |
| 共用 DB 無物理邊界 | DB 內部規則一旦繞過（owner / superuser / role 設定漂），個人 row 與專案 row 同在一張表，沒有「打不到」的物理屏障 |

### 為什麼獨立 personal DB 解這個 threat model

把 raw postgres MCP / shell / 其他工具能拿到的 `DATABASE_URL` **本身**就只連到 project DB；個人資料**根本不在那個 DB**。隔離不靠 DB 內部規則，靠**秘密分隔**（secret partitioning）+ **物理分隔**（不同 database）。對手要看到個人資料，必須拿到 `DATABASE_URL_PERSONAL`，而那個 secret 只配給 hermes / forced-mode personal instance / admin。攻擊面從「N 條 policy × M 張表 × O 個 role」收斂成「一個 secret 的配發控制」。

---

## Decision

**翻案 Personal-Hub Phase 3：從共用 DB + RLS 改成獨立 personal DB。**

- 開新 PostgreSQL service `cc-memory-personal`（Zeabur，與 project DB 同 region 降延遲）。
- 連線字串記為 `DATABASE_URL_PERSONAL`；只配給：
  - **forced-mode personal instance**（hermes / `/hi` / Claude Code 個人 namespace 使用者）
  - **admin / migration instance**（短期 maintenance，不在 long-running services 中）
- project DB 的 `DATABASE_URL` **不變**；project-mode instance 仍照舊。
- ScopePolicy（應用層）保留；新架構下它仍是「同一 process 內」的 scope 決策，邊界不變、語意不變。
- 一 process 一 scope 一 DB：單一 cc-memory MCP process 不做 request-level 切換 DB；跨 scope 起兩個 process，各持自己的 URL。

### Deployment topology

| Instance 類型 | env 配置 | 連接 DB |
|---|---|---|
| `project-mode` 一般 instance（Claude Code 預設、code review agents 等）| **只**配 `DATABASE_URL`（project DB）<br>**禁止**配 `DATABASE_URL_PERSONAL` | project DB |
| `forced-mode personal` instance（hermes / Claude Code forced personal）| `DATABASE_URL_PERSONAL` + `CC_FORCE_PROJECT_ID=__personal__` | personal DB |
| `forced-mode personal + read-only` instance（`/hi` 注入）| 上一行 + `CC_READ_ONLY=1` | personal DB（只讀） |
| `admin / migration` instance | 同時持有兩個 URL，僅 maintenance 用，不在 long-running services 中 | 兩邊都連 |

啟動期 fail-fast：
- forced-mode personal 缺 `DATABASE_URL_PERSONAL` → exit
- project-mode instance 偵測到 `DATABASE_URL_PERSONAL` 存在 → warn + 拒絕載入 personal URL（防誤配）
- `CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID` 同設 → exit（既有）

---

## Alternatives Considered

| 方案 | 取捨 |
|---|---|
| **RLS（原方案）** | 對「應用 client 寫錯 query」夠用，但對 threat model 真實對手（owner / superuser / 漂掉的 role 設定）會靜默失效。複雜度高、policy 攻擊面寬。 |
| **獨立 schema（同 DB）** | 仍共用 DB user 範圍，secret 邊界沒分；對 owner connection 同樣失效。等於弱版 RLS。 |
| **獨立 DB（採納）** | 物理隔離、secret 分隔；對 threat model 直球回應。代價：app-side merge 才能做「跨 project + personal 一起搜」（目前 spec 無此需求）；要多顧一個 backup / monitoring。 |
| **應用層加密 personal payload** | 不解問題：metadata（project_id、time、count）仍可看到；對 search/embedding 不友善。 |

---

## Consequences

### 正面
- Threat model 對手降級為「需要 personal DB URL secret」這一道；不再依賴 DB 內部規則。
- 隔離邏輯極簡：一個 connection string、一個 boolean fail-fast；無 N 條 policy 要維護。
- migration / admin 路徑與 prod 隔離：admin 短期持兩 URL，不會誤把 personal 寫進 project DB 或反之。
- 未來如需要更強隔離（不同 cloud / 不同 region），物理切分已就位。

### 負面與緩解
| 後果 | 緩解 |
|---|---|
| 「跨 project + personal 一起搜」要 app-side merge | 目前 spec 無此需求；列為 Future Work，不在本 ADR 範圍 |
| 多一個 DB 要 backup / monitor | runbook 寫明 backup / restore 步驟；personal DB 量遠小於 project DB，成本 OK |
| 部署多一道 env 矩陣（誰持哪個 URL） | fail-fast 在 `src/config.ts` 啟動期擋；topology 文件化於本 ADR deployment topology 表 + plan.md instance 拓樸表（注：`.env*` 在使用者 harness denylist，topology 註解未寫入 `.env.example`，但 SSOT 已涵蓋） |
| 翻譯遷移有風險（複製 + 刪除原 row） | A2.6 maintenance window + preflight 三 mode（pre-migration / post-copy / post-delete）+ row count + checksum + dry-run + rollback |
| CHECK constraint `project_id='__personal__'` 不能放共用 schema.ts | 放 personal-DB-only migration（`sql/migrations/0007_personal_db_check_constraint.sql`）；runbook 註明「只在 personal DB 套用」 |

---

## 影響範圍

### 翻案文字（A2 開工前先 commit，作為 SSOT）

| 檔 | 動作 |
|---|---|
| `docs/personal-hub/spec.md` | Non-goals「個人資料用獨立資料庫」條目翻案；Goal 7 改寫；US-P3-1 改寫；Phase 3 章節重寫；change log v0.4 |
| `docs/personal-hub/plan.md` | Architecture 圖 Phase 3 註解改；instance 拓樸新增 `DATABASE_URL_PERSONAL` 欄；Phase 3 設計章節重寫；Rollout Order Phase 3 表重寫；Risks 表 RLS 條目改成獨立 DB；OQ #6 結案 |
| `docs/personal-hub/task.md` | Phase 3 章節重寫（3a → preflight 三 mode、3b → 獨立 DB + migration + maintenance window）；Gate 改 |
| `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md` | 本檔 |

### prod 上線 `[x]` 勾打的時機

A2.7 端對端驗收全綠 + rollback rehearsal 通過後才打勾；翻案文字本身不打勾。

---

## 補記（2026-06-10，Phase 3 code review 修復 cascade）

### Delete script 設計（P0 修復：LOCK TABLE + tx 內 checksum）

原 runbook「DELETE 後從另一終端跑 preflight post-delete、PASS 才 COMMIT」在 MVCC（多版本並行控制）下**結構性失效**——其他連線看不到未 COMMIT 的刪除，閘門恆 PASS。改為 `scripts/delete-personal-data.ts`：單一 tx 內 `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE`（擋漏停的 writer，消滅「DELETE 後、COMMIT 前插入新個人列」的 race）→ lock 後重計數 → copied 三表 checksum 與 personal DB 精確比對（count 相等不代表內容一致；最後不可逆關口不依賴「人工有跑過 post-copy」）→ DELETE → 同 tx 驗證（DELETE count == 計數、個人列歸零）→ COMMIT + manifest；任一不符自動 ROLLBACK + exit 1。preflight post-delete 降級為 COMMIT 後最終確認。

### search_feedback：只刪不搬（delete-only）

`search_feedback` 無 `project_id` 欄（`query_project_id` 可 NULL、`result_project_ids` 為 array），一般 inventory 探勘抓不到，必須 special-case。拍板 **privacy 優先**：個人列（`query_project_id='__personal__'`）與混合列（`query_project_id IS NULL AND '__personal__'=ANY(result_project_ids)`）一併從 project DB 刪除、**不搬**到 personal DB——接受個人 retrieval telemetry 損失。`bot_user_state` 維持不遷不刪（user-level state）；既有 `active_project_id='__personal__'` 列的處置見 handback runbook Step 5。

### 0008 反向 CHECK（雙向 DB 層保證）

project DB 在 delete COMMIT 後套 `sql/migrations/0008_project_db_no_personal_check.sql`：`project_memories` / `tasks` CHECK `project_id <> '__personal__'`、`search_feedback` CHECK 兩 arm（query 端 + result array 端）。與 0007（personal DB 只准 personal）**互為鏡像**——漏改 env、舊 client 寫錯邊、或任何回流路徑在 DB 層被拒，不只靠應用層 ScopePolicy。`bot_user_state` 不加（user-level state 合法持有 personal 標記）。

### Advisory probe 直連前提

`assertDistinctDatabasesLive`（`src/db/identity.ts`）的 transaction-level advisory lock probe（`pg_advisory_xact_lock` 隨機 pair；lock tag 含 database OID，同 cluster 不同 database 不衝突）假設**直連或 session pooling**；pgbouncer transaction pooling 下語意不保證——admin 遷移工具鏈一律直連 DB。

---

## References

- [plan.md ## Rollout Order](../plan.md)（Phase 3 章節）
- [spec.md ## Non-goals](../spec.md)（「個人資料用獨立資料庫」條目翻案，已翻轉為 Goals）
- [task.md ## Phase 3](../task.md)
- Codex plan review round 1：14 條 finding 全採納（單輪結束），對應修正點散落於各 Sprint 內 `[CR#N]` 標記
- Codex Phase 3 debate round 1：RLS 5 大弱點論證
