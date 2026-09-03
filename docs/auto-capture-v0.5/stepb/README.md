# T1 Step B：既有崩塌列 project_id 重歸屬（2026-09-03）

對照表：`../remap-2026-09-03.jsonl`（1,690 列；action=`update` 959 列、`skip` 731 列）。
工作目錄（執行時的 journal／SQL 產物都落在這裡）：`~/.cache/cc-memory/stepb-2026-09-03/`。

## 檔案
- `stepb-list.sql`：唯讀擷取崩塌列（`project_id LIKE '\_%'`），輸出 `stepb-rows.jsonl`、`stepb-all-rollups.jsonl`。
- `stepb-build-remap.ts`：依 spool 的 `transcript_path` → transcript 第一個 `cwd` → `resolveProjectId` 產對照表；要在 repo worktree 內跑（`DATABASE_URL=<假 DSN> npx tsx …`）。
- `stepb-apply.py`：`--preflight`（唯讀）／`--execute`（先 preflight，全過才在 worker 同一把 flock 內逐批單一交易套用，每批 COMMIT 後寫 journal）／`--rollback`（只回滾 journal 記錄已 COMMIT 的批次）。正式模式只讀 `~/.ccm-project-url`。
- `stepb-rehearsal.sh`（＋fixture／remap）：本機測試 PG 兩情境彩排（happy path、第 2 批故障注入）。
- `ro-psql.sh`：唯讀 psql 殼。`precheck-newrows.sql`：Step A 上線後新列是否還崩塌。

## 回滾
```bash
cd ~/.cache/cc-memory/stepb-2026-09-03 && python3 stepb-apply.py remap-2026-09-03.jsonl --rollback
```

## 本版不做的事（留人工）
- 同 session 在新 id 已有 active rollup 者（27 個 rollup＋479 筆 observations）：不 archive、不 repoint，需先定義 metadata 合併規則。
- 只有 encoded-dir 證據者（7 個 session、106 列）：目錄名編碼不可逆，需人工核准候選 id。
- transcript 已刪且目錄名對不到者（119 列、3 個 session，皆屬已刪除的 recycling-recognition-tender-pmo）。

沿革與 Codex 對審：`../memory-ops-cutover.md` §4.1；R2／R2b 原文在工作目錄 `codex-r2-out.md`、`codex-r2b-out.md`。
