# CC-memory Step C 合併工具 R3（收斂輪；唯讀審查：可讀檔、不得改檔、不得連正式 DB、不動本機 5438）

你 R2（`codex-r2-out.md`）回 REQUEST-CHANGES 5 項。處置與修正如下；請逐項判定 closed／open，並看修法有沒有引入新問題。目錄 `~/.cache/cc-memory/stepc-2026-09-05/`。

1. **High 類 2 目標被劫**：採納。`stepc-merge-build.py` 改為先從對照表固定「目的專案」（類 1 的 `新 id X 已有 active rollup`／`existing_new_rollup_id`、類 2 的 `合併到 X 會撞`），只在該專案下找完整鍵 `capture:v05:<pid>:<sid>` 的 active rollup；同 session 若在**其他**專案還有 active rollup → 一律 skip（needs human）。類 4 因對照表無目的專案，只在 `--include-class4` 且既有 rollup 恰在一個專案時納入（開關＝使用者核准這條規則，已在提案文件講明）。類 1 另驗 `existing_new_rollup_id` 與 DB 目標一致。彩排 scenario 5 離線重現你的反例（對照表 AI_Copilot、DB 另有 Wrong 專案目標）→ builder skip，sess-c-1 仍指向對照表專案。
2. **High 提交後紀錄未落盤**：採納。`stepc-merge-apply.py --execute` 送交易前先寫 `<plan>.executing.json`（plan／remap sha、started_at）；伺服器明確 ROLLBACK 才刪；COMMIT 後寫 `applied.json` 再刪 executing。`--execute` 與 `stepc-run.sh` 見到 `executing.json` 或 `applied.json` 一律拒絕（不重建、不覆寫）。新增 `--check-state`（唯讀：同時跑正向與反向 preflight，印出各自的 rows_not_matching 等計數＋兩個標記檔存在與否）供人判定 before／after。驅動另在執行前把 plan／remap 複製到 `snapshots/plan.<ts>.jsonl`（`cp -n`＋chmod 400）。彩排 scenario 8。
3. **Medium 來源漂移／未持鎖入口**：採納。計畫為每個被合併 rollup 記 `capture_before`，正向與反向 UPDATE 的 WHERE 都加 `metadata->'capture' IS NOT DISTINCT FROM <capture_before/after>`（ROW_COUNT≠1 → 整筆 ROLLBACK）。驅動執行前 `pgrep -f 'run-auto-capture|drain-capture-backlog|capture-worker'` 有命中即拒絕。執行契約寫進提案：Step C 期間不得手動跑 run-auto-capture／drain。彩排 scenario 6。
   - 你提的「未持鎖程序先讀舊資料、等我們提交後才覆寫」：在 flock 下 systemd worker 整個 tick 都持鎖，驅動 `flock -w 120` 拿到鎖時沒有 worker 交易在途；殘餘風險只剩手動入口，用 pgrep＋契約擋。若你認為還不夠請說。
4. **Medium preflight 誤報**：採納。preflight 改用 `target_conflict_counts_sql` 回傳 `pm_target_key_conflict`／`ob_target_unique_conflict` 真實計數，Python 要求五個必要計數全為 `'0'`（缺任一即 FAIL）。彩排 scenario 7：插入佔用存活者新 key 的 rollup → preflight 回 `pm_target_key_conflict=1`、無 `PREFLIGHT OK`。
5. **Medium 盤點措辭**：採納。逐行驗證 9,266 個 no_path 檔：9,079 個 38 bytes 單行＋187 個多行，**每一行 transcript_path 都是空字串、無解析錯誤**。提案文件改寫為「不隔離的理由是收益證據不足，不是證明無害」。

彩排 `stepc-rehearsal.sh` 8 個情境全 PASSED。正式 DB 唯讀重建計畫：33 session（類 1×30、類 2×3）、44 rollup、843 observations；唯讀 preflight：collapsed_set_equal=0、rows_not_matching_before_state=0、pm_target_key_conflict=0、ob_target_unique_conflict=0、cross_project_fk_now=0（1,112 列 VALUES 清單在正式 DB 上跑完，效能無問題）。

## 請你回答
1. 五項各 closed／open？
2. 修法有沒有引入新問題（特別看 `--check-state`、executing 標記的生命週期、pgrep 樣式、builder 新的 skip 條件會不會誤殺正式資料的 33 個 session——正式計畫數字修前後相同）。
3. 還有沒有阻擋「等使用者說執行就跑 `stepc-run.sh`」的問題？
輸出：逐項 closed／open＋新 finding（severity＋檔案:行號）；最後一行 `verdict: APPROVE | APPROVE-WITH-FIXES | REQUEST-CHANGES`。用繁體中文。
