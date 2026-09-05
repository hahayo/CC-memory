# Step B 提案（2026-09-05，等使用者裁決；DB 尚未寫入任何東西）

## A. Step B 殘餘 1,112 列

| 類 | 列數 | 選項一 | 選項二 | 我選 |
|---|---|---|---|---|
| (1) 新 id 已有 rollup（30 session、38 rollup＋747 obs） | 785 | 合併：舊 rollup 標 archived＋merged_into 目標；observations 改到目標；目標 metadata 只補 transcript_sources／observation_ids | 留原樣 | 選項一（工具已寫好、彩排全過、正式 DB 唯讀預檢通過） |
| (2) 表內自撞（3 session、6 rollup＋96 obs） | 102 | 同上，但沒有現成目標 → 挑一個舊 rollup 當存活者改 key（規則：linked obs 最多→建立最早→id 最小） | 留原樣 | 選項一（與 (1) 同一筆交易一起做） |
| (3) 只有目錄名證據（7 session、106 列；候選 AI_Copilot×5、recycling-recognition×2） | 106 | 使用者逐個核准候選 id 後，用 Step B 工具搬 | 留原樣 | 選項二（沒證據、量小；除非你一眼就認得那 7 個 session） |
| (4) transcript 已刪（3 session、119 列；tender-pmo 已有 7 月 rollup） | 119 | 加 `--include-class4`：其中 2 個 session 併進 recycling-recognition-tender-pmo；551de309 有兩個候選永遠不動 | 留原樣 | 選項二（專案已刪，價值低；Codex 認為「有 rollup」不算歸屬證據） |

執行方式：`bash ~/.cache/cc-memory/stepc-2026-09-05/stepc-run.sh ~/.cache/cc-memory/stepb-2026-09-03/remap-2026-09-03.jsonl ~/.cache/cc-memory/stepc-2026-09-05/plan-2026-09-05.jsonl`
（取 worker 同一把鎖 → 重建計畫 → 唯讀預檢 → 單一交易執行；任一檢查不符整筆回滾。執行後幾分鐘內可 `--rollback`，worker 一寫到目標就拒絕自動回滾。）
執行契約：跑 Step C 期間**不得手動啟動** `run-auto-capture`／`drain-capture-backlog`（它們可繞過 worker 的鎖）；也不得對這兩張表下臨時 SQL。若執行結果不明（有 `plan-2026-09-05.executing.json` 但沒有 `.applied.json`），先跑 `python3 stepc-merge-apply.py <plan> <remap> --check-state`（唯讀）判定，不要重跑。

## B. spool 舊 backlog（12,628 個 session 有待處理）

| 分組 | session | 建議 |
|---|---|---|
| 沒有對話紀錄路徑的檔（每一行的 transcript_path 都是空字串，逐行驗過、無解析錯誤；9,079 個是 38 bytes 的單行檔，187 個是多行） | 9,266（1.6 MB） | 不動。worker 遇到只是跳過。不做隔離的理由是「收益證據不足」，不是「證明無害」 |
| transcript 已刪 | 695（12 MB） | 不動。隔離／封存的風險（hook 追加、非原子搬移）高於收益 |
| transcript 還在 | 2,667（約 5.3 GB 對話、約 23,000 個 LLM 窗口） | **要你決定**：選項一「只回放你點名的少數 project」／選項二「全部放棄」。我選選項二，除非你有特別想救的 project |

transcript 還在的前幾名（窗口數＝要呼叫 LLM 的次數）：finetune-eval 7,240、gov-recycle-ai 1,899、recycling-recognition 1,802、AI_Copilot 968、hermes 884、CC_project 881、CC-memory 833。
注意：8 月的 Claude Code 對話紀錄會被 30 天清理逐步刪掉，Codex 的不會。

## C. 順手一件（可選）
8/27 的 spool 備份快照沒涵蓋 8/31 之後的檔。要再做一次備份就跑 `npm run archive:capture-backlog -- --copy-live --execute`（文件化流程，會頂掉最舊那份本機快照 copy-live-20260825）。不做也行。
