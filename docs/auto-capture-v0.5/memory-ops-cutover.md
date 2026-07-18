# CC-memory cross-client memory-flow cutover

> 目的：讓 Claude Code 與 Codex 共用同一套 hook（事件掛鉤）語意，並把 memory、reminder 與 Todoist 執行責任完全移出 Hermes。
>
> 正式依據：`docs/decisions/DEC-20260716T092938Z-cross-client-hook-driven-memory-flow.md`。

## 0. 目標拓樸與目前狀態

| 流程 | 觸發方式 | systemd unit | Hermes 切換條件 |
|---|---|---|---|
| PostToolUse capture | 只 append 本機 spool；不啟動 worker | 無 | 不適用 |
| Stop capture | append sentinel 後，以 `systemctl --no-block` 快速啟動 | `cc-memory-auto-capture.service` | `cc-memory-auto-capture` 保持 paused |
| SessionStart capture | 每次快速啟動 backlog；注入由 feature flag（功能開關）獨立控制 | `cc-memory-auto-capture.service` | 不適用 |
| reminders | systemd timer 每 5 分鐘 | `cc-memory-reminders.{service,timer}` | 手動執行與一個 timer 週期均通過後才 pause |
| Todoist sync | systemd timer 每 15 分鐘 | `cc-memory-todoist-sync.{service,timer}` | 手動執行與一個 timer 週期均通過後才 pause |

auto-capture 不設 timer，也不做常駐 daemon（背景常駐程序）；service 是跑完即退的 oneshot（單次執行服務）。

> **Cutover status（2026-07-17 17:17 Asia/Taipei）**：五個 user-level（使用者層級）units 與 Claude Code／Codex SessionStart 已安裝；reminder／Todoist 手動 service 及 17:15 首輪 timers 均 PASS，對應 Hermes jobs 已 pause。auto-capture Hermes job 也維持 pause；但 `~/.ccm-memory-alert.env` 尚未建立，因此 service 目前依 ConditionPathExists（檔案存在條件）安全跳過。Codex 新 hook 尚待使用者在 `/hooks` 信任。

## 1. 準備獨立憑證與連線檔

### 1.1 memory 告警

1. 複製 `ops/systemd/cc-memory-alert.env.example` 到 `~/.ccm-memory-alert.env`。
2. 填入 `CC_MEMORY_ALERT_BOT_TOKEN` 與 `CC_MEMORY_ALERT_CHAT_ID`。
3. 執行 `chmod 600 ~/.ccm-memory-alert.env`。

這份檔只給 memory 告警使用，不讀 `~/.hermes/.env`。`cc-memory-auto-capture.service` 同時要求 `~/.ccm-project-url` 與此檔存在；少任一檔都不執行 worker，避免沒有告警能力的半切換狀態。

先只測 Telegram，不讀 DB（資料庫）、不執行 worker、不改告警狀態：

```bash
cd ~/CC_project/CC-memory
npx tsx scripts/run-auto-capture-supervisor.ts --test-alert
```

必須由 memory 專用 bot 收到 `CC-memory Telegram alert test` 才能繼續。

### 1.2 reminders 與 Todoist

- `~/.ccm-personal-url`：personal DB 連線字串，既有 personal-hub（個人中樞）部署沿用。
- `~/.ccm-reminders.env`：由 `ops/systemd/cc-memory-reminders.env.example` 建立，填入 `TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_CHAT_ID`，權限設為 `0600`。
- `~/.ccm-todoist-token`：Todoist token 原始文字檔，既有 personal-hub 部署沿用，權限維持 `0600`。

新 wrapper（包裝腳本）不讀 `~/.hermes/.env`，因此 Hermes 停用後不會失去執行環境。

## 2. 安裝 systemd user units

以下是 2026-07-17 已執行的安裝命令，也可作為重裝手順；auto-capture 只有 service，沒有 timer：

```bash
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-auto-capture.service ~/.config/systemd/user/cc-memory-auto-capture.service
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-reminders.service ~/.config/systemd/user/cc-memory-reminders.service
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-reminders.timer ~/.config/systemd/user/cc-memory-reminders.timer
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-todoist-sync.service ~/.config/systemd/user/cc-memory-todoist-sync.service
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-todoist-sync.timer ~/.config/systemd/user/cc-memory-todoist-sync.timer
systemctl --user daemon-reload
```

分別手動驗證三個 services（服務），此時不啟用任何 timer：

```bash
systemctl --user start cc-memory-auto-capture.service
systemctl --user start cc-memory-reminders.service
systemctl --user start cc-memory-todoist-sync.service
journalctl --user -u cc-memory-auto-capture.service -n 50 --no-pager
journalctl --user -u cc-memory-reminders.service -n 50 --no-pager
journalctl --user -u cc-memory-todoist-sync.service -n 50 --no-pager
```

預期結果：reminders 與 Todoist 各完成一次輪詢。auto-capture 只有在 memory 專用 bot env 已建立且 `--test-alert` 通過後，才應產生健康 summary（摘要）；缺檔時必須顯示 unmet condition（條件未滿足）並跳過。

## 3. 安裝 Claude Code／Codex SessionStart hook

設定草稿與合併注意事項見 `docs/auto-capture-v0.5/m4-settings-draft.md`。兩個客戶端都指向同一支 `hooks/session-start-inject.sh`：

- 每次 SessionStart 都 fail-open（失敗放行）地快速啟動 backlog。
- `CC_MEMORY_INJECT_RECENT` 未設成 `on` 時不注入 Recent Activity（近期活動），但快速啟動仍會發生。
- Claude Code 必須追加到既有 `SessionStart` 陣列，不可覆蓋其他 hooks。
- Codex 不設定 async（非同步）hook；腳本內的 `systemctl --no-block` 已避免等待 worker 完成。修改後由使用者在 `/hooks` 審閱並信任，不手寫 trust hash（信任雜湊值）。

Stop hook 也必須在 Claude Code 與 Codex 都指向 `hooks/stop-capture-sentinel.sh`；PostToolUse 仍只指向 `hooks/post-tool-use-capture.sh`。

## 4. 驗證 hook-driven auto-capture

1. 確認 Hermes `cc-memory-auto-capture` 為 paused。
2. 在 Claude Code 完成一次 tool use（工具呼叫）後結束 session，確認 spool 先寫 sentinel，journal 隨後出現一次 auto-capture service 執行。
3. 在 Codex 重複相同測試。
4. 分別啟動新 Claude Code 與 Codex session，確認即使 `CC_MEMORY_INJECT_RECENT` 為 off，仍會快速啟動 service。
5. 確認單純 PostToolUse 不會啟動 service。

auto-capture service 不 enable（設為開機常駐啟用），也不觀察五分鐘週期；它只由 Stop／SessionStart hooks 啟動。Hermes memory job 只保留為 paused 備援，不再承擔執行或告警。

## 5. 啟用 task timers 並切離 Hermes

只有 reminders 與 Todoist 啟用 timers：

```bash
systemctl --user enable --now cc-memory-reminders.timer
systemctl --user enable --now cc-memory-todoist-sync.timer
systemctl --user status cc-memory-reminders.timer
systemctl --user status cc-memory-todoist-sync.timer
```

切換順序：

1. 保持 Hermes `cc-memory-reminders` 與 `todoist-sync` 啟用，先完成兩個 systemd services 的手動執行。
2. 啟用兩個 timers，各觀察至少一個完整週期及 journal。
3. 確認沒有重複發送 reminder、Todoist 同步錯誤或 DB scope（資料範圍）錯置。
4. 通過後才 pause 對應 Hermes jobs；一次只切一支，失敗時立即停用該 timer 並恢復原 Hermes job。

本 repo 不直接改 `~/.hermes/cron/jobs.json`。實際操作前先以 `hermes cron --help` 與 `hermes cron edit --help` 確認當前 CLI flags（命令列參數）。

## 6. 告警去重規則

- 同一 fingerprint（指紋）=`exitCode + first problem line`，dead-letter count（死信數量）不參與。
- 第一次失敗立即告警。
- 同 fingerprint 6 小時內不重複發送。
- 成功恢復後發一則 recovery（恢復通知），並清除 active failure（現行失敗狀態）。

runtime state（執行期狀態）位於：

```text
~/.local/state/cc-memory/auto-capture-alert-state.json
```

## 7. 注意事項與 rollback

- 手動跑 worker 必須經 supervisor 或自帶 `flock`（檔案鎖）；spool lock 的 stale（過期殘留）回收只處理 crash（異常終止）殘留，不保證活鎖互斥。
- auto-capture rollback（回復）：移除 SessionStart 新增項目；Stop 保留 sentinel append，再視需要暫時恢復原 Hermes memory job。不得同時啟用 Hermes memory job 與另一個 auto timer。
- reminders／Todoist rollback：`systemctl --user disable --now <timer>`，確認停止後再恢復對應 Hermes job。
- 任何 rollback 都保留 spool、checkpoint（檢查點）與 DB 資料，不做破壞性清除。
