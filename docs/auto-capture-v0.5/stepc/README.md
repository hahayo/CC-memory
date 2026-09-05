# Step C：Step B 殘餘列的「同 session 多 rollup」合併（2026-09-05 已執行）

Step B（`../stepb/`）搬完 578 列後剩 1,112 列 needs_human。本步把其中類 (1)「新 id 已有 active rollup」與類 (2)「表內自撞」共 33 個 session 合併進目標 rollup；類 (3) 只有目錄名證據、類 (4) transcript 已刪，依使用者裁決不動。spool 舊 backlog 亦決定不動（盤點見 `PROPOSAL.md` §B）。

## 執行紀錄
- 2026-09-05 14:09:36Z（22:09 +08）單一交易 COMMIT：33 session、44 rollup（41 archived＋merged_into、3 存活者改 key）、843 observations 改 project_id＋rollup_memory_id；`plan-2026-09-05.applied.json`。
- 事後（唯讀）：崩塌 obs 1,055→212、崩塌 active rollup 13（類 3 的 8＋類 4 的 5）、cross_project_fk=0、dup active keys=0、無 active obs 指向 archived rollup；`--check-state`＝AFTER-STATE。

## 合併規則（Codex R1→R4 收斂，原文 `codex-r*-out.md`）
- 目的專案先從對照表固定；只在該專案下找完整鍵 `capture:v05:<pid>:<sid>` 的 active rollup 當目標；同 session 在其他專案另有 rollup → skip。
- 類 2 無目標 → 存活者＝linked observations 最多 → created_at 最早 → id 最小，改 project_id／idempotency_key。
- 其餘舊 rollup：`status='archived'`、`merged_into=<目標>`，其他欄位（含 metadata）保留。
- observations：同一 UPDATE 改 `project_id`＋`rollup_memory_id`。
- 目標 `metadata.capture` 只補 `transcript_sources`（worker `normalizeTranscriptSources` 同構；這是 worker 的重放防線）與 `observation_ids`；`spool_offsets`／`summarize_count`／`discovery_tokens`／`summary`／`embedding`／`updated_at` 不動。

## 檔案
- `stepc-merge-build.py`：唯讀產計畫（對照表 skip 列決定哪些列；DB 唯讀查現況寫進計畫）。
- `stepc-merge-apply.py`：`--preflight`（唯讀）／`--execute`（flock 內單一交易：`LOCK TABLE … SHARE ROW EXCLUSIVE` → 身分（db＋system_identifier）→ 崩塌集合相等（不分 status）→ 目標鍵衝突 → 每列 WHERE 含完整 before-state（含 `metadata->'capture'`）ROW_COUNT=1 → postcheck → COMMIT）／`--rollback`（三個拒絕條件：計畫外 obs 指向目標、目標 updated_at > executed_at、目標 capture ≠ 計畫後狀態）／`--check-state`（唯讀、容錯：判 BEFORE／AFTER／NEITHER／IDENTITY MISMATCH）。送交易前寫 `.executing.json`，只有拿到 `committed|yes` 才換成 `.applied.json`（原子替換）；沒拿到一律保留標記交 `--check-state`。
- `stepc-run.sh`：`flock -w 120` 持 worker 同一把鎖 → 核准計畫存 `snapshots/`（chmod 400）→ 重建 → 結構比對（session／目標／被合併集合／obs 集合）不同即拒絕 → preflight → execute；`--dry-run` 只到 preflight；pgrep 只認 `scripts/(run-auto-capture|drain-capture-backlog).ts`。
- `stepc-rehearsal.sh`＋fixture＋remap：本機測試 PG 11 情境（happy＋rollback、竄改列、目標／來源漂移、writer 介入拒回滾、目標劫持、鍵衝突預檢、executing 標記、COMMIT 後出錯、applied.json 損壞、驅動外層路徑）。
- `spool-inventory-v2.py`：spool 逐來源盤點（all_present／all_missing／no_path 互斥）。
- `PROPOSAL.md`：給使用者的選項與決定；`plan-2026-09-05.jsonl`：執行時的計畫（含每列 before-state，回滾／人工反向依據）。

## 執行契約
執行與回滾窗內不得手動啟動 `run-auto-capture`／`drain-capture-backlog`（可繞過 worker 的鎖），不得對兩張表下臨時 SQL。結果不明（有 `.executing.json` 無 `.applied.json`）先 `--check-state`，不重跑。

## 未動、留人工
類 (3) 7 session／106 列（候選 AI_Copilot×5、recycling-recognition×2）；類 (4) 3 session／119 列（recycling-recognition-tender-pmo，551de309 有 tender-pmo 與 specs 兩候選）。spool：9,266 個無 transcript_path 的檔、695 個 transcript 已刪、2,667 個 transcript 仍在（約 23,000 LLM 窗口）——皆不動。
