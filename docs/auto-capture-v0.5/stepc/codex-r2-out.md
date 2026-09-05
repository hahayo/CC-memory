**建議退回修訂。交易本身沒有看到部分提交漏洞；但工具仍可能選錯目標、漏掉來源漂移，並在提交後故障時丟失回復依據。**

以下依唯讀程式審查與離線反例判定。未連正式資料庫、未動本機 5438、未改檔；你提供的資料庫預檢與彩排結果未重跑。

1. **High（高）｜類 2 可能被同工作階段的其他專案目標劫走。**

   位置：[stepc-merge-build.py:143](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-build.py:143)、[165](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-build.py:165)。

   `targets` 收集所有非崩塌專案的有效彙總。只要有唯一候選，就直接採其 `project_id`；只有完全沒有候選時，才解析對照表的「合併到 X」。類 2 因此沒有驗證既有候選是否屬於原定專案。

   **已離線重現：**對照表指定 `Correct`，資料庫模擬結果只有 `Wrong` 的同工作階段目標，產出仍為 `action=merge, new_project_id=Wrong`。後續逐列守衛會接受這份錯誤計畫，因為它忠實記錄了錯誤目標的現況。

   **建議：**先解析並固定有來源證據的目的專案，再搜尋該專案的完整目標鍵。其他專案候選不得覆寫歸屬。類 1 也須實際驗證註解承諾的 `new_project_id`，不能只驗目標 ID。

2. **High（高）｜提交成功但紀錄未落盤後，驅動腳本可能覆寫唯一回復計畫。**

   位置：[stepc-merge-apply.py:423](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:423)、[stepc-run.sh:15](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-run.sh:15)、[stepc-merge-build.py:219](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-build.py:219)。

   可發生的順序：

   - 資料庫已提交。
   - 程序中斷或檔案寫入失敗，沒有 `.applied.json`。
   - 再跑驅動腳本，存在性檢查放行。
   - 重建計畫把已封存來源列改列為跳過，直接覆寫原計畫。

   此時不只自動回滾被拒，人工反向所需的舊連結與 `capture_before` 也可能消失。單一資料庫交易無法保護這段檔案生命週期。

   **建議：**執行前保存不可覆寫的計畫與對照表副本、雜湊及執行中紀錄。存在未完成執行紀錄時禁止重建覆寫，先唯讀辨認提交狀態。恢復指引也要修正：目前沒有獨立可呼叫的「反向 `--preflight`」模式，缺少 `.applied.json` 時 `--rollback` 會先退出。

3. **Medium（中）｜來源彙總的採集資料漂移，不會被逐列守衛抓到。**

   位置：[stepc-merge-build.py:192](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-build.py:192)、[stepc-merge-apply.py:135](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:135)。

   目標有比對 `capture_before`，但被合併來源只比對專案、鍵、狀態與 `merged_into`。若產計畫後，來源新增一個**沒有新增觀察列**的採集窗口，來源集合與這些欄位都不變。交易仍成功，目標卻缺少新增的來源覆蓋。

   正常共用 `flock`（程序互斥鎖）的背景程序會被驅動腳本擋住；但 [run-auto-capture.ts:49](/home/haha/CC_project/CC-memory/scripts/run-auto-capture.ts:49) 可直接呼叫處理程序，而處理程序明確依賴外層鎖，見 [capture-worker.ts:627](/home/haha/CC_project/CC-memory/src/services/capture-worker.ts:627)。因此不能宣稱所有入口都受保護。

   **建議：**保存並在交易內比對每個來源的完整採集資料；執行契約須明確禁止未持鎖入口。另須防止未持鎖程序先讀舊資料、等 Step C 提交後才覆寫：表鎖只能延後寫入，不能讓程式重新計算已讀取的內容。

4. **Medium（中）｜唯讀預檢會把真正的目標鍵衝突報成成功。**

   位置：[stepc-merge-apply.py:295](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:295)、[389](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:389)。

   預檢把 `RAISE EXCEPTION` 全部改成 `RAISE NOTICE`，但原函式最後仍無條件輸出：

   ```text
   in-txn precheck: target key conflicts pm=0 obs=0
   ```

   Python 又用這段文字判成功，沒有取得實際衝突數。因而即使衝突存在，也可能輸出 `PREFLIGHT OK`。

   **建議：**保留例外，或回傳實際計數並明確要求為零。交易內檢查仍會阻止提交，所以此項是預檢誤報，並非部分成功。

5. **Medium（中）｜盤點不能支持「全部 no_path 都是 sentinel-only、對 worker 無害」。**

   位置：[spool-inventory-v2.py:23](/home/haha/.cache/cc-memory/stepc-2026-09-05/spool-inventory-v2.py:23)。

   分類器只確認沒有讀到非空 `transcript_path`，並忽略解析與讀取錯誤；沒有验证每行都是指定的哨兵內容，也沒有證明來源是 Codex ephemeral（短暫工作階段）。

   唯讀統計 [盤點產物](/home/haha/.cache/cc-memory/stepc-2026-09-05/spool-inventory-2026-09-05.jsonl)：
   `no_path` 共 9,266 筆，其中 **9,079 筆為 38 位元組，187 筆不是**。

   **建議：**保留「不做隔離」的決策方向，但改寫理由為「暫無足夠收益證據，維持原狀」。若要宣稱全部無害，須補逐行內容及解析失敗分類。這不要求本次增加隔離工具。

你特別詢問的 SQL（結構化查詢語言）語意，判定如下：

- `jsonb_set(metadata,'{capture}',…)` 對物件型資料只替換 `capture`，**不會丟掉其他頂層鍵**；`capture_after()` 也先複製原採集資料，再改指定欄位。[官方說明](https://www.postgresql.org/docs/current/functions-json.html)
- `IS NOT DISTINCT FROM` 是處理空值的相等比較。對 `jsonb`（二進位 JSON）比較的是結構化值，不是原文字排列；物件鍵順序不影響相等，陣列順序仍有意義。SQL `NULL` 與 JSON `null` 不相同。[比較語意](https://www.postgresql.org/docs/current/functions-comparison.html)、[JSON 型別](https://www.postgresql.org/docs/current/datatype-json.html)
- 長 `VALUES` 清單不會自動分批提交或截斷後繼續成功；可能遇到資源或效能限制。這份正式規模的執行效能本輪**尚未驗證**。[官方限制提醒](https://www.postgresql.org/docs/current/sql-values.html)
- 現有 `DO` 沒有捕捉並吞掉例外；`ON_ERROR_STOP` 配合 `psql -f` 會停止後續命令，不送到尾端 `COMMIT`。連線退出時未提交交易回復。[psql 說明](https://www.postgresql.org/docs/current/app-psql.html)
- 取得兩表的 `SHARE ROW EXCLUSIVE` 鎖後，其他連線的正常新增、更新、刪除都必須等待，沒有一般應用程式寫入可以穿透；問題在取鎖前與釋鎖後。[鎖衝突表](https://www.postgresql.org/docs/current/explicit-locking.html)

**回滾三條件：**不能單獨稱為「所有寫入者都沒碰過」的證明。例如 [backfill-embeddings.ts:288](/home/haha/CC_project/CC-memory/scripts/backfill-embeddings.ts:288) 更新向量與其他中繼資料，不更新這三項；但反向操作也保留它們，因此這種漏檢本身不會弄壞資料。

在「沒有未持鎖的在途採集、計畫仍完整、禁止臨時 SQL」前提下，加上反向逐列守衛、鍵衝突及交易後檢查，**本輪未找到三條件皆放行、反向操作卻必然破壞既有應用資料的額外反例**。主要缺口是上述執行入口與回復檔案契約，而非再增加一個時間戳條件。

**R1 處置：**第 1、2 項方向可接受；第 5 項集合算法可接受，但不能替代歸屬與來源漂移檢查。類 4 預設排除、交人工裁決可接受；`--include-class4` 只是納入開關，不是歸屬證據，仍須對具體來源與目標核准。第 6–7 項不做隔離沒有異議。存活者排序可作固定選擇規則，但不等於摘要代表性已驗證。

本轮問題沒有問錯；欠缺的關鍵證據是：**重建計畫是否維持已核准歸屬，以及提交結果不明時是否仍保有不可覆寫的回復材料。**

本輪總結：完成指定工具、R1 與相關寫入路徑的唯讀審查；`python3 -B` 語法解析及離線反例完成，`bash -n` 結束碼為 0。未改檔、未連資料庫、未重跑彩排。修正上述問題後，優先驗證錯專案候選、來源空窗口漂移、鍵衝突预檢與提交後中斷情境。

verdict: REQUEST-CHANGES