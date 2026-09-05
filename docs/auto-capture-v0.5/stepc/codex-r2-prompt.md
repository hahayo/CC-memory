# CC-memory Step C 合併工具 R2 審查（唯讀審查：可讀檔、不得改檔、不得連正式 DB；本機測試 PG 5438 也不要動）

你上一輪（R1，原文 `codex-r1-out.md`，同目錄）對提案回 REQUEST-CHANGES，8 項 finding。我逐項處置如下，並把提案 A 落成工具＋彩排。請審**工具本身**的正確性、原子性、與 worker 的競態、回滾契約，以及我對 R1 的處置是否站得住。

工作目錄：`~/.cache/cc-memory/stepc-2026-09-05/`
- `stepc-merge-build.py`：唯讀產計畫（對照表 skip 列決定「哪些列」，DB 唯讀查「現況」寫進計畫）
- `stepc-merge-apply.py`：`--preflight`（唯讀）／`--execute`（flock 內單一交易）／`--rollback`（單一交易＋三個拒絕條件）
- `stepc-run.sh`：flock 內「重建計畫 → preflight → execute」驅動（避免 build 與 execute 之間過期）
- `stepc-rehearsal.sh`＋`stepc-rehearsal-fixture.sql`＋`stepc-rehearsal-remap.jsonl`：本機測試 PG 四情境彩排，**已 PASSED（28 assert）**
- `plan-2026-09-05.jsonl`：對正式 DB 唯讀產出的計畫（33 session：類 1×30、類 2×3；44 個 rollup、843 筆 observations）；`plan-2026-09-05.preflight.preflight.sql` 是唯讀 preflight 產物，正式 DB 上 PREFLIGHT OK（collapsed set 1,112 相等、rows_not_matching_before_state=0、目標鍵衝突 0）
- 參考：Step B 工具 `~/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py`、worker `~/CC_project/CC-memory/src/services/capture-worker.ts`（`transcriptSourceCovered` 1216、`normalizeTranscriptSources` 1194、寫入 1478–1590）

## R1 處置
1. **High 合併口徑**：採納修正版 a。目標 `metadata.capture` 只改兩欄：`transcript_sources`（依 `normalizeTranscriptSources` 同構規則：過濾 end<=start、依 (path_hash,start,end) 排序、同 path 相鄰／重疊合併）與 `observation_ids`（目標原有＋被合併者，去重保序）。`spool_offsets`／`summarize_count`／`discovery_tokens`／`summary`／`embedding` 不動。被合併 rollup 的原 metadata 完整留在 archived 列上（只改 status／merged_into）。
2. **High 內容雜湊**：採納為範圍聲明——「零碰撞」只代表本次搬移不撞既有唯一鍵；transcript_sources 防線是主要重放防線（第 1 項）。不重算雜湊。
3. **High 類 (4) 歸屬證據**：採納。預設不納入（`--include-class4` 才納入且僅單一候選者），交使用者裁決；551de309（兩候選）永遠 skip。
4. **High 回滾契約**：採納。`--rollback` 交易內三個拒絕條件：(a) 指向目標的 observation 不在「計畫列 ∪ 目標原有 linked（build 時記錄）」內；(b) 目標 `updated_at > executed_at`；(c) 目標 `metadata.capture ≠ 計畫後狀態`。任一成立 → RAISE、DB 不變、交人工。反向恢復用計畫記錄的真實舊值（`old_merged_into`、`old_status`、`capture_before`），不假定清空。
5. **Medium 殘餘集合**：採納。集合檢查用「所有 status」的崩塌列 (table,id) 集合，execute 前＝對照表 skip 列 1,112；execute 後＝前集合 − 搬走的 observations − 改 key 的存活者（archived 但保留舊 project_id 的 rollup 仍在集合內）；postcheck 另驗每 session：目標 linked obs 數、archived merged 數、FK=0、dup keys=0。目標檢查含 project_id、完整 idempotency_key、status、且 `metadata->'capture'` 與 build 時相等（WHERE 條件，ROW_COUNT≠1 → 整筆 ROLLBACK）。
6–7. **B1 隔離／copy-live**：暫緩，不做工具。原因：重新逐來源盤點後，原「9,961 個 transcript 已刪」其實是 **9,266 個 Codex ephemeral 的 sentinel-only 檔（38 bytes：`{"transcript_path":"","hwm_offset":0}`，worker 遇到只 skip＋推進 cursor）＋ 695 個真正 transcript 已刪**；總量 13.6 MB、對 worker 無害，隔離收益低於你指出的風險。這部分改為只給使用者「留著／不動」的建議。
8. **Medium 存活者與盤點**：存活者規則改為「linked observations 最多 → created_at 最早 → id 最小」（不用 transcript_sources.start）。盤點已重做（`spool-inventory-v2.py`，分類互斥：all_present 2,667／all_missing 695／no_path 9,266，合計 12,628）。

## 執行方式（Step C，尚未執行，等使用者「執行」）
`bash stepc-run.sh <remap> <plan>`：`flock -w 120` 持 worker 同一把鎖 → build（唯讀）→ preflight（唯讀）→ execute（`STEPC_LOCK_INHERITED=1` 跳過自取鎖；交易：`LOCK TABLE project_memories, observations IN SHARE ROW EXCLUSIVE MODE` → 身分（current_database＋system_identifier）→ 集合相等 → 目標鍵衝突 → 每 session 的 UPDATE 每條 ROW_COUNT=1 → postcheck → COMMIT）。COMMIT 後寫 `<plan>.applied.json`。

## 請你回答
1. 工具的 SQL／守衛有沒有讓交易「部分成功」或「錯列被改」的漏洞？（特別看：`jsonb_set(metadata,'{capture}',…)` 是否會丟掉 capture 以外的 key；`IS NOT DISTINCT FROM` 對 jsonb 的語意；VALUES 清單很長時的行為；DO 區塊內 RAISE 是否一定讓 psql 在 ON_ERROR_STOP 下不送 COMMIT。）
2. 與 worker 的競態：flock＋LOCK TABLE 之外，還有哪個寫入路徑能在交易期間或 build→execute 之間改動目標列而不被 ROW_COUNT 守衛抓到？
3. 回滾三條件是否足夠？有沒有「條件都不成立但反向仍會弄壞資料」的情形？
4. 你對 R1 各項處置有無異議？特別是第 3 項（類 4 交使用者）與第 6–7 項（不做隔離）。
5. 如果你認為提問者連問題都問錯了、或關鍵資料根本沒被蒐集，直接說。
輸出：每項 finding 標 severity＋檔案:行號＋建議；最後一行 `verdict: APPROVE | APPROVE-WITH-FIXES | REQUEST-CHANGES`。用繁體中文。
