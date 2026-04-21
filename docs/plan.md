# CC-memory v0.2 Implementation Plan

> Spec 版本：**1.3** · 範圍：路線 A 最保守自建 · Phase 0+1 已完成
>
> **Phase 劃分（2026-04-21 修訂）：**
> - **Phase A — MCP only（本期交付）**：Phase 0 ✅ + Phase 1 ✅ + Phase 2 + Phase 5-A
> - **Phase B — HTTP + Telegram（後續階段 / 可由其他 agent 承接）**：Phase 3 + Phase 4 + Phase 5-B
>
> Phase A 優先保證：MCP 6 memory tool + 3 task tool 全綠、service layer 抽出、跨電腦 writer_host / repo_name 驗證、被動 retrieval 記錄。Phase B 資料面支援（`idempotency_key`、`bot_user_state` 表）在 Phase A 已就位，屆時不需改 schema。
> - v1.3.1（2026-04-21）：plan.md 加 `## Dependencies` / `## Environment Variables`（從 Deployment 移出）/ `## Testing Strategy` / `## Risks & Open Questions`；`Phase A Groundwork` 區塊；Phase B 標題標記；`Phase 5` → `Phase 5-A`

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
| `drizzle-orm` / `drizzle-kit` | ORM + migration 唯一真相 | Phase A |
| `@modelcontextprotocol/sdk` | MCP stdio server | Phase A |
| `pgvector` (PG extension) | 向量欄位 + HNSW index | Phase A |
| `@google/genai` | Gemini embedding（既有） | Phase A |
| `vitest` / `@types/node` | 測試與型別 | Phase A |
| `hono` / `@hono/node-server` | HTTP REST framework | Phase B |
| `telegraf` | Telegram bot client | Phase B |

Phase A 不加 `hono` / `telegraf`。Phase B 開工時一次補。

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
`/api/bot/state/:telegram_user_id` HTTP。

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

### Phase B — HTTP API service

| Env | 用途 |
|---|---|
| `BOT_API_TOKEN` | Bot scope token（32+ 字元隨機） |
| `ADMIN_API_TOKEN` | Admin scope token（32+ 字元隨機） |
| `PORT` | HTTP listen port（預設 3000） |

### Phase B — Telegram bot service

| Env | 用途 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_ALLOWED_USER_IDS` | 白名單，逗號分隔 user id |
| `API_URL` | 指向 HTTP service（例 `https://cc-memory-api.zeabur.app`） |
| `API_TOKEN` | 等同 `BOT_API_TOKEN` |
| `CC_MEMORY_WRITER` | 建議設 `telegram-bot` 方便辨識 |
| `UNDO_WINDOW_SEC` | Undo 時效（秒），預設 10 |

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

---

## HTTP REST API（Phase B）

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

## Telegram Bot（Phase B）

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

## Deployment（Phase B）

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
  botstate.ts          # Phase B  bot_user_state 唯一通道，僅 HTTP route 使用

src/http/              # Phase B
  index.ts             # Hono app
  routes/{memories,tasks,projects,feedback,health,botstate}.ts
  middleware/{auth,logger,error}.ts

src/bot/               # Phase B
  index.ts             # telegraf entry（tsconfig.bot.json 限制 import）
  client.ts            # fetch wrapper，帶 X-Telegram-User-Id header
  handlers/{switch,search,note,todo,todos,projects,start,done,cancel}.ts
  undo.ts              # idempotency key 管理

src/utils/
  repo-name.ts         # Phase A  git remote 抽 repo name（execFileSync，無 shell）
  writer-host.ts       # Phase A  env 或 os.hostname()

sql/migrations/
  0002_add_idempotency_and_writer.sql  # Phase A  ALTER project_memories + tasks

scripts/
  eval-retrieval.ts    # Phase A  評估腳本；Phase A 僅跑查詢數 / mode 分佈 / 結果穩定度；Phase B 補 thumbs / selected_rank / 撤銷率

docs/
  retrieval-eval.md    # Phase A
  http-api.md          # Phase B  正式 API 規格
  telegram-bot.md      # Phase B
  zeabur-deploy.md     # Phase B
```

### 修改

```
src/db/schema.ts            # 加 project_memories.idempotency_key / writer_host、tasks.writer_host
src/index.ts                # MCP server 加 task tools，call services
src/utils/project-id.ts     # 原有 getProjectId 遷到 services/projects.ts，加 env + repo_name
src/tools/*.ts              # 保留當薄殼
package.json                # 加 hono, @hono/node-server, telegraf; build/start scripts 分 mcp/api/bot
tsconfig.json               # 新增 tsconfig.{mcp,api,bot}.json，bot 不能 import 核心
README.md                   # HTTP + bot + Codex MCP 設定章節
.env.example                # 新增所有 v0.2 env
docs/TODO.md                # v0.2 工作項目
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
| **2** | Schema 補完（idempotency_key、writer_host）+ service layer 抽出 + MCP 改 call service + 3 task MCP tool + regression green | `npm test` 全綠；MCP 全通；writer_host / idempotency_key 欄位 DB 上線 |
| **5-A** | MCP `cc_memory_search` 被動寫 `search_feedback`（query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores）+ `scripts/eval-retrieval.ts` Phase A 指標（查詢數 / mode 分佈 / 結果穩定度）+ `docs/retrieval-eval.md` | ① 跑一次 `cc_memory_search` 後 `SELECT * FROM search_feedback ORDER BY created_at DESC LIMIT 1` 能看到 9 欄完整 row；② eval 腳本產出 markdown 報告含「每日查詢數 / mode 分佈 / 結果穩定度」三區塊；③ Codex MCP (`codex mcp add cc-memory`) 能呼叫 `cc_memory_search` |

### Phase B — 後續階段（HTTP + Telegram，可由其他 agent 承接）

| Phase | 交付 | Gate |
|---|---|---|
| **3** | HTTP API（含 `/api/bot/state`）+ X-Telegram-User-Id middleware + 雙 token + Zeabur deploy | curl 全 endpoint 通；bot token 對 admin 收 403；bot scope 無 user header 收 401 |
| **4** | Telegram bot（走 HTTP only）+ undo + short-id collision | 跨電腦寫讀通；bot CI grep gate 無違規 |
| **5-B** | `POST /api/feedback` + Telegram inline button 回寫 thumbs / selected_rank + `docs/http-api.md` / `docs/telegram-bot.md` / `docs/zeabur-deploy.md` | 10 秒內撤銷成功；Phase B 指標（接受率 / Top-1 / 撤銷率）可量測 |

**Gate 未過不進下個 phase**。Phase A 所有 Gate 通過後才視 Phase B 需求啟動。

---

## Risks & Open Questions

### 已知風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| `pgvector` HNSW index rebuild 卡住 | Phase 2 migration 可能在大表上長時間 lock | idempotency_key 為 partial unique index（WHERE IS NOT NULL）；現有資料 idempotency_key 全 NULL → rebuild 零代價 |
| `writer_host` 在容器環境值不穩 | Zeabur container hostname 可能變動 | 明確用 `CC_MEMORY_WRITER` env 覆蓋（API service 設 `cc-memory-api`，bot 設 `telegram-bot`） |
| idempotency retention 政策未定 | key UNIQUE 永久存留可能與未來 compaction 衝突 | v0.3 再定；MVP 不做 GC |
| Service layer 抽出破向後相容 | MCP client 若語意漂移會破舊行為 | 既有 6 個 memory tool 輸入輸出格式鎖死；regression 測試覆蓋 |

### Open Questions（待答）

- HTTP rate limit：Phase B 上線時每個 scope 的 RPS 限制值（目前 MVP 單人使用不限）
- Retrieval eval 觀察期：Phase A 啟用被動記錄後是否 14 天夠看 signal，或延到 28 天
- `bot_user_state` 生命週期：telegram 使用者停用後該 row 是否歸檔（Phase B 討論）

---

## 回滾策略

- **Phase 2** schema 變更是 additive ALTER（加 nullable column + partial index），回滾 = 不部署新 service
- **Service layer**：新舊並存 1 週，MCP 可 feature-flag 切回 `src/tools/*`
- **HTTP / bot**：獨立 Zeabur service，關閉不影響 Claude Code 本機使用
- **bot_user_state API 失效**：bot 降級為「必須每次訊息帶 `#project=X`」模式（後續實作，v0.3）
