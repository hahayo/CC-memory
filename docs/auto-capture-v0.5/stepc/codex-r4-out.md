R3 兩項皆 **closed（已關閉）**，但新增狀態判定仍需一項修正。

- **High（高）標記誤刪：closed。** 未取得 `committed|yes` 時保留標記並指示查核；記憶體模擬已確認提交前錯誤、提交後錯誤及斷線均不刪標記。[程式:495](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:495)
- **Medium（中）完成紀錄損壞：closed。** 完成紀錄改為原子替換；損壞不阻斷查核，執行／回滾則拒絕繼續。必要計數缺項也會明示。[查核:408](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:408)、[寫入:506](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:506)

**新問題｜Medium：狀態結論未核對資料庫身分。**  
`_matches` 只檢查結束碼及計數，未比對 `db`、`system_id`、`ro`。連到具有相同資料的其他實例時，可能誤報原交易未套用或已提交，進而誤導人工移除標記。[程式:426](/home/haha/.cache/cc-memory/stepc-2026-09-05/stepc-merge-apply.py:426)

純記憶體模擬實際得到：
```text
WRONG identity: VERDICT: BEFORE-STATE (nothing applied)
```

必要修正：兩方向判定皆加入預期資料庫名稱、實例識別碼及唯讀狀態核對；不符時明示身分錯誤，不得宣告前／後狀態。

**本輪總結：**僅審指定修正；`python3 -B` 語法解析與記憶體模擬完成，`bash -n stepc-run.sh stepc-rehearsal.sh` 結束碼為 0。未改檔、未連資料庫、未操作 5438；完整彩排本輪未重跑。下一步修正狀態判定的身分核對。

verdict: APPROVE-WITH-FIXES