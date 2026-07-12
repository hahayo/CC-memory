# CC-memory memory-flow cutover（Hermes → systemd）

> 目的：把 `memory` / auto-capture 的排程與告警從 Hermes 拆出去；`task` 側 reminder / Todoist 繼續留在 Hermes。

## 1. 準備 memory 專用 Telegram bot

1. 複製 `ops/systemd/cc-memory-alert.env.example` 到 `~/.ccm-memory-alert.env`
2. 填入：
   - `CC_MEMORY_ALERT_BOT_TOKEN`
   - `CC_MEMORY_ALERT_CHAT_ID`
3. `chmod 600 ~/.ccm-memory-alert.env`

這份檔只給 memory 告警用，不讀 `~/.hermes/.env`。

## 2. 安裝 systemd user units

以下命令會把 repo 內模板安裝到 user-level `systemd`：

```bash
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-auto-capture.service ~/.config/systemd/user/cc-memory-auto-capture.service
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-auto-capture.timer ~/.config/systemd/user/cc-memory-auto-capture.timer
systemctl --user daemon-reload
systemctl --user enable --now cc-memory-auto-capture.timer
```

驗證：

```bash
systemctl --user status cc-memory-auto-capture.timer
systemctl --user start cc-memory-auto-capture.service
journalctl --user -u cc-memory-auto-capture.service -n 50 --no-pager
```

## 3. 切離 Hermes memory job

先確認 `systemd` 手動跑一輪成功，再處理 Hermes：

1. pause `cc-memory-auto-capture`
2. 觀察一個 5 分鐘週期，確認只有 `systemd` 在跑
3. 確認新 bot 能收到失敗告警與 recovery
4. 再決定是保留 Hermes job 作備援草稿，或直接移除

本 repo 不直接改 `~/.hermes/cron/jobs.json`；請在操作前先用 `hermes cron --help` / `hermes cron edit --help` 確認當前 CLI flags。

## 4. 告警去重規則

- 同一 fingerprint = `exitCode + dead-letter count + first problem line`
- 第一次失敗立即告警
- 同 fingerprint 6 小時內不重複發
- 成功恢復後發一則 recovery，並清掉 active failure

runtime state 存在：

```text
~/.local/state/cc-memory/auto-capture-alert-state.json
```

## 4.1 注意事項

- 手動跑 worker 必須經 wrapper 或自帶 flock（`flock -n ~/.cache/cc-memory/auto-capture-run.lock <command>`），spool lock 的 stale 回收只負責 crash 殘留清理，不保證活鎖互斥。

## 5. Hermes task 側維持現況

- `cc-memory-reminders`
- `todoist-sync`

這兩支仍屬 `task` / personal-hub flow。若要改名成 `cc-task-*`，請在 Hermes 端手動處理；repo 內不直接寫使用者的 cron 設定。
