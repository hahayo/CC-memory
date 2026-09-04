結論：現在不可執行 UPDATE。正式 DB 在審查期間仍持續新增錯誤 `project_id` 列；現有對照表已過期。回滾與競態設計也有阻斷性缺口。

1. Critical（嚴重）— 對照表已落後正式 DB

檔案：[stepb-build-remap.ts:165](/home/haha/CC_project/worktrees/ccm-remap/.scratch/stepb-build-remap.ts:165)、[stepb-apply.py:87](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:87)

問題：對照表在 2026-09-03 06:41:39 +08 產生，涵蓋 1,561 筆 observation。正式 DB 唯讀查詢在 07:05:35 +08 已有 1,579 筆；相差 18 筆。審查期間數量由 1,572 → 1,574 → 1,579，證明仍有活動中的寫入。rollup 仍是 92 筆。

`stepb-apply.py` 只讀靜態 JSONL，不會發現新增列。執行後至少 18 筆仍留在崩塌 ID；數量還會繼續增加。

建議：先部署 Step A，確認新列使用正確 ID。再停止並防止 hook（掛鉤）重新啟動 worker（工作程序），等待執行中的 tick（處理輪次）結束，重新匯出正式 DB、重建對照表及重新審查。

2. Critical — `--rollback` 無法回復部分成功的執行

檔案：[stepb-apply.py:95](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:95)、[stepb-apply.py:107](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:107)、[stepb-apply.py:115](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:115)

問題：實際是四個各自提交的 transaction（交易），不是全體更新共用一個交易。唯讀 `--dry-run` 顯示：

```text
statements=1534 batches=4
500 + 500 + 500 + 34
```

若正向第 2 批失敗，第 1 批已提交。完整 `--rollback` 仍要求全部 1,534 列處於新狀態；它會在混合新舊狀態的批次發生 `ROW_COUNT mismatch`，不能還原已提交子集。

建議：優先改成一個外層交易，批次只用於分段產生 SQL，不在批次間 `COMMIT`。若必須分批提交，就要持久化每批與每列的套用狀態，並讓 rollback（回滾）只處理已成功子集。

3. Critical — 與 worker 並行會產生跨專案關聯及不可逆漂移

檔案：[capture-worker.ts:1217](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1217)、[capture-worker.ts:1297](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1297)、[capture-worker.ts:1403](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1403)、[capture-worker.ts:1441](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1441)、[capture-worker.ts:1546](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1546)

問題：

- (a) worker 先用舊 ID 找到 rollup，migration（資料遷移）再修改其 `project_id`。之後 `updateRollup` 仍會按 `id` 成功更新。它不會把 `project_id` 改回去，但會用遷移前讀到的 metadata（中繼資料）覆寫 rollup，並可能插入「舊 project 的 observation → 新 project 的 rollup」。
- 若舊 rollup 被 archive（封存），`updateRollup` 沒有 `status='active'` 守衛，仍會更新 archived 列。
- (b) 若 migration 先取得新 key，worker 的 INSERT 會撞條件式唯一索引並使 worker 交易失敗；若 worker 先提交，新 key UPDATE 會失敗並使該 migration 批次回滾。沒有靜默重複，但會造成批次部分成功與重試。
- (c) worker 只 INSERT observation。它在對照表建立後新增的列不會被 repoint（重新指向）。FK（外鍵）只檢查 rollup `id`，不檢查兩列的 `project_id` 相同。

正式 DB 目前跨 project 的既有 `rollup_memory_id` 關聯數是 0；這不代表並行執行安全。

建議：不能與 worker 並行。停止／遮罩 worker 與 hook kick，驗證沒有進行中的服務，再建立最終快照。單一交易內鎖定相關表或目標列。

4. High（高）— 漏了 observations 的唯一鍵衝突

檔案：[schema.ts:121](/home/haha/CC_project/worktrees/ccm-remap/src/db/schema.ts:121)、[stepb-build-remap.ts:11](/home/haha/CC_project/worktrees/ccm-remap/.scratch/stepb-build-remap.ts:11)、[stepb-build-remap.ts:149](/home/haha/CC_project/worktrees/ccm-remap/.scratch/stepb-build-remap.ts:149)

問題：`observations` 也有：

```text
(project_id, session_id, content_hash) WHERE status='active'
```

對照表沒有 `content_hash`，產生器只檢查 rollup 唯一鍵。Step A 上線或 transcript（對話紀錄）重播後，可能已存在相同新 project/session/content 的 observation；舊列的 `project_id` UPDATE 將撞唯一鍵。

本次唯讀查詢當下沒有現成 observation 衝突，但部署 Step A 後必須重查。

建議：對照表加入 `old_status`、`session_id`、`content_hash`。執行前分類新 project 下的 observation 衝突，明確決定保留、archive 或跳過；不可等 UPDATE 才靠唯一鍵使整批失敗。

5. High — archive 合併規則會遺失 canonical rollup（標準彙總列）的歷史

檔案：[stepb-build-remap.ts:136](/home/haha/CC_project/worktrees/ccm-remap/.scratch/stepb-build-remap.ts:136)、[stepb-apply.py:44](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:44)、[spec.md:292](/home/haha/CC_project/worktrees/ccm-remap/docs/auto-capture-v0.5/spec.md:292)、[capture-worker.ts:1442](/home/haha/CC_project/worktrees/ccm-remap/src/services/capture-worker.ts:1442)

問題：archive 分支只封存舊 rollup 並 repoint observations。它沒有合併：

- summary、keywords、decisions、next_steps、embedding
- `observation_ids`
- `spool_offsets`
- `transcript_sources`
- `summarize_count`
- `empty_observation_windows`
- `discovery_tokens`

影響：

- `cc_memory_search` 不再看 archived 舊 rollup，因此舊視窗的 rollup summary／關鍵字可能消失或排名改變；個別 observations 仍可能被搜尋到。
- `cc_memory_timeline` 依實際 `rollup_memory_id` 查詢，所以 repoint 後舊 observations 仍可從新 rollup 展開。
- recent activity（近期活動）也依實際 FK 即時計算；缺少 `metadata.capture.observation_ids` 本身不會破壞它。
- `transcript_sources` 缺失會破壞重播去重。worker 可能再次處理舊來源；因 observation hash 含 project ID，重播後甚至可能產生新重複列。
- `summarize_count` 與其他統計會低估。

目前正式對照表是 0 archive，因此這個漏洞尚未由本批觸發；但 Step A 上線後重新建表，很可能產生 archive 個案。

建議：archive 前合併 capture metadata 的集合與覆蓋區間，並明確處理摘要與 embedding。無法安全合併時，該 session 應跳過並人工裁決。

6. High — 實際守衛弱於題目描述

檔案：[stepb-apply.py:37](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:37)、[stepb-apply.py:44](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:44)、[stepb-apply.py:51](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:51)

問題：

- rollup `action=update` 沒有舊 `status` 守衛。
- rollup `action=archive` 沒有舊 `idempotency_key` 守衛。
- observation 沒有 `session_id`、`status`、`content_hash` 守衛。
- archive/repoint 沒驗證 `existing_new_rollup_id` 執行當下仍是相同 project、key、session 且 active。

ROW_COUNT 總數本身不會發生「一條 0、另一條 2」抵銷：每條 UPDATE 都用 primary key（主鍵）`id`，普通表中最多影響一列。因此總數等於預期，數學上代表每條都是 1。主要問題是守衛涵蓋不足，而不是總數相加。

建議：補齊快照欄位守衛，並在每條 UPDATE 後立即檢查 `n = 1`，以便指出具體失敗 ID。archive 前鎖定並驗證目標 canonical rollup。

7. High — `encoded-dir` 不是可單獨採信的身分證據

檔案：[stepb-build-remap.ts:50](/home/haha/CC_project/worktrees/ccm-remap/.scratch/stepb-build-remap.ts:50)、[stepb-build-remap.ts:54](/home/haha/CC_project/worktrees/ccm-remap/.scratch/stepb-build-remap.ts:54)、[stepb-build-remap.ts:73](/home/haha/CC_project/worktrees/ccm-remap/.scratch/stepb-build-remap.ts:73)

問題：兩種編碼都不可逆。

- 舊編碼把 `/`、`_`、`.`、空白、`-` 等都壓成 `-`。
- 新編碼仍無法區分路徑分隔符 `/` 與名稱裡原有的 `-`。
- 「唯一候選」只代表目前 `homedir`、深度 ≤6、未被 `SKIP` 排除、仍存在的目錄中只有一個。它不涵蓋已刪除、改名、掛載、symlink（符號連結）、更深層或被排除的歷史路徑。
- 若原始 cwd 已刪，另一個碰巧同編碼的現存路徑可能被誤認為唯一答案。
- 「同 session ≥2 project」只比較各 transcript 的第一個 cwd；不會偵測單一 transcript 內後續 cwd 改變。

本表有 91 列、共 5 個 session 完全依賴 `encoded-dir`。現存同目錄的其他 transcripts 可提供目錄層級佐證，但不能證明那 5 個已刪 transcript 的實際 cwd。

建議：這 5 個 session 必須人工核准，並至少增加第二種獨立證據：同目錄其他 transcript 的 cwd、spool 來源目錄、內容／files 與 repo 的吻合、當時 marker 或 Git（版本控制）身分。只靠 encoded-dir 不應自動 UPDATE。

8. High — `--dry-run` 不是 DB 預演，且正式 DSN 可被環境變數覆蓋

檔案：[stepb-apply.py:97](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:97)、[stepb-apply.py:103](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-apply.py:103)

問題：`--dry-run`（不落地試跑）完全不連 DB，只印第一條 SQL。它不驗證守衛、唯一鍵衝突、目標 rollup、schema（資料結構）、資料漂移或資料庫身分。

文件說 DSN 只用 `~/.ccm-project-url`，但實作會優先採用任意 `STEPB_DATABASE_URL`。殘留環境變數可能把正式執行導向錯誤 DB；目前只印 host，不拒絕錯誤 database name。

建議：新增真正的唯讀 preflight（執行前檢查），核對 database name、schema/index/FK、每列舊狀態、衝突數、跨 project FK、映射覆蓋率及 map checksum（校驗碼）。正式模式應拒絕 `STEPB_DATABASE_URL` 或要求明確的 production 確認值。

9. Medium（中）— 彩排沒有真正驗收所宣稱的性質

檔案：[stepb-rehearsal.sh:15](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-rehearsal.sh:15)、[stepb-rehearsal.sh:18](/tmp/claude-1000/-home-haha-CC-project-CC-memory/6d472c65-1b49-4a2e-b1c9-671d2202d2ba/scratchpad/stepb-rehearsal.sh:18)、[stepb-rehearsal.sh:21](/tmp/claude-1000/-home/haha/CC_project/worktrees/ccm-remap:1)

問題：彩排只有一批。驗證 SQL 只是列印結果，沒有 assertion（自動斷言）。第二次 execute 的 `|| echo` 會接受任何非零錯誤，不限定必須是 `ROW_COUNT mismatch`。它沒有覆蓋：

- 第 2/3/4 批失敗後的回滾
- worker 並行
- observation 唯一鍵衝突
- archive 後 metadata 合併
- execute 與 rollback 之間的新列

建議：補多批次故障注入、競態與狀態相等斷言。回滾驗收應比較完整受影響列快照，而不是人工看輸出。

UPDATE 前最低必要條件：

1. Step A 已 merge、部署，且新寫入 ID 已驗證正確。
2. worker 與所有 hook kick 已停止；確認沒有在途交易。
3. 建立可還原的正式 DB 備份，並保存受影響列的完整快照。
4. 重新匯出 DB 並重建對照表；人工核准 5 個 encoded-dir session。
5. 補 observation 衝突檢查與 archive metadata 合併規則。
6. 改為單一交易，或實作可靠的部分批次 journal（套用日誌）與子集回滾。
7. 跑真正的 DB preflight，要求每列恰好處於預期舊狀態。
8. 執行後驗證：預期只剩 119 個 skip、無跨 project FK、無新舊唯一鍵衝突，再恢復 worker。

本輪總結：完成只讀腳本、對照表、schema、worker、search/timeline 與正式 DB 查核；未修改任何檔案。正式 DB 已確認持續漂移，且目前方案不能保證完整回滾。

verdict: REQUEST-CHANGES