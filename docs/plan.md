# CC-memory v0.2 Implementation Plan

> Spec 版本：1.1（Codex plan review 修訂） · 範圍：路線 A 最保守自建

---

## Architecture（路徑定死）
```
           ┌──────────────────────────────────────────┐
           │    PostgreSQL (Zeabur, 既有)               │
           │    project_memories (v0.1, 不動)           │
           │    tasks (新) + search_feedback (新)       │
           └──────────────────┬───────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  src/services/      │  ← 核心業務邏輯
                   │  memories / tasks / │     所有 DB 存取的唯一通道
                   │  feedback / auth    │
                   └──┬───────────────┬──┘
                      │               │
             ┌────────┘               └────────┐
             ▼                                 ▼
      ┌─────────────┐                ┌──────────────────┐
      │ MCP stdio   │                │ HTTP REST (Hono) │
      │ (既有+task) │                │ 雙 token 分權    │
      │             │                │ Zeabur           │
      └──────▲──────┘                └────────▲─────────┘
             │                                │
             │                                │ 只走 HTTP，不直連 DB/service
     ┌───────┴────────┐                ┌──────┴──────┐
     │ Claude Code +  │                │ Telegram    │
     │ Codex CLI      │                │ bot         │
     └────────────────┘                └─────────────┘
```

**強制規則**：bot **不得** import `src/services/*` 或 `src/db/*`，編譯期即檢查；bot 的 `package.json` 或 tsconfig path 分離，防止意外依賴。

---

## Data Model

### 新增 `tasks` 表
```sql
-- 0002_tasks.sql
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  project_path text,

  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  description text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','done','cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high')),
  due_date timestamptz,
  tags text[] NOT NULL DEFAULT '{}'::text[],

  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','telegram','claude-code','codex','mcp')),
  source_ref text,

  -- idempotency for Telegram polling / webhook duplicates
  idempotency_key text UNIQUE,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX tasks_project_status_created_idx
  ON tasks (project_id, status, created_at DESC);
CREATE INDEX tasks_due_date_idx
  ON tasks (due_date) WHERE due_date IS NOT NULL AND status <> 'done';
CREATE INDEX tasks_idempotency_idx
  ON tasks (idempotency_key) WHERE idempotency_key IS NOT NULL;
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

在 `services/tasks.ts` 集中驗證；DB trigger 延後（MVP 靠 service 層即可）。

### 新增 `search_feedback` 表（加強版）
```sql
-- 0003_search_feedback.sql
CREATE TABLE search_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  query text NOT NULL,
  query_surface text NOT NULL              -- 'telegram' | 'mcp' | 'http'
    CHECK (query_surface IN ('telegram','mcp','http')),
  query_project_id text,                   -- 查詢當下的 active project（可能 NULL 代表跨專案）

  mode text NOT NULL                       -- 'keyword' | 'semantic' | 'hybrid'
    CHECK (mode IN ('keyword','semantic','hybrid')),
  "limit" integer NOT NULL,

  result_ids uuid[] NOT NULL,
  result_project_ids text[] NOT NULL,      -- 平行陣列 to result_ids
  rank_positions integer[] NOT NULL,       -- 1..N
  scores real[],                           -- similarity / RRF 分數（可 NULL）

  selected_id uuid,                        -- 使用者點了哪條
  selected_rank integer,
  thumbs text                              -- 'up' | 'down' | NULL
    CHECK (thumbs IN ('up','down')),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_feedback_created_idx ON search_feedback (created_at DESC);
CREATE INDEX search_feedback_mode_idx ON search_feedback (mode, thumbs);
```

**為什麼要這麼多欄位**：Codex 指出若只存 `thumbs`，兩週後無法判斷「該調 keyword / semantic / hybrid / threshold / project routing」。加這些欄位後 retrieval eval 才有決策依據。

### 新增 `bot_user_state` 表
```sql
-- 0004_bot_user_state.sql
CREATE TABLE bot_user_state (
  telegram_user_id bigint PRIMARY KEY,
  active_project_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

重啟不掉資料，防止 silent miswrite。

### `project_memories` — 不動（v0.1 schema 保留）

---

## Canonical Project Identity

優先級（保留現有邏輯，只補文件與強制）：

```
(1) CLAUDE.md 的 <!-- cc-memory: project="xxx" --> marker（最權威）
(2) env var CC_MEMORY_PROJECT_ID（手動覆蓋，優先度次高）
(3) 目錄 basename（最弱 fallback）
```

規則：新增 `src/services/projects.ts`（`resolveProjectId` / `listCanonicalProjects` / `projectExists`）。Telegram `/switch` 只能切 DB 既存 project（不存在 → 拒絕並提示先在 CC 建第一筆記憶）。未選 project 的寫入動作一律拒絕，不做任何 fallback。

---

## Service Layer（Signatures）

### `src/services/memories.ts`

搬自 `src/tools/*.ts`（純邏輯，不含 MCP 格式化）：

```ts
export async function saveMemory(input: SaveMemoryInput): Promise<Memory>;
export async function searchMemories(input: SearchInput): Promise<SearchResultWithScore[]>;
export async function listMemories(input: ListInput): Promise<Memory[]>;
export async function getMemory(id: string): Promise<Memory | null>;
export async function deleteMemory(id: string): Promise<void>;
export async function deleteByIdempotencyKey(key: string, maxAgeSec: number): Promise<Memory | null>;
export async function getProjectStats(projectId: string): Promise<Stats>;
```

### `src/services/tasks.ts`（新）

```ts
export async function createTask(input: CreateTaskInput): Promise<Task>;
export async function listTasks(input: ListTasksInput): Promise<Task[]>;
export async function updateTask(id: string, patch: UpdateTaskPatch): Promise<Task>;
// updateTask 內部強制狀態轉移規則；違規 throw InvalidTransitionError
```

### `src/services/projects.ts`（新）

```ts
export function resolveProjectId(opts: ResolveOpts): Promise<string>;
export async function listProjects(): Promise<Project[]>;       // distinct from memories + tasks
export async function projectExists(id: string): Promise<boolean>;
```

### `src/services/feedback.ts`（新）

```ts
export async function recordFeedback(input: FeedbackInput): Promise<void>;
export async function getRetrievalStats(sinceDays: number): Promise<RetrievalStats>;
// breakdown by mode / query_surface
```

### 既有 MCP 層改動

- `src/index.ts`：改 call `services/*`（不再 import `db` client）
- 新增 MCP tools：`cc_task_create`, `cc_task_list`, `cc_task_update`
- 現有 6 個 memory tool 輸入輸出格式**不動**（向後相容）
- `src/tools/*.ts` → 保留當薄殼（v0.3 清理）

---

## HTTP REST API

### 技術選型

Framework **Hono**；Auth **雙 token**（見下）；部署 Zeabur 獨立 service；Entry `src/http/index.ts`。

### Token 分權

| Token | 權限 | 持有者 |
|---|---|---|
| `BOT_API_TOKEN` | `POST /api/memories`（限 source='telegram'）、`POST /api/tasks`（限 source='telegram'）、`PATCH /api/tasks/:id` 限自己 project、`GET /api/*` 限帶 `project` 參數、`POST /api/feedback`、`DELETE /api/memories/by-idempotency/:key`（10 秒內） | Telegram bot |
| `ADMIN_API_TOKEN` | 全部 endpoint，含跨專案 `/search?all=true`、`DELETE /api/memories/:id`、`GET /api/projects` | 個人使用 / curl / 未來 Web UI |

實作：Header `Authorization: Bearer <token>`；middleware `src/http/middleware/auth.ts` 根據 token 設定 `c.var.scope = 'bot' | 'admin'`；各 route handler 檢查 scope。

### Endpoints（含 404/409 行為）

| Method | Path | Scope | 404/409 |
|---|---|---|---|
| `GET /health` | any | — | — |
| `GET /api/memories` | any | 404 不適用，空陣列 |
| `POST /api/memories` | bot+admin | 409 若 idempotency_key 重複（回舊 id） |
| `GET /api/memories/:id` | any | 404 若不存在或跨專案（bot scope） |
| `DELETE /api/memories/:id` | **admin only** | 404 若不存在；已 archived 回 200 no-op |
| `DELETE /api/memories/by-idempotency/:key` | bot+admin | 404 / 403 若超過 10 秒 |
| `GET /api/tasks` | any | 同 memories |
| `POST /api/tasks` | bot+admin | 409 若 idempotency_key 重複 |
| `PATCH /api/tasks/:id` | any | 404 若不存在；409 若違反狀態轉移 |
| `GET /api/projects` | **admin only** | — |
| `POST /api/feedback` | any | 201 |

Response envelope：

```json
{ "data": ..., "error": null }
// or
{ "data": null, "error": { "code": "NOT_FOUND", "message": "..." } }
```

### Observability

`hono/logger` 中介層印每個 request；結構化 log 欄位：timestamp, scope, path, status, duration_ms, project_id。錯誤走 `console.error` + stack（Zeabur log 收集）。MVP 不接 Sentry/Datadog；記錄「何時該接」到 v0.3 backlog。

---

## Telegram Bot

### Commands

| 指令 | 說明 | 未選 project 時 |
|---|---|---|
| `/start` | 歡迎 + 當前 active project（若無則提示 `/switch`） | OK |
| `/projects` | 列出 DB 已存在 project | OK |
| `/switch <name>` | 切換 active project（**必須 DB 存在**） | OK |
| `/here` | 顯示目前 active project | OK |
| `/search <q>` | 限定 active project 搜尋；帶 `--all` 跨專案（需 ADMIN token） | OK（可跨） |
| `/note <text>` | 記錄 memory | **拒絕並提示 `/switch`** |
| `/todo <text>` | 新增 todo | **拒絕並提示 `/switch`** |
| `/todos` | 列未完成 todo（當前 project） | **拒絕** |
| `/done <id前6>` | 完成 | OK（task 自帶 project） |
| `/cancel <id前6>` | 取消 | OK |

### Write 確認 + Undo（改用 pending_until / idempotency_key）

**捨棄 timer 模式**，改為資料層：

1. Bot 送 `/note X`：產生 `idempotency_key = uuid`、**先真的 insert**，訊息帶 inline `[撤銷]` button（callback data = key）
2. 使用者點撤銷：bot → HTTP `DELETE /api/memories/by-idempotency/:key`；10 秒內有效，超過就拒絕（by `created_at`）
3. 重複點撤銷或重複發訊息：idempotency_key 保證冪等

`tasks` 同理，靠 `tasks.idempotency_key UNIQUE`。`project_memories` 不改 schema，把 idempotency_key 存 `metadata.idempotency_key`，query 走 `jsonb` 比對。

### 白名單

env `TELEGRAM_ALLOWED_USER_IDS=123,456`；非白名單訊息直接 ignore + log。

---

## Deployment

### Zeabur 服務拓撲

| Service | Runtime | Repo entry | 說明 |
|---|---|---|---|
| `cc-memory-pg` | PostgreSQL（既有） | — | 不動 |
| `cc-memory-api` | Node.js | `build/http/index.js` | HTTP REST |
| `cc-memory-bot` | Node.js | `build/bot/index.js` | Telegram bot |

**單 repo 多 service**；Zeabur 支援指定 start command。

### 環境變數

```env
# 既有
DATABASE_URL=postgresql://...
GEMINI_API_KEY=...

# 新增（API）
BOT_API_TOKEN=<32+ 字元隨機>
ADMIN_API_TOKEN=<32+ 字元隨機>
PORT=3000

# 新增（Bot）
TELEGRAM_BOT_TOKEN=<BotFather>
TELEGRAM_ALLOWED_USER_IDS=123,456
API_URL=https://cc-memory-api.zeabur.app
API_TOKEN=<= BOT_API_TOKEN>  # bot 只拿 BOT_API_TOKEN
UNDO_WINDOW_SEC=10
```

### 多電腦使用

每台電腦 MCP server 本地跑，連雲端 PG；Telegram bot 單一部署；Codex CLI 用 `codex mcp add cc-memory -- node /path/to/build/index.js`。

---

## Files to Create / Modify

### 新建

```
src/services/
  memories.ts          # 搬自 src/tools/*.ts
  tasks.ts             # 新（含狀態轉移驗證）
  projects.ts          # 新（canonical id）
  feedback.ts          # 新

src/http/
  index.ts             # Hono app
  routes/{memories,tasks,projects,feedback,health}.ts
  middleware/{auth,logger,error}.ts

src/bot/
  index.ts             # telegraf entry (獨立 package imports only from http client)
  client.ts            # fetch wrapper to HTTP API
  state.ts             # bot_user_state DB ops (bot 唯一允許碰 DB 的地方)
  handlers/{switch,search,note,todo,todos,projects,start}.ts
  undo.ts              # idempotency key 管理

sql/migrations/
  0001_baseline.sql    # 從 Drizzle generate，紀錄用
  0002_tasks.sql
  0003_search_feedback.sql
  0004_bot_user_state.sql

scripts/
  eval-retrieval.ts    # 2 週評估腳本

docs/
  http-api.md
  telegram-bot.md
  retrieval-eval.md
  zeabur-deploy.md
  schema-alignment.md  # Day 0 紀錄
```

### 修改

```
src/db/schema.ts            # 加 tasks + search_feedback + bot_user_state
src/index.ts                # MCP server 加 task tools，call services
src/tools/*.ts              # 保留當薄殼（或下一版清）
package.json                # 加 hono, @hono/node-server, telegraf
README.md                   # HTTP + bot + Codex MCP 設定章節
.env.example                # 4 個新 env
docs/TODO.md                # v0.2 工作項目
```

### 刪除（Day 0）

```
sql/schema.sql              # 死檔，避免誤導
```

### 關鍵既有可重用

| 檔案 | 重用點 |
|---|---|
| `src/db/client.ts` | DB 連線 |
| `src/db/schema.ts:9` `projectMemories` | 保留不動 |
| `src/utils/project-id.ts:13` `getProjectId` | MCP 場景繼續用，搬進 `services/projects.ts` |
| `src/utils/embedding.ts` | search service 繼續用 |
| `src/tools/search.ts:135` `hybridSearch` | 搬到 `services/memories.ts`，**加入回傳 mode/scores/rank 給 feedback 寫入** |
| `skills/save-memory.md`, `skills/load-memory.md` | 不動 |

---

## 回滾策略

- Schema migration 單向（加表，不動舊表）→ 回滾 = 不部署新 service
- Service layer：新舊並存 1 週，MCP 可 feature-flag 切回 `src/tools/*` 實作
- HTTP / bot：獨立 service，關閉不影響 CC 使用
