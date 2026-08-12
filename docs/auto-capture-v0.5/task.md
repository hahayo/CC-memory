# CC-memory v0.5 auto-capture Task Breakdown

> **對應文件**：[spec.md](spec.md) / [plan.md](plan.md)。
>
> **全域 Gate（關卡）基線**：每個 milestone（里程碑）第一條都必須確認現行全綠 **592 tests（2026-07-05 repo 基線，43 檔全綠；lint（靜態檢查）基準 0 errors / 4 warnings；test DB（測試資料庫）用 `docker-compose.test.yml` + `scripts/test-db-setup.ts`）不回歸**。
>
> **執行規則**：每個 milestone 開 `feature/v05-m<N>-<name>`；TDD（Test-Driven Development，測試驅動開發）順序是先測試檔、確認紅燈、再實作、再 Gate；Gate 過才 merge（合併）。本 task（任務清單）是未來實作清單，本輪文件起草不 commit（提交）。

---

# Pre-step 0：開工前確認

- [ ] 讀 `docs/auto-capture-v0.5/spec.md`
- [ ] 讀 `docs/auto-capture-v0.5/plan.md`
- [ ] 讀 `CLAUDE.md` 的術語註解規則與工具/env（環境變數）現況
- [ ] 啟動 test DB：`docker compose -f docker-compose.test.yml up -d`
- [ ] 套 test DB：`npx tsx scripts/test-db-setup.ts`
- [ ] baseline（基線）確認：`npm run build && npm test && npm run lint`
- [ ] 記錄實際 tests/lint 結果；若不是 592 tests / lint 0 errors 4 warnings，先更新本 task 的基線註記或查明原因

---

# M1：Schema + migrations 0011-0013

> 狀態：✅ 已交付（2026-07-08，PR #9-#18 merged）——checkbox 保留原樣作歷史紀錄

> 目標：新增 `observations` 表；不建 `pending_observations` 遠端 queue（佇列）；project/personal/test 三側欄位一致，並以 0012/0013 補 observations 分側路由 CHECK。

## 1a：Schema tests 先紅

- [ ] 建 branch：`feature/v05-m1-observations-schema`
- [ ] 新增測試 `tests/db/v05-observations-schema.test.ts`
- [ ] RED（紅燈）：測 `observations` 表存在、欄位存在、`vector(1536)`、status/type CHECK（檢查約束）、content unique index（唯一索引）
- [ ] RED：測 project/personal test DB 都能看到相同欄位集
- [ ] RED：測 `discovery_tokens > 0`
- [ ] RED：測 project test DB 的 `observations_no_personal_check` 拒 `__personal__`
- [ ] RED：測 personal test DB 的 `observations_personal_only_check` 拒 non-personal project_id
- [ ] 執行 `npx vitest run tests/db/v05-observations-schema.test.ts`
- [ ] 確認失敗原因是表不存在，不是 test harness（測試框架）錯誤

## 1b：實作 schema + migration

- [ ] 修改 `src/db/schema.ts` 新增 `observations`
- [ ] 產生或手寫 `sql/migrations/0011_add_observations.sql`
- [ ] 手寫 `sql/migrations/0012_observations_no_personal_check.sql`（project-only，不放 `schema.ts`）
- [ ] 手寫 `sql/migrations/0013_observations_personal_only_check.sql`（personal-only，不放 `schema.ts`）
- [ ] migration（資料庫遷移）含 `CREATE TABLE observations`
- [ ] migration 含 HNSW index（向量索引）與 project/session/status indexes
- [ ] migration 含 CHECK：type/status/discovery_tokens
- [ ] migration 不含 unrelated diff（無關差異）
- [ ] 更新 `scripts/test-db-setup.ts`：0011 套 project/personal test DB，0012 套 project test DB，0013 套 personal test DB
- [ ] 執行 `npx tsx scripts/test-db-setup.ts`
- [ ] 執行 `npx vitest run tests/db/v05-observations-schema.test.ts`

## 1c：三側矩陣驗證

- [ ] 新增或擴充 schema reflection（結構反射）測試：project/test personal 欄位一致
- [ ] 驗 personal DB 仍保留 0007 personal-only CHECK
- [ ] 0008 project no-personal CHECK 不在 M1 一般 test DB setup 驗；沿用既有 e2e 自套自清模式
- [ ] 驗 `__personal__` observation row 不會被 project test DB 接受（0012）
- [ ] 驗 non-personal observation row 不會被 personal test DB 接受（0013）
- [ ] 記錄新表為空，0012/0013 不需要 0008 當年的 maintenance window（維護窗口）順序

## M1 Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] `npx vitest run tests/db/v05-observations-schema.test.ts` 綠
- [ ] `sql/migrations/0011_add_observations.sql` 只含 additive schema（增量結構）與 indexes/CHECK
- [ ] `0012/0013` 是分側 CHECK，使用 `scripts/apply-migration.ts` 指定 DB 套用
- [ ] `_journal.json` 政策已依 [plan.md](plan.md) 記錄，不假裝 0007-0013 全由 journal 管
- [ ] Coolify project DB + personal DB 套 0011-0013 前 backup（備份）與 SSH tunnel（通道）health check（健康檢查）步驟已在部署記錄中

---

# M2a：Hook 端與 PostToolUse payload gate

> 狀態：✅ 已交付（2026-07-08，PR #9-#18 merged）——checkbox 保留原樣作歷史紀錄

> 目標：實測 hook payload（掛鉤輸入）與 transcript offset（逐字稿偏移），並實作 O(1) local spool append（本地緩衝附加）。

## 2a-1：Payload probe tests

- [ ] 建 branch：`feature/v05-m2a-hook-spool`
- [ ] 新增 `tests/scripts/probe-claude-hooks.test.ts`
- [ ] RED：模擬 PostToolUse payload 缺 tool name 時，probe 回 fail-fast report（快速失敗報告）
- [ ] RED：模擬 transcript offset 不穩時，probe 標記 fallback 需求
- [ ] 新增 `scripts/probe-claude-hooks.ts`
- [ ] GREEN：產出 machine-readable JSON report（機器可讀報告）

## 2a-2：Spool append tests

- [ ] 新增 `tests/services/capture-spool.test.ts`
- [ ] RED：100 個 concurrent append（並行附加）不能破 JSONL 行
- [ ] RED：新 spool file 權限必須 0600，目錄 0700
- [ ] RED：project/session path 必須 sanitize，不能寫出 spool root（根目錄）
- [ ] RED：hook 寫入錯誤必須被吞掉且回 success（成功）
- [ ] RED：`CC_MEMORY_SKIP_TOOLS` 設定後是整個覆蓋預設清單，不是 union（聯集）

## 2a-3：Hook wrapper

- [ ] 新增 `src/services/capture-spool.ts`
- [ ] 新增 `hooks/post-tool-use-capture.sh`
- [ ] 新增 `hooks/stop-capture-sentinel.sh`
- [ ] PostToolUse 只寫 thin event：session/project/tool/timestamp/transcript offset
- [ ] Stop 只寫 sentinel：transcript_path + hwm_offset
- [ ] SKIP_TOOLS 預設：`ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion`
- [ ] SKIP_TOOLS 在 hook 端只做廉價集合判斷；`CC_MEMORY_SKIP_TOOLS` 整體覆蓋預設；完整節流留給 worker（工作程序）
- [ ] 手動測 hook wrapper 在無 DB/無網路時仍 exit 0

## M2a Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] `scripts/probe-claude-hooks.ts` 對 Read/Edit/Bash 三種 tool use（工具呼叫）與 Stop sentinel 都 PASS
- [ ] PostToolUse hook p95 <20ms（本機 100 次 sample）
- [ ] Hook 網路斷線/DB 無法連線時仍只寫本地或吞錯
- [ ] 產出 settings draft（設定草稿），不直接改使用者 `~/.claude/settings.json`

---

# M2b：Cron worker + LLM extraction

> 狀態：✅ 已交付（2026-07-08，PR #9-#18 merged）——checkbox 保留原樣作歷史紀錄

> 目標：worker 從 spool harvest（收割）batch（批次），一次呼叫 capture LLM（預設 claude-cli；2026-07-07 拍板前為 Gemini Flash），驗證 JSON schema（結構），寫 rollup + observations。

## 2b-1：Worker failure tests

- [ ] 建 branch：`feature/v05-m2b-capture-worker`
- [ ] 新增 `tests/services/capture-worker.test.ts`
- [ ] RED：DB health check fail 時不呼叫 LLM（大型語言模型）
- [ ] RED：LLM malformed JSON（格式錯誤 JSON）整包進 dead-letter（死信），DB 無寫入
- [ ] RED：DB transaction（交易）失敗時 HWM（high-water mark，高水位）不前進
- [ ] RED：同 spool 重跑不重複寫 observations
- [ ] RED：同 session 兩個 harvest window 只產生一筆 active rollup
- [ ] RED：rollup `metadata.capture.discovery_tokens` 寫入時已存在

## 2b-2：LLM adapter

- [ ] 新增 `src/services/capture-llm.ts`
- [ ] `CC_CAPTURE_LLM` 預設 claude-cli（2026-07-07 拍板；原 Gemini Flash 交付後變更，gemini-flash 保留可切）；`CC_CAPTURE_CLAUDE_MODEL` 預設 haiku
- [ ] provider 不可用（claude CLI 不存在／gemini 缺 `GEMINI_API_KEY`）時靜默停用 capture，stdout 告警
- [ ] schema validation：必須一次回 `{ session_summary, observations[] }`
- [ ] validation fail metadata 含 session id、offset、錯誤碼、模型名、content hash；不含全文 transcript
- [ ] 新增或共用 `estimateDiscoveryTokens()`，供 rollup 寫入時保存 `metadata.capture.discovery_tokens`

## 2b-3：DB write path

- [ ] 新增 `src/services/capture-worker.ts`
- [ ] rollup 寫 `project_memories(type='session')`
- [ ] rollup `idempotency_key` 固定為 `capture:v05:<project>:<session>`，不含 hwm
- [ ] 既有 rollup 走 upsert update：summary 重生成或合併、embedding 重算
- [ ] observations 寫 `observations`
- [ ] rollup `metadata.capture.observation_ids` append drill-down ids（下鑽識別）
- [ ] rollup `metadata.capture.summarize_count` 遞增，`metadata.capture.spool_offsets` append
- [ ] rollup `metadata.capture.discovery_tokens` 寫入時計算；M4 注入器只讀此值
- [ ] embedding（向量嵌入）走 `src/utils/embedding.ts`；失敗可 NULL
- [ ] writer_host 走既有 `resolveWriterHost()`

## 2b-4：Worker entrypoint（歷史交付清單）

- [ ] 新增 `scripts/run-auto-capture.ts`
- [ ] 起手 health check SSH tunnel/project DB
- [ ] spool lock + HWM + rotation
- [ ] stdout summary：processed/skipped/dead-letter counts
- [x] hermes cron draft 已退役；現行由 Stop／SessionStart quick-kick systemd oneshot，auto-capture 不設 timer（2026-07-16 decision）

## M2b Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] DB tunnel down：worker exit 0/非破壞，spool 未前進，LLM 未呼叫
- [ ] malformed LLM output：第 1-4 次 hold（HWM hold、不落 DB）；第 5 次 park（dead-letter 有 metadata、HWM 前進越過該窗）；DB 無半包資料
- [ ] 成功 batch：rollup + observations 同 transaction 寫入
- [ ] 重跑同 batch：不重複 observations
- [ ] 同 session 多個 batch：仍只有一筆 active rollup，observations append-only
- [ ] cron draft 經 user review 才落地

## 2b-R：2026-07-15 parked-window／資料遺失可靠性修復

> 狀態：✅ capture state v2 與資料完整性修復完成；⚠️ 後續發現 Claude CLI 抽取仍有 timeout retry，Hermes memory job 已於 2026-07-15 再次暫停，等待 2b-S 根治驗證與獨立 Telegram bot 切換。

- [x] 以 `.capture-state.json` version 2 取代 active `.hwm` 語意，原子保存 generation、spool cursor、per-path checkpoint 與 retry entries
- [x] legacy `.hwm` 由已消費 spool prefix 重建 checkpoint；`.hwm`/`.retry.json` 改名封存，舊 attempts 歸零
- [x] 依 spool byte order 處理多 transcript path；無 Stop sentinel 的 child path 只到最後 PostToolUse offset；rollup/observation 維持母 session ID
- [x] 原始 transcript bytes 先做 UTF-8 安全 chunking，再移除 injection marker
- [x] chunk transaction commit 後立即保存 checkpoint；完整 snapshot 後才推進 spool cursor
- [x] tick budget 回 `yielded`，不增加 retry、不寫 dead-letter；summary/alert 將 `yielded` 視為正常、`parked` 視為異常
- [x] 第 5 次只 dead-letter 失敗 chunk、越過該 chunk 並停止 session 本 tick；後續 range 下輪繼續
- [x] 有效 transcript path 不可讀／短於 boundary 時，以穩定 key 重試 5 次後只隔離該 range；每次輸出 sanitized warning（去識別警告），來源完整恢復才清除 retry；null/空 path 維持 informational
- [x] rollup metadata 新增可合併 `transcript_sources`；已覆蓋 range 重播跳過所有 DB 寫入，保留 `spool_offsets`
- [x] rotation 僅在末筆為 Stop sentinel 時同步 seal generation state；活躍大 spool 不輪替；state 權限 0600、損壞時 fail closed
- [x] 新增 `scripts/audit-auto-capture-recovery.ts`，只寫 `/tmp` 且固定 `would_replay: false`
- [x] targeted worker/alert/recovery tests：69 tests PASS（2026-07-15）
- [x] `npm run typecheck && npm run lint && npm run build && npm run test:ci && npm run decisions:validate`（59 files／851 tests PASS）
- [x] isolated fake runtime（隔離假執行環境）：worker targeted suite 51 tests、alert/recovery 合計 18 tests PASS
- [x] 正式 Claude CLI Haiku 多路徑／多 chunk canary：6 chunks／2 paths／9 observations／1 母 session rollup，0 failed/dead-letter/parked/yielded/rate-limit，state 0600（隔離 spool + test DB，2026-07-15）
- [x] Claude Code `claude-fable-5` 唯讀 review：早期 600s/300s/600s 因 runner 固定 max effort 而逾時；改用 1800s 後首輪找到「有效 transcript 來源遺失會永久卡住 spool」Important，debate 收斂為穩定重試 5 次後只隔離該 range，實作後第 3 輪 targeted re-review 明確 PASS，無 Critical/Important。結果 `/tmp/ai-review-claude-2026-07-15T04-03-14-193Z.md`、`/tmp/ai-review-claude-2026-07-15T04-24-22-735Z.md`、`/tmp/ai-review-claude-2026-07-15T04-43-44-610Z.md`
- [x] 初次恢復 job 後三次完整 worker tick 無新增同類 parked/dead-letter：三輪既有 `flock` wrapper 均靜默完成，dead-letter 維持 57 筆且檔名集合 hash `d8987f424192f790dfcacd01c4d1e807c7263f86b12d6b947f148f92733e6cf1` 不變，hard-timeout log 未更新；其後因新發現的 timeout retries 與通知通道要求，Hermes job `3fb444d5e112` 已再次 pause（2026-07-15）

## 2b-S：2026-07-15 Claude CLI timeout 根治與告警切離

> 狀態：🚧 repo 內 cross-client（跨客戶端）hooks 與 systemd units 已實作；production cutover（正式切換）等待憑證、設定草稿人審與 user-level 安裝。

- [x] 量化近 360 分鐘 capture child：192 次完成、11 次 75s timeout；timeout transcript 皆只有 user event、零 assistant event／零結構化 API error
- [x] 確認主要成本為每次約 44K cached input tokens 的 Claude Code 預設上下文，加上未約束的長輸出；排除同一 chunk 無限重試、API 529、MCP 初始化與權限阻擋
- [x] Claude CLI 改為 `--safe-mode --tools '' --no-session-persistence --strict-mcp-config --system-prompt ... --json-schema ...`；保留 Haiku 與 75s
- [x] 原生 structured output 優先解析，舊 `result` 字串保留相容；schema 最多 8 個合併 observations 並限制欄位大小
- [x] 112,450-byte synthetic worker canary 以舊 96 KiB policy 在 24 秒完成；production 首輪仍於第 5 個 96 KiB chunk timeout，據此把 Claude 預設降為 32 KiB，timeout／prompt-too-long 大 chunk 自動二分且不計 terminal attempt
- [x] state 載入與 checkpoint 前進時清除已覆蓋舊 retry，避免 chunk policy 改變後留下永遠不會再命中的 key
- [x] timeout／prompt-too-long 的 split tree 持久化在 v2 `splitHints`；budget yield 後下輪直接從較小 leaf 繼續，checkpoint 覆蓋父 range 後清除 hint，避免隱性 livelock
- [x] 修正 checkpoint 前進後新 parent range 遮蔽舊 leaf 的邊界：內容 hash 驗證後優先最小 nested／ancestor boundary，直接接續 sibling；兩個回歸測試均先重現失敗再通過
- [x] 找出 240s tick 可在尾端啟動 75s call、被 270s wrapper hard-kill 的 budget 缺口；每次 Claude call 前新增 timeout+15s reserve，不足即正常 yielded 並釋放 lock
- [x] production split hint 深化到 4 KiB 仍出現 75s call，確認剩餘瓶頸非輸入大小；抽取 CLI 明確指定 `--effort low`，不繼承互動式 coding agent 的高思考成本
- [x] 每次真實 terminal retry 輸出去識別 `retry-pending` warning，第一次就由 supervisor 視為異常；budget yield 維持正常進度
- [x] retry hold 僅為資訊狀態，不製造 failure／recovery 告警乒乓；跨 tick `held → ok → held` 已有回歸測試（2026-08-12）
- [x] cap=1 時純 held session 仍推進 round-robin cursor，但不消耗本 tick 唯一處理名額；同 tick 可繼續處理下一個 ready session（2026-08-12）
- [x] supervisor 新增 `--test-alert`，只測 memory 專用 Telegram bot，不讀 DB、不跑 worker、不改 alert state
- [x] supervisor 直接呼叫時告警缺失預設 soft-disable（軟停用）；repo 正式 systemd service 固定設定 `CC_MEMORY_REQUIRE_ALERTS=1`，缺少或無效告警設定會在 worker 前 hard gate（硬性阻擋）（2026-08-12）
- [x] production approval guard 改以實際 DB identity 對 canonical production URL，比對時忽略密碼與非 routing query parameters 並正規化 loopback；顯式 URL、自訂 URL 檔或常見等值複本皆須 marker，multihost／encoded hostname／空 database path／`?database=` override fail-closed。marker 同 descriptor 驗 regular file／`0600`／`O_NOFOLLOW`；supervisor 移除 inherited `CC_FORCE_PROJECT_ID`／`DATABASE_URL_PERSONAL` 與 PG 連線目標環境，避免 worker 改走未經 gate 的 DB。focused tests 39/39 PASS（2026-08-12）
- [x] Gemini embedding 憑證與 capture provider（擷取供應者）解耦；缺 key 明確警告但不阻斷 capture（2026-08-12）
- [x] 已載入 embedding key 但 rollup／observation 產生向量失敗時，capture 仍寫 `NULL`，同時累加 `embedding-failed` summary 並由 supervisor 視為可告警異常；刻意無 key 的降級不誤計（2026-08-12）
- [x] embedding backfill 支援 observations、預設 dry-run、鍵集分頁、RPM 節流與連續失敗斷路；dry-run 預設 batch 1000、execute 維持 10，正式 DB 4.59 秒掃描 14,202 筆且零 API／零寫入（2026-08-12）
- [x] embedding backfill execute 強制顯式 `--key-file`，共用 benchmark 的 `O_NOFOLLOW`／regular file／`0600` 憑證載入器，隔離 `.env` 與 ambient `GEMINI_API_KEY`，只輸出非機密 key identity evidence（身份證據）；focused tests 11/11 PASS（2026-08-12）
- [x] 新增唯讀 `readiness:production` checker，六個 gate 一對一鏡射 cutover runbook；只讀安全 metadata 與正式 benchmark 報告，unit 漂移／Node 版本／檔案權限可自動 FAIL，外部撤銷、異地復原、人工評分、cutoff／canary／觀察不接受檔案存在或自我聲明漂綠（2026-08-12）
- [x] 以本輪 5 個實際 CC-memory MCP 工作查詢補足近 7 日真實 query 5/5，production `search_feedback` 唯讀複核皆為 `query_surface=mcp`、`query_project_id=CC-memory`；完成 10 題 keyword baseline，並新增 hard gate 讓非純 `hybrid` 報告一律維持 `PARTIAL`（2026-08-12）
- [x] benchmark 正式證據鏈 fail-closed：real query SQL 強制 `query_surface='mcp'` 並輸出 mode／timestamp provenance 與 self-selection caveat；claude-mem 搜尋候選透過公開 `/api/session/:id` detail 驗 project 後才取 Top-5；production 全部 active 非個人語料 embedding coverage 未達 100%、缺顯式 0600 regular key file identity 或任何 scope 未證明時一律 `PARTIAL`。2026-08-12 唯讀實跑為 27/14,229，待 backfill 14,202（2026-08-12）
- [x] benchmark legal-empty 三態：spec 合法的 `observations=[]` 只有在 rollup metadata `observation_ids=[]` 與 DB active count=0 一致時不算 drill-down error；metadata/DB 不一致或 timeline 真失敗仍強制 `PARTIAL`。正式 DB 222 個 active capture rollup 中 7 個零 observation（29–103 discovery tokens），spool/dead/retry 唯讀稽核無 pending 兄弟 chunk；不 replay、不 archive、不從搜尋隱藏。新 worker metadata 以 replay-idempotent `empty_observation_windows` 記錄 range 與 `no_high_value_observations` 原因（2026-08-12）
- [x] foreground backlog drain：預設 dry-run、共用 flock、強制可驗證 backup、30 分鐘 retry gate、failure／429／idle 斷路與 exit code 契約；execute 在任何 side effect 前共用 supervisor 的 production DB identity／approval marker gate，隔離 DB 不誤擋。focused drain＋supervisor tests 50/50 PASS（2026-08-12）
- [x] 正式 spool 復原點 `spool-2026-08-11T21-42-01.641Z.tar.gz` 已完整解壓到隔離 `/tmp`：17,539 個 JSONL／18,274 個檔案／36,781,770 bytes，tar/gzip 無錯誤；archive 已收緊為 `0600`、backup dir 為 `0700`，後續建立流程亦有權限回歸測試；此證據只涵蓋備份時間點，不宣稱包含後續 hook append（2026-08-12）
- [x] project／personal DB 新鮮 custom dump 已建立為 `0600`，兩庫均以 PostgreSQL 18.4 `pg_restore --list`＋`--file=/dev/null` 完整走讀，並實際 restore 到一次性本機 PG18＋pgvector 0.8.3 空庫；兩側皆恢復 8 張 public 表，project 224 memories／14,006 observations、personal 10／0，與備份前基線一致，container 已自動刪除（2026-08-12）
- [x] R2 加密備份 producer 已以 TDD（測試驅動開發）落地：project／personal fresh PostgreSQL 18 custom dump 只在 tmpfs 保留明文，完整走讀後以 age X25519 公鑰加密，append-only 上傳、全量讀回 SHA-256／size 比對，manifest 最後提交；focused tests 9/9、固定 digest image build 與實容器工具鏈驗證 PASS，Fable 5 code review＋targeted re-review 收斂 PASS（2026-08-12）
- [x] project／personal 真實 R2 committed manifests 已建立，freshness checker 實測兩側 PASS；本機 hourly systemd timer 已安裝且 `Result=success`／`ExecMainStatus=0`，作 off-platform tertiary check（平台外第三線檢查）（2026-08-12）
- [ ] Cloudflare Worker Cron primary dead-man 已完成程式與 dry-run bundle（20/20 focused tests），但尚缺 Wrangler deploy 認證、兩個 Telegram secrets 注入、正式 deploy 與 forced-failure 告警驗收；未完成前不得把 dead-man gate 標成 PASS
- [x] Stop sentinel 落盤後 quick-kick `cc-memory-auto-capture.service`；SessionStart 在 injection flag off 時仍 quick-kick；PostToolUse 維持只 append；Claude Code／Codex 共用相同 wrappers
- [x] hook contract tests（契約測試）覆蓋 Stop 順序、SessionStart flag off、recursion breaker（遞迴中止）、PostToolUse 不啟動及 systemctl fail-open
- [x] PostToolUse／Stop 缺少 `transcript_path` 時不寫入 spool；Stop 只有 sentinel 成功落盤才 quick-kick（2026-08-12）
- [x] PostToolUse／Stop 缺少 `session_id` 時 fail-open 但不寫入共同 `unknown.jsonl`，避免 payload 漂移把多個 session 合併成同一 rollup；hook contract tests 11/11 PASS（2026-08-12）
- [x] 移除 `cc-memory-auto-capture.timer`；新增 reminder 5 分鐘與 Todoist 15 分鐘的 systemd services/timers 及獨立 wrappers，不讀 `~/.hermes/.env`
- [x] `systemd-analyze verify` 驗證 auto-capture service、reminder/Todoist services 與兩個 task timers 通過；targeted tests 5 files／17 tests PASS（含 wrapper runtime 與 Telegram channel；2026-07-17）
- [ ] memory 專用 bot 憑證寫入 `~/.ccm-memory-alert.env`（0600），執行 `--test-alert` 並確認收件
- [x] 建立 `~/.ccm-reminders.env`（0600），並確認既有 `~/.ccm-personal-url`、`~/.ccm-todoist-token` 均為 0600（2026-07-17）
- [x] 人審設定草稿，備份後把 SessionStart hook 追加到 Claude Code 與 Codex；JSON／TOML 解析 PASS（2026-07-17）
- [x] Codex 的 SessionStart／PostToolUse／Stop hooks 已在 `~/.codex/hooks.json` 安裝，對應 `hooks.state` 均為 enabled 且有 trusted hash（2026-08-12 唯讀複核）
- [x] 安裝五個 user systemd units；reminder／Todoist 手動 services PASS。auto-capture 不 enable timer，只由 Stop／SessionStart 驅動（2026-07-17）
- [x] auto-capture installed unit 更新為 repo 審查版並保留舊版備份；daemon-reload、逐位元比對與 marker 缺失 start-skip 實測 PASS（inactive/dead、ConditionResult=no、journal 明列 unmet condition），Fable 5 維運複審 NO BLOCKERS（2026-08-12）
- [x] 三個 user service 移除 `/home/haha`，改用 `%h`；auto-capture lock 與 archive/drain CLI 同源，fresh home 先建 cache dir，lock-busy exit 75 視為正常不製造 failed unit。三個 installed units 已在 runtime pause 與 marker 缺失下同步、daemon-reload、逐位元比對 PASS；auto-capture 維持 inactive/dead，Fable 5 targeted re-review `FIXED / NO BLOCKERS`（2026-08-12）
- [x] enable reminder／Todoist timers；17:15 首輪均 PASS，17:17 確認對應 Hermes jobs 已 pause（2026-07-17）
- [x] 以正式 spool 跑超過三次完整 tick：active retry 由 7 降至 3，目標 checkpoint `446274 → 450314 → 453526 → 455136 → 461156`，舊 attempts 維持 3、dead-letter 維持 57、hard-timeout 最後紀錄仍為 19:29:15；Hermes memory job 保持 pause

---

# M3：3 層 retrieval

> 狀態：✅ 已交付（2026-07-08，PR #9-#18 merged）——checkbox 保留原樣作歷史紀錄

> 目標：search（搜尋）輕索引化，不破 `SearchResultEnvelope`（搜尋結果信封）；新增 timeline（時間軸）與 batch get（批次取得）。

## 3a：Search contract tests

- [ ] 建 branch：`feature/v05-m3-retrieval`
- [ ] 擴 `tests/services/memories.test.ts`
- [ ] RED：v0.5 index results 的 `rankingMeta.rankPositions.length === results.length`
- [ ] RED：`scores !== null` 時長度一致
- [ ] RED：`recordSearchQuery` 可吃 v0.5 search envelope 並寫入既有 9+ 欄
- [ ] RED：`CC_MEMORY_INCLUDE_OBSERVATIONS=off` 只回 `project_memories`
- [ ] RED：mixed corpus ranking 預設權重 manual > rollup > decision observation > other observation

## 3b：Observation retrieval service

- [ ] 新增 `src/services/observations.ts`
- [ ] `searchObservationIndexes(db, input)` 回輕索引：id/type/title/subtitle/project/session/discovery_tokens
- [ ] `timeline(db, anchorId, depthBefore, depthAfter)` 只回同 project 且同 session 前後 observations
- [ ] anchor 是 rollup 時，timeline 先找 linked observations，再依 `observed_at` 回前後文
  - ✅ **RESOLVED（2026-07-06 M2b 開工定案）**：採「worker 賦值單調紀律」，**不加 offset 欄位**。`observed_at` = harvest window 處理時間 + 窗口內 LLM 輸出序號毫秒微增量（tie-break）；跨窗口天然單調（後處理窗口時間更晚）；**禁止直接抄 transcript entry timestamp**。否定 additive offset 欄位案的理由：observation 級 byte offset 無可靠來源（LLM 抽取時看不到 offset，worker 只知 window 級），window 級 offset 與窗口處理時間等價，加欄位徒增 schema。M2b worker 2b-3 實作此紀律並附測試。
- [ ] `getObservations(db, ids[])` 批次回全文
- [ ] archived observation 不回
- [ ] ScopePolicy 必須套 project guard

## 3c：MCP tools

- [ ] 修改 `cc_memory_search` handler 顯示 rollup/observation index，不 dump narrative 全文
- [ ] 新增 `cc_memory_timeline`
- [ ] 新增 `cc_memory_get_observations`
- [ ] tool descriptions（工具說明）不得引用 claude-mem prompt 文字
- [ ] allowlist 對 read tools 生效

## M3 Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] `cc_memory_search` 既有 consumer（消費端）測試不破
- [ ] `search_feedback` 陣列長度 CHECK 仍綠
- [ ] search → timeline → get_observations 可完成同一 query drill-down
- [ ] `CC_MEMORY_INCLUDE_OBSERVATIONS=off` 回退到 rollup/manual only
- [ ] 預設權重可由 `CC_MEMORY_WEIGHT_*` 覆蓋，parse 失敗回預設

---

# M4：SessionStart injector + discovery_tokens

> 狀態：✅ 已交付（2026-07-08，PR #9-#18 merged）——checkbox 保留原樣作歷史紀錄

> 目標：Recent Activity 輕索引注入，預設 off；每列標 discovery_tokens（載入成本）。

## 4a：Token estimator acceptance tests

- [ ] 建 branch：`feature/v05-m4-recent-activity`
- [ ] 新增 `tests/services/discovery-tokens.test.ts`
- [ ] RED：CJK（中日韓文字）字元約 1 token
- [ ] RED：ASCII word（英文字）約 1.3 token
- [ ] RED：ASCII punctuation/line break（標點與換行）約 0.3 token；非 ASCII 符號（全形標點/箭頭）約 1.0 token（M4 gate 校準）
- [ ] RED：ASCII word 以 camelCase/snake/kebab 段為單位（M4 gate 校準：identifier 密集文本原低估 >30%）
- [ ] RED：metadata buffer（中繼資料緩衝）固定加 12
- [ ] RED：Recent Activity builder 不現算 rollup tokens，只讀 `metadata.capture.discovery_tokens`

## 4b：Recent Activity builder

- [ ] 新增 `src/services/recent-activity.ts`
- [ ] 查最近 rollups，不查全文 observations
- [ ] 每列含 id、updated_at、summary excerpt（摘要短摘）、observation count、discovery_tokens
- [ ] `discovery_tokens` 來源是 `metadata.capture.discovery_tokens`
- [ ] token budget 預設 1200，超過截斷
- [ ] 注入內容帶 `source=cc-memory-inject` marker（標記）

## 4c：SessionStart hook

- [ ] 新增或修改 SessionStart wrapper（包裝腳本）
- [ ] `CC_MEMORY_INJECT_RECENT=off` 預設 stdout 空
- [ ] flag on 時輸出 Claude Code hook protocol JSON
- [ ] 空 project stdout 空
- [ ] 注入器不呼叫 `recordSearchQuery`

## M4 Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] 20 筆中英混合樣本 token 估算誤差 ±20%
- [ ] `CC_MEMORY_INJECT_RECENT=off` 不注入
- [ ] flag on 注入 Recent Activity，且不含 observation narrative 全文
- [ ] flag on 不重算 rollup `discovery_tokens`
- [ ] capture worker 看到 `source=cc-memory-inject` marker 會排除

---

# M5：refine_delete + governance

> 狀態：✅ 已交付（2026-07-08，PR #9-#18 merged）——checkbox 保留原樣作歷史紀錄

> 目標：只做 delete；promote/merge/edit 延後。

## 5a：Service tests

- [ ] 建 branch：`feature/v05-m5-refine-delete`
- [ ] 新增 `tests/services/refine-delete.test.ts`
- [ ] RED：刪 active observation → status archived
- [ ] RED：刪 active rollup memory → status archived
- [ ] RED：跨 project id 不洩漏存在性
- [ ] RED：已 archived 重刪回可預期錯誤，不改資料

## 5b：Tool policy tests

- [ ] 擴 `tests/services/tool-policy.test.ts`
- [ ] RED：`cc_memory_refine_delete` 是 write tool（寫入工具）
- [ ] 擴 `tests/mcp-read-only.test.ts`
- [ ] RED：read-only ListTools 不露 refine_delete
- [ ] RED：直呼 refine_delete 回 FORBIDDEN（禁止）

## 5c：MCP tool

- [ ] 新增 `src/tools/refine-delete.ts`
- [ ] 修改 `src/index.ts` 註冊 tool 與 handler
- [ ] 修改 `src/services/tool-policy.ts` write tool set
- [ ] 寫 audit metadata 到 target `metadata.refine.deleted`
- [ ] archived observation 不進 search/timeline/get

## M5 Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] read-only/allowlist 雙層 guard 都擋 refine_delete
- [ ] ScopePolicy 擋跨 project 刪除
- [ ] archived row 不回 search/timeline/get
- [ ] promote/merge/edit 沒有被偷偷加進 scope

---

# M6：Benchmark harness

> 狀態：✅ 已交付（2026-07-08，PR #9-#18 merged）——checkbox 保留原樣作歷史紀錄

> 目標：用資料決定是否停用 claude-mem。對比單位是 rollup；observation 是 drill-down。

> **2026-08-12 readiness audit**：正式資料時間與數量門檻已達標，近 7 日真實 MCP query 已為 5/5。最新 `benchmark-2026-08-12.md` 完成固定 5＋真實 5 的 keyword baseline，並以 claude-mem 公開 session detail 對 10/10 題補證 project scope；production active 非個人語料 embedding coverage 為 27/14,229，尚缺 14,202。報告因此是 `PARTIAL`／No-Go 證據，不是正式 Go/No-Go 報告。claude-mem 既有 project metadata 可能包含內容上屬於其他工作的 session，人工標註仍須按結果內容判斷，不能只信 project label（專案標籤）。

## 6a：Fixture + parser

- [ ] 建 branch：`feature/v05-m6-benchmark`
- [ ] 新增 `docs/auto-capture-v0.5/benchmark-fixtures.md`
- [ ] 新增 `tests/scripts/v05-benchmark.test.ts`
- [ ] RED：fixture parser 要求 query、expected intent、project_id、notes
- [ ] RED：缺欄位 fail-fast

## 6b：Runner

- [ ] 新增 `scripts/benchmark-v05.ts`
- [ ] 讀固定 5 query
- [ ] 從 `search_feedback` 近 7 日抽真實 5 query
- [ ] 跑 CC-memory search/timeline/get 三層
- [ ] 跑 claude-mem 對照查詢（只讀，不搬資料）
- [ ] 輸出 `docs/auto-capture-v0.5/benchmark-YYYY-MM-DD.md`

## 6c：Manual annotation template

- [ ] 報告含 Top-5 交集欄位
- [ ] 報告含 first-relevant rank 欄位
- [ ] 報告含錯抓率標註欄位
- [ ] 報告含「10 組中幾組 Top-5 交集 ≥3」與「平均 first-relevant rank」欄位
- [ ] 報告明示 AGPL-3.0 紅線：不複製 claude-mem code/prompt/schema

## M6 Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] `npx tsx scripts/benchmark-v05.ts --fixtures docs/auto-capture-v0.5/benchmark-fixtures.md` 可跑完
- [ ] 報告列出 CC-memory rollup Top-5 與 claude-mem Top-5
- [ ] 人工標註後可計算三硬指標
- [ ] 若 ≥14 天且 ≥30 筆 auto rollup/observation，產 Go/No-Go 建議
- [ ] 10 組 query（固定 5 + 真實 5）量化表完整

---

# Phase 3 Deployment（部署）Gate

- [ ] 0011 已先套 Coolify project DB + personal DB
- [ ] 0012 已套 Coolify project DB；0013 已套 Coolify personal DB
- [ ] 兩側 DB 都就位後，才 merge 含 `observations` schema 的 worker working tree
- [ ] hook settings 走 draft-first：先草稿、人審後落地
- [ ] 併用期 2 週：CC-memory auto-capture 與 claude-mem 並行
- [ ] 併用期 `CC_MEMORY_INJECT_RECENT=off`
- [ ] 累積 ≥30 筆 auto rollup/observation
- [ ] 品質閘三硬指標 AND：
  - [ ] 10 組 query 中 ≥7 組的 Top-5 交集 ≥3
  - [ ] 10 組 query 平均 first-relevant rank ≤ claude-mem 平均 rank
  - [ ] 錯抓率 <10%
- [ ] Go：停用 claude-mem plugin + worker/chroma，下線後保留 SQLite 檔備查
- [ ] No-Go：關閉 CC-memory capture，保留資料分析差距

---

# End-to-End Checklist（端對端清單）

- [ ] PostToolUse hook 本地 append 成功，無網路依賴
- [ ] Stop hook sentinel append 成功
- [ ] Worker 成功產 rollup + observations
- [ ] Worker 在 tunnel down 時不呼叫 LLM、不前進 HWM
- [ ] LLM validation fail 進 dead-letter
- [ ] Search 輕索引可找到 rollup/observation
- [ ] Timeline 只回同 project 且同 session 的 anchor 前後 context（上下文）
- [ ] Batch get 可回全文 facts/files/narrative
- [ ] Injection flag off 無輸出
- [ ] Injection flag on 有 Recent Activity index 且不寫 `search_feedback`
- [ ] `refine_delete` 可刪錯抓且被 read-only 擋
- [ ] Benchmark 可產 Go/No-Go 報告
