# T1 Step B：既有崩塌列 project_id 重歸屬（2026-09-03）

對照表：`../remap-2026-09-03.jsonl`（最終版，2026-09-03 20:37 於 flock 內重建並執行；1,690 列＝action=`update` 578 列（543 obs＋35 rollup，已 COMMIT）、`skip` 1,112 列（1,055 obs＋57 rollup））。
工作目錄（執行時的 journal／SQL 產物都落在這裡）：`~/.cache/cc-memory/stepb-2026-09-03/`。

## 檔案
- `stepb-list.sql`：唯讀擷取崩塌列（`project_id LIKE '\_%'`），輸出 `stepb-rows.jsonl`、`stepb-all-rollups.jsonl`。
- `stepb-build-remap.ts`：依 spool 的 `transcript_path` → transcript 第一個 `cwd` → `resolveProjectId` 產對照表；要在 repo worktree 內跑（`DATABASE_URL=<假 DSN> npx tsx …`）。
- `stepb-apply.py`（v3，Codex R2b 後改寫）：`--preflight`（唯讀：DB 身分、崩塌集合雙向相等、每列現況、目標唯一鍵、跨 project FK）／`--execute`（worker 同一把 flock 內、**單一交易**：`LOCK TABLE … SHARE ROW EXCLUSIVE` → 交易內重做集合相等＋目標鍵衝突檢查 → 逐條 UPDATE 每條 ROW_COUNT=1 → 交易內 postcheck → COMMIT；任一不符整筆 ROLLBACK）／`--rollback`（同樣單一交易；worker 在 execute 後寫了指向搬動 rollup 的新列、或更新過搬動的 rollup → **拒絕自動回滾**，改靠本對照表人工反向）。正式模式只讀 `~/.ccm-project-url`，`current_database()` 必須精確 = `cc_memory_project`。COMMIT 後寫 `<stem>.applied.json`（sha256／DB 身分／executed_at）。
- `stepb-run.sh`：對照表分鐘級過期（Step A 上線後 worker 持續替同 session 建新 rollup），所以在 flock 內一口氣「重新擷取→重建→preflight→本地 commit→execute」。
- `stepb-rehearsal.sh`（＋fixture／remap）：本機測試 PG 三情境彩排（happy path＋rollback、竄改列 → 整筆 ROLLBACK、writer 介入 → 拒絕自動回滾）。
- `ro-psql.sh`：唯讀 psql 殼。`precheck-newrows.sql`：Step A 上線後新列是否還崩塌。

## 回滾
```bash
cd ~/.cache/cc-memory/stepb-2026-09-03 && python3 stepb-apply.py remap-2026-09-03.jsonl --rollback
```
只在「execute 後沒有任何 worker tick 碰過搬動的 rollup」時會成功（通常是幾分鐘內）；之後工具會拒絕，需依本對照表人工反向（每列的 old_project_id／old_idempotency_key 都在表內）。

## 本版不做的事（留人工）
- 同 session 在新 id 已有 active rollup 者（30 個 session：38 個 rollup＋747 筆 observations）：不 archive、不 repoint，需先定義 metadata 合併規則。
- 表內自撞（同 session 被舊 hook 拆在多個崩塌 id 下，3 個 session：6 個 rollup＋96 筆 observations）：合併後會撞 rollup 唯一鍵，同上需合併規則。**此過濾在 Codex R2c 之後才加，未經 Codex 審（只會把列改成 needs_human，不會新增 update）。**
- 只有 encoded-dir 證據者（7 個 session：8 個 rollup＋98 筆 observations）：目錄名編碼不可逆，需人工核准候選 id。
- transcript 已刪且目錄名對不到者（3 個 session：5 個 rollup＋114 筆 observations，皆屬已刪除的 recycling-recognition-tender-pmo）。

沿革與 Codex 對審：`../memory-ops-cutover.md` §4.1；R2／R2b／R2c 原文在本目錄 `codex-r2-out.md`、`codex-r2b-out.md`、`codex-r2c-out.md`；執行紀錄 `remap-2026-09-03.applied.json`、`stepb-run-2034{30,710}.txt`。
