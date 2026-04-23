# CC-memory Implementation Plan（v0.3 Phase A 已交付 + v0.4 Phase C 規劃）

> **當前狀態**：Phase A ✅（tag `v0.3-phase-a`，248 tests 綠） · Phase B ❌ 取消 · Phase C = v0.4 Stage 1（設計 ready，pending implementation）
>
> **Phase 劃分（2026-04-23 更新）：**
> - **Phase A — MCP only** ✅ 已交付：Phase 0 + Phase 1 + Phase 2 + Phase 5-A
> - ~~**Phase B — HTTP + Telegram**~~ ❌ 取消（2026-04-23）：Phase 3 / 4 / 5-B 整塊放棄
> - **Phase C — v0.4 自動採集**（pending）：M1 (schema+refine) + M2 (capture) + M3 (retrieval+cross-project) + M4 (reinject) + M5 (benchmark)
>
> **完整 Phase C 設計見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md`**（source of truth）。本 plan 在既有 Phase A / Phase B 骨架上補入 Phase C 章節 + 把 Phase B 相關段標取消。
>
> change log：
> - v1.3.1（2026-04-21）：plan.md 加 `## Dependencies` / `## Environment Variables` / `## Testing Strategy` / `## Risks`；Phase A Groundwork 區塊；Phase 標題
> - **v0.4（2026-04-23）**：Phase B 整塊標取消；新增 Phase C（自動採集）於各段落；Dependencies 加 `child_process`（Claude CLI subprocess）；Data Model 加 `session_summaries` + `refine_audit_log`

---

## Phase A Groundwork（為 Phase B 預舖路）

Phase A 雖然不實作 HTTP / bot，但以下 4 項資料面支援在 Phase A 完成，Phase B 開工時不需改 schema：

- `idempotency_key text UNIQUE` on `project_memories`（支援 bot undo 冪等）
- `writer_host text` on `project_memories` + `tasks`（支援跨電腦 / 跨介面寫入稽核）
- `bot_user_state` 表 ✅（Phase 1 已上線；Phase A 不寫入，Phase B HTTP 才用）
- `search_feedback` 表 ✅（Phase 1 已上線；Phase A MCP 被動寫入，Phase B 補 thumbs / selected_rank 回寫）

---

## Architecture（路徑定死）

> 下圖為 Phase A + Phase B 完整目標架構；Phase A 本期只交付左下的 MCP stdio + `src/services/*`（不含 `botstate.ts`）。右側 HTTP + Bot 框標記 `[Phase B]` 的元件屬 Phase B。

```
           ┌──────────────────────────────────────────┐
           │    PostgreSQL (Zeabur, 既有)               │
           │    project_memories  (v0.1 + v1.3 補欄位)  │
           │    tasks             (v0.2 Phase 1)        │
           │    search_feedback   (v0.2 Phase 1)        │
           │    bot_user_state    (v0.2 Phase 1)        │
           └──────────────────┬───────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  src/services/      │  ← 核心業務邏輯
                   │  memories / tasks / │     所有 DB 存取的唯一通道
                   │  feedback / auth /  │
                   │  projects / botstate [Phase B]│
                   └──┬───────────────┬──┘
                      │               │
             ┌────────┘               └────────┐
             ▼                                 ▼
      ┌─────────────┐                ┌──────────────────────────┐
      │ MCP stdio   │                │ HTTP REST (Hono) [Phase B]│
      │ (既有+task) │                │ 雙 token + bot            │
      │             │                │  user header              │
      └──────▲──────┘                └────────▲─────────────────┘
             │                                │
             │                                │  只走 HTTP，**完全**不直連 DB
     ┌───────┴────────┐                ┌──────┴──────────────┐
     │ Claude Code +  │                │ Telegram bot [Phase B]│
     │ Codex CLI      │                │                      │
     └────────────────┘                └──────────────────────┘
```

**強制規則（Phase B 開工時起強制執行；Phase A 本期先不存在 src/bot/ 目錄故不適用）**
- bot 的 `package.json` / tsconfig path 與 main src/ 分離
- `src/bot/**` 禁止 import `src/services/**` 或 `src/db/**`（CI grep gate）
- `bot_user_state` 讀寫一律走 `/api/bot/state/:telegram_user_id` HTTP endpoint

---

## Dependencies

| 套件 | 用途 | 階段 |
|---|---|---|
| `drizzle-orm` / `drizzle-kit` | ORM + migration 唯一真相 | Phase A ✅ |
| `@modelcontextprotocol/sdk` | MCP stdio server | Phase A ✅ |
| `pgvector` (PG extension) | 向量欄位 + HNSW index | Phase A ✅ |
| `@google/genai` | Gemini embedding（既有；v0.4 沿用，只給 embedding） | Phase A ✅ / Phase C |
| `vitest` / `@types/node` | 測試與型別 | Phase A ✅ |
| ~~`hono` / `@hono/node-server`~~ | ~~HTTP REST framework~~ | ~~Phase B~~ ❌ 取消 |
| ~~`telegraf`~~ | ~~Telegram bot client~~ | ~~Phase B~~ ❌ 取消 |
| `child_process` (node built-in) | Claude CLI subprocess 調用（v0.4 capture-runner） | Phase C |
| Claude CLI (`claude` binary) | 使用者機器需已登入 Pro/Max subscription | Phase C runtime 相依 |

Phase A 已完工。Phase C 不加新 npm 套件（只用 node 內建 + 既有 @google/genai）；外部相依僅 Claude CLI binary。

---

## Data Model

### `project_memories`（v0.1 + v1.3 補兩欄位）

v1.3 加 2 個 nullable 欄位，不動既有資料：

```sql
-- 由 Phase 2 migration 0002_add_idempotency_and_writer.sql 添加
ALTER TABLE project_memories
  ADD COLUMN idempotency_key text,
  ADD COLUMN writer_host text;

CREATE UNIQUE INDEX project_memories_idempotency_idx
  ON project_memories (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

原因：P0-2。metadata JSONB scan 無法原子冪等；partial unique index 才能讓
webhook retry / bot 重送雙寫 fail-fast。

### `tasks`（v0.2 Phase 1 已上線 + v1.3 補 writer_host）

Phase 1 已有的欄位見 `src/db/schema.ts` / `sql/migrations/0001_add_tasks_feedback_bot_state.sql`。v1.3 只加：

```sql
ALTER TABLE tasks ADD COLUMN writer_host text;
```

#### Task 狀態轉移規則（明定）

| From | To | 動作 | `completed_at` |
|---|---|---|---|
| `open` | `in_progress` | 開始 | 不動 |
| `open` / `in_progress` | `done` | 完成 | **設為 now()** |
| `open` / `in_progress` | `cancelled` | 取消 | 不動 |
| `done` | `open` | 重開 | **清除** |
| `cancelled` | `open` | 復原 | 不動 |
| `done` → `in_progress` | ❌ 禁止（要先 `open`） | — | — |

在 `services/tasks.ts` 集中驗證。**Optimistic locking**：`updateTask` 必須帶
`expectedStatus`；SQL `UPDATE ... WHERE id = ? AND status = ?`，affected=0 時
throw `StaleTaskError`（409）。

### `search_feedback`（Phase 1 已上線，Phase 5-A 補 CHECK）

Phase 5-A 選用增強（MVP 可跳過，若時間允許）：

```sql
ALTER TABLE search_feedback
  ADD CONSTRAINT search_feedback_arrays_same_length CHECK (
    cardinality(result_ids) = cardinality(result_project_ids)
    AND cardinality(result_ids) = cardinality(rank_positions)
    AND (scores IS NULL OR cardinality(scores) = cardinality(result_ids))
  );
```

`selected_rank ∈ 1..N` 由 service 層驗證（SQL 表達過於複雜）。

### `bot_user_state`（Phase 1 已上線，只改 access path）

```sql
-- 已部署
CREATE TABLE bot_user_state (
  telegram_user_id bigint PRIMARY KEY,
  active_project_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**v1.3 關鍵差異**：bot 端**不再**有 `src/bot/state.ts` 直連 DB。所有讀寫經
`/api/bot/state/:telegram_user_id` HTTP。（Phase B 取消後此規則無實作對象，保留為歷史。）

### `session_summaries`（v0.4 Phase C 新增）

完整 schema 見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §Data Model。要點：

```sql
CREATE TABLE session_summaries (
  id uuid PK,
  project_id text NOT NULL,
  session_id text,                       -- Stop hook env 取得；null 走獨立 row
  summary / keywords[] / decisions[] / next_steps[],
  capture_source text CHECK IN ('auto-stop-hook'),   -- Stage 2 可擴充
  capture_hook text CHECK IN ('stop'),               -- Stage 2 可擴充
  summarize_count int DEFAULT 1,         -- upsert 時 ++
  promoted_to_memory_id uuid,            -- promote 時填（指向 project_memories.id）
  embedding vector(1536),                -- Gemini gemini-embedding-001（沿用 Phase A，frozen 2026-04-23）
  writer_host text NOT NULL,
  idempotency_key text UNIQUE,
  status text CHECK IN ('active', 'archived'),   -- 僅兩態（frozen 2026-04-23；merge 走 archive + metadata.merged_into，不用 'merged'）
  metadata jsonb,
  created_at / updated_at
);
-- 核心 upsert 保證：
CREATE UNIQUE INDEX ss_active_per_session_uniq
  ON session_summaries (project_id, session_id)
  WHERE status = 'active' AND session_id IS NOT NULL;
```

**`project_memories` 補欄**：`ADD COLUMN source_summary_id uuid REFERENCES session_summaries(id);`（promote 時填）

**雙向 FK 一致性規則（frozen 2026-04-23）**：
- `session_summaries.promoted_to_memory_id → project_memories.id`（nullable，promote 時填）
- `project_memories.source_summary_id → session_summaries.id`（nullable，promote 時填）
- **雙向皆無 `ON DELETE CASCADE`**：refine delete 單邊時，service layer 負責手動 nullify 對側欄位（避免 cascade 連帶誤刪、保留可追溯性）

### `refine_audit_log`（v0.4 Phase C 新增）

```sql
CREATE TABLE refine_audit_log (
  id uuid PK,
  operation text NOT NULL,   -- delete/promote/merge/edit
  actor text NOT NULL,       -- 'mcp' | 'cli' | writer_host
  target_ids uuid[] NOT NULL,
  payload jsonb NOT NULL,    -- input + before/after snapshot
  created_at
);
CREATE INDEX ral_created_idx ON refine_audit_log (created_at DESC);
```

---

## Canonical Project Identity（v1.3 修訂）

### 優先序（新）

```
(1) explicit function arg（MCP tool 或 HTTP body 明示）
(2) env CC_MEMORY_PROJECT_ID（override）
(3) CLAUDE.md marker `<!-- cc-memory: project="xxx" -->`（專案預設）
(4) repo_name（git remote 穩定 id，跨電腦一致）
(5) basename(cwd)（最弱 fallback）
```

**v1.1 → v1.3 變動**：env 從 #2 升到顯式 override；新增 `repo_name` 層。

### `repo_name` 解析（v0.3：`owner/repo` 格式）

`src/utils/repo-name.ts`。為避免 shell injection，一律使用 Node 的 `execFileSync`
（參數以 argv 陣列傳入，不經 shell 展開）。**回傳 `owner/repo` 而非僅 `repo`**，
解決 fork vs upstream / 不同 org 同名 repo 漂移問題。實作細節見
`src/utils/repo-name.ts` 與 `tests/utils/repo-name.test.ts`，要點：

- 支援 https / scp-like ssh / ssh:// 三種 remote URL，自動去 `.git` 尾綴
- 非 git dir、無 origin、解析不出 owner/repo → 回 null → fallback 下一層
- 多 remote（origin + upstream）→ **一律取 origin**，不猜 upstream
- `execFileSync` 配 argv 陣列 + 2s timeout，避免 shell 展開與掛死

### MCP client 必須傳 `project_path`（v0.3 Phase A 必做）

MCP stdio server 的 `process.cwd()` 是 server process 啟動目錄（非 client 的專案目錄），
因此 client 必須在每個 tool 呼叫時傳 optional `project_path`，否則 resolveProjectId
無法讀 CLAUDE.md marker 或解析 repo_name。

- 每個 MCP tool 的 `inputSchema` 都有 optional `project_path: string` 欄位
- MCP handler 統一：`const cwd = args.project_path ?? process.cwd();`
- Skills（`/save-memory` `/load-memory`）在 call tool 時必須填入當前工作目錄
- 不嗅探 MCP session metadata（標準未保證）、不用 env 綁死 cwd

### `listProjects()` 來源定義

```sql
SELECT DISTINCT project_id FROM (
  SELECT project_id FROM project_memories WHERE status = 'active'
  UNION
  SELECT project_id FROM tasks WHERE status <> 'cancelled'
) s
```

空 project（memories / tasks 全空）**不會**出現在 list，`/switch` 會拒絕。

### Telegram `/switch` 規則

- 必須在 `listProjects()` 結果中（不做任何 fallback）
- 不存在 → 回「專案不存在，先用 Claude Code `/save-memory` 或 `/todo` 建第一筆」

---

## Writer Attribution（v1.3 新增）

### 值來源

`src/utils/writer-host.ts`：

```ts
import os from 'node:os';
export function resolveWriterHost(): string {
  return process.env.CC_MEMORY_WRITER?.trim() || os.hostname();
}
```

### 填入時機

每次 `saveMemory` / `createTask` 由 service 層自動填入 `writer_host`（不交給
呼叫端決定）。
- MCP：`os.hostname()`，Claude Code 本機跑 → 顯示使用者電腦名
- HTTP：同樣由 API service 填，API 在 Zeabur 上 → 顯示 container hostname
- Bot：`CC_MEMORY_WRITER=telegram-bot` 的 env，容易辨認

---

## Environment Variables

### 通用（Phase A 起需要）

| Env | 用途 | 必要性 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 連線（Zeabur） | 必填 |
| `GEMINI_API_KEY` | Gemini embedding API | 必填 |
| `CC_MEMORY_PROJECT_ID` | 明示覆蓋 project_id | 可選 override |
| `CC_MEMORY_WRITER` | writer_host 來源；預設 `os.hostname()` | 可選 |

### ~~Phase B — HTTP API service / Telegram bot service~~ ❌ 取消（env 全不用）

### Phase C — v0.4 自動採集

| Env | 用途 | 預設 |
|---|---|---|
| `CC_MEMORY_AUTO_CAPTURE` | 自動採集主開關 | `off`（opt-in） |
| `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH` | `cc_memory_search` 是否混入 auto summary | `on` |
| `CC_MEMORY_REINJECT` | SessionStart 是否注入記憶 | `off`（opt-in） |
| `CC_MEMORY_CLAUDE_MODEL` | Claude CLI 摘要用的 model | `claude-sonnet-4-5` |
| `CC_MEMORY_SKIP_TOOLS` | SKIP_TOOLS 清單（逗號分隔）；**整個覆蓋預設，非 union**（frozen 2026-04-23） | `ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion` |
| `CC_MEMORY_STOP_MIN_INTERVAL_SEC` | Stop 節流最短間隔（秒） | `180` |
| `CC_MEMORY_STOP_MIN_DELTA_TOKENS` | Stop 節流最少新增 token | `500` |
| `CC_MEMORY_REINJECT_SUMMARIES` | reinject 近 N 筆 summary | `3`（frozen 2026-04-23；比 design doc 原 5 保守） |
| `CC_MEMORY_REINJECT_MANUAL` | reinject 近 M 筆 manual / promoted | `2`（frozen 2026-04-23；比 design doc 原 3 保守） |
| `CC_MEMORY_WEIGHT_MANUAL` | manual 加權 | `1.0` |
| `CC_MEMORY_WEIGHT_PROMOTED` | promoted 加權 | `0.85` |
| `CC_MEMORY_WEIGHT_AUTO` | auto 加權 | `0.65` |
| `CC_MEMORY_MAX_NULL_SESSION_STREAK` | session_id 連續取不到上限 | `5` |

**前提**：使用者機器需已登入 Claude CLI（`claude auth login` 或等效）且有 Pro/Max subscription。`GEMINI_API_KEY` 繼續存在給 embedding 用。

---

## Testing Strategy

| 層級 | 工具 | 範圍 | 執行時機 |
|---|---|---|---|
| Unit | vitest | `services/*` 純邏輯、`utils/*` | 每次 `npm test` |
| Integration | vitest + Docker test PG | Drizzle schema / idempotency unique / service 串 DB | 每次 `npm test` |
| Regression | 既有 9 個測試檔 | MCP 向後相容 | 每次 `npm test` |
| E2E | curl / Telegram 手動 | Phase B 才啟用，HTTP + bot 串接 | Phase B Gate |

**Red-Green-Refactor**：Phase 2a schema 補完必須先紅（測試先失敗）再綠。其他 service layer 測試跟隨 TDD。

> **Phase 執行紀律**：TDD 紀律與完整 Phase 執行流程（brainstorm / context7 /
> simplify / code review / codex-review 順序）見
> `~/.claude/rules/sdd-workflow.md` 的 `## 每個 Phase 執行紀律`。

**Test PG**：使用 `docker-compose.test.yml` 起本地 PG；CI 走 GitHub Actions service container。

---

## Service Layer（Signatures）

### `src/services/memories.ts`

```ts
export async function saveMemory(input: SaveMemoryInput): Promise<Memory>;
export async function searchMemories(input: SearchInput): Promise<SearchResultWithScore[]>;
export async function listMemories(input: ListInput): Promise<Memory[]>;
export async function getMemory(id: string): Promise<Memory | null>;
export async function deleteMemory(id: string): Promise<void>;
export async function deleteByIdempotencyKey(key: string, maxAgeSec: number): Promise<Memory | null>;
export async function getProjectStats(projectId: string): Promise<Stats>;
```

### `src/services/tasks.ts`

```ts
export async function createTask(input: CreateTaskInput): Promise<Task>;
export async function listTasks(input: ListTasksInput): Promise<Task[]>;
export async function updateTask(
  id: string,
  patch: UpdateTaskPatch,
  opts: { expectedStatus: Task['status'] }   // optimistic locking
): Promise<Task>;
export async function resolveTaskByShortId(
  prefix: string,
  projectId: string
): Promise<Task | 'NOT_FOUND' | { kind: 'AMBIGUOUS'; candidates: Task[] }>;
```

### `src/services/projects.ts`

```ts
export function resolveProjectId(opts: {
  explicit?: string;
  cwd?: string;
  envOverride?: string;   // 測試用；預設讀 process.env.CC_MEMORY_PROJECT_ID
}): string | null;
export async function listProjects(): Promise<string[]>;  // union, distinct
export async function projectExists(id: string): Promise<boolean>;
```

### `src/services/botstate.ts`（Phase 3 新增）

Server-side bot_user_state 存取。**僅 HTTP route 使用**，bot 本身不 import。

```ts
export async function getBotUserState(telegramUserId: bigint): Promise<BotUserState | null>;
export async function setActiveProject(telegramUserId: bigint, projectId: string | null): Promise<void>;
```

### `src/services/feedback.ts`

```ts
// [Phase A] MCP cc_memory_search 呼叫完自動 fire-and-forget；寫入 9 欄完整 row（無 thumbs / selected_rank）
export async function recordSearchQuery(input: SearchQueryInput): Promise<void>;
// [Phase B] Telegram inline button / HTTP /api/feedback 回寫；UPDATE 對應 row 的 thumbs + selected_rank
export async function recordFeedback(input: FeedbackInput): Promise<void>;  // 驗長度 + rank
// [Phase A 啟用；Phase B 擴充指標] 離線 eval-retrieval.ts 統計
export async function getRetrievalStats(sinceDays: number): Promise<RetrievalStats>;
```

### 既有 MCP 層改動

- `src/index.ts`：改 call `services/*`（不再 import `db` client）
- 新增 MCP tools：`cc_task_create`, `cc_task_list`, `cc_task_update`
- 現有 6 個 memory tool 輸入輸出格式**不動**（向後相容）
- `src/tools/*.ts` → 保留當薄殼（v0.3 清理）

### Phase C 新增 services（v0.4）

```ts
// src/services/summaries.ts
export async function upsertSessionSummary(input: UpsertSummaryInput): Promise<SessionSummary>;
export async function listRecentSummaries(projectId: string, limit: number): Promise<SessionSummary[]>;

// src/services/refine.ts
export async function refineDelete(id: string, table: 'session_summaries' | 'project_memories', reason?: string): Promise<void>;
export async function refinePromote(summaryId: string, overrides?: Partial<MemoryOverrides>): Promise<Memory>;
export async function refineMerge(sourceIds: string[], targetTable: string, merged: MergedBody): Promise<Memory | SessionSummary>;
export async function refineEdit(id: string, table: string, patch: EditPatch): Promise<SessionSummary | Memory>;

// src/llm/claude-cli.ts
export async function summarizeWithClaudeCli(prompt: string, transcript: string, model: string): Promise<SummaryJson>;

// src/llm/gemini-embed.ts（Phase A 已有邏輯，抽模組）
export async function embed(text: string): Promise<number[]>;
```

### 既有 `cc_memory_search`（Phase C 擴展）

- 新增 `project_ids?: string[]` 參數（支援 `['*']` 全專案）
- 新增跨表 query + 加權 rerank（`W_MANUAL=1.0` / `W_PROMOTED=0.85` / `W_AUTO=0.65`，env 可調）
- `search_feedback` 加 `result_source_breakdown jsonb` 欄位

---

## ~~HTTP REST API（Phase B）~~ ❌ 已取消（以下歷史）

### 技術選型

Framework **Hono**；Auth **雙 token + bot user header**；部署 Zeabur 獨立 service；Entry `src/http/index.ts`。

### Auth 模型（v1.3 修訂）

| Scope | Header 要求 | 伺服器行為 |
|---|---|---|
| `admin` | `Authorization: Bearer <ADMIN_API_TOKEN>` | 跨專案全權 |
| `bot` | `Authorization: Bearer <BOT_API_TOKEN>` + `X-Telegram-User-Id: <bigint>` | 查 `bot_user_state` 取 `active_project_id`；若 null 拒寫 |

`src/http/middleware/auth.ts`：
1. 驗 token，設 `c.var.scope = 'bot' | 'admin'`
2. 若 `scope === 'bot'`：從 header 讀 `X-Telegram-User-Id`（missing → 401）
3. 查 `bot_user_state`，將 `activeProjectId` 塞入 `c.var.activeProjectId`
4. handler 裡 bot scope 任何 mutating route 若 `activeProjectId` 為 null → 403 + `SWITCH_REQUIRED`

### Endpoints

| Method   | Path                                | Scope          | 語意 / 錯誤                                                             |
| -------- | ----------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `GET`    | `/health`                           | —              | 200                                                                     |
| `GET`    | `/api/memories?project=X`           | bot + admin    | bot scope 強制 `project = c.var.activeProjectId`（query 參數忽略）      |
| `POST`   | `/api/memories`                     | bot + admin    | 409 若 idempotency_key 重複（回舊 id）; bot scope 強制 project = active |
| `GET`    | `/api/memories/:id`                 | any            | 404 若不存在；bot scope 額外 404 若跨 project                           |
| `DELETE` | `/api/memories/:id`                 | **admin only** | 404 / 200 no-op on archived                                             |
| `DELETE` | `/api/memories/by-idempotency/:key` | bot + admin    | 404 / 403 若超過 10 秒                                                  |
| `GET`    | `/api/tasks?project=X`              | bot + admin    | 同 memories project 強制                                                |
| `POST`   | `/api/tasks`                        | bot + admin    | 409 若 idempotency_key 重複                                             |
| `PATCH`  | `/api/tasks/:id`                    | bot + admin    | body 需 `expected_status`; 409 若狀態違規 / stale                       |
| `GET`    | `/api/projects`                     | bot + admin    | bot scope 回 `listProjects()` union list（不接受跨專案特權參數）           |
| `POST`   | `/api/feedback`                     | any            | 201；service 驗 array 長度與 rank                                       |
| `GET`    | `/api/bot/state/:telegram_user_id`  | bot only       | bot scope 只能讀自己 id（header 對得上）；404 若無記錄                  |
| `PUT`    | `/api/bot/state/:telegram_user_id`  | bot only       | body `{ active_project_id }`；驗 projectExists；同上只能改自己          |

### HTTP 錯誤碼

| Code | 使用情境 |
|---|---|
| 400 | 欄位缺漏 / 格式錯 |
| 401 | token 缺 / 無效 / bot 無 `X-Telegram-User-Id` |
| 403 | scope 不足 / 無 active project 但嘗試 mutate / undo 超時 |
| 404 | 不存在 |
| 409 | idempotency_key 重複 / 狀態轉移違規 / stale |
| 422 | validation fail（feedback array length / rank out of range） |

### Response envelope

```json
{ "data": ..., "error": null }
{ "data": null, "error": { "code": "NOT_FOUND", "message": "..." } }
```

### Observability

`hono/logger` middleware；結構化 log 欄位：timestamp, scope, path, status, duration_ms, project_id, telegram_user_id（bot scope 時）。錯誤走 `console.error` + stack。MVP 不接 Sentry/Datadog；記錄「何時該接」到 v0.3 backlog。

---

## ~~Telegram Bot（Phase B）~~ ❌ 已取消（以下歷史）

### Commands

| 指令 | 說明 | 未選 project 時 |
|---|---|---|
| `/start` | 歡迎 + 當前 active project（若無則提示 `/switch`） | OK |
| `/projects` | 列出 `listProjects()` 結果 | OK |
| `/switch <name>` | 切換 active project（**必須 `listProjects` 裡存在**） | OK |
| `/here` | 顯示目前 active project | OK |
| `/search <q>` | 限定 active project 搜尋（跨專案查詢改由 admin HTTP API 提供） | **拒絕，提示 `/switch`** |
| `/note <text>` | 記錄 memory | **拒絕，提示 `/switch`** |
| `/todo <text>` | 新增 todo | **拒絕，提示 `/switch`** |
| `/todos` | 列未完成 todo（當前 project） | **拒絕** |
| `/done <id前6>` | 完成（`resolveTaskByShortId`；多筆則列候選） | OK |
| `/cancel <id前6>` | 取消（同上） | OK |

### Write 流程 + Undo（走資料層冪等）

1. Bot 送 `/note X`：產生 `idempotency_key = uuid`、call `POST /api/memories` 帶 key → **先真的 insert**
2. 訊息帶 inline `[撤銷]` button，callback data = key
3. 使用者點撤銷：bot → `DELETE /api/memories/by-idempotency/:key`；`created_at` 距今 ≤ 10 秒生效，> 10 秒收 403
4. 重複點撤銷或重複發訊息：冪等保證（第二次 POST 同 key → 409 回舊 id；第二次 DELETE 同 key → 200 no-op）

`tasks` 同理；memories 現在 v1.3 加了正式欄位 `idempotency_key` 才能可靠冪等（見 Data Model）。

### Short ID 解析

`resolveTaskByShortId(prefix, projectId)` 在 service 層：
- 0 筆 → `NOT_FOUND`（bot 回「找不到」）
- 1 筆 → 回 `Task`
- 2+ 筆 → `AMBIGUOUS`（bot 列候選前 6 碼 + title，要求 7 碼或完整 id）

### 白名單

env `TELEGRAM_ALLOWED_USER_IDS=123,456`；非白名單訊息直接 ignore + log。

### Bot 不碰 DB 的強制

- `src/bot/` 目錄的 `tsconfig.bot.json` 的 `paths` 不包含 `src/db/**` / `src/services/**`
- CI 加 script：`! grep -rnE "from ['\"](\\.\\./)?(db|services)/" src/bot/ || exit 1`
- 所有 active_project 操作：`GET|PUT /api/bot/state/:user`

---

## ~~Deployment（Phase B）~~ ❌ 已取消（Phase C 無新服務部署，沿用 Phase A 的 MCP + Zeabur DB；以下歷史）

### Zeabur 服務拓撲

| Service | Runtime | Entry | 說明 |
|---|---|---|---|
| `cc-memory-pg` | PostgreSQL（既有） | — | 不動 |
| `cc-memory-api` | Node.js | `build/http/index.js` | HTTP REST |
| `cc-memory-bot` | Node.js | `build/bot/index.js` | Telegram bot |

### Build scripts（v1.3 新增，Phase 3 開工前）

```json
{
  "scripts": {
    "build": "tsc",
    "build:mcp": "tsc --project tsconfig.mcp.json",
    "build:api": "tsc --project tsconfig.api.json",
    "build:bot": "tsc --project tsconfig.bot.json",
    "start": "node build/index.js",
    "start:api": "node build/http/index.js",
    "start:bot": "node build/bot/index.js"
  }
}
```

`tsconfig.bot.json` 的 `include` 只含 `src/bot/**`，強制與 main 隔離。

### 多電腦使用

每台電腦 MCP server 本地跑，連雲端 PG；Telegram bot 單一部署在 Zeabur；
Codex CLI：`codex mcp add cc-memory -- node /path/to/build/index.js`。

`project_id` 透過 `repo_name` 解析保證跨電腦一致（見 Canonical Project Identity）。

---

## Files to Create / Modify（v1.3 更新）

### 新建（標記 Phase）

```
src/services/
  memories.ts          # Phase A  搬自 src/tools/*.ts
  tasks.ts             # Phase A  含狀態轉移 + optimistic lock + short-id 解析
  projects.ts          # Phase A  5 層優先序解析
  feedback.ts          # Phase A  含 `recordSearchQuery`（MCP search 被動寫 9 欄 row）+ `getRetrievalStats`；`recordFeedback`（驗 array 長度 + rank）延到 Phase 5-B
  ~~botstate.ts~~      # Phase B ❌ 取消

~~src/http/~~           # Phase B ❌ 取消
~~src/bot/~~            # Phase B ❌ 取消

# v0.4 Phase C 新建
src/services/
  summaries.ts         # Phase C  upsert session_summary、list recent
  refine.ts            # Phase C  delete / promote / merge / edit（共用 audit log 寫入）
src/llm/
  claude-cli.ts        # Phase C  spawn Claude CLI subprocess + timeout / retry / parse
  gemini-embed.ts      # Phase C  抽 Phase A 現有 embedding 邏輯成獨立模組（不改介面）
src/tools/
  save-summary.ts      # Phase C  MCP cc_memory_save_summary
  recent-summaries.ts  # Phase C  MCP cc_memory_recent_summaries（reinject 用 read-only）
  refine-delete.ts     # Phase C
  refine-promote.ts    # Phase C
  refine-merge.ts      # Phase C
  refine-edit.ts       # Phase C

scripts/
  capture-runner.ts    # Phase C  Stop hook 的主流程：SKIP_TOOLS + 節流 + Claude CLI + embed + upsert + queue resume
  reinject-runner.ts   # Phase C  SessionStart hook 的注入邏輯
  refine.ts            # Phase C  CLI 批次 refine（list/delete/promote/merge/edit/audit）
  benchmark.ts         # Phase C  跑 10 組 query 對比 claude-mem

hooks/
  stop-capture.sh          # Phase C
  session-start-reinject.sh # Phase C

sql/migrations/
  0006_session_summaries_refine_audit.sql        # Phase C M1  新 2 表 + project_memories.source_summary_id
  0007_search_feedback_source_breakdown.sql      # Phase C M3  search_feedback.result_source_breakdown jsonb

# runtime state（不入 git）
~/.cc-memory/
  state/<session_id>.json    # 各 session 節流狀態
  capture-queue/              # 失敗待重試
  benchmark/fixtures/         # 固定 5 query fixture（入 git 放 docs/benchmark/）

src/utils/
  repo-name.ts         # Phase A  git remote 抽 repo name（execFileSync，無 shell）
  writer-host.ts       # Phase A  env 或 os.hostname()

sql/migrations/
  0002_add_idempotency_and_writer.sql  # Phase A  ✅ 已上線

scripts/
  eval-retrieval.ts    # Phase A  ✅ 已上線

docs/
  retrieval-eval.md    # Phase A  ✅ 已上線
  ~~http-api.md~~      # Phase B ❌ 取消
  ~~telegram-bot.md~~  # Phase B ❌ 取消
  ~~zeabur-deploy.md~~ # Phase B ❌ 取消
  benchmark/fixtures.md     # Phase C  固定 5 query fixture
  benchmark-YYYY-MM-DD.md   # Phase C  每次 benchmark 跑分結果（產出物）
  claude-mem-switchoff-decision.md  # Phase C  品質閘過後的切換決策記錄
```

### 修改

```
# Phase A（已完成）
src/db/schema.ts            # 加 project_memories.idempotency_key / writer_host、tasks.writer_host
src/index.ts                # MCP server 加 task tools，call services
src/utils/project-id.ts     # 原有 getProjectId 遷到 services/projects.ts，加 env + repo_name
src/tools/*.ts              # 保留當薄殼

# ~~Phase B（已取消）~~
# ~~package.json 加 hono / telegraf、build/start scripts 分 mcp/api/bot~~
# ~~tsconfig.{mcp,api,bot}.json，bot 不能 import 核心~~
# ~~README.md HTTP + bot + Codex MCP 設定章節~~
# ~~.env.example 新增所有 HTTP/bot env~~

# Phase C（v0.4 pending）
src/db/schema.ts            # 加 session_summaries / refine_audit_log / project_memories.source_summary_id / search_feedback.result_source_breakdown
src/index.ts                # 註冊 6 個新 MCP tool（save-summary、recent-summaries、refine-{delete,promote,merge,edit}）
src/services/memories.ts    # searchMemories 擴展跨表+跨專案+加權
src/services/feedback.ts    # recordSearchQuery 填 result_source_breakdown
hooks/session-start.json    # 啟用 SessionStart re-inject（matcher=startup|clear|compact）
package.json                # 加 refine:cli / benchmark:run / build:scripts npm scripts
README.md                   # v0.4 使用說明（capture/reinject feature flag + refine CLI）
docs/next-session-handoff.md # 每個 Milestone 結束更新
```

### 刪除

```
（無；Phase 0 已刪 sql/schema.sql）
```

### 不再規劃的檔案（v1.1 有，v1.3 移除）

- `src/bot/state.ts` ← **刪除規劃**。bot 不碰 DB，走 `/api/bot/state` HTTP

### 關鍵既有可重用

| 檔案 | 重用點 |
|---|---|
| `src/db/client.ts` | DB 連線 |
| `src/db/schema.ts:projectMemories` | 保留，只加 2 欄位 |
| `src/utils/project-id.ts:getProjectId` | 併入 services/projects.ts，加 env + repo_name 層 |
| `src/utils/embedding.ts` | search service 繼續用 |
| `src/tools/search.ts:hybridSearch` | 搬到 services/memories.ts，加入回傳 mode/scores/rank |
| `skills/save-memory.md`, `skills/load-memory.md` | 不動 |

---

## Rollout Order（2026-04-21 修訂）

### Phase A — 本期交付（MCP only）

| Phase | 交付 | Gate |
|---|---|---|
| **0** ✅ | Schema alignment | 完成 |
| **1** ✅ | `tasks` / `search_feedback` / `bot_user_state` + TDD | 完成 |
| **2** ✅ | Schema 補完（idempotency_key、writer_host）+ service layer 抽出 + MCP 改 call service + 3 task MCP tool + regression green | `npm test` 全綠；MCP 全通；writer_host / idempotency_key 欄位 DB 上線 |
| **5-A** ✅ | MCP `cc_memory_search` 被動寫 `search_feedback`（query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores）+ `scripts/eval-retrieval.ts` Phase A 指標（查詢數 / mode 分佈 / 結果穩定度）+ `docs/retrieval-eval.md` | ① 跑一次 `cc_memory_search` 後 `SELECT * FROM search_feedback ORDER BY created_at DESC LIMIT 1` 能看到 9 欄完整 row；② eval 腳本產出 markdown 報告含「每日查詢數 / mode 分佈 / 結果穩定度」三區塊；③ Codex MCP (`codex mcp add cc-memory`) 能呼叫 `cc_memory_search` |

### ~~Phase B — 後續階段（HTTP + Telegram）~~ ❌ 已於 2026-04-23 取消

### Phase C — v0.4 自動採集（~7.5 日 dev + 2 週觀察）

完整任務清單、Gate 條件、依賴見 `docs/task.md` 和 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §Rollout Plan。

| Milestone | 交付 | ~工時 | Gate |
|---|---|---|---|
| **M1** | Schema migration（session_summaries + refine_audit_log）+ 4 refine MCP tools + refine CLI 基本操作 | 1d | migration local/Zeabur 都成功；refine 四 tool happy path；原 248 tests 綠 |
| **M2** | `scripts/capture-runner.ts`（SKIP_TOOLS + 雙節流 + upsert）+ `src/llm/claude-cli.ts` + `src/llm/gemini-embed.ts`（抽模組）+ `hooks/stop-capture.sh` + state/queue 機制 | 2.5d | E2E：Stop → Claude CLI → embed → DB upsert；SKIP_TOOLS 測試；節流測試；斷網 queue resume；`CC_MEMORY_AUTO_CAPTURE=off` 驗無寫入；CLI missing flag 機制 |
| **M3** | `cc_memory_search` 擴展（跨表 + `project_ids[]` + 加權）+ `search_feedback.result_source_breakdown` | 1.5d | 加權 unit test；跨 project integration 測；`CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off` 退回 Phase A 行為；原 248 tests 綠 |
| **M4** | `scripts/reinject-runner.ts` + MCP `cc_memory_recent_summaries` + `hooks/session-start-reinject.sh` + hook protocol 整合 | 1d | `/clear` 能注入；`CC_MEMORY_REINJECT=off` 不注入；空 project 不注入 placeholder |
| **M5** | `scripts/benchmark.ts` + 固定 5 query fixture + 人工標註 template | 0.5d + 2 週觀察 | benchmark 可跑；進入觀察期（觀察期結束才評品質閘） |

**Gate 未過不進下個 Milestone**。

### 品質閘（claude-mem 切換決策，非 v0.4 Gate）

觀察窗結束後跑：
- Top-5 交集 ≥ 3（10 組 query，7/10 達標）
- 人工命中度平均 rank ≤ claude-mem
- 錯抓率 < 10%

AND 全達 → 產出 `docs/claude-mem-switchoff-decision.md`、停用 claude-mem。不過 → v0.5 調參數重跑。

---

## Risks & Open Questions

### Phase A 已知風險（仍有效）

| 風險 | 影響 | 緩解 |
|---|---|---|
| `pgvector` HNSW index rebuild 卡住 | 大表上 long lock | partial unique index（WHERE IS NOT NULL）；現有資料 idempotency_key 全 NULL → rebuild 零代價 |
| `writer_host` 在容器環境值不穩 | Zeabur container hostname 可能變動 | 明確用 `CC_MEMORY_WRITER` env 覆蓋 |
| idempotency retention 政策未定 | key UNIQUE 永久存留 | 未來定；MVP 不做 GC |
| Service layer 抽出破向後相容 | MCP client 語意漂移 | 既有 6 tool I/O 鎖死 + regression |

### Phase C 風險（詳見 design doc §Risks，摘要）

| 風險 | 影響 | 緩解 |
|---|---|---|
| Stop hook 每輪觸發品質污染 | 每輪摘要 → 重複污染 retrieval | 三層過濾：SKIP_TOOLS + 雙節流 + upsert |
| Claude Pro/Max subscription 配額爆 | LLM 摘要失敗 | `quota-exceeded.flag` 1hr 冷卻；極端時 `CC_MEMORY_AUTO_CAPTURE=off` |
| Claude CLI 不存在 / 未認證 | 採集全斷 | `claude-cli-missing.flag` + manual recovery |
| Session boundary 不穩（Codex） | 同主題分散多筆 | refine merge；Stage 2 自動偵測 |
| Retrieval UX 碎化（Codex） | top-K 被 auto 佔滿 | 加權偏 manual；`CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off` 退回 |
| Precision vs LLM 錯抓 | 幻覺污染 | 抄 claude-mem prompt；refine delete；錯抓率 <10% 品質閘 |
| `session_id` 取不到 | 寫 null row、無 upsert 保護 | N 次連不到 exit + log |
| Re-inject 注入干擾 Claude | context 被預期外內容佔用 | 數量可調；`CC_MEMORY_REINJECT=off` |

### Phase C Open Questions

> 2026-04-23 已凍結的 7 項決策（embedding 維度 / Claude model / transcript cap / reinject N-M / Stop 節流預設 / SKIP_TOOLS 覆蓋語義 / 三個 feature flag 預設值）不再是 open — 值見上方 §Environment Variables / §Data Model，及 `docs/superpowers/plans/2026-04-23-v04-phase-c-implementation.md` §Frozen Decisions。

**仍待實作時決定（真正的 Open）**：

1. CLI refine `list` 是否寫 audit log（設計傾向不寫，read-only 無 audit noise；實作時確認）
2. `~/.cc-memory/state/<session_id>.json` 的清理策略（session 對應 row 被 refine delete 後 state 是否同步清）
3. benchmark `scripts/benchmark.ts` 如何讀取 claude-mem SQLite 做 top-5 對比（better-sqlite3 + cosine sim；細節留 M5 實作）

---

## 回滾策略

### Phase A（已完工）
- Phase 2 schema 變更 additive ALTER，回滾 = 不部署新 service
- Service layer 新舊並存 1 週，MCP 可 feature-flag 切回 `src/tools/*`

### Phase C 回滾
- **Schema**：`session_summaries` + `refine_audit_log` + `project_memories.source_summary_id` 皆 additive，回滾 = 不寫入這些表（Phase A 行為完全不受影響）
- **Feature flag 一鍵全關**：`CC_MEMORY_AUTO_CAPTURE=off` + `CC_MEMORY_REINJECT=off` + `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off` → 等於沒裝 v0.4
- **Hook 失效**：hook wrapper `set +e` 吞掉所有錯，Claude Code 使用者體感無異常
- **DB 汙染**：最糟情況 auto summary 寫錯一堆 → `scripts/refine.ts delete --where "capture_source='auto-stop-hook'" --dry-run` 批次清掉
- **取代 claude-mem 決策可逆**：併用期任何時候發現不對，停用 CC-memory 自動採集、繼續用 claude-mem 即可
