# Cross-client SessionStart settings record

> **Applied 2026-07-17 17:11 Asia/Taipei.** 本設定同時涵蓋 Claude Code 與 Codex，正式依據為 `docs/decisions/DEC-20260716T092938Z-cross-client-hook-driven-memory-flow.md`。落地前已完成 JSON／TOML 解析驗證並備份原檔：`~/.claude/settings.json.cc-memory-backup-20260717T091143Z`、`~/.codex/config.toml.cc-memory-backup-20260717T091143Z`。Codex 新 hook 仍須由使用者在 `/hooks` 完成人工信任。

## 行為語意

兩個客戶端都呼叫同一支 `hooks/session-start-inject.sh`，但其中有兩個互不綁定的行為：

1. 每次 SessionStart 都以 `systemctl --user start --no-block cc-memory-auto-capture.service` 快速啟動 backlog（積壓工作）。
2. 只有 `CC_MEMORY_INJECT_RECENT=on` 時，才向新 session 注入精簡 Recent Activity（近期活動）索引。

因此，保持注入關閉不會關掉 backlog 啟動。所有失敗路徑都 fail-open（失敗放行），不可阻擋客戶端啟動。

共同限制：

- `CC_MEMORY_CAPTURE_CHILD` 存在時先退出，避免 capture worker（擷取工作程序）的子程序遞迴觸發。
- 注入只含 id、`updated_at`、observation count（觀察紀錄數）、`discovery_tokens` 與 summary excerpt（摘要節錄），不含 observation 全文。
- 注入文字含 `source=cc-memory-inject`，capture worker 會排除它，避免 feedback loop（回饋循環）。
- Codex 已支援 `SessionStart`／`Stop` command hooks（命令掛鉤）與 `hookSpecificOutput.additionalContext`；但 async command hooks（非同步命令掛鉤）目前會被略過，因此本設定不使用 `async`。快速返回由腳本內 `systemctl --no-block` 達成。官方說明：<https://learn.chatgpt.com/docs/hooks.md>。

## Claude Code settings

在既有 `~/.claude/settings.json` 的 `hooks.SessionStart` **陣列尾端追加**以下物件；不可用整段範例覆蓋既有陣列：

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "/home/haha/CC_project/CC-memory/hooks/session-start-inject.sh"
    }
  ]
}
```

合併後的形狀應類似：

```json
{
  "hooks": {
    "SessionStart": [
      { "...existing hook...": "preserve" },
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/haha/CC_project/CC-memory/hooks/session-start-inject.sh"
          }
        ]
      }
    ]
  }
}
```

上例中的 `...existing hook...` 只是合併位置示意，不得照抄成正式設定。

## Codex config

在 `~/.codex/config.toml` 追加：

```toml
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"

[[hooks.SessionStart.hooks]]
type = "command"
command = "/home/haha/CC_project/CC-memory/hooks/session-start-inject.sh"
timeout = 10
```

注意：

- 不設定 `async = true`。
- 設定寫入後，在 Codex `/hooks` 畫面審閱並信任這支 hook；不可手寫或猜測 `[hooks.state]` 的 trust hash（信任雜湊值）。
- Codex 會接受腳本 stdout 的純文字，或解析含 `hookSpecificOutput.additionalContext` 的 JSON（JavaScript 物件表示法）；現有 injector 已使用相容輸出。

## 啟用注入的條件

初次切換先保持 `CC_MEMORY_INJECT_RECENT` 未設定，僅驗證 backlog quick-kick（快速啟動）。只有 M4 gate（品質關卡）、project DB migrations（專案資料庫遷移）0011–0013 與污染防線都確認後，才在啟動兩個客戶端前的環境中設定：

```bash
export CC_MEMORY_INJECT_RECENT=on
```

wrapper（包裝腳本）會從 repo root（程式碼儲存庫根目錄）執行 `npx tsx scripts/run-session-start-inject.ts`。project DB 必須可連線；DSN（資料來源名稱）解析沿用 `config.databaseUrl`。

## 環境變數

| Variable（變數） | Default（預設） | Effect（效果） |
|---|---|---|
| `CC_MEMORY_INJECT_RECENT` | unset / off | `on` 才注入；其他值仍會 quick-kick backlog，但 stdout 保持空白。 |
| `CC_MEMORY_INJECT_TOKEN_BUDGET` | `1200` | 超量時先移除 observation ids，再縮 summary excerpt，最後移除最舊資料。 |
| `CC_MEMORY_CAPTURE_CHILD` | unset | capture worker 子程序設為 `1`；wrapper 在 quick-kick 與注入前直接退出。 |

## 驗證與 rollback

設定完成後，兩個客戶端都要分別驗證：

1. `CC_MEMORY_INJECT_RECENT` 為 off 時，新 session 不輸出索引，但 journal 顯示 service 被快速啟動。
2. Stop 時 sentinel 已落盤後才啟動 service。
3. 單純 PostToolUse 只寫 spool，不啟動 service。
4. flag 設為 on 時，只注入輕索引；DB 不可用時不阻擋 session。

Rollback（回復）：從兩個客戶端各自移除新增的 `SessionStart` 項目。若只要暫停注入，可取消 `CC_MEMORY_INJECT_RECENT`，同時保留 backlog quick-kick。
