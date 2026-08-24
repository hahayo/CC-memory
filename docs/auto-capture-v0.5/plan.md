# CC-memory v0.5 auto-capture Implementation Plan

> **對應 spec（規格）**：[spec.md](spec.md)。本 plan（計畫）只描述未來實作，不代表本輪已修改程式碼。
>
> **執行紀律**：每個 milestone（里程碑）開 feature branch（功能分支）`feature/v05-m<N>-<name>`，先 TDD（Test-Driven Development，測試驅動開發）再實作，Gate（關卡）過才 merge（合併）。
>
> **基線**：現行全綠 592 tests（2026-07-05 repo 基線，43 檔全綠；lint（靜態檢查）基準 0 errors / 4 warnings；test DB（測試資料庫）用 `docker-compose.test.yml` + `scripts/test-db-setup.ts`）不回歸。

---

## Architecture（架構）

```
Claude Code / Codex session
  │
  ├─ PostToolUse hook（掛鉤）
  │    └─ O(1) append thin JSONL 到本機 spool（緩衝暫存區）
  │
  ├─ Stop hook
  │    └─ append sentinel（哨兵）後 quick-kick systemd oneshot（快速啟動單次服務）
  │
  ├─ SessionStart hook
  │    ├─ quick-kick backlog（快速啟動積壓工作）
  │    └─ feature flag on 時注入 Recent Activity index（近期活動索引）
  │
  ▼
~/.cache/cc-memory/spool/<project>/<session>.jsonl
  │
  └─ cc-memory-auto-capture.service（hook-driven、無 timer、跑完即退）
       ├─ health check（健康檢查）SSH tunnel（通道）與 project DB（專案資料庫）
       ├─ file lock（檔案鎖）+ rotation（輪替）+ high-water mark（高水位）commit
       ├─ batch harvest（批次收割）transcript 增量窗口
       ├─ capture LLM（大型語言模型）一次呼叫（正式 unit：codex-cli 主力 + claude-cli fallback；可切 gemini-flash）
       ├─ JSON schema validation（結構驗證）
       ├─ write rollup → project_memories(type='session')
       └─ write observations → observations
             │
             ├─ SessionStart injector（注入器）→ Recent Activity index
             └─ Retrieval（檢索）→ search → timeline → get_observations
```

> 2026-07-16 決策：auto-capture 由 Stop／SessionStart hooks 驅動 systemd user service（使用者層級服務），不設 timer；reminder／Todoist 才使用 systemd timers。遷移手順見 `memory-ops-cutover.md`。

### 模組邊界

| 模組 | 責任 | 不做 |
|---|---|---|
| hook wrappers（掛鉤包裝） | 解析 hook input（輸入）、SKIP_TOOLS、append local spool | DB 寫入、LLM、重試 |
| spool service（緩衝服務） | atomic append（原子附加）、lock、capture state v2、rotation、dead-letter（死信） | 解析 LLM 內容 |
| capture worker（擷取工作程序） | claim batch（認領批次）、呼叫 LLM、驗 schema、寫 DB | 常駐 daemon（守護程序） |
| observation service（觀察紀錄服務） | insert/query/archive observations | personal 自動採集 |
| retrieval service（檢索服務） | search 輕索引、timeline、batch get | 改破 `SearchResultEnvelope` |
| injection service（注入服務） | Recent Activity 格式化、token budget（語彙預算） | 寫 `search_feedback` |
| refine service（整理服務） | delete only + audit metadata（稽核中繼資料） | promote/merge/edit |

## Data Model（資料模型）

### `observations` 草案

Drizzle（TypeScript ORM）風格偽碼，實作時需對齊 `src/db/schema.ts` 命名與 import（匯入）慣例：

```ts
export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    rollupMemoryId: uuid('rollup_memory_id').references(() => projectMemories.id),

    type: text('type').notNull(), // decision | bugfix | feature | refactor | discovery | change
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    facts: text('facts').array().notNull().default(sql`'{}'::text[]`),
    concepts: text('concepts').array().notNull().default(sql`'{}'::text[]`),
    files: text('files').array().notNull().default(sql`'{}'::text[]`),
    narrative: text('narrative').notNull(),

    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    discoveryTokens: integer('discovery_tokens').notNull(),
    sourceHook: text('source_hook').notNull(), // post-tool-use | stop-rollup
    contentHash: text('content_hash').notNull(),
    writerHost: text('writer_host').notNull(),
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata').notNull().default({}),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('observations_type_check', sql`${table.type} IN (...)`),
    check('observations_status_check', sql`${table.status} IN ('active','archived')`),
    check('observations_discovery_tokens_check', sql`${table.discoveryTokens} > 0`),
    uniqueIndex('observations_content_uniq')
      .on(table.projectId, table.sessionId, table.contentHash)
      .where(sql`${table.status} = 'active'`),
    index('observations_project_active_idx')
      .on(table.projectId, table.observedAt.desc())
      .where(sql`${table.status} = 'active'`),
    index('observations_session_idx').on(table.projectId, table.sessionId, table.observedAt),
    index('observations_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ]
);
```

`observations_no_personal_check` 與 `observations_personal_only_check` 不放在共用 `schema.ts`：它們是 per-DB invariant（分側資料庫不變量），若由 Drizzle generate（產生）帶到錯側，會重演 0007/0008 檔頭明示的錯側 CHECK 風險。

### Rollup 寫入

rollup 不開 `session_summaries` 新表，改用既有 `project_memories`，並保留「同 project 與同 session 一筆 active canonical」語義：

| 欄位 | 寫法 |
|---|---|
| `type` | `'session'` |
| `summary` | LLM 產出的 session summary |
| `keywords/decisions/next_steps` | 結構化 JSON 映射到既有欄位 |
| `metadata.capture` | `{ version:'0.5', session_id, observation_ids, model, spool_offsets, summarize_count, discovery_tokens }` |
| `embedding` | 沿用 `src/utils/embedding.ts`，失敗可為 NULL |
| `idempotency_key` | `capture:v05:<project>:<session>` |

worker 對既有 rollup 做 upsert update：summary 可重生成或合併，embedding 重算，`metadata.capture.observation_ids` 與 `metadata.capture.spool_offsets` append，`metadata.capture.summarize_count` 遞增，`metadata.capture.discovery_tokens` 寫入時計算並覆蓋。observations 本身 append-only，不受 rollup upsert 影響；每筆 observation 的 `rollupMemoryId` 指向該 canonical rollup。

### 為何不建 `pending_observations`

v0.5 不建遠端 pending queue（待處理佇列）。hook 不走網路是硬約束；跨機重試由各機 spool 自理。遠端 queue 只有在未來需要「A 機 capture、B 機 worker 代處理」時才另開 SDD。

## Files Impact（檔案影響）

### 新增

```
src/services/capture-spool.ts          # spool append；worker 管 lock/state/rotation/dead-letter
src/services/capture-worker.ts         # harvest + LLM + schema validation + DB write
src/services/observations.ts           # insert/search-index/timeline/get/archive
src/services/capture-llm.ts            # capture LLM adapter（codex-cli 主力 / claude-cli fallback / gemini-flash）+ fallback wrapper + schema parser
src/services/recent-activity.ts        # SessionStart index builder
src/tools/timeline.ts                  # cc_memory_timeline
src/tools/get-observations.ts          # cc_memory_get_observations
src/tools/refine-delete.ts             # cc_memory_refine_delete
scripts/run-auto-capture.ts            # 非常駐 capture worker；由 supervisor 啟動
scripts/run-auto-capture-supervisor.ts # supervisor 模式入口（systemd 路徑；已交付）
scripts/probe-claude-hooks.ts          # M2a payload/offset gate
hooks/post-tool-use-capture.sh         # O(1) spool append
hooks/stop-capture-sentinel.sh         # sentinel append 後 quick-kick service
hooks/session-start-inject.sh          # quick-kick backlog；flag on 才注入索引
hooks/kick-auto-capture.sh             # systemctl --no-block fail-open helper
tests/services/*capture*.test.ts       # spool/worker/LLM validation
tests/services/observations.test.ts    # DB + timeline/get
tests/mcp-observations.test.ts         # MCP tools
tests/scripts/probe-claude-hooks.test.ts
```

### 修改

```
src/db/schema.ts                       # add observations（implementation round only）
sql/migrations/0011_add_observations.sql
sql/migrations/0012_observations_no_personal_check.sql
sql/migrations/0013_observations_personal_only_check.sql
scripts/test-db-setup.ts               # 0011 雙側；0012 project test；0013 personal test
src/index.ts                           # register new tools + central guards
src/services/memories.ts               # search 輕索引化，保持 envelope
src/services/feedback.ts               # 若需記 result kind，必須維持既有欄位長度不變量
src/services/tool-policy.ts            # add write tool cc_memory_refine_delete
src/services/scope-policy.ts           # ensure observations path uses same project policy
CLAUDE.md                              # 工具清單與 env 總表 cascade，實作完成後再更新
docs/INDEX.md                          # v0.5 狀態
```

### 不動

```
skills/**
package.json        # 除非實作輪確定需 script；本 SDD 不預設新增 npm package
claude-mem plugin   # 併用期保留
```

## Spool Reliability Spec（可靠性規格）

可靠性不得低於 `src/services/delivery-queue.ts` 的 at-least-once（至少一次）claim-lease（租約認領）模式。

| 項目 | v0.5 規格 | Gate |
|---|---|---|
| path | `~/.cache/cc-memory/spool/<project>/<session>.jsonl` | project/session sanitize（安全正規化）測試 |
| permission（權限） | 目錄 0700、檔案 0600 | chmod test |
| atomic append | `open(O_APPEND)` + 單行 JSON + newline；失敗吞掉 | concurrent append 100 次無破行 |
| file lock | worker processing（處理）時鎖 session spool；hook append 不等待長鎖 | worker/hook race 測試 |
| capture state commit | 每個 chunk DB transaction（交易）成功後原子保存 path checkpoint；整個 spool snapshot（快照）完成後才推進 spool cursor。state 損壞 fail closed | crash recovery / corrupt state 測試 |
| empty transcript chunk | 先按原始 bytes 切 chunk，再移除 injection marker；過濾後空白時不呼叫 LLM、不寫 dead-letter，但保存原始 byte range checkpoint | empty chunk / marker 測試 |
| max window chunking | transcript range 超過 `CC_CAPTURE_MAX_WINDOW_BYTES` 時依原始 bytes 的 UTF-8 安全邊界切 chunk；各 chunk 共用 canonical rollup，`observed_at` 微增序號跨 chunk 延續；前已成功 chunk 即時保存 checkpoint | chunk / UTF-8 / partial failure 測試 |
| idempotency | rollup metadata 的可合併 transcript source coverage + DB unique index 擋重複；已覆蓋 range 重播跳過所有 DB 寫入 | commit 後 state 寫入失敗的重播測試 |
| rotation | 單檔 >10MB 或 session 結束 24h 後一併 seal spool 與 generation state；新同名 spool 從 cursor 0 開新 generation | rotation / 0600 測試 |
| size cap | 全 spool >500MB 時停止 capture 並 stdout 告警 | flood（洪水）測試 |
| dead-letter | v2 state 以 path hash + 原始 range + content hash 穩定 retry key 跨 tick 累計 attempts：第 1-4 次 hold；第 5 次只 park 該 chunk、保存 checkpoint 並停止該 session 本 tick。有效 path 的來源不可讀／短於 boundary 時改用固定 `TRANSCRIPT_SOURCE_UNAVAILABLE` hash；來源可讀且長度達 boundary 才清除該 retry。429 與 budget yield 不計 attempts | metadata 不含敏感全文或完整本機 path；來源不可用時 `model=none`，warning 只含 path hash prefix/range/attempts |
| recovery | worker crash 後從各 path checkpoint 重讀；DB source coverage 讓 commit 後 state 寫入失敗可安全重播。歷史資料只由 audit script 產生 `would_replay: false` manifest | at-least-once / dry-run audit 測試 |

### Hook SKIP_TOOLS policy（掛鉤跳過工具政策）

預設 skip 清單沿用 v0.4 frozen 值：`ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion`。`CC_MEMORY_SKIP_TOOLS` 若設定，語義是**整個覆蓋預設清單**，不是 union（聯集）；空字串代表不 skip 任何 tool。hook 端只做這個廉價集合判斷，完整節流與 retry 留給 worker。

### Capture state v2 commit 時機

1. worker 固定本輪 spool snapshot 的 complete-line byte end，載入或由 legacy `.hwm` 前綴建立 `.capture-state.json`。
2. 依 spool record 順序為每個 transcript path 建 baseline／增量 range；多路徑各自讀取 checkpoint。
3. 先按原始 transcript bytes 切 UTF-8 安全 chunk，再排除 injection marker，呼叫 LLM 並做 schema validation。
4. DB transaction 內先檢查 `metadata.capture.transcript_sources`；已完整覆蓋則不執行任何寫入，否則 upsert rollup + insert observations。
5. 每個 transaction commit 成功後立即原子保存該 path checkpoint；第 5 次終局失敗則只越過失敗 chunk 並停止 session 本 tick。有效 path 的來源不可讀或短於 boundary 時，每 tick 保存同一 stable retry entry（穩定重試項目），第 5 次以 metadata-only dead-letter 隔離該 range。
6. 只有 snapshot 內所有 record 都已處理、略過或由 checkpoint 證明完成，才原子推進 spool cursor。budget 用盡只回 `yielded`；不改 retry state。

## Search Contract（搜尋契約）

`cc_memory_search` v0.5 改成「輕索引化」，但不改 service envelope（服務信封）核心欄位：

```ts
interface SearchResultEnvelope<T = MemoryIndexResult> {
  results: T[];
  effectiveMode: SearchMode;
  rankingMeta: { rankPositions: number[]; scores: number[] | null };
  queryContext: SearchQueryContext;
}
```

上方是 v0.5 目標型別示意；現行 `src/services/types.ts` 的 default generic（預設泛型）仍是 `Memory`，實作時以 additive 擴充（增量擴充）方式導入，不得讓既有消費端被迫改型別。

規則：
- `rankPositions.length === results.length`。
- `scores !== null` 時 `scores.length === results.length`。
- `result.id` 仍可寫入 `search_feedback.result_ids`；observation index id 與 rollup id 不可混淆，必要時 metadata 標 `result_kind`，不得改既有陣列長度。
- 注入器不呼叫 `recordSearchQuery`。

### Mixed Corpus Ranking（混合語料排序）

預設權重：

| 來源 | 預設權重 | env override |
|---|---:|---|
| manual `project_memories` | 1.00 | `CC_MEMORY_WEIGHT_MANUAL` |
| canonical session rollup | 0.85 | `CC_MEMORY_WEIGHT_ROLLUP` |
| `decision` observation index | 0.80 | `CC_MEMORY_WEIGHT_OBSERVATION_DECISION` |
| 其他 observation index | 0.65 | `CC_MEMORY_WEIGHT_OBSERVATION_AUTO` |

排序策略是 precision-first（精準優先）：manual/decision 類結果不應被低信心 observation 洪水淹沒；env 值只調權重，不改 `SearchResultEnvelope` 形狀。

### Timeline Semantics（時間軸語義）

`cc_memory_timeline(anchor_id, depth_before, depth_after)` 僅在同 project 且同 session 內排序。anchor 若是 observation，取同 session 依 `observed_at` 前後 N 筆；anchor 若是 rollup，先找 `rollupMemoryId` 指向該 rollup 的 observations，再以這組 observations 的時間範圍回前後文。v0.5 不做跨 session timeline；跨 session 發現靠 search index。

## Environment Variables（環境變數）

| 名稱 | 預設值 | 讀取元件 | 缺值或降級行為 |
|---|---|---|---|
| `CC_CAPTURE_LLM` | `claude-cli`（程式碼預設；正式 unit 設為 `codex-cli`） | capture worker | 未支援 provider 時 fail-fast 到 dead-letter metadata |
| `CC_CAPTURE_LLM_FALLBACK` | 未設（無 fallback） | capture worker | 設為 `claude-cli` 時主 provider 失敗自動退回 |
| `CC_CAPTURE_CODEX_MODEL` | `gpt-5.6-sol` | capture LLM（codex-cli provider） | parse 失敗／缺值用預設 |
| `CC_CAPTURE_CODEX_TIMEOUT_MS` | `90000` | capture LLM（codex-cli provider） | parse 失敗用預設 |
| `CC_CAPTURE_MAX_WINDOWS_PER_TICK` | 無上限（`Number.MAX_SAFE_INTEGER`；正式 unit 設為 `1`） | capture worker | parse 失敗或小於 1 用預設 |
| `CC_CAPTURE_GEMINI_TIMEOUT_MS` | 未記錄（實作預設） | capture LLM（gemini-flash provider） | parse 失敗用預設 |
| `CC_CAPTURE_CLAUDE_MODEL` | `haiku` | capture LLM（claude-cli provider） | parse 失敗／缺值用預設；tier 別名交給 claude CLI 解析 |
| `GEMINI_API_KEY` | 無 | capture LLM（僅 gemini-flash provider）/ embedding | gemini-flash 下缺值時 capture 靜默停用並 stdout 告警；claude-cli 下不需要；既有 search 降級沿用 `embedding.ts` |
| `CC_MEMORY_SKIP_TOOLS` | `ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion` | hook wrapper | 設定後整個覆蓋預設；空字串代表不 skip |
| `CC_MEMORY_SPOOL_DIR` | `~/.cache/cc-memory/spool` | hook / worker | 缺值用預設；無法建立時 hook 吞錯、worker 告警 |
| `CC_MEMORY_SPOOL_MAX_MB` | `500` | worker | 超過上限停止 capture 並 stdout 告警 |
| `CC_CAPTURE_MAX_WINDOW_BYTES` | claude-cli 預設 32768（32 KiB）；其他 provider 262144（256 KiB）；顯式設定則優先 | capture worker | parse 失敗或小於 4 bytes 用 provider 預設；超過上限的 transcript window 依 UTF-8 邊界分塊；chunk timeout／prompt-too-long 時原子保存 split hint 並二分，跨 tick 不重試父 chunk |
| `CC_MEMORY_INCLUDE_OBSERVATIONS` | `on` | search service | `off` 時 search 只回 manual/rollup |
| `CC_MEMORY_INJECT_RECENT` | `off` | SessionStart injector | off 時 stdout 空 |
| `CC_MEMORY_INJECT_TOKEN_BUDGET` | `1200` | SessionStart injector | 超過先截 observation ids，再截 summary text |
| `CC_MEMORY_WEIGHT_MANUAL` | `1.00` | search ranking | parse 失敗用預設 |
| `CC_MEMORY_WEIGHT_ROLLUP` | `0.85` | search ranking | parse 失敗用預設 |
| `CC_MEMORY_WEIGHT_OBSERVATION_DECISION` | `0.80` | search ranking | parse 失敗用預設 |
| `CC_MEMORY_WEIGHT_OBSERVATION_AUTO` | `0.65` | search ranking | parse 失敗用預設 |

## Injection Pollution Defense（注入污染防線）

- `CC_MEMORY_INJECT_RECENT=off` 預設。
- ~~併用期兩週內只 capture，不注入。~~ （2026-08-23 後記：併用期／筆數門檻降為 advisory，上線改依 `memory-ops-cutover.md` §9 canary 制。）
- 注入內容加 metadata marker（標記）`source=cc-memory-inject`；worker 看到該 marker 直接排除。
- **遞迴 capture 斷路器**（2026-07-07 claude-cli provider 連帶補強；2026-08-23 codex-cli 雙層強化）：worker spawn 的子程序帶 `CC_MEMORY_CAPTURE_CHILD=1` env，兩支 capture hook 開頭偵測到即 exit 0——抽取 session 自身不得再進 spool。codex-cli 子程序另以 bwrap（bubblewrap 沙箱）+ execpolicy（執行策略）兩層防護、`--ignore-user-config` 不載使用者設定，雙重確保遞迴斷路；claude-cli 子程序仍帶 `--strict-mcp-config` 不載使用者 MCP servers。
- token budget 預設 1,200；超過先截 observations ids，再截 summary text。
- 每列 rollup 的 `discovery_tokens` 讀 `metadata.capture.discovery_tokens`；注入器不即時計算。
- 注入 stdout 不含全文 observation narrative，只含索引。
- 空結果 stdout 空，不注入 placeholder（佔位文字）。

## Milestones

### M1：Schema + migrations 0011-0013（1 到 1.5 天）

依賴：無，但需先確認 `sql/migrations/meta/_journal.json` 政策。

交付：
- `observations` Drizzle schema + migration 0011。
- `0012_observations_no_personal_check.sql`（project-only）與 `0013_observations_personal_only_check.sql`（personal-only）。
- project/personal/test 三側套用規格與 CHECK 矩陣；新表為空，不需要 0008 當年的 maintenance window。
- `observations` DB tests。

Gate：
- 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`。
- migration 在 test project/personal DB 可套：0011 雙側，0012 project test，0013 personal test。
- Coolify project DB 與 personal DB 套 0011-0013 前有 backup（備份）與 tunnel health check。

### M2a：Hook 端與 payload gate（1 天）

依賴：M1 schema 可先不存在，因 hook 只寫本地。

交付：
- `scripts/probe-claude-hooks.ts` 實測 PostToolUse payload 與 transcript offset。
- `hooks/post-tool-use-capture.sh`、`hooks/stop-capture-sentinel.sh`。
- spool append library（函式庫）最小版。

Gate：
- 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`。
- 三種 tool event（事件）與 Stop sentinel offset 可重現。
- hook p95 <20ms。
- hook 網路斷線時行為不變。
- `CC_MEMORY_SKIP_TOOLS` 預設清單與整體覆蓋語義有測試。

### M2b：Cron worker + LLM extraction（2 天）

依賴：M1 + M2a。

交付：
- `scripts/run-auto-capture.ts`。
- capture LLM adapter（原交付 Gemini Flash；2026-07-07 預設改 claude-cli；2026-08-23 正式 unit 改 codex-cli 主力 + claude-cli fallback，見 spec 紅線 3 後記）、JSON schema validation、dead-letter。
- rollup + observations 寫入 transaction。
- per-session canonical rollup upsert；同 session 多個 harvest window 只更新同一筆 rollup。
- 2026-07-15 reliability repair（可靠性修復）：capture state v2、多 transcript checkpoint、穩定 chunk retry key、來源遺失第 5 次只隔離該 range、source coverage 冪等、`parked/yielded` summary、只在末筆為 Stop sentinel 時 rotation，以及唯讀 recovery manifest。
- 2026-07-15 extraction root fix（抽取根治）：Claude CLI 改用 safe mode（安全模式）＋low effort（低思考強度）＋無 tools／無 session persistence＋替換 system prompt＋原生 JSON Schema；最多 8 個合併 observation 並限制欄位大小。維持 Haiku/75s，不增加 timeout。終局失敗第一次 retry 即輸出去識別 warning。
- split tree 原子保存後，排程必須優先採用內容 hash 仍吻合的最小 nested／ancestor boundary；checkpoint 前進造成下一個 32 KiB parent range 改變時，仍直接處理既有 leaf/sibling，不重新呼叫已知過大的父區間。
- tick scheduler 在每次 Claude call 前保留 `per-call timeout + 15s`；不足即正常 yield，確保 240s worker budget 可在 270s wrapper hard timeout 前保存 state 並釋放 lock。
- memory 執行與告警由 Hermes 切至 hook-driven systemd oneshot＋memory 專用 Telegram bot；auto-capture 不設 timer，Hermes memory job 保持 pause。
- reminder／Todoist 另由 systemd timers 接手；各自手動 service 與一輪 timer 驗證完成後，才 pause 對應 Hermes job。
- Claude Code／Codex hook settings（掛鉤設定）走 draft-first，不直接覆寫使用者設定。

> 2026-07-16 註：先前 systemd timer 路線已被正式決策取代；現行 cutover 手順見 `memory-ops-cutover.md`。

Gate：
- 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`。
- worker 在 DB tunnel down 時不呼叫 LLM。
- malformed LLM output 不落 DB。
- 同 spool 重跑不重複 observation。
- 同 session 兩個 harvest window 只產生一筆 active rollup，`summarize_count/spool_offsets/observation_ids` 更新。
- budget yield 不增加 retry/dead-letter；多路徑 checkpoint 各自單調前進；LLM 終局失敗或有效 path 來源永久不可用時，第 5 次只隔離該 chunk/range，後續 range 下一 tick 恢復；暫時來源遺失在完整 boundary 恢復後清除 retry 並正常處理。
- Claude CLI 112,450-byte synthetic worker canary（合成 worker 驗證）以 2 個舊 96 KiB-policy chunks 在 24 秒完成，證明 safe-mode 路徑有效；其後 production 真實內容仍有單一 96 KiB timeout，故最終預設降為 32 KiB並加入 timeout 二分。第一次真實 retry warning 可由獨立 supervisor 判定為 alertable（可告警）。
- production 受控輪次證據：active retry 由 7 降至 3（皆為既有 `CLAUDE_CLI_TIMEOUT`）；目標 checkpoint `446274 → 450314 → 453526 → 455136 → 461156`，原 retry attempts 維持 3，dead-letter 維持 57，wrapper hard-timeout 最後紀錄停在 2026-07-15 19:29:15。
- transaction commit 後 state 保存失敗的重播不改 DB；legacy sidecar 只封存不沿用 attempts；rotation 僅封存已 Stop 的 generation state，不封存仍活躍的大 spool。

### M3：3 層 retrieval（2 天）

依賴：M1 有 observations。

交付：
- `cc_memory_search` 輕索引回應。
- `cc_memory_timeline`。
- `cc_memory_get_observations`。
- `search_feedback` 相容性測試。

Gate：
- 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`。
- search → timeline → get 三步可取回完整 facts/files/narrative。
- envelope 長度不變量與 DB CHECK 都綠。
- `CC_MEMORY_INCLUDE_OBSERVATIONS=off` 可退回只查 `project_memories`。
- mixed corpus 預設權重排序符合 manual > rollup > decision observation > other observation。

### M4：SessionStart injector + discovery_tokens（1.5 天）

依賴：M3 的 index result shape。

交付：
- Recent Activity formatter。
- 讀取 `metadata.capture.discovery_tokens`；不在注入時重新估算。
- CJK-aware `estimateDiscoveryTokens()` 驗收測試（helper 由 M2b 寫入路徑使用）。
- SessionStart hook wrapper 與 payload schema。

Gate：
- 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`。
- 預設 flag off 無輸出。
- flag on 時輸出 token budget 內的索引。
- 20 筆樣本估算誤差 ±20%。
- 每列 `discovery_tokens` 來自 rollup metadata。

### M5：refine_delete + governance（0.5 到 1 天）

依賴：M1。

交付：
- `cc_memory_refine_delete` 支援 rollup/observation。
- `tool-policy.ts` write classification。
- ScopePolicy project guard。

Gate：
- 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`。
- read-only ListTools 隱藏 + 直呼拒絕。
- allowlist 排除時直呼拒絕。
- archived 結果不進 search/timeline/get。

### M6：Benchmark harness（1 天）

依賴：M3 有三層 retrieval。

交付：
- query fixture（固定查詢資料）。
- CC-memory vs claude-mem 結果映射。
- 人工標註 template。

Gate：
- 592 tests 不回歸；跑 `npm run build && npm test && npm run lint`。
- 至少 10 組 query 可產 markdown report（報告）。
- result unit（結果單位）為 rollup，observation 為 drill-down。
- 10 組 query 中 ≥7 組 Top-5 交集 ≥3，平均 first-relevant rank 與錯抓率可計算。

## Migration Journal Policy

現況：
- `_journal.json` 記到 0006。
- 0007/0008 是 per-DB hand-written（手寫）CHECK。
- 0009/0010 也是手寫/特殊套用，其中 0010 明文要求兩側 DB 都套以避免 schema drift。

v0.5 規則：

1. **0011-0013 檔名固定**：`0011_add_observations.sql`、`0012_observations_no_personal_check.sql`、`0013_observations_personal_only_check.sql`。
2. **允許 drizzle generate 產 0011 草稿，但必須人工審 SQL**：若 generate 編號錯或帶 unrelated diff（無關差異），丟棄重生或手修。
3. **0012/0013 必須手寫並用 `scripts/apply-migration.ts` 指定 DB 套用**：per-DB CHECK 不放共用 `schema.ts`，避免把 project-only 或 personal-only invariant 帶到錯側。
4. **journal 不自動假裝完整**：若用手寫 0011-0013，`_journal.json` 不補假 entry；plan/task 記明 0007-0013 的實際套用狀態由 `scripts/test-db-setup.ts` 和 prod runbook 管。
5. **test DB 套用來源**：`scripts/test-db-setup.ts` 必須知道 0011-0013；0011 套 project/personal test DB，0012 套 project test DB，0013 套 personal test DB。0008 仍沿用既有 e2e 自套自清模式，不在 M1 一般 setup 驗。
6. **prod 狀態記錄**：套用 Coolify project DB + personal DB 後，在 benchmark/report 或 runbook 留 `applied_at`、operator、DB identity（身份）與 checksum（校驗碼）摘要。
7. **新空表無 maintenance window**：observations 是新表，0012/0013 不需要 0008 當年「先清資料再套 CHECK」順序；仍需備份與 catalog verify。
8. **不做 destructive rollback（破壞式回滾）**：0011-0013 additive；回滾等於 feature flag off + 不寫表。

## Deployment（部署）

### Phase 1：schema first

1. 確認 SSH tunnel alive。
2. 備份 project DB 與 personal DB。
3. 同一維護窗口套 0011 到 Coolify project DB 與 personal DB。
4. 套 0012 到 project DB，套 0013 到 personal DB。
5. 跑 catalog verify（表/欄位/index/CHECK）確認兩側欄位一致、路由 CHECK 分側存在。
6. 再 merge 實作 branch 或切 worker working tree（工作目錄）。hermes reminder/todoist cron 每 5/15min 直跑 working tree，兩側 DB 未就位前不得讓含 `observations` 的 `schema.ts` 上 main。

### Phase 2：capture only 併用期

> 2026-08-23 後記：本節兩週／≥30 筆／注入關閉皆降為 advisory 歷史紀錄，上線閘門改依 `memory-ops-cutover.md` §9 canary 制。

1. hook settings 走 draft-first：同時產 Claude Code 與 Codex 草稿，不直接寫 `~/.claude/settings.json` 或 `~/.codex/config.toml`。
2. PostToolUse 只 append；Stop／SessionStart quick-kick `cc-memory-auto-capture.service`，不建立 auto-capture timer。
3. reminders／Todoist 以 systemd timers 接手，驗證後才逐支 pause Hermes jobs。
4. `CC_MEMORY_INJECT_RECENT=off`。
5. ~~並行 claude-mem 2 週，收 ≥30 筆 auto rollup/observation。~~（advisory，見上方後記）

> 2026-07-16 註：現行觸發與切換語意以正式 decision card（決策卡）及 `memory-ops-cutover.md` 為準。

### Phase 3：quality gate

> 2026-08-23 後記：本節降為歷史紀錄——benchmark 與人工標註已拍板降為 advisory，Go/No-Go 改依 `memory-ops-cutover.md` §9 替換版（canary → 觀察窗 → 使用者核准長跑）。

1. ~~跑 M6 benchmark。~~
2. ~~人工標註 Top-5/rank/錯抓率。~~
3. ~~Go：停用 claude-mem plugin、停止 worker/chroma、保留 SQLite 檔。~~
4. ~~No-Go：關閉 CC-memory auto-capture，保留資料供分析。~~

## Risks

| 風險 | 影響 | 緩解 |
|---|---|---|
| SSH tunnel down | worker 連不上 DB | 起手 health check；spool 累積；stdout 告警 |
| LLM output drift（輸出漂移） | 寫入錯 schema | type guard（型別守門）/JSON schema 驗證，整包 dead-letter |
| spool flood | 磁碟爆 | 500MB cap + 停止 capture 告警 |
| PostToolUse payload 改版 | hook 讀不到 tool name | M2a 實測 gate；fallback transcript tail hash |
| duplicate observations | 檢索污染 | contentHash unique + transcript source coverage + checkpoint after DB commit |
| search envelope drift | `search_feedback` 寫壞 | M3 contract tests |
| injection loop | 注入內容又被摘要 | metadata marker 排除 + 注入不寫 feedback |
| personal 污染 | 自動採集個人資料 | worker 排除 `__personal__` + observations 0012/0013 CHECK |

## Dependencies & Unblocks

| 依賴 | 解除時機 |
|---|---|
| PostToolUse payload/offset 實測 | M2a 前 ✅ **已解除 2026-07-06**（gate PASS，見 `oq1-gate-report.json` 與 spec OQ1 RESOLVED 註記） |
| 0011-0013 migrations applied to prod project/personal | M2b 前 ✅ **已解除 2026-07-06**（雙側套用 + catalog verify 全綠，紀錄見 `docs/personal-hub/prod-runbook.md` Migration 套用紀錄節） |
| hermes cron draft review | ✅ closed/historical（hook-driven systemd oneshot 取代，見 memory-ops-cutover.md） |
| Search contract design | M3 前 |
| CJK token estimate acceptance | M4 前 |
| ~~≥30 auto records~~（2026-08-23 降 advisory） | ~~M6 品質閘前~~ |

> 2026-07-16 註：auto-capture 現行路線是 Stop／SessionStart 驅動 systemd oneshot，不設 timer；cutover 手順見 `memory-ops-cutover.md`。

## Self-Review Checklist

- [ ] 沒有引用 claude-mem 原始碼或 prompt 文字。
- [ ] 沒有把 v0.5 scope 擴到 personal auto-capture。
- [ ] 沒有新增常駐 daemon。
- [ ] 所有 write tools 進 read-only/allowlist guard。
- [ ] 所有 Gate 都含 592 tests + build + lint。
- [ ] migration 0011-0013 不依賴 `_journal.json` 假完整。
