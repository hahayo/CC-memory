# CC-memory cross-client memory-flow cutover

> 目的：讓 Claude Code 與 Codex 共用同一套 hook（事件掛鉤）語意，並把 memory、reminder 與 Todoist 執行責任完全移出 Hermes。
>
> 正式依據：`docs/decisions/DEC-20260716T092938Z-cross-client-hook-driven-memory-flow.md`。

## 0. 目標拓樸與目前狀態

| 流程 | 觸發方式 | systemd unit | Hermes 切換條件 |
|---|---|---|---|
| PostToolUse capture | 只 append 本機 spool；不啟動 worker | 無 | 不適用 |
| Stop capture | append sentinel 後，以 `systemctl --no-block` 快速啟動 | `cc-memory-auto-capture.service` | `cc-memory-auto-capture` 保持 paused；程式已備妥 codex-cli 主力 + claude-cli fallback（PR #19），但 Phase 7（安裝 unit＋marker＋canary）尚未執行，現行安裝仍為舊 unit（見 §2.5） |
| SessionStart capture | 每次快速啟動 backlog；注入由 feature flag（功能開關）獨立控制 | `cc-memory-auto-capture.service` | 不適用 |
| reminders | systemd timer 每 5 分鐘 | `cc-memory-reminders.{service,timer}` | 手動執行與一個 timer 週期均通過後才 pause |
| Todoist sync | systemd timer 每 15 分鐘 | `cc-memory-todoist-sync.{service,timer}` | 手動執行與一個 timer 週期均通過後才 pause |

auto-capture 不設 timer，也不做常駐 daemon（背景常駐程序）；service 是跑完即退的 oneshot（單次執行服務）。

> **Cutover status（2026-08-17 Asia/Taipei）**：五個 user-level（使用者層級）units 與 Claude Code／Codex SessionStart 已安裝；reminder／Todoist timers 均在運作，對應 Hermes jobs 已 pause。auto-capture Hermes job 也維持 pause。auto-capture installed unit 已更新為與 repo 逐位元一致：同時要求 `~/.ccm-project-url`、`~/.ccm-auto-capture-production-approved`，並固定 `CC_MEMORY_REQUIRE_ALERTS=1`；舊 unit 備份為 `~/.config/systemd/user/cc-memory-auto-capture.service.pre-20260812`。marker 缺失時的實際 start 驗收為 `inactive/dead`、`ConditionResult=no`，journal 明列 condition skip，worker 未執行；runtime pause drop-in（執行期暫停覆寫）目前仍保留。memory 專用 `~/.ccm-memory-alert.env` 已建立為 `0600`，`--test-alert` 已實際送達並由操作人確認。Cloudflare Worker 與 Coolify 每日雙 DB 排程已完成，且新 age（檔案加密工具）金鑰的 project／personal R2 備份均通過異地下載、解密與隔離還原；私鑰另存 Bitwarden（密碼管理服務）。2026-08-12 readiness audit（就緒稽核）確認資料量與併用時間已達門檻；近 7 日已透過本輪實際 MCP 工作查詢累積 5/5 筆 project-scoped `search_feedback`。10 題 keyword baseline benchmark（關鍵字基線測試）已完成，正式報告實測 production 非個人 active corpus 為 14,229 筆、只有 27 筆有 embedding；因此維持 **PARTIAL／No-Go**。暴露的舊 Gemini key 已由操作人在 provider 端撤銷，新 key 已安裝為 `0600` 並以 1536 dimensions smoke test（維度煙霧測試）通過；（2026-08-23 後記：embedding backfill 已 100% 完成；benchmark 與人工三硬指標降為 advisory、backlog 改為 copy-live 異地備份後從 live 續處理——停用 claude-mem 的條件改依 §9 替換版：canary → 觀察窗 → 使用者核准長跑。另 installed unit 的「逐位元一致」為 2026-08-17 對當時 repo 版本的紀錄；PR #19 改版後 installed unit 已落後 repo，Phase 7 需重新安裝。）

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

capture LLM（擷取用語言模型）即使選 `claude-cli`，寫入後的 embedding 仍獨立使用 Gemini。正式 supervisor 從 `~/.gemini-api-key` 載入 key；程式強制該路徑為 `0600` regular file（一般檔案）且拒絕 symlink（符號連結）。缺少或不安全時擷取仍會成功，但新資料的 embedding 為 `NULL`，supervisor 會輸出 `embeddings-disabled` 並把非 `ENOENT` 的 credential error（憑證錯誤）視為不健康 tick。若 key 已載入但 API 回傳空值或失敗，worker 仍保留 capture 的 NULL 降級語意，同時在 summary 增加 `embedding-failed=N`，supervisor 將其視為需要告警的異常；這可抓到已輪替、失效或填錯內容的 key。正式 backfill 不接受 `.env` 或 ambient `GEMINI_API_KEY`，規則見下方。

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

兩份 manifest 的真實 freshness checker 結果皆為 PASS，完成時年齡約 0.01 小時。這證明加密異地副本已 committed（提交完成）且遠端密文與上傳端一致；當時尚未完成私鑰 escrow（託管備援）與異地 restore。§5 的 immutable backlog archive 仍須在正式 cutoff 後以相同原則加密上 R2；不得用接受 `file changed as we read it` 的 live tar 冒充一致性 snapshot（快照）。

2026-08-14 重新執行原生 PostgreSQL 18 producer，project 與 personal 分別建立 `20260814T125919Z-6cf7e0a026c3a7ee`、`20260814T125934Z-44f61b67a002094e`；兩側均完成 R2 full readback，freshness checker 隨後由 stale FAIL 恢復為 PASS。

2026-08-17 因舊 age 私鑰無法尋獲而輪替金鑰；舊 R2 密文仍受 30 天 Bucket Lock 保留，但未找到舊私鑰前不可解密。新 recipient（加密接收公鑰）的 SHA-256 fingerprint（指紋）為 `ec2810bd6e8fb43d6936e100eb135dd962bcc0761eb683619c8dc1c417a89fea`。Coolify 已改用新 recipient，並建立下列新備份：

- project：`backups/v1/project/2026/08/20260817T011951Z-7604bcce047ca519.dump.age`
- personal：`backups/v1/personal/2026/08/20260817T012001Z-9fdec2426d6196a4.dump.age`

兩份密文均從 R2 完整下載，依 manifest 核對密文與明文 bytes／SHA-256，使用本機新私鑰解密，並以隔離的 PostgreSQL 18.4、`--network none`、tmpfs 容器完成實際 restore。project 還原為 8 張 public tables、224 筆 memories、14,006 筆 observations；personal 還原為 8 張 public tables、47 筆 memories、0 筆 observations，scope 分布符合預期。一次性容器與 `/dev/shm` 明文均已清除。新私鑰保留於本機 `0600` regular file，並以 Bitwarden Secure Note（安全筆記）完成異地託管；CLI 讀回內容的 SHA-256 與本機私鑰一致，完成後已鎖定保管庫並刪除暫存 session 檔。DB 異地復原證據已完成；g1 仍須等待 §5 historical epoch 與 backlog archive 完成。

2026-08-29 23:15 Asia/Taipei 起進入 Phase 8 觀察窗並直接以長跑 marker 運行（使用者拍板，偏離計畫「一天期觀察 marker → 核准 → 週期長跑」的三段接續）：使用者先建一天期 marker（首 tick 於 23:15:31 成功，summary `processed=1 primary-provider=codex-cli primary-success=1 fatal=0 windows=1`），隨後拍板改為**一年期** marker（理由：不願每週手動續期；仍保留到期自然停止的保險，未採「永久」）。Phase 8 七項檢查改以 personal task 提醒驅動：第 1／3／7 天（8/30、9/1、9/5 09:00 Asia/Taipei）各一則 Telegram 提醒，第 7 天檢查通過後才依 §9 替換版第 7 項決定 pause claude-mem。觀察窗基線：`observations=14034`、`project_memories=226`、spool 132 MB（2026-08-29T15:15Z）。canary 期「不調整預算鏈／不加 timer／不提高每 tick 數」的限制維持不變。

2026-08-29 Phase 7 第 10–12 步完成（單 tick canary）：短效 marker（30 分鐘）由操作人建立並 `chmod 600`；**踩雷**：首次以編輯器建立時權限為 `0664`，supervisor 以 `production approval marker must have mode 0600 (actual: 0664)` fail-closed 拒絕，worker 未執行——marker 的權限檢查是獨立於 systemd Condition 的第二道閘，建立後務必立即 chmod。權限修正後成功 tick 的 summary：`processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 blocked=0 transcript-missing=0 parked=0 yielded=1 held=0 embedding-failed=0 primary-provider=codex-cli primary-success=1 fallback-success=0 fallback-failed=0 fatal=0 spool-bytes=55367474 spool-cap-pct=11 windows=1`。DB 對帳：`observations` 14006→14007、`project_memories` 223→224，新列 `project_id=recycling-recognition`、key 為 `capture:v05:recycling-recognition:006120d9…`、embedding 非 NULL；`__personal__` 於兩表皆為 0 列。**四個實測量**：windows/tick=1（符合 `CC_CAPTURE_MAX_WINDOWS_PER_TICK=1`）；tick 實際耗時約 20 秒（17:40:44 啟動→17:41:05 完成，含 codex 呼叫）；kick 碰撞未觀察到 exit 75，但同期多次 SessionStart kick 以 `transcript-source-unavailable`（對應 session 的 transcript 已被清除）結束並回 exit 1，屬既有設計的 retry 語意（attempts=1/5、dead-letter=0）而非新問題；effective ticks/day 觀察起點＝2026-08-29 17:41。撤除依 §1.5 順序：先 `rm` marker 再 `systemctl --user stop`，事後確認 marker 不存在、無 worker 程序、`ConditionResult=no`、journal 回到 condition skip。

2026-08-29 Phase 7 第 2–9 步完成（unit 重裝與 fail-closed 驗收）：`systemd-analyze --user verify` 無輸出；`install -Dm644` 後 installed 與 repo 逐位元一致（diff 空）；`daemon-reload` 後 `FragmentPath=/home/haha/.config/systemd/user/cc-memory-auto-capture.service`、`DropInPaths=` 為空（無 runtime pause drop-in、無 `/dev/null` mask 殘留，故計畫第 8 步無事可做）；載入的 fragment 含兩條 `ConditionPathExists`（`%h/.ccm-project-url`、`%h/.ccm-auto-capture-production-approved`）、codex-cli 五行 Environment 與 `CC_MEMORY_REQUIRE_ALERTS=1`。marker 不存在時實際 `start` 驗收：`ActiveState=inactive`、`ConditionResult=no`，journal 明列 `skipped because of an unmet condition check (ConditionPathExists=/home/haha/.ccm-auto-capture-production-approved)`，worker 未執行。

2026-08-27 告警 hard gate 重驗：`npx tsx scripts/run-auto-capture-supervisor.ts --test-alert` 執行無錯誤，操作人確認 memory 專用 bot 實際收到 `CC-memory Telegram alert test`。`~/.ccm-memory-alert.env` 維持 `0600` 一般檔，正式 unit 內 `CC_MEMORY_REQUIRE_ALERTS=1`。三項告警前置全數通過。

2026-08-27 Phase 7 前置判定（使用者拍板）：canary 前**不另做手動 dump／restore**，沿用 §1.4.1 每日自動備份與 freshness dead-man 的現行證據——當日 `cc-memory-backup-freshness.service` 連續 PASS，project `completed_at=2026-08-26T19:00:31Z`、personal `completed_at=2026-08-26T19:30:08Z`，兩側皆為「fresh committed manifest with full ciphertext readback」，age 皆在 26 小時門檻內；最近一次完整異地 restore 演練為 2026-08-17（見上文）。理由：canary 只跑單一 tick、單一 session，資料面風險遠低於既有每日備份所涵蓋的範圍。此判定只適用於本次 canary；Phase 8 觀察窗結束、核准長跑前仍依 §9 替換版第 1 條重新確認復原證據。

### 1.4.1 每日 DB 備份與 freshness dead-man

production 實際拓樸是一套 Coolify PostgreSQL stack 內的 `cc_memory_project` 與 `cc_memory_personal` 兩個 DB。`docker-compose.coolify.yml` 因此提供兩個長駐 idle container（閒置容器）：`backup-project` 固定 `CC_BACKUP_TARGET=project`／`PGDATABASE=cc_memory_project`，`backup-personal` 固定 `CC_BACKUP_TARGET=personal`／`PGDATABASE=cc_memory_personal`。不得再用一個可由排程臨時覆寫 target／database 的容器，避免兩個排程都成功但實際重複備份同一個 DB。

在 Coolify Scheduled Tasks 建立兩筆每日排程，選對應 container，兩者 command 都是：

```bash
/app/cc-memory-backup.sh run
```

兩筆排程必須錯開至少 30 分鐘，並先確認 Coolify instance 使用的排程 timezone（時區）；`TZ=Asia/Taipei` 只控制容器內時間，不替 Coolify scheduler（排程器）改時區。兩個 service 各自擁有獨立 tmpfs 與 flock，因此腳本鎖只防同一 container 重入，不能阻止兩個 container 同時 dump。部署後須各觀察至少一個自動週期，確認兩個新 manifest 與 freshness checker 都 PASS。

全新建立或災難重建 stack 時，PostgreSQL image 只會自動建立 `POSTGRES_DB` 指定的 personal DB；啟用 `backup-project` 排程前，必須依既有 migration／restore 流程建立 `cc_memory_project`。`POSTGRES_DB` 不得偏離 `cc_memory_personal`。若 project DB 不存在，備份會 fail-closed 並告警，不會產生 manifest。

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

2026-08-13 已用獨立 account API token（帳號 API 權杖）正式部署 Worker；遠端狀態確認兩個 Telegram secrets 皆為 `secret_text`、R2 binding 指向 `cc-memory-backups`、Cron 為 `17 * * * *`。先以官方 `wrangler dev --remote --test-scheduled` 對真實 R2 驗證 26 小時門檻 HTTP 200 與極小門檻 HTTP 500；Fable 5 review 指出 preview 的臨時 secrets 不能證明正式 secrets 正確，因此再把正式 Worker 暫時部署為極小門檻。真實 Cron 於 18:17:12 Asia/Taipei 觸發，正式 tail 明列 `backup freshness gate failed` 而不是 Telegram 傳送錯誤；操作人已確認 Telegram 實際收到正式 alert。18:18 已立即用 repo 設定還原為 26 小時門檻，現行 version 為 `c4b00cfb-24e8-444f-bc6b-fe1615207917`，Cron、R2 binding 與兩個 secrets 均保留。一次性 `0600` preview secret 檔與目錄均已刪除，forced-failure 人工驗收完成。

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

### 2.5 Phase 7：codex-cli 主力 provider 安裝差異

下列 `Environment=` 行已寫入 `ops/systemd/cc-memory-auto-capture.service`（2026-08-23 更新）。重新安裝 unit 時複製整個 service 檔即自動套用：

```
Environment=CC_CAPTURE_LLM=codex-cli
Environment=CC_CAPTURE_LLM_FALLBACK=claude-cli
Environment=CC_CAPTURE_CODEX_MODEL=gpt-5.6-sol
Environment=CC_CAPTURE_CODEX_TIMEOUT_MS=90000
Environment=CC_CAPTURE_MAX_WINDOWS_PER_TICK=1
```

同時移除舊的 `Environment=CC_CAPTURE_LLM=claude-cli`（已不在 service 檔中）。安裝後需兩次 `daemon-reload` 並依 §2 步驟 3、4 重新驗證 fragment 與 ConditionResult。

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

### 5.0 未處理 backlog 的 copy-live 異地備份（canary 前的硬性 gate）

計畫 Phase 6 新增的「未處理 backlog 異地備份」走 **copy-live（唯讀快照）** 路徑，與下方 5.1 起的 epoch cutoff（世代切換）是兩條不同流程：copy-live **不改名 live spool、不切 epoch**，備份後仍從原 live backlog 繼續處理。canary marker 建立前必須完成本節兩步。

先做 dry-run 盤點（不取鎖、不寫檔）：

```bash
cd ~/CC_project/CC-memory
npm run archive:capture-backlog -- --copy-live
```

確認 `spoolFiles`／`spoolBytes` 合理後執行快照。它會取得與 worker 共用的全域 `flock`，先做容量預檢（公式：`(spool + 被引用 transcript 總量) × 2 + 1 GB` 餘裕），複製完成才釋放鎖，接著打包、驗證、依 `--copy-live-max-archives`（預設 2）保留最近數份：

```bash
npm run archive:capture-backlog -- --copy-live --execute
```

成功輸出含 `archiveDir` 與 `counts`。archive 目錄與 cutoff archive 採**同一組允許清單**：`manifest.json`、`manifest.sha256`、`spool.tar.gz`、`transcripts/`——打包後未壓縮的暫存 `spool/` 目錄會被刪除，因為上傳 CLI 的 allowlist 檢查不接受清單外的任何額外項目。`transcriptsUnrecoverable` 計入的是 spool 指向但原檔已不存在或已短於捕捉邊界的項目，屬既有已知現象，不中止流程。

接著沿用同一支上傳 CLI 建立加密異地副本；`--archive-dir` 指向上一步的 `archiveDir` 即可：

```bash
install -d -m 0700 /dev/shm/cc-memory-backlog-upload
CC_BACKLOG_UPLOAD_TMP_DIR=/dev/shm/cc-memory-backlog-upload \
  npm run upload:capture-backlog -- \
  --archive-dir <archiveDir> --json
```

上傳 CLI 依 manifest 自述的 `mode` 欄位選用驗證器：`mode: "copy-live"` 走 copy-live 驗證器（比對 `snapshotId`／`snapshotAt`），無 `mode` 欄位則視為 cutoff archive 走原驗證器（比對 `cutoffId`／`cutoffAt`）；`mode` 為其他值一律拒絕。提交到 R2 的 manifest 新增 `source_mode` 標明來源型態，`source_cutoff_id`／`source_cutoff_at` 兩個既有欄位名保留不變，copy-live 情況下承載的是 snapshot 的 id 與時間，因此既有讀取端不需改動。tmpfs 容量需求為 `archive 大小 × 3 + manifest 宣告的未壓縮 spool 大小 + 64 MB`——兩次驗證都會把 `spool.tar.gz` 解開到 tmpfs 逐檔比對，而 JSONL 壓縮率很高，只按 archive 大小估會在驗證中途 `ENOSPC`（磁碟空間不足）。容量檢查在任何驗證之前執行，不足即中止且不會產生半套上傳。以 2026-08-25 的實測為例：archive 4.6 GB、未壓縮 spool 約 125 MB，需求約 14.6 GB，`/dev/shm` 的 20 GB 足夠。

---


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

成功輸出會列出 `oldEpochDir`、`newEpochDir` 與 `archiveDir`。archive 內含 `spool.tar.gz`、`transcripts/`、`manifest.json` 與 `manifest.sha256`；verifier（驗證器）會實際解開 tar 到一次性目錄，逐檔比對 manifest 的相對路徑、大小、行數與 SHA-256。spool 內的安全空目錄可保留，但任何額外 regular file、symlink、hardlink 或 special entry 都會拒絕。manifest 不保存 transcript 完整路徑，只保存路徑雜湊、需要的最大 byte boundary（位元組邊界）、快照狀態與內容雜湊。任何缺檔或短檔都明列為 unrecoverable（不可復原），不會冒充成功。舊 epoch 與 archive 都不可因 cutover 成功而刪除，且仍需另做 offsite copy（異地副本）。

本機 archive verifier 通過後，使用專用 CLI 建立加密異地副本。它預設以 `O_NOFOLLOW` 讀取 `~/.ccm-r2.env` 與 `~/.config/cc-memory/age-recipient.txt`；R2 檔必須是 `0600` regular file，recipient 檔不得由 group／others 寫入，兩者皆拒絕 symlink。暫存打包、驗證解包、密文與全量讀回只放在 tmpfs；archive 與 tmpfs 路徑不得相同或互為祖先。CLI 取得全域 flock 後先清除固定前綴的舊 tmpfs run directory，再檢查本機 archive 的精確 allowlist、內層 tar 型態、私有檔案樹與容量；實際打包完成後會再解開並驗證一次，避免驗證與打包間的內容變動。R2 密文使用 `--immutable` append-only key，上傳後完整讀回比對 bytes／SHA-256，最後才提交 content-addressed manifest（內容定址清單檔）：

```bash
install -d -m 0700 /dev/shm/cc-memory-backlog-upload
CC_BACKLOG_UPLOAD_TMP_DIR=/dev/shm/cc-memory-backlog-upload \
  npm run upload:capture-backlog -- \
  --archive-dir <archiveDir> --json
```

成功輸出會列出 `objectKey` 與 `manifestKey`。`manifestKey` 內含 manifest 內容的 SHA-256；reader 必須先核對 key 內雜湊才可把它視為完成標記。密文或 manifest 讀回不一致時，R2 可能因 Bucket Lock 留下孤兒物件，但不會形成可通過雜湊驗證的完成標記。同一 run ID 重試不得覆寫既有物件，必須使用新的隨機 run ID。archive directory 必須維持 pristine，不得加入 receipt、README 或其他檔案；若要保存輸出收據，放在 archive 的 sibling directory（同層目錄），不可放進 archive。完成後仍保留本機 archive 與 historical epoch，不得因 R2 上傳成功而刪除。

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

下列七項必須依序全部通過；任何一項未完成都是 No-Go，不能只因 unit、typecheck（型別檢查）或測試成功就停用 claude-mem：

1. **可復原性（擴充）**：
   - canary 前 project／personal DB 新鮮 dump 且 restore 驗證通過（維持原條）
   - **新增**：未處理 spool 及其引用 transcript（對話紀錄）的唯讀、已驗 hash、異地備份完成（備份後仍從 live backlog 繼續處理）
   - **新增**：定義並執行 weekly full snapshot 與每月 restore drill，持續到 backlog 清零
2. **秘密安全**：新 Gemini key 為 `0600` 一般檔，且 Phase 2 沙箱（sandbox）三層驗收全過（L1 為作業系統層證據，L2 為事件流（event flow）證據）。
3. **告警 hard gate**：`~/.ccm-memory-alert.env` 為 `0600` 一般檔、`--test-alert` 實際送達並經操作人確認、持久 unit 內固定 `CC_MEMORY_REQUIRE_ALERTS=1`。**未過不得建立任何 marker。**
4. **品質（降為 advisory（參考用））**：benchmark 不再是啟用前置硬閘門；readiness checker（就緒檢查器）的相關文案與測試已同步更新為 advisory。
5. **營運契約**：Phase 6 的 marker 四段生命週期、spool sealed（密封）移出程序（含 70%/90% 告警）、以及 ETA（預估完成時間）的量測方法已定案並記錄；ETA 本身為條件式範圍，不列為承諾。
6. **單 tick canary**：依 Phase 7 全部 12 步（含 runtime mask 清除、兩次 daemon-reload 與兩次 fragment（單元片段）/condition（條件）檢查）。
7. **觀察窗**：建立一天期觀察 marker → Phase 8 全項通過 → 使用者本人核准長跑 marker → 才 pause claude-mem capture（保留其套件與資料，記錄 rollback（還原）操作）；不做 uninstall 或資料刪除。

可隨時執行唯讀 readiness checker（就緒檢查器）彙整目前證據；它讀取 repo 與 installed systemd unit 全文做逐位元比對，並只讀其他使用者檔案的 metadata（中繼資料）及最新 timestamped canonical benchmark report（帶日期的正式基準報告）。它不讀 DB、不聯網、不呼叫 systemd、不建立 marker，也不讀任何 key／URL／token 內容：

```bash
npm run readiness:production
npm run readiness:production -- --json
npm run backup:freshness -- --json
```

exit code：`0` 只保留給所有 gate 都能由機器證明通過的情況；`1` 代表至少一項 `FAIL` 或 `PARTIAL`；`2` 代表沒有已證明失敗，但仍有 `BLOCKED`／`UNKNOWN`；`3` 是 CLI 使用錯誤。provider 端 key 撤銷、異地復原、人工 benchmark、cutoff 授權、canary 與觀察窗都不會因本機檔案或自我聲明而轉成 `PASS`，因此 checker 是 fail-closed advisory（安全失敗的輔助證據），不能取代本節人工簽核。

2026-08-17 的狀態：DB 本機備份與 restore、程式防線、focused tests（聚焦測試）、完整 suite（完整測試集）與 5 筆近 7 日 MCP 真實 query 已有證據；10 題 keyword baseline 也已完成。project／personal 已用新 age 金鑰產生加密 R2 副本，通過 full readback、異地下載、解密與 PostgreSQL 18.4 隔離 restore；私鑰已在 Bitwarden 完成託管。Cloudflare Worker primary dead-man 與 Coolify 每日雙 DB 排程也已部署並驗證。暴露的舊 Gemini key 已由操作人撤銷，新 key 檔為 `0600` 並通過 1536 維 smoke test。最新報告證明 claude-mem 10/10 題可由公開 session detail 驗證 project scope，並揭露 production embedding coverage 僅 27/14,229；runner 會把非純 hybrid、coverage 非 100%、缺顯式 key evidence、scope 未證明或真實 query provenance 不完整的報告強制標為 `PARTIAL`。尚未完成 §5 backlog cutoff 與異地封存、14,202 筆 backfill、正式 hybrid benchmark、人工標註、單 tick production canary 及後續觀察窗。故 2026-08-17 當時結論為 **No-Go**。（2026-08-23 後記：Go/No-Go 紀律已拍板降級為 canary 制、benchmark 降 advisory——本段保留為歷史紀錄，現行上線條件見 §9 替換版。）

### 9.1 相依套件安全基線

Node.js 支援下限已提升為 20，CI 與本機驗證採 Node.js 22。2026-08-12 的 `npm audit --omit=dev` 為 0 vulnerabilities（漏洞）；完整 `npm audit` 尚有 4 個 moderate（中等）且全屬 dev-only（僅開發期）鏈：`drizzle-kit@0.31.10` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → 舊版 `esbuild`。`drizzle-kit@0.31.10` 已是當時最新版，npm 提示降至 `0.18.1` 不是可接受修正；正式 runtime 不安裝 dev dependencies（開發相依套件），也不得把 migration／Vitest 開發服務暴露到網路。此項是有記錄的 upstream constraint（上游限制），不是 production 漏洞豁免；上游釋出安全版本後應升級並重跑 audit、typecheck、lint 與完整測試。
