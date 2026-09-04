結論：v3 已解掉單一交易、執行期競態、阻斷式 postcheck（執行後檢查）與分鐘級資料漂移。仍有 2 High＋2 Medium；都可小改完成。

1. High／[stepb-apply.py:105](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:105>)、[stepb-apply.py:315](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:315>)、[stepb-apply.py:329](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:329>)、[stepb-apply.py:372](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:372>)

   問題：DB identity（資料庫身分）只記錄，沒有真正驗證。交易只要求 `current_database()='cc_memory_project'`；位址、port（連接埠）與 postmaster 啟動時間只寫進 `applied.json`，rollback（回滾）也未比對。若 `~/.ccm-project-url` 誤指另一套同名 DB，所有資料檢查只要碰巧成立，就會修改錯誤實例。

   建議：交易內同時精確驗證 `pg_control_system().system_identifier`。既有證據是 `7656209034643652651`，見 [t5-result.txt:59](</home/haha/.cache/cc-memory/stepb-2026-09-03/t5-result.txt:59>)。把它寫入 `applied.json`，rollback 再比對。這比 postmaster 啟動時間穩定。

2. High／[stepb-run.sh:11](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-run.sh:11>)、[stepb-run.sh:25](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-run.sh:25>)、[stepb-run.sh:31](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-run.sh:31>)

   問題：driver（驅動腳本）執行呼叫者指定的 `$BUILDER_WT/.scratch/stepb-build-remap.ts`，並載入該 worktree（工作樹）的 repo 程式碼，但沒有綁路徑、HEAD 或 SHA-256。交易檢查只能證明資料庫狀態一致，不能判斷 `new_project_id` 是否由錯版 builder（產生器）算錯。

   目前離線核對結果正常：兩份 builder SHA-256 都是 `905194f01eb4779a9f4a217cb9b3a99004ea6853e6157b00a2ec399d33ccfe06`；builder worktree HEAD 是 `1b337c59daf20cc7880f72ad05a880efa3c1fcc5`。但腳本沒有強制這些前提。

   建議：執行前 fail-closed（條件不符立即停止）驗證：

   - `$BUILDER_WT` 的 realpath、HEAD、tracked files（已追蹤檔案）乾淨。
   - `.scratch/stepb-build-remap.ts` SHA-256 等於已審版本。
   - `$TABLE_WT` 是乾淨的 `feature/stepb-remap-table`，起始 HEAD 符合預期。
   - commit 後，Git blob（版本庫物件）SHA-256 等於實際要執行的 `$MAP`。

3. Medium／[stepb-apply.py:274](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:274>)、[stepb-apply.py:361](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:361>)、[stepb-apply.py:365](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:365>)

   問題：若伺服器已完成 `COMMIT`，但連線在回傳結果或最後的 `committed|yes` 前中斷，程式會宣稱 `DB unchanged`。實際狀態是 indeterminate（無法判定），且 `applied.json` 尚未寫入。

   集合檢查通常會阻止再次執行，因此不會重複修改；但錯誤訊息可能導致錯誤復原決策。

   建議：缺少 `committed|yes` 時改報 `COMMIT OUTCOME INDETERMINATE`，禁止直接重試。先以唯讀查詢判定完整 before-state（執行前狀態）或 after-state（執行後狀態）；混合狀態則人工處理。

4. Medium／[stepb-apply.py:182](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:182>)、[stepb-apply.py:196](</home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py:196>)

   問題：「沒有任何 writer（寫入者）碰過」的描述過寬。現有檢查能覆蓋已知 worker：新增 observation，或以 `updated_at=NOW()` 更新 rollup。若有人用臨時 SQL 修改內容但不更新 `updated_at`，自動 rollback 不會察覺。

   建議：把保證明確限縮為「目前已知的應用程式 writer」，並把「rollback 判斷窗內禁止臨時 SQL writer」列為操作前提。若要覆蓋任意 writer，需保存列指紋或 `xmin` 證據；本晚不必擴成這個方案。

六項處置判定：

- R2b #1 單一交易：已解；只剩 finding 3 的 commit 回覆不確定性。
- R2b #2 rollback：對題目明示的 worker／MCP 路徑已解；任意 SQL writer 僅部分解。
- R2b #3 集合、TOCTOU（檢查與使用時間差）、目標衝突：已解；DB identity 尚未解完。
- R2b #4 阻斷式 postcheck：已解。
- R2b #5 其他 DB writer：執行交易期間已解。
- 新增的分鐘級過期：DB 競態已解；builder 版本來源尚未綁定。

框架判定：writer 介入後拒絕自動 rollback 是正確設計。forward execute（正向執行）可以無人值守，因為它是單一交易且提交前驗證全部 invariant（不變條件）。但 writer 恢復後，「人工反向」不能理解成直接倒跑對照表；必須先處理後來新增的 observation 與 rollup metadata（中繼資料）。如果「隨時一鍵 rollback」是硬性需求，就不應讓 writer 在人工驗證完成前恢復。

鎖評估：`SHARE ROW EXCLUSIVE` 會阻擋兩表的 `INSERT`／`UPDATE`／`DELETE`，但不阻擋一般 `SELECT`。既有 writer 會讓 migration（資料遷移）最多等 30 秒；migration 持鎖時，新寫入會排隊。repo 的 PostgreSQL client（客戶端）沒有設定 statement timeout（陳述逾時），所以通常會等待後繼續；外部呼叫端若有較短 deadline（期限），該次 MCP 寫入可能報錯並需重試，但不會造成部分遷移。`SET LOCAL lock_timeout='30s'` 合理。正式環境 `<2 秒` 仍是尚未驗證的估計；更新 indexed `project_id` 會產生索引維護，建議在低流量窗執行。

`stepb-run.sh` 前仍須：完成上述 fixes、重讀最新 committed backup manifest 並確認 `<26h`、確認沒有臨時 SQL writer、保存執行輸出。第 41–42 行所稱「毫秒空窗」不精確，因 `stepb-apply.py` 會先跑 preflight 才取 flock；但交易內會重新檢查，所以不是安全阻擋項。

本輪總結：只讀審查；未連正式 DB、未改檔。已核對 v3 腳本、三情境彩排、正式 preflight、schema、worker 寫入路徑、Git 分支及對照表 SHA-256。

verdict: APPROVE-WITH-FIXES（必做：綁定 builder/worktree 與 committed map；交易內驗證正式 DB `system_identifier` 並於 rollback 重驗；commit 結果不明時禁止重試、改走唯讀判定；限縮自動 rollback 的 writer 保證範圍）