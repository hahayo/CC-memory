# recall-exam：cc-memory vs claude-mem 盲測

回答一個問題：**在這台機器真實的對話上，cc-memory 的回想品質有沒有輸 claude-mem？**
不能證明「永遠比較好」，只能定期考、看趨勢（2026-10-23 Codex 對審結論）。

## 怎麼跑

```bash
# 只看會抽到哪些 session（不花錢）
python3 scripts/recall-exam/recall_exam.py pool --days 14 --n 6

# 固定回歸題 9 題（Q1–Q8＋Q10）＋ 6 題隨機新題
python3 scripts/recall-exam/recall_exam.py run --fixed --rolling 6 --days 14

# 只跑固定題
python3 scripts/recall-exam/recall_exam.py run --fixed-only
```

產物：`~/.cache/cc-memory/recall-exam/runs/<時間戳>/report.md`（＋ questions／answers／grades／meta JSON）。
考過的隨機題 session 記在 `~/.cache/cc-memory/recall-exam/ledger.jsonl`，不重抽。

## 流程與隔離

| 角色 | 模型 | 看得到什麼 | 看不到什麼 |
|---|---|---|---|
| 出題者 | sonnet | 腳本把一份原始對話檔轉成的精簡文字稿（放在提示的 `<transcript>` 區塊；**沒有任何工具**） | 檔案系統、任何記憶工具 |
| 作答者 ×2 | sonnet | 只有一套記憶系統的唯讀 MCP 工具（明確清單，見下） | 另一套、檔案系統、Bash／Read |
| 評分者 ×2 | sonnet | 題目、標準答案、兩個答案（系統名遮成 `[工具]`、順序相反；沒有工具） | 哪個答案來自哪套 |

原始對話檔是不可信資料（夾帶網頁與工具輸出，可能藏提示注入），所以出題者不給工具：`lib.render_transcript()`
只留 user／assistant 文字、tool_use 的工具名＋精簡參數、tool_result 前 600 字元，每段標原始行號與時間戳；
總長上限約 35 萬字元／估 12 萬 token，超過時保留後段並註明截斷。

作答者可用的工具（`--permission-mode dontAsk`：清單外一律拒）：

- cc-memory：`cc_memory_search`／`list`／`get`／`stats`／`timeline`／`get_observations`、`cc_task_list`／`cc_task_stats`；
  server 端另有 `CC_READ_ONLY=1` 與 `CC_TOOL_ALLOWLIST` 兩層。
- claude-mem：`search`／`timeline`／`get_observations`（另含只回說明文字的 `__IMPORTANT`）。`smart_search`／`smart_outline`／`smart_unfold` 會讀本機任意檔，
  用 `--disallowedTools` 封鎖。

每次 `claude -p` 都帶 `--setting-sources local --no-session-persistence` 與 `CC_MEMORY_CAPTURE_CHILD=1`，
考試本身不會被兩套系統錄進去（已實測 `sdk_sessions`、spool 都不增加）。
環境變數走白名單（`PATH`、`HOME`、`LANG`、`LC_*`、`XDG_*`、`ANTHROPIC_*`、`CLAUDE_*` 等），不再整包傳；
cc-memory 的 DB 連線字串由 wrapper 自己從檔案讀。

## 題庫

- **固定題** `~/.cache/cc-memory/recall-exam/fixed-set.json`（含各專案內部內容，**不進 repo**）：2026-09-19 盲測的 Q1–Q8 與 Q10。這些 session 早於 2026-10-21 收尾功能上線、未回溯收尾，
  測的是搜尋／抽取；要看收尾修了沒，看 rolling 題。
- **隨機題**：近 N 天、兩邊都抓到（cc 觀察 ≥15、claude-mem 觀察 ≥5）、cc 已收尾（`metadata.capture.finalized_at`）、
  原始對話檔還在、沒考過；按專案分層抽。`--allow-unfinalized` 可放寬。
  `--since <ISO 時間，要帶時區>` 只抽之後才開始的對話（看 claude-mem 記的 session 開始時間），用來只考某次改版後抓的資料；它不會超出 `--days` 的範圍。

## 判定

等級：correct 3、partial 2、no_answer 1、wrong 0、confident_wrong −1。兩位評分者意見不同就標 DISAGREE，留人工仲裁，不自動裁。
報表另列每題查詢輪數與費用（成本是替代決策的一環，但不是品質證據）。

## 考前檢查

跑之前會打 claude-mem worker 的 `/api/search`；回 error 就拒跑（`--ignore-health` 可硬跑，報表會標）。
2026-10-23 實例：claude-mem 的 chroma-mcp 因 uvx 相依未釘版（pydantic ≥2.12 與 mcp 不合）壞了兩天多，
修法 `uv tool install --python 3.13 --with 'pydantic<2.12' chroma-mcp`，再 `node <plugin>/scripts/worker-cli.js restart`。
