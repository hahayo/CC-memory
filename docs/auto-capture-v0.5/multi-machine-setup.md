# v0.5 auto-capture 跨機安裝指南（multi-machine setup）

> 適用：要在**另一台電腦**的 Claude Code／Codex CLI 上啟用 CC-memory auto-capture。
> 架構前提（plan.md OQ3 拍板）：**spool 各機自理**——每台機器自己 capture 自己的 spool、自己跑 worker 寫同一個 prod project DB；跨機去重靠 `content_hash` unique index 與 canonical rollup upsert（冪等），`writer_host` 欄位記錄來源機器。

## 0. 前提

| 項目 | 要求 |
|---|---|
| repo | clone 到 `~/CC_project/CC-memory`（**路徑建議一致**，下方片段都用此路徑；不一致就自行改路徑） |
| Node.js | ≥ 20（worker 用 `npx tsx` 跑） |
| `npm install` | repo 內執行一次 |
| claude CLI | 已安裝且以訂閱帳號登入（capture 抽取預設 `claude -p --model haiku`，吃訂閱額度） |
| prod DB 連線 | `~/.ccm-project-url`（mode 600，內容 = Coolify project DB 連線字串）；DB 不可直達時需先建立 SSH tunnel（連不上時 worker 安全跳過、不推 HWM）。⚠️ 勿用舊的 `~/.ccm-prod-url`（Zeabur 退役庫） |
| jq | **不需要**（hook 是純 bash） |

## 1. Claude Code 啟用（hook 端）

把以下兩個 entry **merge**（合併，不是覆蓋）進 `~/.claude/settings.json` 的 `hooks`：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/CC_project/CC-memory/hooks/post-tool-use-capture.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "~/CC_project/CC-memory/hooks/stop-capture-sentinel.sh" }
        ]
      }
    ]
  }
}
```

驗證（pipe-test，不用等真 session）：

```bash
TESTSPOOL=$(mktemp -d)
echo '{"session_id":"t","tool_name":"Bash","transcript_path":"/tmp/x.jsonl","cwd":"'$HOME'/CC_project/CC-memory","tool_input":{}}' \
  | CC_MEMORY_SPOOL_DIR=$TESTSPOOL ~/CC_project/CC-memory/hooks/post-tool-use-capture.sh && echo OK
find "$TESTSPOOL" -name '*.jsonl'   # 應出現一筆事件
rm -rf "$TESTSPOOL"
```

之後任一 Claude Code session 用過工具，`~/.cache/cc-memory/spool/<project>/<session>.jsonl` 就會累積事件。

## 2. Codex CLI 啟用（hook 端）

Codex（rust CLI ≥ 0.14x）的 hooks 事件與 payload 欄位（`session_id`／`tool_name`／`transcript_path`／`cwd`）與 Claude Code 同構，**同兩支 script 直接可用**。在 `~/.codex/config.toml` 追加：

```toml
[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "/home/<user>/CC_project/CC-memory/hooks/post-tool-use-capture.sh"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "/home/<user>/CC_project/CC-memory/hooks/stop-capture-sentinel.sh"
```

（Codex hook command 建議寫**絕對路徑**；`<user>` 換成實際 username。）

**⚠️ hook trust（信任）**：Codex 的 user hooks 需 trust 過才會執行（依 hook 定義的 sha256）。加完設定後**互動跑一次 `codex`**，在 trust 提示出現時接受；未 trust 前 headless `codex exec` 會**靜默跳過** hooks（不報錯）。驗證是否生效：跑一次 `codex exec "run: echo hi"` 後檢查 `~/.cache/cc-memory/spool/<cwd 專案>/` 是否出現 codex session（uuid v7）的 jsonl。

## 3. Worker（cron 端）

worker 每 5 分鐘讀本機 spool → claude CLI（haiku）抽取 → 寫 prod DB。wrapper 範本：`docs/auto-capture-v0.5/m2b-cron-draft.md`（hermes 版）；實際部署版在主力機的 `~/.hermes/scripts/cc-memory-auto-capture.sh`（含「正常 tick 靜默、異常才輸出」過濾）。

沒有 hermes 的機器用 plain crontab（邏輯相同）：

```cron
*/5 * * * * /home/<user>/CC_project/CC-memory/scripts/cron-wrapper.sh >> /home/<user>/.cache/cc-memory/worker.log 2>&1
```

wrapper 核心（自行落地成檔案並 `chmod +x`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
export DATABASE_URL="$(cat "$HOME/.ccm-project-url")"
export CC_CAPTURE_LLM="${CC_CAPTURE_LLM:-claude-cli}"
export CC_CAPTURE_CLAUDE_MODEL="${CC_CAPTURE_CLAUDE_MODEL:-haiku}"
cd "$HOME/CC_project/CC-memory"
exec npx tsx scripts/run-auto-capture.ts
```

## 4. 驗證清單

1. `ls ~/.cache/cc-memory/spool/` — 用過 Claude Code／Codex 後有專案目錄
2. 手動跑一次 wrapper — stdout 出現 `[cc-memory] auto-capture summary: processed=N ...`
3. `ls ~/.cache/cc-memory/spool/.dead/ | wc -l` — 應為 0（有 dead 檔時內含 `llm_raw_output` 可診斷）
4. 到任一 Claude Code session 用 `cc_memory_search` 查該機工作內容 → drill-down `cc_memory_timeline` / `cc_memory_get_observations`

## 5. 注意事項

- **遞迴斷路器**：worker spawn 的 claude 子程序帶 `CC_MEMORY_CAPTURE_CHILD=1`，hooks 開頭 guard 直接 exit 0——抽取 session 不會再進 spool。不要移除該 guard。
- **`GEMINI_API_KEY` 不要 unset**：雙用途（gemini-flash capture 選項 + search embedding）；unset 會讓語義搜尋失效。claude-cli capture 不需要它。
- spool 安全閥：單檔 >10MB rotate、全 spool >500MB 停止 capture（`CC_MEMORY_SPOOL_MAX_MB`）。
- 窗口安全閥：空窗口 skip；>256KB 依 UTF-8 邊界分塊（`CC_CAPTURE_MAX_WINDOW_BYTES`）。
- 環境變數全表：`plan.md` §Environment Variables。
