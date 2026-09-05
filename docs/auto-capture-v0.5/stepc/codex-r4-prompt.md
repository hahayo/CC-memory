# CC-memory Step C R4（收斂確認；唯讀審查：可讀檔、不改檔、不連正式 DB、不動本機 5438）

你 R3（`codex-r4-prompt.md` 同目錄的 `codex-r3-out.md`）判 4 項 closed、第 2 項 open，另列 High／Medium 兩個必要修正。修正如下，請只判定這兩項是否 closed，以及修法有無新問題；其他已 closed 項不必重審。

1. **High 任意 ERROR 誤刪 executing 標記**：`stepc-merge-apply.py` 改為**沒有拿到 `committed|yes` 就一律保留 `.executing.json`**（不論有無 ERROR）；訊息分兩種：「ERROR 出現在 pre-COMMIT 標記（`executed_at`）之前，很可能已回滾但未證明，標記保留」／「COMMIT OUTCOME INDETERMINATE」，兩者都指示跑 `--check-state`。彩排 scenario 9 用 rehearsal 專用 env `STEPC_REHEARSAL_FAIL_AFTER_COMMIT=1`（正式模式偵測到即 refuse）在 COMMIT 後插入 `SELECT 1/0` 實測：回報 INDETERMINATE、標記保留、無 applied.json、`stepc-run.sh` 拒絕重建、`--check-state` 判 AFTER-STATE、人工依標記補 applied.json（executed_at 取標記 started_at，比真值早 → 回滾的 updated_at 檢查只會更嚴）後 `--rollback` 成功回到原狀。
2. **Medium 完成紀錄損壞**：`applied.json` 改 tmp＋`os.replace` 原子寫入；`--check-state` 不再依賴可解析的 applied.json（損壞時印 `CORRUPT — <err>` 並照常查詢）；check-state 改用「容錯」preflight（集合檢查回傳 `collapsed_db_only`／`collapsed_map_only` 計數而非 RAISE，六個必要計數缺項列在 `_missing_counts`），並印 `VERDICT: BEFORE-STATE / AFTER-STATE / NEITHER`。`--execute`／`--rollback` 遇到損壞 applied.json 一律 refuse。彩排 scenario 10（截斷的 applied.json）與 scenario 6（漂移狀態下 check-state 回 NEITHER 且六個計數齊全）。
3. 你另提的：`PROPOSAL.md` 已補「執行期間不得手動啟動 run-auto-capture／drain、不得臨時 SQL；結果不明先 --check-state 不重跑」契約；`pgrep` 只當輔助，契約才是保證（已在提案講明）。

彩排 `stepc-rehearsal.sh` 10 情境全 PASSED。正式 DB 唯讀 preflight 以修後工具重跑仍全 0（`plan-2026-09-05.preflight.preflight.sql`）。

請回答：R3 兩項 closed／open？新問題？最後一行 `verdict: APPROVE | APPROVE-WITH-FIXES | REQUEST-CHANGES`。繁體中文。
