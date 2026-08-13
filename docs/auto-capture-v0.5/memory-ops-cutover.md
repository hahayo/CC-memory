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

> **Cutover status（2026-08-12 Asia/Taipei）**：五個 user-level（使用者層級）units 與 Claude Code／Codex SessionStart 已安裝；reminder／Todoist timers 均在運作，對應 Hermes jobs 已 pause。auto-capture Hermes job 也維持 pause。auto-capture installed unit 已更新為與 repo 逐位元一致：同時要求 `~/.ccm-project-url`、`~/.ccm-auto-capture-production-approved`，並固定 `CC_MEMORY_REQUIRE_ALERTS=1`；舊 unit 備份為 `~/.config/systemd/user/cc-memory-auto-capture.service.pre-20260812`。marker 缺失時的實際 start 驗收為 `inactive/dead`、`ConditionResult=no`，journal 明列 condition skip，worker 未執行；runtime pause drop-in（執行期暫停覆寫）目前仍保留。memory 專用 `~/.ccm-memory-alert.env` 已建立為 `0600`，`--test-alert` 已實際送達並由操作人確認。2026-08-12 readiness audit（就緒稽核）確認資料量與併用時間已達門檻；近 7 日已透過本輪實際 MCP 工作查詢累積 5/5 筆 project-scoped `search_feedback`。10 題 keyword baseline benchmark（關鍵字基線測試）已完成，正式報告實測 production 非個人 active corpus 為 14,229 筆、只有 27 筆有 embedding；因此維持 **PARTIAL／No-Go**。暴露的舊 Gemini key 已由操作人在 provider 端撤銷，新 key 已安裝為 `0600` 並以 1536 dimensions smoke test（維度煙霧測試）通過；仍須完成 14,202 筆 embedding backfill、正式 hybrid benchmark（混合檢索基準測試）、人工標註三硬指標全過，且 §9 全部閘門依序通過後，才可停用 claude-mem。

## 1. 準備獨立憑證與連線檔

runtime 前提是 Node.js `>=20.0.0`；CI 使用 Node.js 22，本機正式操作也建議使用同一個 major version。`@google/genai` 現行安裝版本要求 Node.js 20 以上，因此 Node.js 18 不在支援範圍。執行 cutover 前先確認 `node --version` 與 `npm ci` 沒有 engine（執行版本）警告。

### 1.1 memory 告警

1. 複製 `ops/systemd/cc-memory-alert.env.example` 到 `~/.ccm-memory-alert.env`。
2. 填入 `CC_MEMORY_ALERT_BOT_TOKEN` 與 `CC_MEMORY_ALERT_CHAT_ID`。
3. 執行 `chmod 600 ~/.ccm-memory-alert.env`。

這份檔只給 memory 告警使用，不讀 `~/.hermes/.env`。supervisor 的通用預設是缺少此檔時輸出 `alerts-disabled` 並繼續執行 worker；但 repo 提供的正式 auto-capture unit 固定設定 `CC_MEMORY_REQUIRE_ALERTS=1`，因此正式 unit 缺少或無法解析告警檔時會在 worker 前 fail-closed。`~/.ccm-project-url` 與 §1.5 的 production approval marker 也是 service hard gate，任一缺少時不執行 worker。

先只測 Telegram，不讀 DB（資料庫）、不執行 worker、不改告警狀態：

```bash
cd ~/CC_project/CC-memory
npx tsx scripts/run-auto-capture-supervisor.ts --test-alert
```

必須由 memory 專用 bot 收到 `CC-memory Telegram alert test`，才可安裝或啟動正式 unit。只有開發期直接呼叫 supervisor 且未設定 hard gate 時，才允許 `alerts-disabled` 降級行為。

### 1.2 Gemini embedding 憑證與安全補算

capture LLM（擷取用語言模型）即使選 `claude-cli`，寫入後的 embedding 仍獨立使用 Gemini。正式 supervisor 從權限為 `0600` 的 `~/.gemini-api-key` 載入 key；缺少時擷取仍會成功，但新資料的 embedding 為 `NULL`，supervisor 會輸出 `embeddings-disabled`。如果 key 已載入但 API 回傳空值或失敗，worker 仍保留 capture 的 NULL 降級語意，同時在 summary 增加 `embedding-failed=N`，supervisor 將其視為需要告警的異常；這可抓到已輪替、失效或填錯內容的 key。正式 backfill 不接受 `.env` 或 ambient `GEMINI_API_KEY`，規則見下方。

暴露的舊 Gemini key 已由操作人在 provider（供應商）端撤銷；新 key 已寫入 `0600` 的 `~/.gemini-api-key`，並以 1536 dimensions smoke test（維度煙霧測試）通過。舊 key 不得再拿來做 benchmark、backfill（補算）或 canary。新值不得貼進終端輸出、文件、issue（議題）或 Git。repo 內的程式與測試不能代替 provider 端撤銷證據；正式簽核仍須以操作人的外部處置紀錄為準。後續 key 輪替以本節兩張表各 10 筆的 canary 作為可重複 smoke test：它會同時驗證安全 key loader、Gemini 呼叫、DB 寫入與 schema 的 `vector(1536)` 維度約束。

先以預設 dry-run 盤點，不會呼叫 Gemini 或寫 DB；dry-run 預設以 1000-row keyset batch（1000 筆鍵集批次）降低遠端 DB round trip，`--execute` 預設仍是 10，兩者不可混淆：

```bash
DATABASE_URL="$(<~/.ccm-project-url)" npm run backfill:embeddings -- --table all
```

確認 key、待補筆數與 Gemini quota（配額）後，先對兩張表各用顯式 `--limit 10` 執行 canary；`--table all --limit 10` 會把全域上限先用在 `project_memories`，無法涵蓋 `observations`，因此不可拿它代替下列兩次試跑。`--batch-size 10` 只控制每批筆數，**不會**限制整次執行總量：

```bash
DATABASE_URL="$(<~/.ccm-project-url)" npm run backfill:embeddings -- \
  --table project_memories --execute --key-file ~/.gemini-api-key \
  --limit 10 --batch-size 10 --rpm 60 --max-consecutive-failures 20

DATABASE_URL="$(<~/.ccm-project-url)" npm run backfill:embeddings -- \
  --table observations --execute --key-file ~/.gemini-api-key \
  --limit 10 --batch-size 10 --rpm 60 --max-consecutive-failures 20
```

兩次 canary 都必須各自 `attempted=10`、`updated=10`、`failed=0`；schema 已把兩欄固定為 `vector(1536)`，成功寫入 10 筆即為維度約束通過的證據。任一條件不符即停止，不得進入全量。通過後才改用 `--table all` 並移除 `--limit 10` 執行全量回填：

```bash
DATABASE_URL="$(<~/.ccm-project-url)" npm run backfill:embeddings -- \
  --table all --execute --key-file ~/.gemini-api-key \
  --batch-size 10 --rpm 60 --max-consecutive-failures 20
```

全量執行使用 keyset pagination（鍵集分頁）、RPM（每分鐘請求數）節流與連續失敗斷路。人工停止條件刻意比內建斷路器保守：`attempted < 500` 時只要 `failed > 0` 就中止；`attempted >= 500` 後只要 `failed/attempted > 2%` 就中止並調查。這些不是程式內建條件，操作人必須監看每 10 次請求輸出的 progress（進度）；回填具冪等性，中止後只會再取尚未成功的 `embedding IS NULL` 資料列。

`--execute` 強制要求顯式 `--key-file`；檔案必須是 `0600` regular file（一般檔案）且不得是 symlink（符號連結）。程式會隔離 `.env` 與 ambient `GEMINI_API_KEY`，輸出只留 path label、mode、mtime 與 12-hex SHA-256 fingerprint（指紋），不輸出 key。`--table all --limit N` 的 `N` 是兩張表合計的全域上限，依 `project_memories`、`observations` 順序分配。若結果的 `failed` 大於 0，失敗 row（資料列）本輪已跳過；修正暫時性錯誤後用相同命令重跑，`embedding IS NULL` 條件只會再取尚未成功的資料。

2026-08-12 正式 project DB dry-run：4.59 秒掃描 14,202 個 NULL embeddings，`attempted=0`、`updated=0`、`failed=0`。這是待補算量，不是 API call 數；真正 execute 前仍須確認新 Gemini key、quota 與 RPM。

正式 hybrid benchmark 不讀 `.env`，也不接受 ambient `GEMINI_API_KEY`。必須用 `--embedding-key-file ~/.gemini-api-key` 顯式指定 regular file（一般檔案）；檔案須為 `0600` 且不得是 symlink（符號連結）。報告只記 `path label`、mode、mtime 與 key 的 12-hex SHA-256 fingerprint，不記 key 值；這只能證明本次使用哪一份本機憑證，不能代替 provider 端撤銷證據。正式命令為：

```bash
DATABASE_URL="$(<~/.ccm-project-url)" npx tsx scripts/benchmark-v05.ts \
  --fixtures docs/auto-capture-v0.5/benchmark-fixtures.md \
  --embedding-key-file ~/.gemini-api-key
```

報告只有在 production DB 全部 active、非 `__personal__` 的 `project_memories` 與 `observations` embedding coverage 達 100% 時，才可能進入人工標註。claude-mem 10.5.2 的 search table 不含可驗證 Project 欄；runner 會透過其公開唯讀 `/api/session/:id` detail 補證 project、排除跨 project 候選後才取 Top-5，並在每題記錄 scope evidence。補證失敗時該題直接不可用，不把未驗證 title 寫入報告。

`observations[]` 依 spec 可在短 session 沒有高價值 durable fact 時合法為空。benchmark 只有在 rollup metadata 明確為 `observation_ids=[]`，且 DB active observation count 也為 0 時，才標 `legal-empty` 並保留給人工判讀；metadata／DB 不一致或真正 timeline/getObservations 失敗仍是 `PARTIAL`。2026-08-12 唯讀稽核發現 222 個 active capture rollup 中有 7 個合法空候選（discovery tokens 29–103）；對應 live/legacy spool 無 dead-letter，兩個仍有 current state 的同 session 其他 project 檔均 cursor 到 EOF、retry 為 0，其餘 sealed。目標 session 的一次舊 `CLAUDE_CLI_EXIT_NONZERO` retry 早於成功 rollup，且已封存為 v1 `.legacy`，不是 pending。不得因此 replay、archive 或從 search 隱藏這些合法 rollup。新 capture 會在 metadata 的 `empty_observation_windows` 留下 window range 與 `no_high_value_observations` 原因，且 replay 不重複。

先依 §5 將歷史 spool backlog 封存成獨立 epoch（世代目錄），讓新 capture 只寫新 epoch；不要求在正式啟用前把全部歷史資料跑完。之後只對核准的目標批次回放，再補算 embedding，避免一邊新增缺值、一邊掃描舊資料。

### 1.3 reminders 與 Todoist

- `~/.ccm-personal-url`：personal DB 連線字串，既有 personal-hub（個人中樞）部署沿用。
- `~/.ccm-reminders.env`：由 `ops/systemd/cc-memory-reminders.env.example` 建立，填入 `TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_CHAT_ID`，權限設為 `0600`。
- `~/.ccm-todoist-token`：Todoist token 原始文字檔，既有 personal-hub 部署沿用，權限維持 `0600`。

新 wrapper（包裝腳本）不讀 `~/.hermes/.env`，因此 Hermes 停用後不會失去執行環境。

### 1.4 project／personal DB 復原點

production canary 與停用 claude-mem 前，除了 spool archive，project 與 personal PostgreSQL 都必須有新鮮 custom-format dump。使用與 server 對齊的 `pg_dump` major version（主版本），backup dir `0700`、每個 dump `0600`；`pg_restore --list` 只驗 TOC，不足以證明資料段完整，還要以 `pg_restore --file=/dev/null` 完整走讀 archive。不得把連線字串寫進命令紀錄或備份檔名。

2026-08-12 實際證據：兩庫 server／client 均為 PostgreSQL 18.4、pgvector 0.8.3，public schema 都是 8 張表且欄位數一致；已建立並完整走讀：

- `~/backups/cc-memory/project-20260811T215639Z.dump`：8,222,774 bytes，`0600`
- `~/backups/cc-memory/personal-20260811T215639Z.dump`：126,542 bytes，`0600`

備份前基線：project `project_memories=224`、`observations=14006`；personal `project_memories=10`、`observations=0`。兩份 dump 隨後已實際 restore 到一次性本機 `pgvector/pgvector:pg18` container 的獨立空庫；兩側均恢復 8 張 public tables，pgvector 0.8.3 與上述 row counts 完全一致，container 結束後自動刪除且無殘留。真正災難復原仍依 `docs/personal-hub/prod-runbook.md`。

本機可還原不等於災難復原完成。canary 前須把兩份 DB dump 與 §5 產生且驗證通過的 backlog archive 複製到獨立於本機／同一磁碟的 offsite storage（異地儲存），再從異地副本核對大小與 SHA-256。不得把 DB URL、Gemini key 或其他秘密一併封裝。

2026-08-12 已建立 private Cloudflare R2 bucket `cc-memory-backups`，全 bucket 啟用 30 天 Bucket Lock（儲存桶鎖定）；限定該 bucket 的 Object Read & Write token 已實測 Put／List／Head，Delete 回 `409 ObjectLockedByBucketPolicy`。project 與 personal 已各完成一輪 fresh PostgreSQL 18 custom dump → `pg_restore --list` → `pg_restore --file=/dev/null` → age X25519 公鑰加密 → R2 全量讀回 size／SHA-256 比對 → manifest 最後提交：

- project：`backups/v1/project/2026/08/20260812T151738Z-d5fca92d3736a815.manifest.json`
- personal：`backups/v1/personal/2026/08/20260812T151757Z-62c55a8535f2361c.manifest.json`

兩份 manifest 的真實 freshness checker 結果皆為 PASS，完成時年齡約 0.01 小時。這只證明加密異地副本已 committed（提交完成）且遠端密文與上傳端一致；**尚未**證明私鑰 escrow（託管備援）或從 R2 完整下載、解密與 restore，因此 g1 仍不可轉 PASS。§5 的 immutable backlog archive 也仍須在正式 cutoff 後以相同原則加密上 R2；不得用接受 `file changed as we read it` 的 live tar 冒充一致性 snapshot（快照）。

### 1.4.1 每日 DB 備份與 freshness dead-man

`docker-compose.coolify.yml` 的 `backup` 是長駐 idle container（閒置容器）；每一套 project／personal Coolify compose 各自設定 `CC_BACKUP_TARGET`，並由 Coolify Scheduled Task 每日執行：

```bash
/app/cc-memory-backup.sh run
```

容器只持有 DB dump 權限、限定 R2 token、Telegram 告警設定與 age recipient 公鑰，**不得**放 age 私鑰。明文 dump 僅存在 2 GiB `/backup-tmp` tmpfs（記憶體暫存檔案系統）；腳本使用全域 flock、每輪 fresh destination、完整 archive 走讀、append-only object key（只新增物件鍵）及 full readback（全量讀回）驗證。任何一步失敗都不建立 manifest；30 天 lock 下的孤兒密文保留到期，不嘗試刪除。

primary dead-man（主要失聯監測器）的目標部署是 `ops/cloudflare-backup-monitor/` 的 Cloudflare Worker Cron，每小時第 17 分執行。它用 R2 binding 直接讀 bucket，不持有 S3 token；`TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_CHAT_ID` 必須用 Wrangler secret（秘密）注入，禁止寫進 `wrangler.jsonc`：

```bash
cd ops/cloudflare-backup-monitor
npm ci
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler deploy
```

Worker 對 project／personal manifests 使用與本機 checker 相同的 fail-closed contract（失敗即停止契約）；R2 list/get 例外、manifest 缺失／格式錯誤、recipient／cipher readback 不一致或 age >26 小時都發 Telegram 並讓 scheduled event 失敗。Cloudflare 與 R2 同平台故障時可能同時失去 storage 與 primary monitor，因此仍保留下列本機 timer 作 off-platform tertiary check（平台外第三線檢查），但它不能在 WSL／PC 關機時承擔 24/7 RPO 告警責任。

截至 2026-08-12，Worker 程式、20 項 focused tests（聚焦測試）與 Wrangler dry-run bundle 已通過，但尚未注入 secrets、正式 deploy 或完成 forced-failure 告警驗收；因此 24/7 primary 仍缺位，本機 timer 是目前唯一自動 freshness 監測，且 PC 關機時有告警空窗。

本機 freshness checker 每小時驗證兩個 target 最新 canonical manifest：

```bash
install -Dm644 ops/systemd/cc-memory-backup-freshness.service ~/.config/systemd/user/
install -Dm644 ops/systemd/cc-memory-backup-freshness.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start cc-memory-backup-freshness.service
systemctl --user enable --now cc-memory-backup-freshness.timer
```

它讀 `~/.ccm-r2.env`、`~/.ccm-memory-alert.env` 與 `~/.config/cc-memory/age-recipient.txt`，只在 project／personal 都具備 ≤26 小時、PostgreSQL 18 custom dump、指定 recipient、cipher/readback 一致的 manifest 時 PASS；同一故障 6 小時內不重複洗版，恢復時另送一次 Telegram。狀態檔只含 fingerprint（故障指紋）與時間，不含 token、URL、hash 或 recipient。

2026-08-12 23:31 Asia/Taipei 的安裝後驗收：`ConditionResult=yes`，`ExecMainStartTimestamp` 與 `ExecMainExitTimestamp` 均為該次實際執行時間，`Result=success`、`ExecMainStatus=0`；journal 明列 project／personal 兩側 PASS 與各自 `completed_at`／`age_hours`，不是 condition skip（條件略過）。monitor unit 刻意不設 `ConditionPathExists`：R2／alert env 或 recipient 缺失時必須讓 unit 明確失敗，不能靜默 skip。

RPO 必須分開陳述：DB 端災難的資料遺失窗 ≤24 小時（每日 dump 間隔）；本機故障時可能遺失尚未寫入 DB、只存在 active spool 的事件，窗口是 worker 停擺到告警與修復的時間，正常應為分鐘級。active spool 不做會把 live tar 誤當一致性的每日備份；若 worker 刻意 pause 數小時或 backlog 長期超出可容忍窗口，才另做與 §5 cutoff 同級的 verified immutable archive。

### 1.5 production approval marker

auto-capture 預設 fail-closed。只有人工批准一段有期限的 canary 時，才建立 `~/.ccm-auto-capture-production-approved`；空檔、`touch` 出來的檔案、錯 scope、未來批准或過期批准都無效。內容格式如下，時間一律用 UTC ISO 8601：

```dotenv
scope=auto-capture-prod
approved_by=haha
approved_at=2026-08-12T08:00:00.000Z
expires_at=2026-08-12T08:30:00.000Z
```

以編輯器建立後執行 `chmod 600 ~/.ccm-auto-capture-production-approved`。marker 必須是 `0600` regular file，不接受 symlink；不要把這個路徑加入 AI 可寫 allowlist（允許清單）。批准檔的建立、延長與撤除都由人操作，worker 不會自行延長或刪除 marker。supervisor 以實際解析出的 DB identity（資料庫身份：正規化 host、port、database path）與 canonical `~/.ccm-project-url` 比對，而非相信 URL 檔路徑；`projectUrl`、自訂 `CC_MEMORY_PROJECT_URL_FILE` 或 canonical URL 的逐字／常見等值複本仍須 marker。含多 host、encoded hostname（編碼主機名）、空 database path 或 `?database=` override（覆寫）的模糊 URL 直接拒絕；supervisor 也會移除 inherited（繼承而來的）`CC_FORCE_PROJECT_ID`、`DATABASE_URL_PERSONAL` 與 `PGHOST`／`PGPORT`／`PGDATABASE` 等 libpq-style（PostgreSQL 用戶端慣例）連線環境，避免 worker 改走未經 gate 的目標。這是防止誤操作的 interlock（安全連鎖），不是阻止有本機程式碼執行權限之操作者的完整安全邊界。

撤除批准不是只刪檔：Condition 只在啟動時評估，已在執行的 tick 最長仍可跑到 300 秒。正確撤除順序是先刪 marker，再停止既有 service：

```bash
rm ~/.ccm-auto-capture-production-approved
systemctl --user stop cc-memory-auto-capture.service
```

撤除不刪 spool、checkpoint 或 DB rows。若 marker 無效或過期，直接呼叫 supervisor 會非零退出，且在告警憑證可用時走既有 Telegram failure alert。

## 2. 安裝 systemd user units

以下是 2026-07-17 已執行命令的安全更新版；auto-capture 只有 service，沒有 timer。從舊 runtime gate 過渡時必須保持這個順序，避免安裝窗口被高頻 SessionStart／Stop kick 啟動：

```bash
# 1. marker 保持不存在；先驗 repo unit
test ! -e ~/.ccm-auto-capture-production-approved
systemd-analyze --user verify ~/CC_project/CC-memory/ops/systemd/cc-memory-auto-capture.service

# 2. 安裝持久 unit 並 reload
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-auto-capture.service ~/.config/systemd/user/cc-memory-auto-capture.service
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-reminders.service ~/.config/systemd/user/cc-memory-reminders.service
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-reminders.timer ~/.config/systemd/user/cc-memory-reminders.timer
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-todoist-sync.service ~/.config/systemd/user/cc-memory-todoist-sync.service
install -Dm644 ~/CC_project/CC-memory/ops/systemd/cc-memory-todoist-sync.timer ~/.config/systemd/user/cc-memory-todoist-sync.timer
systemctl --user daemon-reload

# 3. 必須看見 project URL 與 production approval 兩條條件都來自持久 fragment
systemctl --user cat cc-memory-auto-capture.service
systemctl --user show cc-memory-auto-capture.service -p FragmentPath -p DropInPaths

# 4. 嘗試啟動仍須因 marker 不存在而 skip
systemctl --user start cc-memory-auto-capture.service
systemctl --user show cc-memory-auto-capture.service -p ActiveState -p ConditionResult
journalctl --user -u cc-memory-auto-capture.service -n 20 --no-pager
```

只有上述四步證實 installed fragment 已有兩條 Condition 且 `ConditionResult=no` 後，才可清理 `/run/user/$UID/systemd/user/cc-memory-auto-capture.service.d/90-production-pause.conf` 與同目錄下指向 `/dev/null` 的無效 runtime mask，再 `daemon-reload` 並重做第 3、4 步。不得先清 runtime 防線再安裝。`systemd-analyze condition` 不能讀 unit 的完整條件集，不可拿它代替 start＋journal＋`ConditionResult` 驗收。

分別手動驗證 reminders 與 Todoist；auto-capture 必須先依 §1.5 建立有期限 marker，且只做一個 tick 的 canary。此時不啟用任何 timer：

```bash
systemctl --user start cc-memory-auto-capture.service
systemctl --user start cc-memory-reminders.service
systemctl --user start cc-memory-todoist-sync.service
journalctl --user -u cc-memory-auto-capture.service -n 50 --no-pager
journalctl --user -u cc-memory-reminders.service -n 50 --no-pager
journalctl --user -u cc-memory-todoist-sync.service -n 50 --no-pager
```

預期結果：reminders 與 Todoist 各完成一次輪詢。auto-capture 同時有 project URL、有效 marker 與可用告警設定時應產生健康 summary（摘要）；`CC_CAPTURE_MAX_SESSIONS_PER_TICK=1` 將 canary 限於一個可處理 session。正式 unit 固定設定 `CC_MEMORY_REQUIRE_ALERTS=1`，所以缺少或無效告警設定必須在 worker 前失敗；只有開發期直接呼叫 supervisor 時才有 optional 告警模式。canary 結束立即依 §1.5 撤除 marker 並 stop service。

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

## 5. 封存歷史 capture backlog，再按需回放

目前的歷史 backlog 不適合在 cutover 前全部 drain：大量 pathless terminal（缺路徑終止紀錄）本來就不可擷取，完整回放的 LLM 成本也遠高於正式啟用所需。主線是先把既有 spool 切成 historical epoch（歷史世代），新 hook 仍寫原本的 `~/.cache/cc-memory/spool` 路徑，但該路徑會原子切換為指向新 epoch 的 symlink（符號連結）。舊 epoch、其 spool archive（封存檔）、以及仍可讀的 transcript prefix（對話紀錄前綴）都保留，因此後續可以選擇性回放。

先做預設 dry-run。它會讀取並雜湊 spool 內容以產生批准綁定的 fingerprint（指紋），但不讀 transcript、不連 DB、不拿鎖、不寫檔：

```bash
cd ~/CC_project/CC-memory
npm run archive:capture-backlog -- --json
```

將輸出的 `spoolFingerprint` 填入短效批准檔；期限不得超過 24 小時，且批准後 spool 的既有內容若被改寫或截短會 fail-closed（安全失敗）：

```text
scope=capture-backlog-cutoff
approved_by=<operator>
approved_at=2026-08-12T02:00:00.000Z
expires_at=2026-08-12T04:00:00.000Z
spool_fingerprint=<dry-run output>
```

批准檔預設是 `~/.ccm-backlog-cutoff-approved`，權限設為 `0600`。execute（實際執行）會取得與 systemd 共用的鎖、切換 epoch、等待預設 10 分鐘，再做第二次完整掃描；舊 epoch 在等待期間有任何檔案數、內容、大小或時間變動都會中止，不產生「看似完成」的 archive。這是正式狀態變更，必須由操作人另行批准後才執行：

```bash
npm run archive:capture-backlog -- --execute
```

成功輸出會列出 `oldEpochDir`、`newEpochDir` 與 `archiveDir`。archive 內含 `spool.tar.gz`、`transcripts/`、`manifest.json` 與 `manifest.sha256`；verifier（驗證器）會實際解開 tar 到一次性目錄，逐檔比對 manifest 的相對路徑、大小、行數與 SHA-256。manifest 不保存 transcript 完整路徑，只保存路徑雜湊、需要的最大 byte boundary（位元組邊界）、快照狀態與內容雜湊。任何缺檔或短檔都明列為 unrecoverable（不可復原），不會冒充成功。舊 epoch 與 archive 都不可因 cutover 成功而刪除，且仍需另做 offsite copy（異地副本）。

如果輸出已顯示 spool symlink 指向新 epoch，但 settle、snapshot、tar 或 verify 隨後失敗，不要再次對目前的新 spool 執行一般 cutoff，也不要刪除 partial archive（不完整封存）。錯誤訊息中的 historical epoch 仍是資料真相；先確認新 spool symlink 正常，再對該 historical epoch 重新做指紋綁定的 resume：

```bash
npm run archive:capture-backlog -- \
  --resume-epoch-dir <historicalEpochDir> --json

# 以這次輸出的 fingerprint 重建短效 0600 批准檔後：
npm run archive:capture-backlog -- \
  --resume-epoch-dir <historicalEpochDir> --execute
```

resume 只 settle、封存與驗證指定 epoch，不再切換 symlink。若看到 `spool.cutoff-stray-*`，它是競態期間保留下來的資料，不得刪除；先確認其內容已合併進 historical epoch，無法確認時保留並升級人工處理。正式操作維持預設 600 秒 settle；`--allow-short-settle` 只供隔離測試或經另行風險批准的緊急診斷，不是正式 cutover 選項。

需要回放特定歷史 epoch 時，先以 dry-run 檢查分類；`--transcript-snapshot-dir` 只在明確指定時啟用，原始 transcript 遺失或比捕捉邊界短時才改讀封存快照：

```bash
npm run drain:capture -- \
  --spool-dir <oldEpochDir> \
  --transcript-snapshot-dir <archiveDir>/transcripts \
  --json

# 人工選定回放範圍、確認 DB／LLM provider／成本，並依 §1.5 建立
# 有效 production approval marker 後才加：--execute --max-minutes 30
```

foreground（前景執行）的 drain 不是 timer 或 daemon。execute 會在任何 env 注入、LLM／DB 載入或備份前，將實際 project URL 交給 §1.5 的 production DB identity gate；命中 production 而 marker 缺少、過期或不安全時直接以 preflight 失敗中止，隔離測試 DB 則不誤擋。通過後仍會先建立並驗證完整 spool tar 備份；缺 Gemini key 時允許擷取並寫入 `NULL` embedding，之後依 §1.2 補算；若 capture provider 是 `gemini-flash`，缺 key 會在 preflight 中止。

重要 exit code（退出碼）：`0` 全清、`1` preflight 失敗、`2` 連續 failure 斷路、`3` 共用鎖忙、`4` backup 失敗、`5` 有殘工可續跑、`6` 額度冷卻、`130` 收到停止訊號。worker 對同一 terminal retry 預設至少間隔 30 分鐘（`CC_CAPTURE_RETRY_MIN_INTERVAL_MS=1800000`），hold 不增加 attempt、不推進 checkpoint，且在 supervisor 中只屬資訊狀態；真正執行 retry 又失敗時輸出的 `retry-pending` warning 才會告警。不要為了加速設成 `0` 跑正式 backlog。

還原 epoch 指向時先停下會 quick-kick 的 Claude Code／Codex sessions，取得共用鎖並保留目前 symlink 與兩個 epoch，再以原子 symlink swap 指回原目錄，最後重新 dry-run。不要直接覆蓋或刪除目前 spool。DB 寫入由 content hash（內容雜湊）與 idempotency key（冪等鍵）防重，但還原前仍先保留現況，不刪除任何 spool 或 DB row。

## 6. 啟用 task timers 並切離 Hermes

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

## 7. 告警去重規則

- 同一 fingerprint（指紋）=`exitCode + first problem line`，dead-letter count（死信數量）不參與。
- 第一次失敗立即告警。
- 同 fingerprint 6 小時內不重複發送。
- 成功恢復後發一則 recovery（恢復通知），並清除 active failure（現行失敗狀態）。

runtime state（執行期狀態）位於：

```text
~/.local/state/cc-memory/auto-capture-alert-state.json
```

## 8. 注意事項與 rollback

- 手動跑 worker 必須經 supervisor 或自帶 `flock`（檔案鎖）；spool lock 的 stale（過期殘留）回收只處理 crash（異常終止）殘留，不保證活鎖互斥。
- auto-capture rollback（回復）：移除 SessionStart 新增項目；Stop 保留 sentinel append，再視需要暫時恢復原 Hermes memory job。不得同時啟用 Hermes memory job 與另一個 auto timer。
- auto-capture 緊急 pause：先移除 `~/.ccm-auto-capture-production-approved`，再 `systemctl --user stop cc-memory-auto-capture.service`；持久 unit 保留，讓後續 hook 因條件不成立而 skip。
- reminders／Todoist rollback：`systemctl --user disable --now <timer>`，確認停止後再恢復對應 Hermes job。
- 任何 rollback 都保留 spool、checkpoint（檢查點）與 DB 資料，不做破壞性清除。
- claude-mem 在 CC-memory 通過正式品質閘與 canary 後只 pause／disable capture（暫停／停用擷取），不 uninstall（解除安裝）、不刪 SQLite 或其他資料。套件、設定與資料無期限保留，直到使用者另行明確批准清理；rollback 時先停止 CC-memory 的新擷取，再恢復 claude-mem。這避免把「切換成功」誤當成資料刪除授權。

## 9. 正式啟用 Go／No-Go 清單

下列項目必須依序全部通過；任何一項未完成都是 No-Go，不能只因 unit、typecheck（型別檢查）或測試成功就停用 claude-mem：

1. **可復原性**：project／personal DB 有 canary 前的新鮮 dump，完整 restore 驗證通過；§5 historical epoch 與 archive 驗證通過；三者皆有已核對 SHA-256 的異地副本。
2. **秘密安全**：provider 端已撤銷暴露的 Gemini key；新 key 只存在核准的 `0600` regular file（一般檔案）且不是 symlink（符號連結），安全 credential loader（憑證載入器）檢查與兩張表 canary 均通過，輸出與文件沒有 key 值。
3. **品質閘**：收集至少 5 筆近 7 日、`query_surface='mcp'` 的真實 query，加上固定 5 組案例；production DB 全部 active 非個人語料 embedding coverage 必須為 100%，再以顯式的新 key file 跑完整 hybrid benchmark。claude-mem 對照須以公開 session detail 證明 project scope；人工標註者須知悉真實 query 的 self-selection caveat，並讓既定三項硬指標全部達標。只跑 keyword partial benchmark 不算通過。
4. **backlog 切代**：操作人以最新 dry-run fingerprint 建立短效批准，執行預設 600 秒 settle 的 cutoff；archive verifier 通過後才允許新 epoch 承接正式 capture。歷史 backlog 不要求在啟用前全部回放。
5. **單 tick canary**：先安裝 `0600` 告警 env、讓 `--test-alert` 實際送達，並在持久 unit 設定 `CC_MEMORY_REQUIRE_ALERTS=1`；任一條件未通過，canary 與觀察窗都不得起算。接著依 §2 更新並驗證 installed unit，建立短效 production marker，只允許 `CC_CAPTURE_MAX_SESSIONS_PER_TICK=1`；檢查 journal、DB project scope、capture 結果、`embedding-failed` 與告警，再立刻撤除 marker 並 stop。
6. **觀察與切換**：在另行核准的觀察窗內沒有資料錯置、重複寫入、持續 embedding failure 或未告警故障，才 pause claude-mem capture。保留其套件與資料，並記錄 rollback 操作；不做 uninstall 或資料刪除。

可隨時執行唯讀 readiness checker（就緒檢查器）彙整目前證據；它讀取 repo 與 installed systemd unit 全文做逐位元比對，並只讀其他使用者檔案的 metadata（中繼資料）及最新 timestamped canonical benchmark report（帶日期的正式基準報告）。它不讀 DB、不聯網、不呼叫 systemd、不建立 marker，也不讀任何 key／URL／token 內容：

```bash
npm run readiness:production
npm run readiness:production -- --json
npm run backup:freshness -- --json
```

exit code：`0` 只保留給所有 gate 都能由機器證明通過的情況；`1` 代表至少一項 `FAIL` 或 `PARTIAL`；`2` 代表沒有已證明失敗，但仍有 `BLOCKED`／`UNKNOWN`；`3` 是 CLI 使用錯誤。provider 端 key 撤銷、異地復原、人工 benchmark、cutoff 授權、canary 與觀察窗都不會因本機檔案或自我聲明而轉成 `PASS`，因此 checker 是 fail-closed advisory（安全失敗的輔助證據），不能取代本節人工簽核。

2026-08-12 的狀態：DB 本機備份與 restore、程式防線、focused tests（聚焦測試）、完整 suite（完整測試集）與 5 筆近 7 日 MCP 真實 query 已有證據；10 題 keyword baseline 也已完成。project／personal 的加密 DB 異地副本已 committed 到 R2 並通過 full readback，但 age 私鑰 escrow 與 R2 下載→解密→restore 演練尚未完成，因此不能宣稱異地可復原。暴露的舊 Gemini key 已由操作人撤銷，新 key 檔為 `0600` 並通過 1536 維 smoke test。最新報告證明 claude-mem 10/10 題可由公開 session detail 驗證 project scope，並揭露 production embedding coverage 僅 27/14,229；runner 會把非純 hybrid、coverage 非 100%、缺顯式 key evidence、scope 未證明或真實 query provenance 不完整的報告強制標為 `PARTIAL`。14,202 筆 backfill、正式 hybrid benchmark 與人工標註、正式 backlog cutoff、單 tick production canary、Cloudflare Worker primary dead-man、Coolify 每日備份排程及後續觀察窗仍未完成。故目前結論維持 **No-Go**。

### 9.1 相依套件安全基線

Node.js 支援下限已提升為 20，CI 與本機驗證採 Node.js 22。2026-08-12 的 `npm audit --omit=dev` 為 0 vulnerabilities（漏洞）；完整 `npm audit` 尚有 4 個 moderate（中等）且全屬 dev-only（僅開發期）鏈：`drizzle-kit@0.31.10` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → 舊版 `esbuild`。`drizzle-kit@0.31.10` 已是當時最新版，npm 提示降至 `0.18.1` 不是可接受修正；正式 runtime 不安裝 dev dependencies（開發相依套件），也不得把 migration／Vitest 開發服務暴露到網路。此項是有記錄的 upstream constraint（上游限制），不是 production 漏洞豁免；上游釋出安全版本後應升級並重跑 audit、typecheck、lint 與完整測試。
