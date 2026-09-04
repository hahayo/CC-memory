結論：R2 的 #2、#3、#8、#9 尚未完全解決；#1 的資料已更新，但執行工具仍沒有完整覆蓋檢查。現在仍不應執行 `--execute`。

1. Critical — 檔案 journal（套用日誌）仍不能保證部分成功可回滾

檔案：[stepb-apply.py:204](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:204>)、[stepb-apply.py:211](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:211>)、[stepb-rehearsal.sh:57](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal.sh:57>)

問題：

- DB `COMMIT` 在第 204 行完成。
- `committed_batches` 更新及 journal 寫入要到第 211–215 行才發生。
- 若程序、主機或檔案系統在兩者之間中止，DB 已提交，但 journal 沒記錄。`--rollback` 會漏掉該批。
- 回滾也有對稱問題：DB 已回滾一批，但程序在 journal 移除批號前中止；下次回滾會因來源狀態已不是新值而在 preflight（執行前檢查）中止，剩餘批次不能自動繼續。
- `write_text()` 是截斷後重寫，沒有 atomic rename（原子改名）或 `fsync`（強制落盤）。中止時 journal 也可能成為無法解析的半份 JSON。
- 彩排情境 2 沒走 `main()` 的正式流程；它直接呼叫 `batch_sql()`，並在迴圈結束後一次寫 journal，因此沒有測到上述崩潰視窗。

建議：959 筆更新改成單一 DB transaction（交易），多個 ≤500 的 `DO` 區塊共用一次 `BEGIN`／`COMMIT`。若必須分批提交，batch 狀態必須在同一個 DB transaction 內寫入持久化 migration journal（資料遷移日誌）；不能用提交後才寫的本機檔案作唯一真相。

2. Critical — rollback（回滾）會破壞 execute 後新增的合法 worker 資料

檔案：[stepb-apply.py:47](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:47>)、[stepb-apply.py:111](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:111>)、[capture-worker.ts:1304](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1304)、[capture-worker.ts:1391](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1391)、[capture-worker.ts:1532](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1532)

具體交錯：

1. `--execute` 把 rollup R 從舊 project 改成新 project，然後釋放 flock（檔案鎖）。
2. worker 用新 project/key 找到 R。
3. worker 新增 observation N：`N.project_id=new`、`N.rollup_memory_id=R`。
4. worker by-id 更新 R。
5. `--rollback` 只處理 journal 內舊列，把 R 改回舊 project；N 不在對照表，所以保持新 project。
6. 結果是 `N.project_id=new → R.project_id=old` 的跨 project FK（外鍵）關聯。

目前 rollback preflight 只預測對照表內 observation；不會檢查 journal 外、後來新增的 N。第 184–185 行甚至把 rollback 前的 `cross_project_fk_now` 當純資訊。當時它仍會是 0，所以 preflight 會通過。

此外，「差異只在 summary／metadata」這個前提不正確。`updateRollup()` 還會改：

- `keywords`
- `decisions`
- `next_steps`
- `embedding`
- `content_hash`
- `writer_host`
- `updated_at`

其中 `content_hash` 由新 project ID 計算。即使該次 window 沒產生 observation，回滾後仍會留下「舊 project/key＋新 project 計算內容」的混合 rollup。

建議：二選一：

- 在 rollback 決策窗結束前持續隔離所有 writer（寫入者）；或
- rollback 前計算整個 DB 的預測後狀態。若有 journal 外 observation 指向將被移回舊 project 的 rollup，必須拒絕自動回滾，另行 repoint／拆分 rollup。

所以我不同意第 3 題所述狀態可直接視為可接受。

3. High — preflight 沒有證明完整集合與正式 DB 身分

檔案：[stepb-apply.py:79](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:79>)、[stepb-apply.py:142](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:142>)、[stepb-apply.py:175](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:175>)、[stepb-apply.py:186](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:186>)

問題：

- preflight 只接收 `actionable(rows)`，即 959 筆 update。它不驗證 731 筆 skip，也不找 DB 中未列入 JSONL 的新增崩塌列。
- 因此 `*_state_mismatch=0` 只代表「表內 actionable 列符合」，不能證明「DB 崩塌集合正好等於 1,690 列」。
- preflight 在取得 flock 前執行。檢查與鎖定之間仍有 TOCTOU（檢查與使用時間差）。
- DB 身分只查 `current_database()`；沒有驗證 host、port 或 canonical production identity（標準正式環境身分）。
- 第 186 行使用 `startswith(expected_db)`，所以 `cc_memory_project_copy` 也會被接受，與「名稱必須是 `cc_memory_project`」的描述不符。

我離線核對了目前 JSONL：1,690 列、無重複 `(table,id)`、959 筆 update 必要欄位完整，907 筆 observation 的目標 project 都與其 52 個被移動 rollup 一致。這只能證明目前檔案內部一致，不能取代執行當下的完整 DB 檢查。

建議：取得 flock 後重跑最終 preflight，要求：

- DB 中完整崩塌 ID 集合與 1,690 筆 map 完全相等；
- DB 名使用精確相等；
- 驗證 canonical host／port／database identity；
- journal 綁定 DB identity、remap SHA-256 與 batch 規格。

4. High — postcheck（執行後檢查）是 fail-open（檢查失敗仍回成功）

檔案：[stepb-apply.py:217](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:217>)

問題：程式取得 `code, out` 後只列印內容，隨即 `return 0`。以下狀況都會回成功：

- postcheck SQL 執行失敗；
- `cross_project_fk_now > 0`；
- execute 後殘餘數不是 observations 691／project_memories 40；
- 必要輸出鍵缺失。

而且 postcheck 在 `with open(... flock ...)` 區塊外，檢查時鎖已經釋放。

建議：在仍持鎖時檢查 return code、必要鍵與精確預期值。任何不符必須非零結束，並明確指示進入 rollback／人工復原流程。若改成單一 transaction，關鍵 invariant（不變條件）應在 `COMMIT` 前檢查。

5. High — flock 足以排除該 systemd worker，但沒有排除其他 DB writer

檔案：[stepb-apply.py:193](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:193>)、[refine.ts:72](/home/haha/CC_project/worktrees/ccm-remap/src/services/refine.ts:72)、[memories.ts:236](/home/haha/CC_project/worktrees/ccm-remap/src/services/memories.ts:236)、[memories.ts:1048](/home/haha/CC_project/worktrees/ccm-remap/src/services/memories.ts:1048)

對第 2 題的直接答案：若前提是「唯一可能的同時寫入者就是該 systemd worker，而且所有啟動方式都取得同一 inode 的 flock」，則這把鎖足以保護 forward execute（正向執行）。不存在 worker 穿過鎖、與 migration 同時交易的交錯序列。

但 repo 還有 MCP 寫入路徑，可新增或 archive（封存）同兩張表；它們不取得這把 flock。例如 PM 批次提交後，MCP 依新 project archive 該 rollup，後續 observation 批次仍可能成功，而 rollback 的 `status='active'` 守衛將無法命中。

建議：執行前明確確認 migration 時段沒有其他 MCP／腳本 writer。較可靠的做法是單一 transaction 加適當 table lock（資料表鎖），允許讀取但阻擋兩張表的其他寫入。

R2 九項處置判定：

- #1：資料重建已解；工具的完整集合 gate（驗收關卡）未解。
- #2：未解。
- #3：正向 worker 競態已解；execute 後 rollback 競態未解。
- #4：已解。
- #5：已解。
- #6：已解。
- #7：已解。
- #8：部分解；DB 身分與 postcheck 仍不足。
- #9：一般 happy/批次失敗斷言已補；沒有測真正的 commit→journal crash window，因此未完全解。

`--execute` 前還必須：

- 修正上述 Critical 項目。
- 執行當下重新確認兩份 committed backup manifest 仍小於 26 小時。
- 在持鎖狀態重跑完整集合 preflight。
- 明確隔離或盤點所有 DB writer。
- 固定並記錄 remap SHA-256；目前檔案為 `f9907534b3b73cdb90db973ced50a2c6eec26c5a40b3495b9d94a0712fe5c6d`。
- 將 postcheck 改成真正的阻斷式驗收。

本輪總結：完成只讀審查，未修改檔案。主要阻斷是 journal 非原子、介入寫入後無法安全回滾、完整集合／DB 身分未受 gate 保護，以及 postcheck 失敗仍回成功。

verdict: REQUEST-CHANGES