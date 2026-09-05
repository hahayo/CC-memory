**仍有執行阻擋：提交後錯誤可能誤刪執行中標記，恢復查核也無法處理損壞的完成紀錄。**

五項判定：

| R2 項目 | 判定 | 核對結果 |
|---|---|---|
| 1. 目標專案被劫 | **closed（已關閉）** | 先固定目的專案，再匹配完整鍵；其他專案候選會跳過，類 1 也比對目標 ID。[程式:145](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-build.py:145) |
| 2. 提交後紀錄未落盤 | **open（未關閉）** | 已增加標記與副本，但錯誤判定仍可能清掉應保留的標記。見下方高嚴重度問題。 |
| 3. 來源漂移／未持鎖入口 | **closed（以本次執行契約為前提）** | 來源 `capture_before` 已加入正反向逐列比對；正常背景程序使用同一把鎖。接受本次明示「期間不得手動啟動採集」的限制。[正向:135](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:135)、[反向:158](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:158) |
| 4. 預檢誤報 | **closed** | 回傳真實衝突數，五個必要計數缺項或非零都失敗。[程式:428](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:428) |
| 5. 盤點措辭 | **closed** | 提案已改成收益證據不足，未再把盤點當作無害證明。逐行原始檔驗證本輪未重跑。[提案](/home/haha/.cache/cc-memory/stepc-2026-09-05/PROPOSAL.md) |

新增／殘留問題：

1. **High（高）｜任意 `ERROR:` 被當成確定回滾，可能誤刪標記。**  
   [stepc-merge-apply.py:460](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:460)

   程式先 `COMMIT`（提交），再另外查詢 `committed|yes`。如果提交完成，但最後查詢被取消而回傳 `ERROR:`，這裡會宣稱資料庫未變，並刪除 `.executing.json`。此時也沒有 `.applied.json`，驅動腳本下次便允許重建計畫。

   已用**記憶體內模擬輸出**執行原判定分支，實際得到：
   ```text
   TRANSACTION ROLLED BACK by server error (exit=3); DB unchanged.
   executing marker DELETED
   ```
   這驗證了誤判分支；未實際連資料庫注入故障。

   **必要修正：**沒有可靠提交結果時一律保留標記；不能以出現 `ERROR:` 證明交易已回滾。最小修法是所有未取得成功確認的情況都保留，交人工查核。

2. **Medium（中）｜完成紀錄寫到一半，會讓恢復查核直接崩潰。**  
   [stepc-merge-apply.py:387](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:387)

   `.applied.json` 使用直接寫入。若提交後寫入中斷，可能留下空白或截斷內容。`--check-state` 卻在進入查核分支前就解析它，觸發 `JSONDecodeError`（JSON 解析錯誤），完全不執行狀態查詢。離線模擬已重現。

   **必要修正：**恢復查核不能依賴完成紀錄可解析；損壞時應照常查詢，並明示紀錄損壞。

   此外，集合不符會提早中止查詢，後續計數缺席；[現有查核輸出](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-rehearsal-checkstate.txt) 已呈現此情況。因此目前不能宣稱「兩方向都印出全部計數」。缺項須明示為未完成查核。

其他指定核對：

- **正式計畫沒有誤殺：**離線比對[計畫](/home/haha/.cache/cc-memory/stepc-2026-09-05/plan-2026-09-05.jsonl)與[對照表](/home/haha/.cache/cc-memory/stepb-2026-09-03/remap-2026-09-03.jsonl)，類 1／2 的工作階段 ID 集合完全相同，目的專案無不符；確為 30＋3 個工作階段、44 個來源彙總、843 筆觀察。這比只比總數更強，但不代表正式資料庫現在仍未漂移。
- **`pgrep` 樣式偏寬：**可能命中命令列含相關文字的包裝程序，造成安全拒絕；它也無法阻止檢查後才啟動的手動程序。因此接受的是「同鎖＋本次禁止手動啟動」契約，不是 `pgrep` 提供完整互斥保證。
- **文件有落差：**目前 `PROPOSAL.md` 未找到所述「不得手動跑採集／drain」契約；應補入執行說明。本次訊息已明示該限制，因此不另擴成架構問題。
- 彩排情境 8 只放入假標記測拒絕，沒有覆蓋「提交成功後錯誤」或「完成紀錄截斷」。[彩排:133](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-rehearsal.sh:133)

**目前不宜在使用者說執行後直接跑 `stepc-run.sh`；先修上述標記誤刪與恢復查核問題。**

本輪總結：完成唯讀審查；`python3 -B` 語法解析、計畫集合比對及記憶體反例完成，`bash -n` 結束碼為 0。未改檔、未連資料庫、未操作 5438。下一步只需針對上述故障情境修正與驗證。

verdict: REQUEST-CHANGES