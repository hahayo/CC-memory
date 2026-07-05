# CC-memory v0.5 auto-capture Spec

> **狀態（2026-07-05）**：Draft（待 Claude main loop 審查）。本檔是 SDD（Spec-Driven Development，規格驅動開發）三件套之一，與 [plan.md](plan.md)、[task.md](task.md) 共同取代 v0.4 Phase C auto-capture（自動採集）休眠設計。
>
> **資料來源**：`CLAUDE.md`、`docs/INDEX.md`、`docs/spec.md`、`docs/superpowers/specs/2026-04-22-auto-capture-design.md`、`docs/superpowers/plans/2026-04-23-v04-phase-c-implementation.md`、`docs/personal-hub/*`、`src/db/schema.ts`、`sql/migrations/0000-0010*.sql`、`scripts/test-db-setup.ts`、`src/services/{delivery-queue,scope-policy,tool-policy,memories,feedback}.ts`、`src/utils/embedding.ts`。
>
> **AGPL-3.0 紅線**：claude-mem 的原始碼、prompt（提示詞）文字、schema DDL（資料定義語言）不得逐字搬入本 repo（程式庫）。本 SDD 只引用概念層：hook（掛鉤）佈局、queue（佇列）語義、observation（觀察紀錄）taxonomy（分類法）、`discovery_tokens`（載入成本標記）與 3 層 retrieval（檢索）工作流。

---

## Context（脈絡）

v0.4 Phase C 於 2026-04-22 到 2026-04-23 完成規劃，但未實作。2026-07-05 repo（程式庫）盤點後，該設計有兩類問題：

1. **差距本質不同**：v0.4 把取代 claude-mem 建模成 Stop hook 產 session summary（工作階段摘要），但 claude-mem 的核心是 PostToolUse hook + background worker（背景工作程序）產細粒度 observation，並用 3 層 token（語彙單位）節約檢索。
2. **部署前提過期**：Zeabur 已切到 Coolify + SSH tunnel（通道）；單 DB（資料庫）已變 project/personal 雙 DB；migration 編號已到 0010；read-only（唯讀）與 allowlist（白名單）雙層 guard（防線）已上線。

本輪不在舊 v0.4 文件上補丁。v0.4 文件保留為歷史與決策溯源；v0.5 重開 SDD，因為資料模型、capture（擷取）管線、注入模型與檢索工作流都變成新架構。

### 2026-07-05 RAM 量測摘要

方法：本機以 `ps` RSS（常駐記憶體）實測，並用 PID（Process ID，程序識別碼）鏈驗證常駐件來源。

| 常駐件 | RSS |
|---|---:|
| chroma-mcp（Chroma 向量庫 sidecar） | 約 1.27GB |
| worker-service.cjs（bun 常駐 daemon） | 約 85MB |
| 殘留 mcp-server.cjs 多程序 | 約 55MB |
| **合計常駐** | **約 1.4GB RAM** |

磁碟另佔約 2.6GB。v0.5 的 RAM 三紅線目標是：取代完成並停用 claude-mem 後，回收上述本機常駐成本；CC-memory 細粒度資料改由遠端 PostgreSQL + pgvector 承擔。

### 為什麼是 v0.5，不是 v0.4 refresh

| 判斷 | v0.4 | v0.5 |
|---|---|---|
| 設計地基 | `session_summaries` 單表 | `observations` + `project_memories(type='session')` rollup（彙總） |
| 採集入口 | Stop hook 同步 Claude CLI subprocess（子程序） | PostToolUse/Stop hook 只 append（附加）本地 spool（緩衝暫存區），cron worker（排程工作程序）批次處理 |
| LLM（大型語言模型） | Claude CLI，吃 subscription（訂閱） | 遠端 Gemini Flash，`CC_CAPTURE_LLM` 可切，無 key 靜默停用 |
| 注入 | 固定 N+M 筆全文 | Recent Activity（近期活動）輕索引，每列標 `discovery_tokens` |
| 檢索 | `cc_memory_search` 單層回全文 | search 輕索引 → timeline（時間軸）→ batch get observations（批次取觀察紀錄） |
| 成本/RAM | 可能有本機常駐 daemon（守護程序）誘惑 | 明確禁止常駐 daemon；hook 不走網路、不 spawn LLM |

### v0.4 決策覆寫表

| v0.4 舊決策 | v0.5 新決策 | 覆寫原因 | 受影響文件（grep 來源） | Cascade（連鎖影響） |
|---|---|---|---|---|
| `session_summaries` 是 auto-capture 主表 | 新增 `observations` 主表；session rollup 寫進既有 `project_memories(type='session')` | 細粒度 observation 是 PostToolUse worker 與 3 層 retrieval 的地基 | `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §Data Model、§Non-goals；`docs/plan.md` §Data Model；`docs/task.md` M1 | M1 schema 改寫；M3 search 結果單位改 rollup；M4 注入改 rollup index；benchmark 對比單位重定 |
| `observations` 是 Stage 2 non-goal | v0.5 M1 必做 `observations` | 四大 gap 中 #3/#4 直接缺地基 | 舊 design §Non-goals/Future Roadmap；`docs/INDEX.md` 長期目標 | v0.4 舊 SDD 標 superseded；v0.5 不再稱 Stage 2 |
| Stop hook 同步跑 capture-runner + Claude CLI | hook 僅 O(1) local append，不走網路、不 spawn LLM；cron worker 批次抽取 | RAM 紅線與 RTT（來回延遲）風險；不能讓每次 tool use（工具呼叫）受遠端 DB/LLM 牽制 | 舊 design §Capture Pipeline；`docs/plan.md` §Phase C 新增 services；舊 plan M2 | M2 拆 M2a hook 與 M2b worker；新增 spool 可靠性 Gate |
| Claude CLI subprocess 摘要 | Gemini Flash 預設，`CC_CAPTURE_LLM` 可切；缺 key 靜默停用 | 本機不跑重型子程序；成本與 RAM 可控；對齊批量任務用便宜模型規則 | 舊 design §Claude CLI 呼叫；`docs/plan.md` env `CC_MEMORY_CLAUDE_MODEL` | env 全改；品質閘要記模型名；LLM 驗證失敗進 dead-letter（死信） |
| 固定 N summary + M manual 全文注入 | Recent Activity 輕索引 + `discovery_tokens` | token 經濟學：先低成本看索引，再按需展開 | 舊 design §SessionStart Re-inject；`docs/task.md` M4 | M4 增 token budget（預算）硬上限、截斷測試、污染防線 |
| `cc_memory_search` 跨表加權後回全文 | `cc_memory_search` 回輕索引，不破 `SearchResultEnvelope`（搜尋結果信封）；新增 `cc_memory_timeline`、`cc_memory_get_observations` | 3 層 retrieval 才能同時省 token 與保細節 | 舊 design §Retrieval；`src/services/types.ts`；`src/services/feedback.ts` | M3 新工具；`search_feedback` 寫入形狀相容性 Gate |
| 同一 session 一筆 active canonical summary | 保留 per-session canonical（每 session 單一標準列）語義；rollup 改寫 `project_memories(type='session')`，`idempotency_key=capture:v05:<project>:<session>`，後續 harvest 走 upsert update | 避免同 session 多個 harvest window 稀釋注入索引、search top-K 與品質閘對比單位 | 舊 design §Data Model partial unique；舊 plan M2 capture-runner；`docs/spec.md` Phase C | M2b 更新 rollup metadata；M3/M4/M6 都以 canonical rollup 去重；observations 仍 append-only |
| refine promote/merge/edit/delete 全做 | v0.5 只做 `refine_delete` | v0.5 先建 capture/檢索閉環，降低寫入面積；promote/merge/edit 延後 | 舊 design §Refine Tools；舊 plan M1 | tool-policy 新增 1 個 write tool；audit 範圍縮小 |
| migration 0006/0007、Zeabur、248 tests | migration 0011-0013 起；0012/0013 補 observations 分側 CHECK；Coolify project/personal/test 三側；592 tests + lint 基準 | repo 現況已變，舊 Gate 失真 | `sql/migrations/0007-0010*.sql`、`scripts/test-db-setup.ts`、`docs/personal-hub/prod-runbook.md` | plan/task Gate 全換；migration journal 政策明文化 |
| `SKIP_TOOLS` 雙節流是主節流 | hook 端只做廉價 SKIP_TOOLS；真正 batching/claim 在 worker | hook 必須 <20ms、try/catch 永不 throw；worker 才能有 lease/retry/dead-letter | 舊 design §SKIP_TOOLS、§Risk 1 | M2a/M2b 責任分界；spool HWM（high-water mark，高水位）規格 |

## Goals

1. **取代 claude-mem 的自動記憶核心**：PostToolUse/Stop hook 無感側錄，cron worker 批次產 session rollup + observations。
2. **維持 CC-memory 既有優勢**：PostgreSQL + pgvector（向量擴充模組）+ Gemini embedding（向量嵌入）+ cross-device（跨裝置）同步，不退回本機 SQLite/Chroma。
3. **把 RAM 成本壓到本機近零常駐**：不新增常駐 daemon，不新增本機 DB sidecar（旁掛服務）；RAM 量測摘要中的 claude-mem 常駐成本是停用後的回收目標。
4. **提供 token 經濟學**：SessionStart 注入與 search 都先給輕索引與 `discovery_tokens`，讓 agent 按需付費展開。
5. **用資料判斷 Go/No-Go**：併用 2 週、至少 30 筆 auto rollup/observation 後，以 10 組 benchmark query（基準查詢）量化三項硬指標，AND 全達才停用 claude-mem。
6. **所有 schema 變更 additive（增量）且雙側一致**：project/personal/test 三側欄位一致；per-DB CHECK constraint 只放各側不變量。

## User Stories

### US-V5-1：全自動 capture，不用手動 `/save-memory`

**作為** 每天長時間使用 Claude Code 的開發者，我希望每次有實質 tool use 後，CC-memory 自動記錄工作步驟，**以便** 我不用記得手動存記憶。

驗收條件：
- PostToolUse hook 對非 skip 類工具 append 一行 thin JSONL（薄 JSON Lines）到本地 spool，hook 目標 <20ms。
- Stop hook append session sentinel（哨兵） `{transcript_path, hwm_offset}`，不呼叫遠端服務。
- cron worker 下一輪批次處理 spool，產出 1 筆 rollup + N 筆 observations。

### US-V5-2：worker 故障不阻塞 Claude Code

**作為** 正在工作的使用者，我希望 DB tunnel 斷線、Gemini key 缺失或 LLM 輸出壞掉時，Claude Code 仍照常跑，**以便** 記憶系統故障不變成本業故障。

驗收條件：
- hook 永不 throw；任何錯誤只寫本地 debug log（除錯紀錄）或略過。
- worker 起手 health check（健康檢查）DB/SSH tunnel；失敗只累積 spool 並 stdout 告警，不在 stderr 無限刷重試。
- LLM schema 驗證失敗整包 dead-letter，內容本身不落 DB。

### US-V5-3：細粒度 observation 可下鑽

**作為** 需要回憶某個修 bug（錯誤修復）步驟的開發者，我希望 search 先看到索引，再用 timeline/get 取回當時的 facts（事實）、files（檔案）與 narrative（敘述），**以便** 不用一次載入整個 session。

驗收條件：
- `observations` 欄位含 `type`、`concepts`、`facts`、`files`、`session_id`、`embedding vector(1536)`、`discovery_tokens`。
- `cc_memory_get_observations` 支援批次 ids，單次回多筆全文。
- archived（已封存） observation 不進 search/timeline/get。

### US-V5-4：SessionStart 自動注入 Recent Activity 索引

**作為** 開新 session 的使用者，我希望 Claude 看到最近活動清單與讀取成本，**以便** 它能自行決定是否展開細節。

驗收條件：
- `CC_MEMORY_INJECT_RECENT=off` 預設關閉；併用期只 capture，不注入。
- 開啟後只注入 rollup 索引列，每列含 `discovery_tokens` 與 drill-down ids（下鑽識別）。
- rollup 的 `discovery_tokens` 寫入時存於 `metadata.capture.discovery_tokens`；注入器只讀，不即時計算。
- 注入內容不寫 `search_feedback`，也不被 capture worker 反向摘要。

### US-V5-5：3 層 retrieval 省 token

**作為** 主 agent，我希望先用 `cc_memory_search` 找輕索引，再用 `cc_memory_timeline` 看前後脈絡，最後批次 `cc_memory_get_observations` 讀全文，**以便** 只為真正需要的記憶付 token。

驗收條件：
- `cc_memory_search` 保持 `SearchResultEnvelope` 消費端相容，結果 item 可以是 rollup/observation index。
- `cc_memory_timeline(anchor_id, depth_before, depth_after)` 只在同 project 且同 session 內依 `observed_at` 回相鄰 observations；anchor 若是 rollup，先展開該 rollup 連結的 observations 再取前後文。
- `cc_memory_get_observations(ids[])` 回全文，並在回應中標明總 `discovery_tokens`。

### US-V5-6：錯抓可刪，且有稽核

**作為** 看到錯抓內容的使用者，我希望一個 write tool（寫入工具）能軟刪 rollup 或 observation，**以便** 污染能立刻停止擴散。

驗收條件：
- v0.5 只新增 `cc_memory_refine_delete`。
- tool 納入 `CC_READ_ONLY` / `CC_TOOL_ALLOWLIST` 雙層 guard 與 ScopePolicy。
- 刪除寫 audit metadata（稽核中繼資料），promote/merge/edit 延後。

### US-V5-7：project 與 personal 不互相污染

**作為** 同時有 project DB 與 personal DB 的使用者，我希望 v0.5 只採 project 側，**以便** 個人近況不被自動採集混入專案記憶。

驗收條件：
- `__personal__` spool 段由 worker 直接排除。
- project/personal/test 三側 schema 欄位一致，但 v0.5 worker 只寫 project DB。
- 既有表仍由 0007/0008 保護；`observations` 另由 0012 project-only CHECK 拒 `__personal__`、0013 personal-only CHECK 只准 `__personal__`。

### US-V5-8：可用 benchmark 決定停用 claude-mem

**作為** 想停用 claude-mem 的使用者，我希望有固定 query set（查詢集）和人工標註流程，**以便** 不靠感覺判斷品質。

驗收條件：
- 品質閘對手是 claude-mem 10.5.2 的 observation + 3 層 retrieval 行為。
- 結果對比單位定義為 rollup；observation 是 drill-down。
- 10 組 query（固定 5 + 真實 5）中，至少 7 組的 Top-5 交集 ≥3；10 組平均 first-relevant rank ≤ claude-mem；錯抓率 <10%，三項 AND 全達才 Go。

## Non-goals

- 不移植 claude-mem code/prompt/schema DDL。
- 不實作 claude-mem 的 smart code search（程式碼結構搜尋）；這不是記憶核心。
- 不導入本機 SQLite、Chroma 或常駐 DB sidecar。
- 不做 personal 自動採集；`__personal__` worker 排除。
- 不做歷史 import；claude-mem SQLite 7,313 observations 留檔，import 另開 SDD。
- 不做 promote/merge/edit refine tools。

## Scope 摘要

| 項目 | v0.5 範圍 | 備註 |
|---|---|---|
| Schema | `observations` 新表；必要 index；rollup 用既有 `project_memories` | migration 0011-0013 起 |
| Capture hook | PostToolUse/Stop thin spool append | hook 不走網路 |
| Worker | hermes cron 批次 harvest（收割）+ LLM extract（抽取）+ DB write | 不做 daemon |
| LLM | Gemini Flash 預設；`CC_CAPTURE_LLM` 可切；無 key 靜默停用 | 仿 `src/utils/embedding.ts` 降級 |
| Retrieval | search 輕索引 + timeline + batch get | 不破既有 envelope |
| Injection | SessionStart Recent Activity 索引 | flag 預設 off |
| Refine | delete only | write guard 必做 |
| Benchmark | 對 claude-mem 10.5.2 觀察級行為 | 併用 2 週 |

## Constraints

### RAM 三紅線

1. **不做常駐 daemon**：worker 走 hermes cron，跑完即退；不得常駐 worker-service。
2. **hook 只做 O(1) 輕量寫入且不走網路**：PostToolUse 只 append thin JSONL；Stop 只 append sentinel；hook 內不 INSERT 遠端 DB、不 spawn LLM。
3. **observation 抽取用遠端便宜模型**：預設 Gemini Flash；`CC_CAPTURE_LLM` 可切；缺 key 時靜默停用並告警，不做本機重型 subprocess。

### 資料與部署

- `observations` 落 project DB；v0.5 worker 直接排除 `__personal__`。
- migration 0011 建共用 `observations` 結構；0012/0013 分別套 project/personal 的 observations 路由 CHECK；schema 變更 additive；雙側欄位一致，避免 0010 personal-only 欄位造成的 drift 重演。
- `observations` 相關 CHECK/索引在 project/personal/test 三側存在性需有矩陣；per-DB 路由 CHECK 仿 0007/0008，且不放共用 `schema.ts`。
- 新 migration 必須先套 prod Coolify project DB 與 personal DB，再切 working tree 或部署 worker，避免任何 cron 直跑新 schema 時遇到 `relation does not exist` 事故。
- tunnel 斷線是 P1 故障；worker 先 health check，失敗不消耗 LLM、不重試刷屏。

### 相容性

- `cc_memory_search` 不能破壞 `SearchResultEnvelope.results / rankingMeta / queryContext`。
- `search_feedback` 既有陣列長度 CHECK 仍是硬背線；注入不寫 telemetry（遙測）。
- 所有新增 write tool 必須進 `src/services/tool-policy.ts` 的分類與 central dispatch guard。
- `GEMINI_API_KEY` 或 capture LLM key 缺失不應讓既有 memory search 失敗；降級要明確。

## Design Principles

- **Observation-first**：先有 atom（原子紀錄），再有 rollup 與 index。
- **Hook cheap, worker reliable**：hook 保使用者工作流；worker 負責可靠性、租約、retry（重試）與 dead-letter。
- **Rollup as comparison unit**：品質閘與注入以 rollup 比較；observation 是 drill-down。
- **Index before full text**：任何自動注入或 search 預設先給索引，不直接 dump 全文。
- **Project-only first**：v0.5 不碰 personal 自動採集，先穩住專案記憶替代。
- **Fail loud to operators, quiet to sessions**：使用者 session 不被打擾；cron stdout 與 dead-letter metadata 要可觀測。
- **Weighted mixed corpus**：manual memory（手動記憶）預設權重最高；canonical rollup 次之；observation index 依 type 加權，decision observation 高於一般 auto observation；係數可用 env（環境變數）調整。

### Search ranking defaults（搜尋排序預設）

預設排序權重：manual `project_memories` = 1.00、canonical session rollup = 0.85、`decision` observation index = 0.80、其他 observation index = 0.65。env override（環境變數覆寫）名稱由 plan.md 的 Environment Variables 表定義；覆寫只調分數，不改 `SearchResultEnvelope` 形狀。

## Schema 矩陣

| 物件 | project DB | personal DB | test DB | 說明 |
|---|---|---|---|---|
| `observations` | 建立且 worker 寫入 | 建立但 worker 排除 `__personal__` | 建立 | 欄位一致，防 Drizzle select 展開缺欄 |
| `observations.embedding` | `vector(1536)` | `vector(1536)` | `vector(1536)` | 對齊 `EMBEDDING_DIMENSIONS=1536` |
| `observations_project_active_idx` | 有 | 有 | 有 | 即使 personal 暫不用，也保持 schema 一致 |
| `observations_session_idx` | 有 | 有 | 有 | timeline/get 查詢用 |
| `observations_status_check` | 有 | 有 | 有 | `active|archived` |
| `observations_type_check` | 有 | 有 | 有 | taxonomy 值由 v0.5 定義 |
| `observations_no_personal_check`（0012） | 有 | 不適用 | project test DB 有 | 拒 `project_id='__personal__'`；不放共用 schema |
| `observations_personal_only_check`（0013） | 不適用 | 有 | personal test DB 有 | 只准 `project_id='__personal__'`；不放共用 schema |
| legacy 0007/0008 CHECK | 既有表由 0008 保護 | 既有表由 0007 保護 | 0008 沿用既有 e2e 自套自清模式 | 不等同於 observations 路由 CHECK |
| `pending_observations` | 不建 | 不建 | 不建 | 預設不建遠端佇列表 |

## Observation Taxonomy（觀察紀錄分類法）

taxonomy 只取概念，不搬 claude-mem 原始 prompt 或 schema。v0.5 初版限制在工程工作常見類型，避免一開始把分類空間做太大。

### `type` 值

| type | 用途 | 典型來源 | Search 顯示 |
|---|---|---|---|
| `decision` | 記錄已拍板技術/產品決策 | 使用者明確裁決、ADR（Architecture Decision Record，架構決策紀錄） | 決策 |
| `bugfix` | 記錄 bug root cause（根因）與修法 | failing test（失敗測試）、stack trace（堆疊追蹤）、patch（修補） | 修復 |
| `feature` | 記錄新增功能的行為與檔案面 | 新 service/tool/script | 功能 |
| `refactor` | 記錄無行為改變的結構整理 | rename/split/extract | 重構 |
| `discovery` | 記錄調查出的現況、限制或地雷 | grep/read/test result | 發現 |
| `change` | 記錄一般修改，無法歸入上列時使用 | 小修、設定調整 | 變更 |

### `concepts` 值

| concept | 用途 |
|---|---|
| `gotcha` | 容易踩錯的限制或事故教訓 |
| `pattern` | 可重用做法 |
| `trade-off` | 取捨與替代方案 |
| `invariant` | 不可破壞的不變量 |
| `deployment` | 部署、migration、cron、tunnel 相關 |
| `security` | 權限、scope、secret（密鑰）與資料外洩邊界 |
| `testing` | 測試策略、fixture（測試資料）、Gate |

### 欄位契約

| 欄位 | 必填 | 契約 |
|---|---|---|
| `title` | 是 | 單句，給 search 輕索引用；不可含整段 transcript |
| `subtitle` | 否 | 補充上下文，最多 160 字元 |
| `facts` | 是 | 每項是可驗證事實，避免主觀猜測 |
| `files` | 是 | repo 相對路徑或絕對路徑；不得放不存在的幻想路徑 |
| `narrative` | 是 | 全文 drill-down；只在 get_observations 回傳 |
| `discovery_tokens` | 是 | 寫入時計算，供注入與 search 呈現載入成本 |
| `metadata` | 是 | 可放 model、spool offset、validation version；不可放 API key |

Rollup 的載入成本不新增 `project_memories` 欄位，統一存 `metadata.capture.discovery_tokens`；M4 注入器與 M3 search 只讀該值。

### Rollup 與 Observation 關係

- 每個 project/session 只有一筆 active canonical rollup；`idempotency_key` 固定為 `capture:v05:<project>:<session>`。
- 每個 harvest window 都 update 同一筆 rollup：summary 可重生成或合併，embedding 重算，`metadata.capture.observation_ids` 與 `metadata.capture.spool_offsets` append，`metadata.capture.summarize_count` 遞增。
- observations 維持 append-only；每筆 observation 的 `rollupMemoryId` 指向該 canonical rollup。
- 若某次 batch 無高價值 observation，`observations[]` 可為空，但 worker 必須記錄原因並仍可更新 rollup metadata。
- Benchmark（基準測試）以 rollup 作 Top-5 對比單位；observation 只用來判斷該 rollup 是否可解釋命中。
- refine_delete 刪 rollup 時，不自動 cascade（連帶）刪 observations；retrieval 層需讓 archived rollup 不出 search，但 observations 可由 audit/debug 工具另查。
- refine_delete 刪 observation 時，不改 rollup summary；若大量 observations 被刪導致 rollup 失真，未來另開 edit/refresh SDD。

## LLM Output Contract（模型輸出契約）

worker 對 LLM output 採 all-or-nothing（全有或全無）策略：

1. 必須是單一 JSON object（物件）。
2. 必須含 `session_summary` 與 `observations`。
3. `session_summary.summary` 不可空白，且要能映射到 `project_memories.summary`。
4. `observations` 每筆必須通過 type/concepts/facts/files/narrative/discovery_tokens 驗證。
5. 任一筆 observation 壞掉，整包進 dead-letter，不半吞。
6. dead-letter metadata 必須可追查 session id、hwm offset、模型名、錯誤碼、content hash。
7. dead-letter 不把 transcript 全文或 LLM 原文落 DB。

## Cross-System Mapping（跨系統對比口徑）

| claude-mem 概念 | CC-memory v0.5 對應 | 對比方式 |
|---|---|---|
| observation row | `observations` row | 只比行為，不比 schema 字段名 |
| session summary | `project_memories(type='session')` rollup | Top-5 對比單位 |
| Recent Activity row | rollup index row | 比是否有載入成本與 drill-down |
| search result | rollup/observation index | 比 query 是否找到同主題 |
| timeline | `cc_memory_timeline` | 比 anchor 前後脈絡可用性 |
| get observations | `cc_memory_get_observations` | 比 batch get 是否能拿到足夠 facts/files |

## Success Criteria

### 基線

- 所有 milestone Gate 第一條：現行全綠 **592 tests（2026-07-05 repo 基線，43 檔全綠；lint 基準 0 errors / 4 warnings；test DB 用 `docker-compose.test.yml` + `scripts/test-db-setup.ts`）不回歸**。
- 每個 milestone Gate 跑：`npm run build && npm test && npm run lint`。

### 功能成功

- PostToolUse/Stop hook 實測只做本地 append，p95 <20ms。
- worker 從 spool 產出 rollup + observations；schema 驗證失敗不落 DB。
- search → timeline → batch get 三層流程可完成同一 query 的 drill-down。
- SessionStart 注入 flag on 時，只注入 Recent Activity 索引且有 token budget 上限。
- `refine_delete` 可刪 rollup/observation，並被 read-only/allowlist 擋住。

### claude-mem Go/No-Go

併用條件：至少 14 天，且累積 ≥30 筆 CC-memory auto rollup/observation。併用期 CC-memory 只 capture，注入 flag 保持 off。

三項硬指標 AND：
- 10 組 benchmark query（固定 5 + 從 `search_feedback` 抽樣真實 5）中，至少 7 組的 CC-memory rollup Top-5 與 claude-mem Top-5 交集 ≥3。
- 10 組 query 的人工 first-relevant rank 平均值 ≤ claude-mem 平均值。
- 錯抓率 <10%。

Go：停用 claude-mem plugin、下線 worker/chroma，回收 RAM 量測摘要列出的本機常駐成本，claude-mem SQLite 留檔備查。

No-Go：保留 claude-mem，回 Phase 2 補強 query/taxonomy/worker。

## 端對端驗收

- [ ] PostToolUse hook append thin JSONL，內容含 session/project/tool metadata 且權限 0600。
- [ ] Stop hook append sentinel；worker 讀 transcript 增量窗口並更新 hwm_offset。
- [ ] DB tunnel 關閉時 worker 不呼叫 LLM、不寫 DB，只累積 spool 並告警。
- [ ] LLM 回 malformed JSON（格式錯誤 JSON）時整包 dead-letter，DB 無半包資料。
- [ ] `cc_memory_search` 回 rollup/observation index；`recordSearchQuery` 仍能寫既有欄位。
- [ ] `cc_memory_timeline` 對 anchor observation 回同 project 且同 session 前後 N 筆；anchor rollup 先展開 linked observations。
- [ ] `cc_memory_get_observations` 批次 ids 回全文與總 `discovery_tokens`。
- [ ] SessionStart 注入 flag off 無輸出；flag on 有截斷與 token budget 測試。
- [ ] `CC_READ_ONLY=1` 時 `cc_memory_refine_delete` 不出現在 ListTools，直呼也拒絕。

## Open Questions

1. **PostToolUse payload 與 transcript offset 穩定性**：M2a 動工前實測 gate。實測項：hook stdin shape、tool name 欄位、transcript_path 來源、append 後 offset 是否 byte-stable（位元組穩定）、Stop sentinel 的 offset 是否能讓 worker 重讀同一窗口。判準：3 種 tool（Read/Edit/Bash）+ 1 次 `/clear` + 1 次 compact 後 offset 皆可重現；否則 fallback 為 worker 只讀 transcript tail 並用 content hash 去重。
2. **`discovery_tokens` CJK-aware 估算**：提案公式為 CJK 字元 ×1.0 + ASCII word ×1.3 + punctuation/line break ×0.3，向上取整並加 12 token metadata buffer。M4 Gate 用 20 筆真實中英混合 rollup/observation 對實際 tokenizer（若可用）或 Claude context 估算抽樣，誤差目標 ±20%；若超標，調整係數但不引入 `tiktoken` 依賴。
3. **是否建 `pending_observations` 遠端佇列表**：結論：v0.5 不建。理由：hook 不能走網路；跨機重試語義由各機 spool + 各機 cron worker 承擔；遠端 queue 會增加 DB 寫入風險。M1 只新增 `observations` 結構與分側路由 CHECK：0011 建表/索引，0012 project-only CHECK，0013 personal-only CHECK；不建遠端 pending queue。

## References

- `docs/auto-capture-v0.5/plan.md`
- `docs/auto-capture-v0.5/task.md`
- `docs/personal-hub/prod-runbook.md`
- `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md`
- `src/services/delivery-queue.ts`
- `src/services/types.ts`
- `src/services/feedback.ts`
- `src/utils/embedding.ts`
