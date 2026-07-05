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

> 目標：worker 從 spool harvest（收割）batch（批次），一次呼叫 Gemini Flash，驗證 JSON schema（結構），寫 rollup + observations。

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
- [ ] `CC_CAPTURE_LLM` 預設 Gemini Flash
- [ ] 無 `GEMINI_API_KEY` 或 provider key 時靜默停用 capture，stdout 告警
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

## 2b-4：Cron script

- [ ] 新增 `scripts/run-auto-capture.ts`
- [ ] 起手 health check SSH tunnel/project DB
- [ ] spool lock + HWM + rotation
- [ ] stdout summary：processed/skipped/dead-letter counts
- [ ] hermes cron draft：`cc-memory-auto-capture` */5min

## M2b Gate

- [ ] **回歸基線**：現行 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`
- [ ] DB tunnel down：worker exit 0/非破壞，spool 未前進，LLM 未呼叫
- [ ] malformed LLM output：dead-letter 有 metadata，DB 無半包資料
- [ ] 成功 batch：rollup + observations 同 transaction 寫入
- [ ] 重跑同 batch：不重複 observations
- [ ] 同 session 多個 batch：仍只有一筆 active rollup，observations append-only
- [ ] cron draft 經 user review 才落地

---

# M3：3 層 retrieval

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

> 目標：Recent Activity 輕索引注入，預設 off；每列標 discovery_tokens（載入成本）。

## 4a：Token estimator acceptance tests

- [ ] 建 branch：`feature/v05-m4-recent-activity`
- [ ] 新增 `tests/services/discovery-tokens.test.ts`
- [ ] RED：CJK（中日韓文字）字元約 1 token
- [ ] RED：ASCII word（英文字）約 1.3 token
- [ ] RED：punctuation/line break（標點與換行）約 0.3 token
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

> 目標：用資料決定是否停用 claude-mem。對比單位是 rollup；observation 是 drill-down。

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
