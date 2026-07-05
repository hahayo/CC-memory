> **[SUPERSEDED（已被取代）2026-07-05]** 本 v0.4 Phase C implementation plan 已被 `docs/auto-capture-v0.5/plan.md` 與 `docs/auto-capture-v0.5/task.md` 取代。保留本文作為 milestone/Gate 慣例溯源；不要依本文開工實作。

# v0.4 Phase C — Auto-capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 v0.3 Phase A 基線（MCP + 6 memory tools + 3 task tools + 248 tests 綠）之上，疊加 claude-mem 風格的自動採集（Stop hook capture + SessionStart re-inject）、四個 refine tools（delete/promote/merge/edit）、跨表+跨專案的加權 retrieval，以及決定是否停用 claude-mem 的 benchmark harness。

**Architecture:** 新表 `session_summaries`（auto 採集）與既有 `project_memories`（manual/promoted）兩表並存，透過 `cc_memory_search` 的「跨表 candidate fetch + 加權 rerank」統一召回（W_MANUAL=1.0 > W_PROMOTED=0.85 > W_AUTO=0.65）。採集端以 `Stop` hook → `capture-runner.ts`（SKIP_TOOLS 過濾 → 雙節流 → Claude CLI subprocess → Gemini embed → MCP upsert）；注入端以 `SessionStart(startup|clear|compact)` hook → `reinject-runner.ts` → stdout `additionalContext`。Refine 能力是一等公民：MCP（LLM 場景）+ CLI（批次場景）共用同一 handler，所有操作寫 `refine_audit_log`。

**Tech Stack:**
- Runtime: Node.js + TypeScript（strict mode）+ tsx
- DB: PostgreSQL + pgvector 0.8.2（Zeabur 部署，本機 docker-compose）
- ORM: Drizzle（single source of truth：`src/db/schema.ts` + `sql/migrations/`）
- MCP: `@modelcontextprotocol/sdk` StdioServerTransport
- LLM (摘要): **Claude CLI subprocess**（`claude -p --output-format json --model <m>`，吃 subscription，不呼叫 Anthropic API）
- Embedding: **Gemini `gemini-embedding-001` @ 1536 維**（沿用 Phase A，不用 design doc 原寫的 `text-embedding-004`/768；理由見 §Prerequisites Task 0.4 Open Questions）
- Tests: vitest（`npm run test:ci`）+ integration via `docker compose -f docker-compose.test.yml up -d`
- Hooks: Claude Code `Stop` + `SessionStart` 協定（`additionalContext` stdout JSON）

**Phase alignment：** 對應 design doc §Rollout Plan 的 Milestones M1–M5（不使用 Phase A/B/C banner 內的子階段詞，避免混淆）。每個 Milestone 獨立可 commit、獨立可驗 Gate。

---

## Source of Truth & Referenced Docs

- **Design spec（source of truth）**：`docs/superpowers/specs/2026-04-22-auto-capture-design.md`
- **三檔同步版**：`docs/spec.md` / `docs/plan.md` / `docs/task.md`（已同步到 v0.4）
- **Handoff**：`docs/next-session-handoff.md`
- **Workflow rules**：`~/.claude/rules/sdd-workflow.md` §「每個 Phase 執行紀律」（每個 Milestone 開工對齊）
- **claude-mem 可抄原始檔**：
  - `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json`（抽取 prompt）
  - `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/hooks/*.json`（hook 配置）
  - `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/scripts/worker-cli.js`（env defaults / provider 設定）

---

## File Structure Overview

### 新增檔案（按 Milestone 分組）

**M1 — Schema + Refine**
- `sql/migrations/0006_session_summaries_refine_audit.sql`（drizzle-kit 生成）
- `src/services/refine.ts`（四操作業務邏輯 + audit log 寫入）
- `src/tools/refine-delete.ts`、`refine-promote.ts`、`refine-merge.ts`、`refine-edit.ts`（MCP tool shells）
- `scripts/refine.ts`（CLI 批次介面）
- `tests/services/refine.test.ts`、`tests/db/v04-session-summaries-schema.test.ts`

**M2 — Capture Pipeline**
- `prompts/code.json`（從 claude-mem 10.5.2 複製）
- `src/llm/claude-cli.ts`（subprocess 封裝）
- `src/llm/gemini-embed.ts`（Phase A embedding 的 LLM-layer wrapper；實作內部 delegate 到 `src/utils/embedding.ts`）
- `src/utils/transcript.ts`（read + extract tool-list + truncate）
- `src/utils/skip-tools.ts`
- `src/utils/throttle.ts`
- `src/utils/idempotency-summary.ts`（session summary 專用 key 算法）
- `src/utils/session-state.ts`（`~/.cc-memory/state/<session_id>.json`）
- `src/utils/capture-queue.ts`（`~/.cc-memory/capture-queue/`）
- `src/utils/flag-files.ts`（`claude-cli-missing.flag` / `quota-exceeded.flag`）
- `src/services/summaries.ts`（`upsertSessionSummary` + null-session 降級）
- `src/tools/save-summary.ts`（MCP `cc_memory_save_summary`）
- `scripts/capture-runner.ts`（主流程）
- `hooks/stop-capture.sh`
- `tests/services/summaries.test.ts`、`tests/llm/claude-cli.test.ts`、`tests/llm/gemini-embed.test.ts`、`tests/utils/skip-tools.test.ts`、`tests/utils/throttle.test.ts`、`tests/utils/transcript.test.ts`、`tests/utils/session-state.test.ts`、`tests/utils/capture-queue.test.ts`、`tests/utils/flag-files.test.ts`、`tests/scripts/capture-runner.test.ts`

**M3 — Retrieval Integration**
- `sql/migrations/0007_search_feedback_source_breakdown.sql`
- `src/utils/weights.ts`
- `tests/services/search-weighted.test.ts`、`tests/services/search-cross-project.test.ts`

**M4 — SessionStart Re-inject**
- `src/services/reinject.ts`
- `src/tools/recent-summaries.ts`（MCP `cc_memory_recent_summaries`，read-only）
- `scripts/reinject-runner.ts`
- `hooks/session-start-reinject.sh`
- `tests/services/reinject.test.ts`、`tests/scripts/reinject-runner.test.ts`

**M5 — Benchmark**
- `scripts/benchmark.ts`
- `docs/benchmark/fixtures.md`
- `docs/benchmark/manual-template.md`

### 修改檔案

- `src/db/schema.ts`：M1 加 `sessionSummaries` + `refineAuditLog` + `projectMemories.sourceSummaryId`；M3 加 `searchFeedback.resultSourceBreakdown`
- `src/services/memories.ts`：M3 擴展 `searchMemories` 新增 `project_ids?: string[]` + `include_auto` + 跨表加權分支
- `src/services/feedback.ts`：M3 `recordSearchQuery` 填 `result_source_breakdown`
- `src/services/types.ts`：M1 加 refine input/output types；M2 加 summary types；M3 加 weighted ranking meta
- `src/index.ts`：註冊新 MCP tools（M1 x4、M2 x1、M4 x1 = 6 個新 tool）
- `hooks/session-start.json`：M4 啟用 re-inject（移除 Phase A 的 disabled 預設）
- `package.json`：加 `build:scripts`、`refine:cli`、`benchmark:run`、`capture:dry-run` npm scripts
- `README.md`：收尾補 v0.4 使用說明（capture hook 啟用步驟、feature flag、refine CLI 用法）
- `docs/next-session-handoff.md`：每個 Milestone 結束更新「當前狀態」

---

## Prerequisites（~0.5d，M1 開工前必過）

> 這段處理換電腦後的環境準備 + Open Questions 解決。不跑完這四個 Task 不准進 M1。

### Task 0.1 — 啟動 test DB（本機 container runtime）

**目的：** 換電腦後 `npm run test:ci` 因 `localhost:5433` 連不上而 163 tests 失敗。必須先裝 container runtime + 跑起 pg16+pgvector container，才能驗 TDD red-green。

**Files：**
- Reference: `docker-compose.test.yml`（existing）
- Reference: `tests/helpers/db.ts:8-9`（`TEST_DB_URL`）

**Steps：**

- [ ] **Step 1：盤點機器環境**

```bash
which docker podman nerdctl 2>&1 | grep -v "no "
ls /var/run/docker.sock 2>&1
```

若三者皆無 → 進 Step 2 決定安裝路徑。

- [ ] **Step 2：選裝 container runtime（擇一）**

選項 A（WSL2 上推薦）：Docker Desktop for Windows + WSL2 整合（`wsl --update`、Docker Desktop 設定勾 WSL integration），Linux 端就能跑 `docker compose`。

選項 B（純 WSL，不裝桌面）：`sudo apt-get install -y docker.io docker-compose-plugin`、`sudo usermod -aG docker $USER`、重開 shell、`sudo service docker start`。

選項 C（跳過本機 container）：export `TEST_DATABASE_URL=postgres://<user>:<pw>@<host>:<port>/<db>` 指向現有 PG + pgvector（需事先 `CREATE EXTENSION vector;`）。

使用者決定後貼 command 進 next-session-handoff.md。

- [ ] **Step 3：拉起 test DB**

```bash
docker compose -f docker-compose.test.yml up -d
# 驗 healthy：
docker compose -f docker-compose.test.yml ps
# 等到 STATUS=healthy 再進 Step 4
```

- [ ] **Step 4：套用 baseline migrations 到 test DB**

```bash
npx drizzle-kit push --config drizzle.test.config.ts
```

預期：列出 0000~0005 migration 全 applied、`project_memories` / `tasks` / `search_feedback` / `bot_user_state` 表存在、`CREATE EXTENSION vector` 已裝。

- [ ] **Step 5：手動驗 test DB 可連**

```bash
psql postgres://test:test@localhost:5433/cc_memory_test -c "\dt"
psql postgres://test:test@localhost:5433/cc_memory_test -c "SELECT extname FROM pg_extension WHERE extname='vector';"
```

預期：看到 4 張表 + `vector` extension。

- [ ] **Step 6：Commit docker-compose 設定調整（若有）**

若 Step 2 改過 `docker-compose.test.yml`，commit。否則跳。

---

### Task 0.2 — context7 查 4 份官方 docs（M2/M4 實作前鎖住 API 形狀）

**目的：** `sdd-workflow.md` 規定「context7 擺 brainstorm 之後、TDD 之前」。M1 只動 schema / refine（既有 pattern），不需要 context7。M2/M4 動到外部 API（Claude CLI flags、Gemini embedContent、Claude Code hook protocol），開工前要鎖死最新 signature。

**Files：**
- Output: append 一個 `docs/context7-snapshot-2026-04-XX.md`（4 份查詢結果彙整）

**Steps：**

- [ ] **Step 1：查 Drizzle ORM pgvector 0.8.2 語法**

```
Use: mcp__plugin_context7_context7__resolve-library-id("drizzle-orm")
Then: mcp__plugin_context7_context7__query-docs with topic:
  - "vector column + HNSW index"
  - "partial unique index with WHERE clause"
  - "ALTER TABLE add column with FK"
```

預期記下：`vector({dimensions: 1536})` 語法、`index().using('hnsw', ...)` 語法、`uniqueIndex().where(sql\`...\`)` 語法確認和 schema.ts 現有 pattern 相容。

- [ ] **Step 2：查 Claude Code hook protocol（`additionalContext` JSON shape、env 變數清單）**

```
Use: mcp__plugin_context7_context7__resolve-library-id("anthropics/claude-code")
Then: query-docs topic:
  - "Stop hook transcript path environment variables"
  - "SessionStart hook additionalContext output"
  - "hook matcher startup clear compact"
```

確認：
- `$CLAUDE_SESSION_ID` / `$CLAUDE_TRANSCRIPT_PATH` / `$CLAUDE_PROJECT_DIR` 實際 env 變數名
- `SessionStart` hook stdout JSON schema（`hookSpecificOutput.hookEventName`、`additionalContext` 欄位名稱）
- Matcher 字串語法（`startup|clear|compact`）

- [ ] **Step 3：查 Claude CLI `claude -p` 的 flags**

```bash
claude --help
claude -p --help   # 若有
```

確認：`--output-format json`、`--model <id>`、`--verbose` 等可用 flag、stdout JSON schema、如何讀 stderr 做錯誤診斷。

- [ ] **Step 4：查 Gemini `embedContent` API 當前 signature**

```
Use: context7 on @google/genai
Topic: "embedContent outputDimensionality RETRIEVAL_DOCUMENT"
```

確認：`gemini-embedding-001` 當前支援的維度、rate limit、錯誤型態；比對 `src/utils/embedding.ts` 現有寫法還對不對（API 有無變動）。

- [ ] **Step 5：彙整 context7 snapshot 檔**

Create `docs/context7-snapshot-2026-04-23.md`，每份查詢結論 1–2 段 + 官方文件 URL。

- [ ] **Step 6：Commit**

```bash
git add docs/context7-snapshot-2026-04-23.md
git commit -m "docs: v0.4 Phase C context7 API snapshot (Drizzle/Hook/CLI/Gemini)"
```

---

### Task 0.3 — Baseline 248 tests 綠

**目的：** 確認 Phase A 的 248 tests 在當前機器 + test DB 上全綠，作為 v0.4 不回歸的硬基線。

**Steps：**

- [ ] **Step 1：執行完整測試套件**

```bash
npm run test:ci 2>&1 | tee /tmp/cc-memory-baseline.log
```

- [ ] **Step 2：驗 summary line**

```bash
grep -E "Test Files|Tests " /tmp/cc-memory-baseline.log | tail -3
```

預期：
```
Test Files  18 passed (18)
Tests  248 passed (248)
```

若有 failed → 先診斷（常見：test DB migration 沒跑、`GEMINI_API_KEY` 未設導致 embedding test 跳、node_modules 不同步）。不修好 baseline 不准進 M1。

- [ ] **Step 3：記 baseline commit**

```bash
git rev-parse HEAD > /tmp/cc-memory-v04-baseline-commit.txt
cat /tmp/cc-memory-v04-baseline-commit.txt
```

記在 next-session-handoff.md 作為「v0.4 起點 commit」。

---

### Task 0.4 — Open Questions 解決（M1 前 4 個 + M2 前 3 個）

**目的：** Design doc §Open Questions 有 6 個待決策點（handoff 列出 7 個），其中 4 個阻擋 M1（schema 維度、migration number、status enum、FK 方向），3 個阻擋 M2（Claude model、transcript cap、SKIP_TOOLS 擴充策略）。先定下來再動手，避免 TDD 寫到一半回頭改 schema。

**Steps：**

- [ ] **Step 1：embedding 維度（session_summaries 用 768 還是 1536？）**

背景：design doc §Data Model 寫 `vector(768)`（`text-embedding-004`），但 Phase A 實際用 `gemini-embedding-001` + 1536 維。

決策（推薦）：**統一 1536**，理由：
1. `src/utils/embedding.ts` / `config.ts` 已硬編 1536，改成異構兩表需要兩組 helper + 兩個 HNSW index 配不同 distance operator
2. Gemini `text-embedding-004` 已被 `gemini-embedding-001` 取代（Gemini 1.5 系列之後的推薦）
3. 併用期和 claude-mem 做 benchmark，claude-mem 也用 Gemini（品質不差）
4. 維度不同對 retrieval 召回品質在中小規模 corpus（萬級以下）差距可忽略

記入 plan 並在 M1 Task 1.1 的 schema 用 `vector('embedding', { dimensions: EMBEDDING_DIMENSIONS })`（重用常數）。

- [ ] **Step 2：migration 編號**

現況：`sql/migrations/` 最新是 `0005_scope_idempotency_by_active_status.sql`。

決策：
- M1 migration = `0006_session_summaries_refine_audit.sql`
- M3 migration = `0007_search_feedback_source_breakdown.sql`
- task.md 寫的 `0003_*.sql` 是舊規劃疏漏，不用理（task.md 三檔同步下一回合再修）

- [ ] **Step 3：status enum 範圍**

`session_summaries.status` 只用 `'active' | 'archived'`（CHECK constraint），不引入 `'merged'`（`project_memories` 有，但 session_summaries 單純用 archived + `metadata.merged_into` 指向新 row 即可，見 design doc §Refine Tools `cc_memory_refine_merge`）。

- [ ] **Step 4：FK 方向（promote 不搬表）**

`project_memories.source_summary_id → session_summaries.id`（nullable，promote 時填）
`session_summaries.promoted_to_memory_id → project_memories.id`（nullable，promote 時填）

雙向都是 nullable，無 ON DELETE CASCADE（手動處理 refine delete 時的 nullify）。

- [ ] **Step 5：Claude model 預設值**

決策：預設 `claude-sonnet-4-5`（抄 `CLAUDE_MEM_MODEL` 的當前值，claude-mem 長期穩定）。env `CC_MEMORY_CLAUDE_MODEL` 可覆蓋。

- [ ] **Step 6：Transcript size cap 策略**

決策：預設 head 500KB + tail 1MB（保留意圖 + 近期），total cap 1.5MB。超過 → truncate 後在 middle 補 `\n\n...[truncated: <N> bytes]...\n\n`。

- [ ] **Step 7：SKIP_TOOLS 擴充策略**

決策：預設值 hardcode 在 `src/utils/skip-tools.ts` 的 `DEFAULT_SKIP_TOOLS` 常數，env `CC_MEMORY_SKIP_TOOLS`（逗號分隔）可**整個覆蓋**（不是 union）。這和 claude-mem 一致，用法最明確。

- [ ] **Step 8：SessionStart re-inject 數量**

決策：`REINJECT_SUMMARIES` 預設 `3`（非 design doc 說的 5），`REINJECT_MANUAL` 預設 `2`（非 3）。更保守，觀察期再看是否調高。

- [ ] **Step 9：把所有決策寫進 plan 頭部 frozen decisions 表**

在本 plan 的上方補一節「Frozen Decisions（Task 0.4 結論）」列這 8 條（見下方 commit 裡的 edit）。

- [ ] **Step 10：Commit**

```bash
git add docs/superpowers/plans/2026-04-23-v04-phase-c-implementation.md
git commit -m "plan(v0.4 Phase C): Task 0.4 frozen decisions (embedding 1536/migration/status/FK/model/cap/skip-tools/reinject-N)"
```

---

## Frozen Decisions（Task 0.4 結論，所有 M1+ tasks 必須遵守）

1. **Embedding 維度**：`vector(1536)`（重用 `EMBEDDING_DIMENSIONS` 常數）
2. **Migration number**：M1=`0006_session_summaries_refine_audit.sql`、M3=`0007_search_feedback_source_breakdown.sql`
3. **`session_summaries.status`**：`'active' | 'archived'`（無 merged）
4. **FK 方向**：雙向 nullable，無 CASCADE
5. **Claude model 預設**：`claude-sonnet-4-5`
6. **Transcript cap**：head 500KB + tail 1MB，middle 補 `[truncated]`
7. **SKIP_TOOLS 覆蓋策略**：env 整個覆蓋，不 union
8. **Re-inject 預設數量**：`REINJECT_SUMMARIES=3` / `REINJECT_MANUAL=2`

---

# Milestone 1 — Schema + Refine Tools MVP（~1d）

> **開工對齊（sdd-workflow §每個 Phase 執行紀律 Step 1）：**
> - 本 Milestone 不需要再跑 brainstorming skill（brainstorm 在 design doc 完成）。只需和使用者當面對齊本 M1 的最終 gate 項目（見 M1 Gate Task）。
> - 不需要 context7（純 DB schema + 既有 Drizzle pattern）。Task 0.2 已查過 Drizzle vector/hnsw 語法。
>
> **TDD 紀律（Step 2）：**
> - Schema task：先寫 schema test（查表存在、查 constraint、查 index）→ push migration → 驗測綠。
> - Service task：先寫 service unit test（happy path + 一個邊界 case）→ 實作到綠 → refactor。
> - MCP tool task：先寫 MCP handler test（mock service）→ 實作薄殼。
>
> **Simplify（Step 3）：** 每個 task block 寫完跑 `npm run lint && npm run build` 確認 DRY；若三個 refine service function 出現相似 audit log 寫入，抽 `writeAuditLog()` helper。
>
> **Review（Step 4）：** M1 Gate 之前整段送 `coderabbit:review`。
>
> **Commit 節奏：** 每個 Task 結束 commit 一次（細碎提交比巨大 commit 易 review）。Commit 訊息格式：`feat(M1): <具體內容>`。

## Task 1.1 — schema.ts 加 `sessionSummaries` 表

**Files：**
- Modify: `src/db/schema.ts`（新增段落，緊接 `searchFeedback` 之前或之後）
- Test: `tests/db/v04-session-summaries-schema.test.ts`（新檔）

**Design context：** Design doc §Data Model 新表。關鍵約束：
- `embedding vector(1536)`（決策 #1）
- Partial unique index `(project_id, session_id) WHERE status='active' AND session_id IS NOT NULL`（保證同 session 只有一筆 active canonical）
- `capture_source CHECK IN ('auto-stop-hook')` + `capture_hook CHECK IN ('stop')`（MVP only，留擴充）
- `status CHECK IN ('active','archived')`

- [ ] **Step 1：寫 schema 測（RED）**

建立 `tests/db/v04-session-summaries-schema.test.ts`：

```typescript
// tests/db/v04-session-summaries-schema.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';

let sql: Sql;

beforeAll(async () => {
  sql = await connectTestDb();
});

afterAll(async () => {
  await sql?.end();
});

describe('v0.4 session_summaries schema', () => {
  it('表存在且有預期欄位', async () => {
    const rows = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'session_summaries'
      ORDER BY ordinal_position
    `;
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'project_id', 'session_id', 'summary', 'keywords', 'decisions', 'next_steps',
      'capture_source', 'capture_hook', 'summarize_count', 'promoted_to_memory_id',
      'embedding', 'writer_host', 'idempotency_key', 'status', 'metadata',
      'created_at', 'updated_at',
    ]));
  });

  it('同 (project_id, session_id) status=active 只能有一筆（partial unique index）', async () => {
    await resetAllTables(sql);
    const base = {
      project_id: 'p1',
      session_id: 's1',
      summary: 'first',
      capture_source: 'auto-stop-hook',
      capture_hook: 'stop',
      writer_host: 'hostA',
      idempotency_key: 'k1',
    };
    await sql`INSERT INTO session_summaries ${sql(base)}`;
    const dup = { ...base, summary: 'dup', idempotency_key: 'k2' };
    await expect(sql`INSERT INTO session_summaries ${sql(dup)}`).rejects.toThrow(/unique/i);
  });

  it('session_id IS NULL 時 partial index 不作用，可多筆並存', async () => {
    await resetAllTables(sql);
    const makeRow = (k: string) => ({
      project_id: 'p1',
      session_id: null,
      summary: `orphan ${k}`,
      capture_source: 'auto-stop-hook',
      capture_hook: 'stop',
      writer_host: 'hostA',
      idempotency_key: k,
    });
    await sql`INSERT INTO session_summaries ${sql(makeRow('orphan-1'))}`;
    await sql`INSERT INTO session_summaries ${sql(makeRow('orphan-2'))}`;
    const rows = await sql`SELECT id FROM session_summaries WHERE session_id IS NULL`;
    expect(rows.length).toBe(2);
  });

  it('status CHECK 只接受 active / archived', async () => {
    await resetAllTables(sql);
    await expect(sql`
      INSERT INTO session_summaries (project_id, summary, capture_source, capture_hook, writer_host, idempotency_key, status)
      VALUES ('p1', 'x', 'auto-stop-hook', 'stop', 'h1', 'k-status', 'pending')
    `).rejects.toThrow(/status/i);
  });

  it('capture_source CHECK 只接受 auto-stop-hook', async () => {
    await resetAllTables(sql);
    await expect(sql`
      INSERT INTO session_summaries (project_id, summary, capture_source, capture_hook, writer_host, idempotency_key)
      VALUES ('p1', 'x', 'manual-import', 'stop', 'h1', 'k-src')
    `).rejects.toThrow(/capture_source/i);
  });
});
```

執行：
```bash
npx vitest run tests/db/v04-session-summaries-schema.test.ts
```
預期：5 tests FAIL（表不存在）。

- [ ] **Step 2：schema.ts 加 `sessionSummaries`（GREEN 準備）**

在 `src/db/schema.ts` 內（`searchFeedback` 之後、`botUserState` 之前）新增：

```typescript
// ---------------------------------------------------------------------------
// session_summaries（v0.4 Phase C M1）— auto-captured Stop hook summaries
// 同 (project_id, session_id) 只能有一筆 active（upsert 覆蓋，避免 retrieval 污染）
// ---------------------------------------------------------------------------

export const sessionSummaries = pgTable(
  'session_summaries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id'),
    summary: text('summary').notNull(),
    keywords: text('keywords').array().notNull().default(sql`'{}'::text[]`),
    decisions: text('decisions').array().notNull().default(sql`'{}'::text[]`),
    nextSteps: text('next_steps').array().notNull().default(sql`'{}'::text[]`),
    captureSource: text('capture_source').notNull(),
    captureHook: text('capture_hook').notNull(),
    summarizeCount: integer('summarize_count').notNull().default(1),
    promotedToMemoryId: uuid('promoted_to_memory_id'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    writerHost: text('writer_host').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('ss_capture_source_chk', sql`${table.captureSource} IN ('auto-stop-hook')`),
    check('ss_capture_hook_chk', sql`${table.captureHook} IN ('stop')`),
    check('ss_status_chk', sql`${table.status} IN ('active', 'archived')`),
    // 同 session 只有一筆 active（upsert 的核心保證）
    uniqueIndex('ss_active_per_session_uniq')
      .on(table.projectId, table.sessionId)
      .where(sql`${table.status} = 'active' AND ${table.sessionId} IS NOT NULL`),
    // idempotency_key 在 archive-safe scope 下唯一（同 project × 非 archived）
    uniqueIndex('ss_idempotency_idx')
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.status} = 'active'`),
    // retrieval 用
    index('ss_project_active_idx')
      .on(table.projectId, table.updatedAt.desc())
      .where(sql`${table.status} = 'active'`),
    index('ss_session_idx')
      .on(table.projectId, table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index('ss_embedding_hnsw').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ]
);

export type SessionSummary = typeof sessionSummaries.$inferSelect;
export type NewSessionSummary = typeof sessionSummaries.$inferInsert;
```

- [ ] **Step 3：生成 migration（drizzle-kit）**

```bash
npx drizzle-kit generate --name=session_summaries_refine_audit
```

確認產出 `sql/migrations/0006_*.sql`（drizzle 會自動挑編號）。若編號不對手動改檔名。打開產出檔檢查：必須只含 `CREATE TABLE session_summaries` + 該表相關 CHECK/INDEX，**不應**含其他不相關 schema 改動（若 drizzle 誤判會 diff 到 project_memories，人工移除）。

- [ ] **Step 4：apply migration 到 test DB + verify**

```bash
npx drizzle-kit push --config drizzle.test.config.ts
```

重跑測試：
```bash
npx vitest run tests/db/v04-session-summaries-schema.test.ts
```
預期：5 tests PASS。

- [ ] **Step 5：確認沒回歸原 248 tests**

```bash
npm run test:ci 2>&1 | tail -10
```
預期：`Tests  253 passed (253)` 或更多（加了 5 個新 test，原 248 不動）。

- [ ] **Step 6：Commit**

```bash
git add src/db/schema.ts sql/migrations/0006_*.sql tests/db/v04-session-summaries-schema.test.ts
git commit -m "feat(M1): add session_summaries table with partial unique indexes"
```

---

## Task 1.2 — schema.ts 加 `refineAuditLog` 表

**Files：**
- Modify: `src/db/schema.ts`
- Test: 延用 Task 1.1 的 test 檔補一個 describe block（或新檔 `tests/db/v04-refine-audit-schema.test.ts`）

**Design context：** Design doc §Refine Tools。欄位：`id / operation / actor / target_ids / payload / created_at`。

- [ ] **Step 1：寫 schema 測（RED）**

Append 到 `tests/db/v04-session-summaries-schema.test.ts`（或新檔）：

```typescript
describe('v0.4 refine_audit_log schema', () => {
  it('表存在且必要欄位齊', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'refine_audit_log'
    `;
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'operation', 'actor', 'target_ids', 'payload', 'created_at',
    ]));
  });

  it('operation CHECK 只接受 delete/promote/merge/edit', async () => {
    await expect(sql`
      INSERT INTO refine_audit_log (operation, actor, target_ids, payload)
      VALUES ('unknown-op', 'mcp', ARRAY['00000000-0000-0000-0000-000000000000']::uuid[], '{}'::jsonb)
    `).rejects.toThrow(/operation/i);
  });

  it('target_ids 是 uuid 陣列', async () => {
    const rows = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'refine_audit_log' AND column_name = 'target_ids'
    `;
    expect(rows[0].data_type).toBe('ARRAY');
  });
});
```

執行預期：3 tests FAIL。

- [ ] **Step 2：schema.ts 加 `refineAuditLog`**

在 `src/db/schema.ts` 緊接 `sessionSummaries` 之後：

```typescript
// ---------------------------------------------------------------------------
// refine_audit_log（v0.4 Phase C M1）— refine 操作稽核
// ---------------------------------------------------------------------------

export const refineAuditLog = pgTable(
  'refine_audit_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    operation: text('operation').notNull(),
    actor: text('actor').notNull(),
    targetIds: uuid('target_ids').array().notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('ral_operation_chk', sql`${table.operation} IN ('delete','promote','merge','edit')`),
    index('ral_created_idx').on(table.createdAt.desc()),
    index('ral_operation_idx').on(table.operation),
  ]
);

export type RefineAuditLog = typeof refineAuditLog.$inferSelect;
export type NewRefineAuditLog = typeof refineAuditLog.$inferInsert;
```

- [ ] **Step 3：drizzle-kit 重新 generate（合進 0006 migration）**

若 Task 1.1 的 migration 已提交，則生新 migration；若本 plan 在同一 commit 週期內尚未 push migration，`drizzle-kit generate --name=... --to=0006` 重 gen 合併（或 `drop` + re-gen）。推薦：**Task 1.1~1.3 的 schema 改動放同一 migration `0006`**，所以 Task 1.1 的 Step 3 先不 push，等 Task 1.3 結束一起 gen + push。

**本 step 實務做法：** 還不 generate，等 Task 1.3 結束統一 generate。只驗 schema.ts 語法：`npm run build`。

- [ ] **Step 4：build 驗**

```bash
npm run build
```

預期：無 TS 錯。

- [ ] **Step 5：Commit（schema only，暫不產 migration）**

```bash
git add src/db/schema.ts tests/db/v04-session-summaries-schema.test.ts
git commit -m "feat(M1): add refine_audit_log schema (migration pending Task 1.3)"
```

---

## Task 1.3 — schema.ts 給 `projectMemories` 加 `sourceSummaryId` FK

**Files：**
- Modify: `src/db/schema.ts`（`projectMemories` 欄位區）
- Test: `tests/db/v04-project-memories-source-summary.test.ts`（新檔）

- [ ] **Step 1：寫測（RED）**

```typescript
// tests/db/v04-project-memories-source-summary.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';

let sql: Sql;

beforeAll(async () => { sql = await connectTestDb(); });
afterAll(async () => { await sql?.end(); });

describe('project_memories.source_summary_id FK', () => {
  it('欄位存在且 nullable', async () => {
    const rows = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'project_memories' AND column_name = 'source_summary_id'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('FK 指向 session_summaries.id', async () => {
    const rows = await sql<{ foreign_table_name: string }[]>`
      SELECT ccu.table_name AS foreign_table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'project_memories'
        AND kcu.column_name = 'source_summary_id'
    `;
    expect(rows[0]?.foreign_table_name).toBe('session_summaries');
  });
});
```

執行預期：2 tests FAIL。

- [ ] **Step 2：schema.ts 加欄位**

在 `projectMemories` 的 column 區（`writerHost` 之後、`metadata` 之前）加：

```typescript
    // v0.4 Phase C：promote 時指回原 session_summary
    sourceSummaryId: uuid('source_summary_id').references(() => sessionSummaries.id),
```

注意：`sessionSummaries` 必須在 `projectMemories` 之前宣告，但 `projectMemories` 現在在 `sessionSummaries` 之前。解法：
- 在 `projectMemories` column 定義時用 drizzle 的 lazy reference：`.references((): AnyPgColumn => sessionSummaries.id)`（需 `import type { AnyPgColumn }`）
- 或把整段 `sessionSummaries` 宣告**搬到 `projectMemories` 之前**（但這樣 types 宣告順序亂）

**決策：** 用 drizzle lazy ref pattern：

```typescript
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
// ...
    sourceSummaryId: uuid('source_summary_id').references(
      (): AnyPgColumn => sessionSummaries.id
    ),
```

- [ ] **Step 3：generate migration（統一 0006）**

```bash
# 若 Task 1.1 已產過 migration：刪除再 re-gen（要確認未 push 到 Zeabur）
rm -f sql/migrations/0006_*.sql
npx drizzle-kit generate --name=session_summaries_refine_audit
```

檢查 `sql/migrations/0006_session_summaries_refine_audit.sql` 包含：
- `CREATE TABLE session_summaries`（所有 column、CHECK、index）
- `CREATE TABLE refine_audit_log`
- `ALTER TABLE project_memories ADD COLUMN source_summary_id uuid REFERENCES session_summaries(id)`

若 drizzle 順序錯（project_memories ALTER 在 session_summaries CREATE 之前）→ 手動搬 statement 到正確順序。

- [ ] **Step 4：apply + run tests**

```bash
npx drizzle-kit push --config drizzle.test.config.ts
npm run test:ci 2>&1 | tail -10
```
預期：`Tests  258 passed`（原 248 + 新 5 schema + 新 3 schema + 新 2 FK = 258）。

- [ ] **Step 5：Commit**

```bash
git add src/db/schema.ts sql/migrations/0006_*.sql \
        tests/db/v04-session-summaries-schema.test.ts \
        tests/db/v04-project-memories-source-summary.test.ts
git commit -m "feat(M1): migration 0006 (session_summaries + refine_audit_log + project_memories.source_summary_id FK)"
```

---

## Task 1.4 — apply migration 到 Zeabur production DB

**Design context：** Drizzle 本地 test 綠不代表 Zeabur 上綠。Zeabur PG 雖然 schema 會在生產環境 `npm start` 跑 migrate 跑起來，但 MCP server 啟動時就讀 schema，所以必須事先 apply。

**Files：**
- Reference: `~/.claude.json` → `mcpServers.cc-memory.env.DATABASE_URL`

- [ ] **Step 1：抓 production DATABASE_URL**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude.json','utf8')).mcpServers?.['cc-memory']?.env?.DATABASE_URL)"
```

- [ ] **Step 2：dry-run migration on production（無 push，僅印 diff）**

```bash
DATABASE_URL='<production-url>' npx drizzle-kit migrate --config drizzle.config.ts
# 或 push:
DATABASE_URL='<production-url>' npx drizzle-kit push --config drizzle.config.ts
```

若 `drizzle-kit` 要求互動確認 → 用非互動模式或 `--strict`；若有破壞性提示（如 drop column）→ **停下來**，回查 migration 檔是否正確。

- [ ] **Step 3：連 production DB 驗表存在**

```bash
psql "<production-url>" -c "\dt session_summaries"
psql "<production-url>" -c "\dt refine_audit_log"
psql "<production-url>" -c "\d project_memories" | grep source_summary_id
```

- [ ] **Step 4：Verify MCP server 啟動 OK**

```bash
# 本機直接跑 MCP server 驗它能讀到新 schema：
DATABASE_URL='<production-url>' npm start &
sleep 3
kill %1
```

預期：無 schema error。

- [ ] **Step 5：不 commit（本步無 code 改動）**

---

## Task 1.5 — `src/services/refine.ts` deleteRecord 實作

**Files：**
- Create: `src/services/refine.ts`
- Modify: `src/services/types.ts`（加 refine input/output types）
- Modify: `src/services/errors.ts`（若需新 error class）
- Test: `tests/services/refine.test.ts`

**Design context：** Design doc §Refine Tools `cc_memory_refine_delete`。軟刪除（status='archived'），對 archived row 重 delete 回 409 noop，寫 `refine_audit_log`。

- [ ] **Step 1：在 types.ts 加 input/output type**

```typescript
// src/services/types.ts（append）
export interface RefineDeleteInput {
  id: string;              // uuid
  table: 'session_summaries' | 'project_memories';
  reason?: string;
  actor?: string;          // 'mcp' | 'cli' | hostname（預設 hostname）
}

export interface RefineDeleteResult {
  ok: true;
  archivedAt: Date;
}
```

- [ ] **Step 2：寫 deleteRecord 測（RED）**

```typescript
// tests/services/refine.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { projectMemories, sessionSummaries, refineAuditLog } from '../../src/db/schema.js';
import { deleteRecord } from '../../src/services/refine.js';

let sql: Sql;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => { sql = await connectTestDb(); db = drizzle(sql); });
afterAll(async () => { await sql?.end(); });
beforeEach(async () => { await resetAllTables(sql); });

async function seedSummary(overrides: Record<string, unknown> = {}) {
  const [row] = await db.insert(sessionSummaries).values({
    projectId: 'p1',
    sessionId: 's1',
    summary: 'auto capture 1',
    captureSource: 'auto-stop-hook',
    captureHook: 'stop',
    writerHost: 'hostA',
    idempotencyKey: `k-${Date.now()}`,
    ...overrides,
  }).returning();
  return row;
}

describe('refine.deleteRecord', () => {
  it('把 session_summary 標成 archived 並寫 audit log', async () => {
    const row = await seedSummary();
    const res = await deleteRecord(db, { id: row.id, table: 'session_summaries', reason: 'bad', actor: 'hostA' });
    expect(res.ok).toBe(true);
    expect(res.archivedAt).toBeInstanceOf(Date);

    const [after] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.id, row.id));
    expect(after.status).toBe('archived');

    const audits = await db.select().from(refineAuditLog);
    expect(audits.length).toBe(1);
    expect(audits[0].operation).toBe('delete');
    expect(audits[0].actor).toBe('hostA');
    expect(audits[0].targetIds).toEqual([row.id]);
    expect(audits[0].payload).toMatchObject({ reason: 'bad', table: 'session_summaries' });
  });

  it('對已 archived row 再 delete 回 409', async () => {
    const row = await seedSummary({ idempotencyKey: 'k-dup' });
    await deleteRecord(db, { id: row.id, table: 'session_summaries', actor: 'hostA' });
    await expect(
      deleteRecord(db, { id: row.id, table: 'session_summaries', actor: 'hostA' })
    ).rejects.toThrow(/already archived/i);
  });

  it('project_memories 軟刪除也支援', async () => {
    const [pm] = await db.insert(projectMemories).values({
      projectId: 'p1', type: 'decision', summary: 'manual-1',
      writerHost: 'hostA', idempotencyKey: 'pm-k',
    }).returning();
    await deleteRecord(db, { id: pm.id, table: 'project_memories', actor: 'hostA' });
    const [after] = await db.select().from(projectMemories).where(eq(projectMemories.id, pm.id));
    expect(after.status).toBe('archived');
  });

  it('找不到 id 回 404', async () => {
    await expect(
      deleteRecord(db, { id: '00000000-0000-0000-0000-000000000000', table: 'session_summaries', actor: 'hostA' })
    ).rejects.toThrow(/not found/i);
  });
});
```

(note: `import { eq } from 'drizzle-orm';` 需要加到檔頭。)

預期：4 tests FAIL（`deleteRecord` 不存在）。

- [ ] **Step 3：實作 `src/services/refine.ts`（GREEN）**

```typescript
// src/services/refine.ts
import { and, eq } from 'drizzle-orm';
import type { DbClient } from './types.js';
import type { RefineDeleteInput, RefineDeleteResult } from './types.js';
import { projectMemories, sessionSummaries, refineAuditLog } from '../db/schema.js';
import { NotFoundError, ConflictError } from './errors.js';
import { resolveWriterHost } from '../utils/writer-host.js';

const TABLES = {
  session_summaries: sessionSummaries,
  project_memories: projectMemories,
} as const;

async function writeAuditLog(
  db: DbClient,
  operation: 'delete' | 'promote' | 'merge' | 'edit',
  actor: string,
  targetIds: string[],
  payload: Record<string, unknown>
): Promise<void> {
  await db.insert(refineAuditLog).values({ operation, actor, targetIds, payload });
}

export async function deleteRecord(
  db: DbClient,
  input: RefineDeleteInput
): Promise<RefineDeleteResult> {
  const table = TABLES[input.table];
  const actor = input.actor ?? resolveWriterHost();

  const [existing] = await db.select().from(table).where(eq(table.id, input.id));
  if (!existing) throw new NotFoundError(`${input.table}/${input.id} not found`);
  if (existing.status === 'archived') {
    throw new ConflictError(`${input.table}/${input.id} already archived`);
  }

  const now = new Date();
  await db.update(table)
    .set({ status: 'archived', updatedAt: now })
    .where(eq(table.id, input.id));

  await writeAuditLog(db, 'delete', actor, [input.id], {
    table: input.table,
    reason: input.reason ?? null,
    before_snapshot: { status: existing.status, summary: existing.summary },
  });

  return { ok: true, archivedAt: now };
}
```

新 error class（若 errors.ts 未有）：
```typescript
// src/services/errors.ts（append）
export class NotFoundError extends Error {
  constructor(msg: string) { super(msg); this.name = 'NotFoundError'; }
}
export class ConflictError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ConflictError'; }
}
```

- [ ] **Step 4：run tests**

```bash
npx vitest run tests/services/refine.test.ts
```
預期：4 tests PASS。

- [ ] **Step 5：Commit**

```bash
git add src/services/refine.ts src/services/types.ts src/services/errors.ts \
        tests/services/refine.test.ts
git commit -m "feat(M1): refine.deleteRecord + audit log writer"
```

---

## Task 1.6 — `refine.promoteSummary` 實作

**Design context：** Design doc §Refine Tools `cc_memory_refine_promote`。從 session_summaries 讀、overrides 可覆寫 summary/keywords/decisions；插 project_memories 新 row（writer_host+'(promoted)'）；雙向填 source_summary_id + promoted_to_memory_id；重複 promote 同一筆 → 409。

- [ ] **Step 1：types.ts 加 type**

```typescript
export interface RefinePromoteInput {
  summaryId: string;
  overrides?: {
    summary?: string;
    keywords?: string[];
    decisions?: string[];
    nextSteps?: string[];
  };
  actor?: string;
}

export interface RefinePromoteResult {
  ok: true;
  memoryId: string;
}
```

- [ ] **Step 2：寫測（RED）**

```typescript
// tests/services/refine.test.ts（append 到同檔）
describe('refine.promoteSummary', () => {
  it('promote 後 project_memories 多一筆、source_summary_id 填對、原 summary 有 promoted_to_memory_id', async () => {
    const row = await seedSummary({ idempotencyKey: 'p-1' });
    const res = await promoteSummary(db, { summaryId: row.id, actor: 'hostA' });
    expect(res.ok).toBe(true);
    expect(res.memoryId).toBeDefined();

    const [newMem] = await db.select().from(projectMemories).where(eq(projectMemories.id, res.memoryId));
    expect(newMem.sourceSummaryId).toBe(row.id);
    expect(newMem.summary).toBe(row.summary);
    expect(newMem.writerHost).toMatch(/\(promoted\)$/);

    const [afterSummary] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.id, row.id));
    expect(afterSummary.promotedToMemoryId).toBe(res.memoryId);

    const audits = await db.select().from(refineAuditLog).where(eq(refineAuditLog.operation, 'promote'));
    expect(audits.length).toBe(1);
  });

  it('overrides 覆蓋 summary/keywords 寫入新 memory', async () => {
    const row = await seedSummary({ idempotencyKey: 'p-2', summary: 'orig', keywords: ['a'] });
    const res = await promoteSummary(db, {
      summaryId: row.id,
      overrides: { summary: 'edited', keywords: ['b', 'c'] },
      actor: 'hostA',
    });
    const [newMem] = await db.select().from(projectMemories).where(eq(projectMemories.id, res.memoryId));
    expect(newMem.summary).toBe('edited');
    expect(newMem.keywords).toEqual(['b', 'c']);
  });

  it('重複 promote 同一筆 summary 回 409', async () => {
    const row = await seedSummary({ idempotencyKey: 'p-3' });
    await promoteSummary(db, { summaryId: row.id, actor: 'hostA' });
    await expect(
      promoteSummary(db, { summaryId: row.id, actor: 'hostA' })
    ).rejects.toThrow(/already promoted/i);
  });
});
```

執行預期：3 tests FAIL。

- [ ] **Step 3：實作 promoteSummary（GREEN）**

```typescript
// src/services/refine.ts（append）
import type { RefinePromoteInput, RefinePromoteResult } from './types.js';

export async function promoteSummary(
  db: DbClient,
  input: RefinePromoteInput
): Promise<RefinePromoteResult> {
  const actor = input.actor ?? resolveWriterHost();
  const [summary] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.id, input.summaryId));
  if (!summary) throw new NotFoundError(`session_summaries/${input.summaryId} not found`);
  if (summary.promotedToMemoryId) {
    throw new ConflictError(`session_summaries/${input.summaryId} already promoted to ${summary.promotedToMemoryId}`);
  }

  const ovr = input.overrides ?? {};
  const newMemory = {
    projectId: summary.projectId,
    type: 'decision' as const,
    summary: ovr.summary ?? summary.summary,
    keywords: ovr.keywords ?? summary.keywords,
    decisions: ovr.decisions ?? summary.decisions,
    nextSteps: ovr.nextSteps ?? summary.nextSteps,
    writerHost: `${actor}(promoted)`,
    idempotencyKey: `promote-${summary.id}`,
    sourceSummaryId: summary.id,
  };

  const [inserted] = await db.insert(projectMemories).values(newMemory).returning();

  await db.update(sessionSummaries)
    .set({ promotedToMemoryId: inserted.id, updatedAt: new Date() })
    .where(eq(sessionSummaries.id, summary.id));

  await writeAuditLog(db, 'promote', actor, [summary.id, inserted.id], {
    source_summary_id: summary.id,
    new_memory_id: inserted.id,
    overrides: ovr,
  });

  return { ok: true, memoryId: inserted.id };
}
```

- [ ] **Step 4：run tests + commit**

```bash
npx vitest run tests/services/refine.test.ts
git add src/services/refine.ts src/services/types.ts tests/services/refine.test.ts
git commit -m "feat(M1): refine.promoteSummary (bidirectional link + overrides)"
```

---

## Task 1.7 — `refine.mergeRecords` 實作

**Design context：** Design doc §Refine Tools `cc_memory_refine_merge`。所有 source_ids 必須同 project_id 同 table；插新 row（writer_host+'(merged-from-N)'）；舊 N 筆 status='archived'、metadata.merged_into=新 id；跨 project/table 回 400。

- [ ] **Step 1：types.ts 加 type**

```typescript
export interface RefineMergeInput {
  sourceIds: string[];
  targetTable: 'session_summaries' | 'project_memories';
  merged: {
    summary: string;
    keywords?: string[];
    decisions?: string[];
    nextSteps?: string[];
  };
  actor?: string;
}

export interface RefineMergeResult {
  ok: true;
  mergedId: string;
}
```

- [ ] **Step 2：寫測（RED）— 3 個 cases**

```typescript
// tests/services/refine.test.ts（append）
describe('refine.mergeRecords', () => {
  it('merge 兩筆 auto summary → 新 row + 兩筆 archived + metadata.merged_into', async () => {
    const a = await seedSummary({ sessionId: 'sA', idempotencyKey: 'mA' });
    const b = await seedSummary({ sessionId: 'sB', idempotencyKey: 'mB', summary: 'second' });
    const res = await mergeRecords(db, {
      sourceIds: [a.id, b.id],
      targetTable: 'session_summaries',
      merged: { summary: 'merged', keywords: ['m1'] },
      actor: 'hostA',
    });
    const [merged] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.id, res.mergedId));
    expect(merged.summary).toBe('merged');
    expect(merged.writerHost).toMatch(/\(merged-from-2\)$/);

    for (const src of [a, b]) {
      const [after] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.id, src.id));
      expect(after.status).toBe('archived');
      expect((after.metadata as any).merged_into).toBe(res.mergedId);
    }
  });

  it('跨 project merge 回 400', async () => {
    const a = await seedSummary({ projectId: 'pA', idempotencyKey: 'x1' });
    const b = await seedSummary({ projectId: 'pB', idempotencyKey: 'x2' });
    await expect(
      mergeRecords(db, {
        sourceIds: [a.id, b.id],
        targetTable: 'session_summaries',
        merged: { summary: 'cross-project' },
        actor: 'hostA',
      })
    ).rejects.toThrow(/same project/i);
  });

  it('sourceIds 少於 2 筆回 400', async () => {
    const a = await seedSummary({ idempotencyKey: 'one' });
    await expect(
      mergeRecords(db, {
        sourceIds: [a.id],
        targetTable: 'session_summaries',
        merged: { summary: 'alone' },
        actor: 'hostA',
      })
    ).rejects.toThrow(/at least 2/i);
  });
});
```

- [ ] **Step 3：實作 mergeRecords**

```typescript
// src/services/refine.ts（append）
import { inArray } from 'drizzle-orm';
import type { RefineMergeInput, RefineMergeResult } from './types.js';
import { InvalidArgumentError } from './errors.js';

export async function mergeRecords(
  db: DbClient,
  input: RefineMergeInput
): Promise<RefineMergeResult> {
  if (input.sourceIds.length < 2) {
    throw new InvalidArgumentError('merge requires at least 2 source ids');
  }
  const actor = input.actor ?? resolveWriterHost();
  const table = TABLES[input.targetTable];

  const sources = await db.select().from(table).where(inArray(table.id, input.sourceIds));
  if (sources.length !== input.sourceIds.length) {
    throw new NotFoundError(`some source ids not found in ${input.targetTable}`);
  }
  const uniqueProjects = new Set(sources.map((s) => s.projectId));
  if (uniqueProjects.size !== 1) {
    throw new InvalidArgumentError('all source ids must belong to the same project');
  }
  const projectId = sources[0].projectId;

  const insertValues: any = input.targetTable === 'session_summaries'
    ? {
        projectId,
        sessionId: null,  // merged row 不屬於任何單一 session
        summary: input.merged.summary,
        keywords: input.merged.keywords ?? [],
        decisions: input.merged.decisions ?? [],
        nextSteps: input.merged.nextSteps ?? [],
        captureSource: 'auto-stop-hook',
        captureHook: 'stop',
        writerHost: `${actor}(merged-from-${sources.length})`,
        idempotencyKey: `merge-${input.sourceIds.slice().sort().join('-')}`,
      }
    : {
        projectId,
        type: 'decision',
        summary: input.merged.summary,
        keywords: input.merged.keywords ?? [],
        decisions: input.merged.decisions ?? [],
        nextSteps: input.merged.nextSteps ?? [],
        writerHost: `${actor}(merged-from-${sources.length})`,
        idempotencyKey: `merge-${input.sourceIds.slice().sort().join('-')}`,
      };

  const [inserted] = await db.insert(table).values(insertValues).returning();

  // 原 N 筆 archive + metadata.merged_into
  for (const src of sources) {
    await db.update(table)
      .set({
        status: 'archived',
        updatedAt: new Date(),
        metadata: { ...(src.metadata as Record<string, unknown> ?? {}), merged_into: inserted.id },
      })
      .where(eq(table.id, src.id));
  }

  await writeAuditLog(db, 'merge', actor, [inserted.id, ...input.sourceIds], {
    target_table: input.targetTable,
    new_id: inserted.id,
    source_ids: input.sourceIds,
  });

  return { ok: true, mergedId: inserted.id };
}
```

- [ ] **Step 4：run tests + commit**

```bash
npx vitest run tests/services/refine.test.ts
git add src/services/refine.ts src/services/types.ts src/services/errors.ts tests/services/refine.test.ts
git commit -m "feat(M1): refine.mergeRecords (same-project guard + metadata.merged_into)"
```

---

## Task 1.8 — `refine.editRecord` 實作（含 re-embed）

**Design context：** Design doc §Refine Tools `cc_memory_refine_edit`。UPDATE 指定欄位；若改 summary 或 keywords → 自動重算 embedding；before/after snapshot 進 audit。

- [ ] **Step 1：types.ts**

```typescript
export interface RefineEditInput {
  id: string;
  table: 'session_summaries' | 'project_memories';
  patch: {
    summary?: string;
    keywords?: string[];
    decisions?: string[];
    nextSteps?: string[];
  };
  actor?: string;
}

export interface RefineEditResult {
  ok: true;
  updatedAt: Date;
  reembedded: boolean;
}
```

- [ ] **Step 2：寫測（RED）**

```typescript
// tests/services/refine.test.ts（append，mock embedding 以避免 API call）
import { vi } from 'vitest';
vi.mock('../../src/utils/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/embedding.js')>()),
  generateEmbedding: vi.fn(async () => new Array(1536).fill(0.01)),
}));

describe('refine.editRecord', () => {
  it('改 summary 會重算 embedding', async () => {
    const row = await seedSummary({ idempotencyKey: 'e-1', summary: 'orig', embedding: new Array(1536).fill(0) });
    const res = await editRecord(db, {
      id: row.id, table: 'session_summaries',
      patch: { summary: 'edited' }, actor: 'hostA',
    });
    expect(res.reembedded).toBe(true);
    const [after] = await db.select().from(sessionSummaries).where(eq(sessionSummaries.id, row.id));
    expect(after.summary).toBe('edited');
    expect(after.embedding?.[0]).not.toBe(0);
  });

  it('只改 decisions 不重算 embedding（看需求：decisions 不在 compose 內則不重）', async () => {
    const row = await seedSummary({ idempotencyKey: 'e-2' });
    const res = await editRecord(db, {
      id: row.id, table: 'session_summaries',
      patch: { decisions: ['new decision'] }, actor: 'hostA',
    });
    expect(res.reembedded).toBe(true);  // composeEmbeddingText 含 decisions，故改 decisions 也重算
  });

  it('audit log 含 before/after snapshot', async () => {
    const row = await seedSummary({ idempotencyKey: 'e-3' });
    await editRecord(db, {
      id: row.id, table: 'session_summaries',
      patch: { summary: 'edited' }, actor: 'hostA',
    });
    const [audit] = await db.select().from(refineAuditLog).where(eq(refineAuditLog.operation, 'edit'));
    expect((audit.payload as any).before.summary).toBe(row.summary);
    expect((audit.payload as any).after.summary).toBe('edited');
  });
});
```

- [ ] **Step 3：實作 editRecord**

```typescript
// src/services/refine.ts（append）
import { generateEmbedding, composeEmbeddingText } from '../utils/embedding.js';
import type { RefineEditInput, RefineEditResult } from './types.js';

const REEMBED_FIELDS: Array<keyof RefineEditInput['patch']> = ['summary', 'keywords', 'decisions'];

export async function editRecord(
  db: DbClient,
  input: RefineEditInput
): Promise<RefineEditResult> {
  const actor = input.actor ?? resolveWriterHost();
  const table = TABLES[input.table];

  const [before] = await db.select().from(table).where(eq(table.id, input.id));
  if (!before) throw new NotFoundError(`${input.table}/${input.id} not found`);

  const patch = input.patch;
  if (Object.keys(patch).length === 0) {
    throw new InvalidArgumentError('edit patch is empty');
  }

  const shouldReembed = REEMBED_FIELDS.some((k) => patch[k] !== undefined);
  let newEmbedding: number[] | null | undefined = undefined;
  if (shouldReembed) {
    const textForEmbed = composeEmbeddingText(
      patch.summary ?? before.summary,
      patch.keywords ?? before.keywords ?? [],
      patch.decisions ?? before.decisions ?? [],
    );
    newEmbedding = await generateEmbedding(textForEmbed);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.summary !== undefined) updates.summary = patch.summary;
  if (patch.keywords !== undefined) updates.keywords = patch.keywords;
  if (patch.decisions !== undefined) updates.decisions = patch.decisions;
  if (patch.nextSteps !== undefined) updates.nextSteps = patch.nextSteps;
  if (newEmbedding !== undefined) updates.embedding = newEmbedding;

  await db.update(table).set(updates).where(eq(table.id, input.id));

  await writeAuditLog(db, 'edit', actor, [input.id], {
    table: input.table,
    before: {
      summary: before.summary,
      keywords: before.keywords,
      decisions: before.decisions,
      nextSteps: before.nextSteps,
    },
    after: patch,
    reembedded: shouldReembed,
  });

  return { ok: true, updatedAt: updates.updatedAt as Date, reembedded: shouldReembed };
}
```

- [ ] **Step 4：run tests + commit**

```bash
npx vitest run tests/services/refine.test.ts
git add src/services/refine.ts src/services/types.ts tests/services/refine.test.ts
git commit -m "feat(M1): refine.editRecord (re-embed when content fields change + before/after snapshot)"
```

---

## Task 1.9 — 四個 MCP refine tool shells

**Files：**
- Create: `src/tools/refine-delete.ts`、`refine-promote.ts`、`refine-merge.ts`、`refine-edit.ts`
- Modify: `src/tools/index.ts`（export）
- Modify: `src/index.ts`（register 4 tools）
- Test: `tests/mcp-handler.test.ts`（append refine tool integration smoke）

**Pattern：** 照既有 `src/tools/save.ts` / `delete.ts` pattern 做薄殼——一個 tool 一個檔；zod schema for input；handler 呼 service；error → McpError。

- [ ] **Step 1：寫 MCP handler integration smoke test（RED）**

```typescript
// tests/mcp-handler.test.ts（append）
describe('MCP refine tools', () => {
  it('cc_memory_refine_delete archives the row', async () => {
    const row = await seedSummary({ idempotencyKey: 'mcp-1' });
    const result = await callTool('cc_memory_refine_delete', {
      id: row.id, table: 'session_summaries', reason: 'test',
    });
    expect(result.content[0].text).toMatch(/archived/);
  });
  // 其他 3 tool 同 pattern 各一個 happy path test
});
```

(`callTool` 是既有 test helper；沿用 pattern。)

- [ ] **Step 2：實作四個 tool handler**

範本（refine-delete.ts，其他 3 個 clone 此 pattern 換 service function 即可）：

```typescript
// src/tools/refine-delete.ts
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { deleteRecord } from '../services/refine.js';
import { NotFoundError, ConflictError } from '../services/errors.js';
import type { DbClient } from '../services/types.js';

export const refineDeleteSchema = z.object({
  id: z.string().uuid(),
  table: z.enum(['session_summaries', 'project_memories']),
  reason: z.string().optional(),
});

export async function handleRefineDelete(db: DbClient, args: unknown) {
  const input = refineDeleteSchema.parse(args);
  try {
    const result = await deleteRecord(db, input);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, archived_at: result.archivedAt }) }] };
  } catch (err) {
    if (err instanceof NotFoundError) throw new McpError(ErrorCode.InvalidParams, err.message);
    if (err instanceof ConflictError) throw new McpError(ErrorCode.InvalidRequest, err.message);
    throw err;
  }
}

export const refineDeleteToolDefinition = {
  name: 'cc_memory_refine_delete',
  description: '軟刪除 session_summary 或 project_memory（status=archived）+ 寫 refine_audit_log',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'row uuid' },
      table: { type: 'string', enum: ['session_summaries', 'project_memories'] },
      reason: { type: 'string', description: '選填的刪除理由（進 audit log）' },
    },
    required: ['id', 'table'],
  },
};
```

`refine-promote.ts` / `refine-merge.ts` / `refine-edit.ts` 比照 pattern，zod schema 對齊 Task 1.6/1.7/1.8 的 Input types。

- [ ] **Step 3：src/tools/index.ts 加 export**

```typescript
// src/tools/index.ts（append）
export * from './refine-delete.js';
export * from './refine-promote.js';
export * from './refine-merge.js';
export * from './refine-edit.js';
```

- [ ] **Step 4：src/index.ts 註冊 4 tool**

找到既有 `server.setRequestHandler(ListToolsRequestSchema, ...)` 段，在 `tools:` 陣列加 4 個新 tool definitions；在 `CallToolRequestSchema` handler 的 switch 加 4 個 case 路由到對應 handler。

- [ ] **Step 5：build + run test**

```bash
npm run build
npm run test:ci 2>&1 | tail -10
```
預期：所有原測 + 新 MCP smoke tests 綠。

- [ ] **Step 6：Commit**

```bash
git add src/tools/refine-*.ts src/tools/index.ts src/index.ts tests/mcp-handler.test.ts
git commit -m "feat(M1): register 4 MCP refine tools (delete/promote/merge/edit)"
```

---

## Task 1.10 — `scripts/refine.ts` CLI

**Files：**
- Create: `scripts/refine.ts`
- Modify: `package.json`（加 `refine:cli` script）
- Test: `tests/scripts/refine-cli.test.ts`（可選 smoke test；或在 E2E 手驗）

**Design context：** Design doc §Refine Tools CLI。操作：`delete / promote / merge / edit / list / audit`。通用 flags：`--dry-run` / `--yes` / `--project`。背後 call service layer function（不透過 MCP；直接 import）。

- [ ] **Step 1：CLI arg-parse 架構**

```typescript
// scripts/refine.ts
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { deleteRecord, promoteSummary, mergeRecords, editRecord } from '../src/services/refine.js';
import { sessionSummaries, projectMemories, refineAuditLog } from '../src/db/schema.js';
import { eq, sql as dsql, desc } from 'drizzle-orm';
import { resolveProjectId } from '../src/services/projects.js';

const OPS = ['delete', 'promote', 'merge', 'edit', 'list', 'audit'] as const;
type Op = (typeof OPS)[number];

async function main() {
  const [, , op, ...rest] = process.argv;
  if (!OPS.includes(op as Op)) {
    console.error(`usage: refine.ts <${OPS.join('|')}> [options]`);
    process.exit(1);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      ids: { type: 'string' },                    // comma-sep uuids
      id: { type: 'string' },
      table: { type: 'string' },
      summary: { type: 'string' },
      keywords: { type: 'string' },               // comma-sep
      where: { type: 'string' },                  // raw SQL WHERE for list/delete
      params: { type: 'string' },                 // comma-sep values for $1..$N
      project: { type: 'string' },
      limit: { type: 'string', default: '20' },
      since: { type: 'string' },                  // audit --since 2026-04-22
      reason: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });

  const client = postgres(process.env.DATABASE_URL ?? '');
  const db = drizzle(client);
  const projectId = values.project ?? await resolveProjectId(process.cwd());
  const actor = 'cli';

  try {
    switch (op as Op) {
      case 'delete':  await runDelete(db, values, projectId, actor); break;
      case 'promote': await runPromote(db, values, actor); break;
      case 'merge':   await runMerge(db, values, actor); break;
      case 'edit':    await runEdit(db, values, actor); break;
      case 'list':    await runList(db, values, projectId); break;
      case 'audit':   await runAudit(db, values); break;
    }
  } finally {
    await client.end();
  }
}

// --- 範例 runDelete ---
async function runDelete(db: any, vals: any, projectId: string, actor: string) {
  const ids = (vals.ids ?? '').split(',').filter(Boolean);
  const table = (vals.table ?? 'session_summaries') as 'session_summaries' | 'project_memories';
  if (vals['dry-run']) {
    console.log(`[dry-run] would archive ${ids.length} rows in ${table}:`, ids);
    return;
  }
  if (!vals.yes) {
    console.log(`about to archive ${ids.length} rows in ${table}. Use --yes to confirm.`);
    return;
  }
  for (const id of ids) {
    await deleteRecord(db, { id, table, actor, reason: vals.reason });
    console.log(`archived ${table}/${id}`);
  }
}

async function runList(db: any, vals: any, projectId: string) {
  const limit = parseInt(vals.limit, 10);
  const rows = await db.select().from(sessionSummaries)
    .where(eq(sessionSummaries.projectId, projectId))
    .orderBy(desc(sessionSummaries.updatedAt))
    .limit(limit);
  console.log(JSON.stringify(rows, null, 2));
}

async function runAudit(db: any, vals: any) {
  const rows = await db.select().from(refineAuditLog)
    .orderBy(desc(refineAuditLog.createdAt))
    .limit(parseInt(vals.limit, 10));
  console.log(JSON.stringify(rows, null, 2));
}

// runPromote / runMerge / runEdit：比照 pattern，call 對應 service function

main().catch((e) => { console.error(e); process.exit(1); });
```

（`--where '<sql>' --params '<csv>'` 的 parametric raw SQL 走 `postgres.js` `sql.unsafe` 為避免注入，**明確禁止**；如果需要動態 WHERE 改成 drizzle 預定義條件，或限制只接受受控 column 名單。）

- [ ] **Step 2：package.json scripts**

```json
{
  "scripts": {
    "refine:cli": "npx tsx scripts/refine.ts"
  }
}
```

- [ ] **Step 3：手動 smoke test**

需要 test DB 有資料（插入一筆 fixture）：

```bash
# 插一筆假資料
psql "$TEST_DATABASE_URL" -c "INSERT INTO session_summaries (project_id, session_id, summary, capture_source, capture_hook, writer_host, idempotency_key) VALUES ('cc-memory', 's-cli-test', 'cli smoke', 'auto-stop-hook', 'stop', 'hostA', 'cli-k-1') RETURNING id;"

# 跑 CLI list
DATABASE_URL="$TEST_DATABASE_URL" npm run refine:cli -- list --project cc-memory --limit 5

# dry-run delete
DATABASE_URL="$TEST_DATABASE_URL" npm run refine:cli -- delete --table session_summaries --ids <id-from-above> --dry-run

# 確認 audit
DATABASE_URL="$TEST_DATABASE_URL" npm run refine:cli -- audit --limit 5
```

- [ ] **Step 4：Commit**

```bash
git add scripts/refine.ts package.json
git commit -m "feat(M1): refine CLI (delete/promote/merge/edit/list/audit with --dry-run)"
```

---

## Task 1.11 — M1 Gate 驗收 + simplify + review

- [ ] **Step 1：跑完整測試**

```bash
npm run test:ci 2>&1 | tee /tmp/m1-gate.log | tail -10
```
預期：**all green**，tests 數 = 248 baseline + ≥ 12 新（5 session_summaries schema + 3 audit_log + 2 FK + 4 refine service + 若干 MCP smoke）= ≥ 262。

- [ ] **Step 2：lint + build clean**

```bash
npm run lint
npm run build
```

- [ ] **Step 3：Zeabur migration 已 apply 驗證**

```bash
psql "<production-url>" -c "SELECT COUNT(*) FROM session_summaries;"  # 應 = 0
psql "<production-url>" -c "SELECT COUNT(*) FROM refine_audit_log;"   # 應 = 0
```

- [ ] **Step 4：手動 MCP smoke（Claude Code 內）**

開 Claude Code session，呼叫：
- `cc_memory_refine_delete({id: <fake-uuid>, table: 'session_summaries'})` → 預期回 NotFound error
- `cc_memory_save({...})` 建一筆 manual memory → 拿到 id
- `cc_memory_refine_edit({id: <manual-id>, table: 'project_memories', patch: {summary: 'edited'}})` → 預期 ok
- 查 refine_audit_log 有對應 row

- [ ] **Step 5：Simplify review**

讀 `src/services/refine.ts` 全檔，檢查：
- 四個 function 有沒有可抽的 helper？（`writeAuditLog` 已抽；若有更多 DRY 機會如「讀 row → NotFound 檢查」可抽 `requireRow(db, table, id)`）
- CLI `scripts/refine.ts` 有沒有 command 重複的 dry-run/yes 判斷？抽 `confirmOrDryRun(action, opts)` helper。

做適當重構 + 跑測確認不回歸。

- [ ] **Step 6：送 code review**

呼 `coderabbit:review` 或 `code-review:code-review` skill：

```
/coderabbit:review 
# 或
/code-review:code-review
```

等 comments，處理高優先意見（P1/P2）。

- [ ] **Step 7：codex-review（本 M1 是「大顆粒」，跑 SDD 二審）**

```
/codex-review
```

確認 SDD 三檔 + 本 plan + code 三者一致。

- [ ] **Step 8：更新 handoff**

編輯 `docs/next-session-handoff.md`：M1 ✅ 段落加勾、貼 M1 gate log 路徑。

- [ ] **Step 9：最終 commit + tag**

```bash
git add docs/next-session-handoff.md
git commit -m "docs(M1): gate passed, update handoff"
git tag v0.4-m1
```

---

# Milestone 2 — Capture Pipeline（~2.5d）

> **開工對齊（sdd-workflow §每個 Phase 執行紀律 Step 1）：**
> - 再跑一次 needs alignment：和使用者確認 M2 gate 項目 + 本 milestone 預計哪天完成。
> - context7 已在 Task 0.2 查過 Claude CLI flags + Claude Code `Stop` hook protocol。
>
> **TDD 紀律：**
> - 每個 helper 純 function test 優先（skip-tools / throttle / transcript / idempotency / flag-files）
> - I/O heavy 模組（claude-cli subprocess / capture-queue fs / session-state fs）用 `vi.mock` mock
> - capture-runner 本身用 integration test（跑 fake transcript fixture）
>
> **Commit 節奏：** 每個 helper / service / script 一個 commit。

## Task 2.1 — `prompts/code.json` 複製 + pinning

**目的：** design doc 明說「抄 claude-mem `code.json`」，不發明新路。複製一份到本 repo 方便 diff/pin 版本。

**Files：**
- Create: `prompts/code.json`
- Create: `prompts/README.md`（說明抄自哪裡 + 何時同步）

- [ ] **Step 1：複製檔案**

```bash
mkdir -p prompts
cp ~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json prompts/code.json
```

- [ ] **Step 2：寫 README**

```markdown
# prompts/

## code.json

抄自 `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json`（claude-mem 10.5.2，2026-04-23 快照）。

**為何不 symlink / 直接引用原檔：**
- claude-mem plugin 升版時 prompt 可能有 breaking change；本 repo 要能獨立鎖版本驗 benchmark
- design doc §Design Principles「抄 claude-mem 能抄的」前提是同一 prompt 做公平對比

**同步策略：**
- 每次 claude-mem 升版想跟進 → diff 兩邊 → 明確決策是否採納 → commit 時註明「sync from claude-mem X.Y.Z」
```

- [ ] **Step 3：Commit**

```bash
git add prompts/code.json prompts/README.md
git commit -m "feat(M2): pin claude-mem 10.5.2 code.json prompt template"
```

---

## Task 2.2 — `src/utils/skip-tools.ts`

**Files：**
- Create: `src/utils/skip-tools.ts`
- Test: `tests/utils/skip-tools.test.ts`

**Design context：** Design doc §SKIP_TOOLS 過濾。本輪 tool 集合 ⊆ SKIP_TOOLS → skip。

- [ ] **Step 1：寫測（RED）**

```typescript
// tests/utils/skip-tools.test.ts
import { describe, it, expect } from 'vitest';
import { shouldSkipBySkipTools, parseSkipToolsEnv, DEFAULT_SKIP_TOOLS } from '../../src/utils/skip-tools.js';

describe('skip-tools', () => {
  it('只叫 TodoWrite → skip', () => {
    expect(shouldSkipBySkipTools(['TodoWrite'], DEFAULT_SKIP_TOOLS)).toBe(true);
  });
  it('叫 TodoWrite + SlashCommand → skip（兩者都在清單）', () => {
    expect(shouldSkipBySkipTools(['TodoWrite', 'SlashCommand'], DEFAULT_SKIP_TOOLS)).toBe(true);
  });
  it('叫 Edit + Bash → 不 skip', () => {
    expect(shouldSkipBySkipTools(['Edit', 'Bash'], DEFAULT_SKIP_TOOLS)).toBe(false);
  });
  it('空 tool list（純對話輪）→ 不 skip', () => {
    expect(shouldSkipBySkipTools([], DEFAULT_SKIP_TOOLS)).toBe(false);
  });
  it('env 覆蓋（整個覆蓋，不 union）', () => {
    const custom = parseSkipToolsEnv('Foo,Bar');
    expect(custom).toEqual(['Foo', 'Bar']);
    // 原 DEFAULT 的 TodoWrite 不會自動 include
    expect(shouldSkipBySkipTools(['TodoWrite'], custom)).toBe(false);
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/utils/skip-tools.ts
export const DEFAULT_SKIP_TOOLS: readonly string[] = [
  'ListMcpResourcesTool', 'SlashCommand', 'Skill', 'TodoWrite', 'AskUserQuestion',
];

export function parseSkipToolsEnv(envValue: string | undefined): string[] {
  if (!envValue) return [...DEFAULT_SKIP_TOOLS];
  return envValue.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 判斷本輪 tool 使用清單是否 ⊆ skip-tools 清單（空輪次不 skip） */
export function shouldSkipBySkipTools(
  toolsUsed: string[],
  skipTools: readonly string[]
): boolean {
  if (toolsUsed.length === 0) return false;
  const skipSet = new Set(skipTools);
  return toolsUsed.every((t) => skipSet.has(t));
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/utils/skip-tools.test.ts
git add src/utils/skip-tools.ts tests/utils/skip-tools.test.ts
git commit -m "feat(M2): skip-tools filter (default list from claude-mem 10.5.2)"
```

---

## Task 2.3 — `src/utils/throttle.ts`（雙節流）

**Files：**
- Create: `src/utils/throttle.ts`
- Test: `tests/utils/throttle.test.ts`

**Design context：** Design doc §Constraint 6「雙節流是硬要求」：min-interval 180s AND min-delta-tokens 500，任一不過即跳過。

- [ ] **Step 1：測（RED）**

```typescript
// tests/utils/throttle.test.ts
import { describe, it, expect } from 'vitest';
import { shouldThrottle, DEFAULT_MIN_INTERVAL_SEC, DEFAULT_MIN_DELTA_TOKENS } from '../../src/utils/throttle.js';

describe('throttle', () => {
  it('間隔 < min-interval → throttle', () => {
    const now = Date.now();
    expect(shouldThrottle({
      lastSummaryAtMs: now - 60 * 1000,  // 60s
      deltaTokens: 10_000,
      nowMs: now,
      minIntervalSec: DEFAULT_MIN_INTERVAL_SEC,
      minDeltaTokens: DEFAULT_MIN_DELTA_TOKENS,
    })).toBe(true);
  });

  it('delta tokens < min → throttle', () => {
    const now = Date.now();
    expect(shouldThrottle({
      lastSummaryAtMs: now - 600 * 1000,  // 10 min
      deltaTokens: 100,
      nowMs: now,
      minIntervalSec: DEFAULT_MIN_INTERVAL_SEC,
      minDeltaTokens: DEFAULT_MIN_DELTA_TOKENS,
    })).toBe(true);
  });

  it('兩者都過 → 不 throttle', () => {
    const now = Date.now();
    expect(shouldThrottle({
      lastSummaryAtMs: now - 600 * 1000,
      deltaTokens: 1000,
      nowMs: now,
      minIntervalSec: DEFAULT_MIN_INTERVAL_SEC,
      minDeltaTokens: DEFAULT_MIN_DELTA_TOKENS,
    })).toBe(false);
  });

  it('lastSummaryAtMs = null（首次摘要）→ 只看 token 門檻', () => {
    expect(shouldThrottle({
      lastSummaryAtMs: null, deltaTokens: 1000, nowMs: Date.now(),
      minIntervalSec: DEFAULT_MIN_INTERVAL_SEC, minDeltaTokens: DEFAULT_MIN_DELTA_TOKENS,
    })).toBe(false);
    expect(shouldThrottle({
      lastSummaryAtMs: null, deltaTokens: 100, nowMs: Date.now(),
      minIntervalSec: DEFAULT_MIN_INTERVAL_SEC, minDeltaTokens: DEFAULT_MIN_DELTA_TOKENS,
    })).toBe(true);
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/utils/throttle.ts
export const DEFAULT_MIN_INTERVAL_SEC = 180;
export const DEFAULT_MIN_DELTA_TOKENS = 500;

export interface ThrottleInput {
  lastSummaryAtMs: number | null;
  deltaTokens: number;
  nowMs: number;
  minIntervalSec: number;
  minDeltaTokens: number;
}

/** 回 true 表示「跳過本輪摘要」（throttled）。雙門檻 AND 條件：兩者都過才不跳。 */
export function shouldThrottle(input: ThrottleInput): boolean {
  if (input.deltaTokens < input.minDeltaTokens) return true;
  if (input.lastSummaryAtMs === null) return false;  // 第一輪：token 過門即可
  const elapsedSec = (input.nowMs - input.lastSummaryAtMs) / 1000;
  if (elapsedSec < input.minIntervalSec) return true;
  return false;
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/utils/throttle.test.ts
git add src/utils/throttle.ts tests/utils/throttle.test.ts
git commit -m "feat(M2): dual throttle (min-interval 180s AND min-delta-tokens 500)"
```

---

## Task 2.4 — `src/utils/transcript.ts`（read + extract tools + truncate）

**Files：**
- Create: `src/utils/transcript.ts`
- Test: `tests/utils/transcript.test.ts`
- Fixture: `tests/fixtures/transcript-sample.jsonl`（JSON Lines，Claude Code transcript 格式）

**Design context：** Design doc §Capture Pipeline：讀 transcript、抽本輪實際 tool list、做 size cap。

**Transcript 格式假設（Task 0.2 context7 確認）：** Claude Code 的 transcript 是 JSONL，每行 `{type: 'user'|'assistant'|'tool_use'|'tool_result', content: ..., name?: <tool_name>}`。實際 schema 以 Task 0.2 查到為準，本實作需保留未來 schema 微調彈性。

- [ ] **Step 1：準備 fixture**

```
// tests/fixtures/transcript-sample.jsonl（每行一個 JSON event）
{"type":"user","content":"hello"}
{"type":"assistant","content":"hi"}
{"type":"tool_use","name":"TodoWrite","input":{"items":[]}}
{"type":"tool_use","name":"Edit","input":{"file_path":"/x"}}
{"type":"assistant","content":"done"}
```

- [ ] **Step 2：測（RED）**

```typescript
// tests/utils/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readTranscript, extractToolsFromTranscript, truncateTranscript, hashTranscript } from '../../src/utils/transcript.js';

const FIXTURE = resolve(__dirname, '../fixtures/transcript-sample.jsonl');

describe('transcript', () => {
  it('readTranscript 回 JSONL 解析後的 events', async () => {
    const events = await readTranscript(FIXTURE);
    expect(events.length).toBe(5);
    expect(events[0].type).toBe('user');
  });

  it('extractToolsFromTranscript 回 unique tool names', async () => {
    const events = await readTranscript(FIXTURE);
    const tools = extractToolsFromTranscript(events);
    expect(tools.sort()).toEqual(['Edit', 'TodoWrite']);
  });

  it('truncateTranscript：< cap 不動', () => {
    const small = 'abc';
    expect(truncateTranscript(small, { headBytes: 100, tailBytes: 100 })).toBe(small);
  });

  it('truncateTranscript：> cap 切 head + tail + truncated 標註', () => {
    const big = 'a'.repeat(200) + 'MIDDLE' + 'b'.repeat(200);
    const out = truncateTranscript(big, { headBytes: 50, tailBytes: 50 });
    expect(out).toContain('[truncated');
    expect(out.startsWith('a'.repeat(50))).toBe(true);
    expect(out.endsWith('b'.repeat(50))).toBe(true);
  });

  it('hashTranscript 相同內容 hash 相同', () => {
    expect(hashTranscript('abc')).toBe(hashTranscript('abc'));
    expect(hashTranscript('abc')).not.toBe(hashTranscript('abd'));
  });
});
```

- [ ] **Step 3：實作**

```typescript
// src/utils/transcript.ts
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface TranscriptEvent {
  type: string;
  content?: unknown;
  name?: string;          // tool_use 時有
  [k: string]: unknown;
}

export async function readTranscript(path: string): Promise<TranscriptEvent[]> {
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) as TranscriptEvent; }
    catch { return { type: 'malformed' }; }
  });
}

/** 抽本 transcript 裡所有 tool_use 事件的 unique name 集合。 */
export function extractToolsFromTranscript(events: TranscriptEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool_use' && typeof e.name === 'string') set.add(e.name);
  }
  return [...set];
}

export function truncateTranscript(
  content: string,
  opts: { headBytes: number; tailBytes: number } = { headBytes: 500_000, tailBytes: 1_000_000 }
): string {
  const bytes = Buffer.byteLength(content, 'utf8');
  const cap = opts.headBytes + opts.tailBytes;
  if (bytes <= cap) return content;
  const buf = Buffer.from(content, 'utf8');
  const head = buf.subarray(0, opts.headBytes).toString('utf8');
  const tail = buf.subarray(bytes - opts.tailBytes).toString('utf8');
  return `${head}\n\n...[truncated: ${bytes - cap} bytes omitted]...\n\n${tail}`;
}

export function hashTranscript(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
```

- [ ] **Step 4：調整 fixture / 測實際對應 Claude Code 當前格式**

Task 0.2 context7 查到的實際 Claude Code transcript schema 如和上方 fixture 不符（例如 `type: 'tool_use'` 事件實際是 nested 在 `assistant.content` 裡），修 fixture + `extractToolsFromTranscript` 實作。

- [ ] **Step 5：run + commit**

```bash
npx vitest run tests/utils/transcript.test.ts
git add src/utils/transcript.ts tests/utils/transcript.test.ts tests/fixtures/transcript-sample.jsonl
git commit -m "feat(M2): transcript read/extract/truncate/hash helpers"
```

---

## Task 2.5 — `src/utils/idempotency-summary.ts`

**Files：**
- Create: `src/utils/idempotency-summary.ts`
- Test: `tests/utils/idempotency-summary.test.ts`

**Design context：** Design doc：`idempotency_key = sha256(project_id + session_id + last_transcript_hash)`，session_id 為 null 時改用 `sha256(project_id + 'orphan' + transcript_hash + uuid)` 避免碰撞。

- [ ] **Step 1：測（RED）**

```typescript
import { describe, it, expect } from 'vitest';
import { computeSummaryIdempotencyKey } from '../../src/utils/idempotency-summary.js';

describe('idempotency-summary', () => {
  it('same inputs → same key', () => {
    const a = computeSummaryIdempotencyKey({ projectId: 'p1', sessionId: 's1', transcriptHash: 'h1' });
    const b = computeSummaryIdempotencyKey({ projectId: 'p1', sessionId: 's1', transcriptHash: 'h1' });
    expect(a).toBe(b);
  });
  it('different sessionId → different key', () => {
    const a = computeSummaryIdempotencyKey({ projectId: 'p1', sessionId: 's1', transcriptHash: 'h' });
    const b = computeSummaryIdempotencyKey({ projectId: 'p1', sessionId: 's2', transcriptHash: 'h' });
    expect(a).not.toBe(b);
  });
  it('null sessionId 每次都給不同 key（含 uuid 防碰撞）', () => {
    const a = computeSummaryIdempotencyKey({ projectId: 'p1', sessionId: null, transcriptHash: 'h' });
    const b = computeSummaryIdempotencyKey({ projectId: 'p1', sessionId: null, transcriptHash: 'h' });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/utils/idempotency-summary.ts
import { createHash, randomUUID } from 'node:crypto';

export interface SummaryIdempotencyInput {
  projectId: string;
  sessionId: string | null;
  transcriptHash: string;
}

export function computeSummaryIdempotencyKey(input: SummaryIdempotencyInput): string {
  if (input.sessionId === null) {
    // null session 無法 upsert；key 隨機 + transcriptHash 保留可追
    return createHash('sha256')
      .update(`${input.projectId}|orphan|${input.transcriptHash}|${randomUUID()}`)
      .digest('hex');
  }
  return createHash('sha256')
    .update(`${input.projectId}|${input.sessionId}|${input.transcriptHash}`)
    .digest('hex');
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/utils/idempotency-summary.test.ts
git add src/utils/idempotency-summary.ts tests/utils/idempotency-summary.test.ts
git commit -m "feat(M2): summary idempotency key with null-session collision guard"
```

---

## Task 2.6 — `src/utils/session-state.ts`

**Files：**
- Create: `src/utils/session-state.ts`
- Test: `tests/utils/session-state.test.ts`

**Design context：** Design doc §Per-session state。路徑 `~/.cc-memory/state/<session_id>.json`，欄位 `last_summary_at / last_transcript_hash / summarize_count / null_session_streak / last_tools`。

- [ ] **Step 1：測（RED，用 tmpdir 隔離 fs）**

```typescript
// tests/utils/session-state.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readSessionState, writeSessionState, type SessionState } from '../../src/utils/session-state.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), 'cc-mem-state-')); });

describe('session-state', () => {
  it('read non-existent → null', async () => {
    const s = await readSessionState('s1', { baseDir: dir });
    expect(s).toBeNull();
  });

  it('write then read 回同值', async () => {
    const state: SessionState = {
      lastSummaryAtMs: 1_700_000_000_000,
      lastTranscriptHash: 'h',
      summarizeCount: 2,
      nullSessionStreak: 0,
      lastTools: ['Edit'],
    };
    await writeSessionState('s1', state, { baseDir: dir });
    expect(await readSessionState('s1', { baseDir: dir })).toEqual(state);
  });

  it('檔名是 sessionId.json，不同 session 互不影響', async () => {
    await writeSessionState('s1', { lastSummaryAtMs: 1, lastTranscriptHash: 'a', summarizeCount: 1, nullSessionStreak: 0, lastTools: [] }, { baseDir: dir });
    await writeSessionState('s2', { lastSummaryAtMs: 2, lastTranscriptHash: 'b', summarizeCount: 5, nullSessionStreak: 0, lastTools: [] }, { baseDir: dir });
    expect((await readSessionState('s1', { baseDir: dir }))?.summarizeCount).toBe(1);
    expect((await readSessionState('s2', { baseDir: dir }))?.summarizeCount).toBe(5);
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/utils/session-state.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface SessionState {
  lastSummaryAtMs: number | null;
  lastTranscriptHash: string | null;
  summarizeCount: number;
  nullSessionStreak: number;
  lastTools: string[];
}

export interface SessionStateOpts {
  baseDir?: string;
}

function stateDir(opts?: SessionStateOpts): string {
  return opts?.baseDir ?? resolve(homedir(), '.cc-memory', 'state');
}

function fileFor(sessionId: string, opts?: SessionStateOpts): string {
  return resolve(stateDir(opts), `${sessionId}.json`);
}

export async function readSessionState(
  sessionId: string,
  opts?: SessionStateOpts
): Promise<SessionState | null> {
  const p = fileFor(sessionId, opts);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

export async function writeSessionState(
  sessionId: string,
  state: SessionState,
  opts?: SessionStateOpts
): Promise<void> {
  const d = stateDir(opts);
  await mkdir(d, { recursive: true });
  await writeFile(fileFor(sessionId, opts), JSON.stringify(state, null, 2), 'utf8');
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/utils/session-state.test.ts
git add src/utils/session-state.ts tests/utils/session-state.test.ts
git commit -m "feat(M2): session-state read/write helpers (~/.cc-memory/state/)"
```

---

## Task 2.7 — `src/utils/capture-queue.ts`

**Files：**
- Create: `src/utils/capture-queue.ts`
- Test: `tests/utils/capture-queue.test.ts`

**Design context：** Design doc §Queue resume design。路徑 `~/.cc-memory/capture-queue/<idempotency_key>.json`。attempts ≥ 5 → 改名 `.dead`。

- [ ] **Step 1：測（RED）**

```typescript
// tests/utils/capture-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { enqueueCaptureFailure, listPendingQueue, popQueueItem, markDead, type CaptureQueueItem } from '../../src/utils/capture-queue.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), 'cc-mem-q-')); });

describe('capture-queue', () => {
  const sample: CaptureQueueItem = {
    idempotencyKey: 'k1',
    projectId: 'p1',
    sessionId: 's1',
    transcriptSnapshotPath: '/tmp/fake',
    captureHook: 'stop',
    timestampMs: 1_700_000_000_000,
    attempts: 0,
  };

  it('enqueue 建檔、list 回該檔', async () => {
    await enqueueCaptureFailure(sample, { baseDir: dir });
    const pending = await listPendingQueue({ baseDir: dir });
    expect(pending.length).toBe(1);
    expect(pending[0].idempotencyKey).toBe('k1');
  });

  it('pop 刪檔', async () => {
    await enqueueCaptureFailure(sample, { baseDir: dir });
    await popQueueItem('k1', { baseDir: dir });
    const files = await readdir(dir);
    expect(files.length).toBe(0);
  });

  it('attempts >= 5 → markDead 改名 .dead', async () => {
    await enqueueCaptureFailure({ ...sample, attempts: 5 }, { baseDir: dir });
    await markDead('k1', { baseDir: dir });
    const files = await readdir(dir);
    expect(files[0]).toMatch(/\.dead$/);
    const pending = await listPendingQueue({ baseDir: dir });
    expect(pending.length).toBe(0);  // .dead 不進 pending
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/utils/capture-queue.ts
import { writeFile, readFile, readdir, rename, unlink, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export interface CaptureQueueItem {
  idempotencyKey: string;
  projectId: string;
  sessionId: string | null;
  transcriptSnapshotPath: string;
  captureHook: 'stop';
  timestampMs: number;
  attempts: number;
}

export interface QueueOpts { baseDir?: string; }

function qdir(opts?: QueueOpts): string {
  return opts?.baseDir ?? resolve(homedir(), '.cc-memory', 'capture-queue');
}

function pending(key: string, opts?: QueueOpts) { return resolve(qdir(opts), `${key}.json`); }
function dead(key: string, opts?: QueueOpts)    { return resolve(qdir(opts), `${key}.dead`); }

export async function enqueueCaptureFailure(item: CaptureQueueItem, opts?: QueueOpts): Promise<void> {
  await mkdir(qdir(opts), { recursive: true });
  await writeFile(pending(item.idempotencyKey, opts), JSON.stringify(item, null, 2), 'utf8');
}

export async function listPendingQueue(opts?: QueueOpts): Promise<CaptureQueueItem[]> {
  if (!existsSync(qdir(opts))) return [];
  const entries = await readdir(qdir(opts));
  const out: CaptureQueueItem[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(resolve(qdir(opts), e), 'utf8')));
    } catch { /* skip malformed */ }
  }
  return out;
}

export async function popQueueItem(key: string, opts?: QueueOpts): Promise<void> {
  const p = pending(key, opts);
  if (existsSync(p)) await unlink(p);
}

export async function markDead(key: string, opts?: QueueOpts): Promise<void> {
  const p = pending(key, opts);
  if (existsSync(p)) await rename(p, dead(key, opts));
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/utils/capture-queue.test.ts
git add src/utils/capture-queue.ts tests/utils/capture-queue.test.ts
git commit -m "feat(M2): capture queue (enqueue/list/pop/markDead at ~/.cc-memory/capture-queue/)"
```

---

## Task 2.8 — `src/utils/flag-files.ts`

**Files：**
- Create: `src/utils/flag-files.ts`
- Test: `tests/utils/flag-files.test.ts`

**Design context：** Design doc §Error Handling。`claude-cli-missing.flag` 首次偵測存在時所有後續 runner skip；`quota-exceeded.flag` 含時戳，< 1hr 前存在則 skip。

- [ ] **Step 1：測（RED）**

```typescript
// tests/utils/flag-files.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  setClaudeCliMissing, clearClaudeCliMissing, isClaudeCliMissing,
  setQuotaExceeded, isQuotaExceededRecently,
} from '../../src/utils/flag-files.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(resolve(tmpdir(), 'cc-mem-flag-')); });

describe('flag-files', () => {
  it('claude-cli-missing 可設、查、清', async () => {
    expect(await isClaudeCliMissing({ baseDir: dir })).toBe(false);
    await setClaudeCliMissing({ baseDir: dir });
    expect(await isClaudeCliMissing({ baseDir: dir })).toBe(true);
    await clearClaudeCliMissing({ baseDir: dir });
    expect(await isClaudeCliMissing({ baseDir: dir })).toBe(false);
  });

  it('quota-exceeded < 1hr 前 → 回 true', async () => {
    await setQuotaExceeded({ baseDir: dir });
    expect(await isQuotaExceededRecently({ baseDir: dir, windowSec: 3600 })).toBe(true);
  });

  it('quota-exceeded > window → 回 false', async () => {
    await setQuotaExceeded({ baseDir: dir, atMs: Date.now() - 2 * 3600_000 });
    expect(await isQuotaExceededRecently({ baseDir: dir, windowSec: 3600 })).toBe(false);
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/utils/flag-files.ts
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export interface FlagOpts { baseDir?: string; atMs?: number; windowSec?: number; }
function dir(opts?: FlagOpts) { return opts?.baseDir ?? resolve(homedir(), '.cc-memory', 'state'); }
function missing(opts?: FlagOpts) { return resolve(dir(opts), 'claude-cli-missing.flag'); }
function quota(opts?: FlagOpts)   { return resolve(dir(opts), 'quota-exceeded.flag'); }

export async function setClaudeCliMissing(opts?: FlagOpts) {
  await mkdir(dir(opts), { recursive: true });
  await writeFile(missing(opts), new Date().toISOString(), 'utf8');
}
export async function clearClaudeCliMissing(opts?: FlagOpts) {
  if (existsSync(missing(opts))) await unlink(missing(opts));
}
export async function isClaudeCliMissing(opts?: FlagOpts): Promise<boolean> {
  return existsSync(missing(opts));
}

export async function setQuotaExceeded(opts?: FlagOpts) {
  await mkdir(dir(opts), { recursive: true });
  const ts = opts?.atMs ?? Date.now();
  await writeFile(quota(opts), String(ts), 'utf8');
}
export async function isQuotaExceededRecently(opts?: FlagOpts): Promise<boolean> {
  if (!existsSync(quota(opts))) return false;
  try {
    const ts = parseInt(await readFile(quota(opts), 'utf8'), 10);
    const windowSec = opts?.windowSec ?? 3600;
    return (Date.now() - ts) / 1000 < windowSec;
  } catch { return false; }
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/utils/flag-files.test.ts
git add src/utils/flag-files.ts tests/utils/flag-files.test.ts
git commit -m "feat(M2): flag files (claude-cli-missing / quota-exceeded with TTL)"
```

---

## Task 2.9 — `src/llm/claude-cli.ts`（subprocess 封裝）

**Files：**
- Create: `src/llm/claude-cli.ts`
- Test: `tests/llm/claude-cli.test.ts`

**Design context：** Design doc §Capture Pipeline `Claude CLI 呼叫`。封裝 `spawn('claude', ['-p', ..., '--output-format', 'json', '--model', <m>])` + timeout 60s + retry 3 次指數退避 + stdout JSON parse。

- [ ] **Step 1：測（RED，mock `child_process.spawn`）**

```typescript
// tests/llm/claude-cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { callClaudeCli, ClaudeCliError } from '../../src/llm/claude-cli.js';

function fakeChild(stdout: string, exitCode = 0): any {
  const child: any = new EventEmitter();
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from('');
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

beforeEach(() => { spawnMock.mockReset(); });

describe('callClaudeCli', () => {
  it('spawn args 正確', async () => {
    spawnMock.mockReturnValueOnce(fakeChild('{"summary":"ok","keywords":[],"decisions":[],"next_steps":[]}'));
    await callClaudeCli({ prompt: 'P', model: 'claude-sonnet-4-5', timeoutMs: 1000 });
    expect(spawnMock).toHaveBeenCalledWith('claude', [
      '-p', 'P', '--output-format', 'json', '--model', 'claude-sonnet-4-5',
    ], expect.anything());
  });

  it('exit code !=0 → ClaudeCliError', async () => {
    spawnMock.mockReturnValueOnce(fakeChild('', 1));
    await expect(
      callClaudeCli({ prompt: 'P', model: 'x', timeoutMs: 1000 })
    ).rejects.toThrow(ClaudeCliError);
  });

  it('stdout 非 JSON → ClaudeCliError', async () => {
    spawnMock.mockReturnValueOnce(fakeChild('not json'));
    await expect(
      callClaudeCli({ prompt: 'P', model: 'x', timeoutMs: 1000 })
    ).rejects.toThrow(/parse/i);
  });

  it('超過 timeout → ClaudeCliError', async () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();  // 不 emit data
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    spawnMock.mockReturnValueOnce(child);
    await expect(
      callClaudeCli({ prompt: 'P', model: 'x', timeoutMs: 10 })
    ).rejects.toThrow(/timeout/i);
    expect(child.kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2：實作（不含 retry 層，retry 留給 runner 的包裝）**

```typescript
// src/llm/claude-cli.ts
import { spawn } from 'node:child_process';

export class ClaudeCliError extends Error {
  constructor(msg: string, public kind: 'exit' | 'timeout' | 'parse' | 'quota' = 'exit') {
    super(msg); this.name = 'ClaudeCliError';
  }
}

export interface ClaudeCliInput {
  prompt: string;
  model: string;
  timeoutMs: number;
}

export interface ClaudeSummaryOutput {
  summary: string;
  keywords: string[];
  decisions: string[];
  next_steps: string[];
}

export async function callClaudeCli(input: ClaudeCliInput): Promise<ClaudeSummaryOutput> {
  const child = spawn('claude',
    ['-p', input.prompt, '--output-format', 'json', '--model', input.model],
    { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const exitCode = await new Promise<number>((resolveOk, rejectFail) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectFail(new ClaudeCliError('claude CLI timeout', 'timeout'));
    }, input.timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolveOk(code ?? 0); });
    child.on('error', (e) => { clearTimeout(timer); rejectFail(e); });
  });

  if (exitCode !== 0) {
    if (/quota|rate[\s_-]?limit/i.test(stderr + stdout)) {
      throw new ClaudeCliError(`claude CLI quota exceeded: ${stderr || stdout}`, 'quota');
    }
    throw new ClaudeCliError(`claude CLI exit ${exitCode}: ${stderr || stdout}`, 'exit');
  }

  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.summary !== 'string') throw new Error('missing summary');
    return {
      summary: parsed.summary,
      keywords: parsed.keywords ?? [],
      decisions: parsed.decisions ?? [],
      next_steps: parsed.next_steps ?? [],
    };
  } catch (e: any) {
    throw new ClaudeCliError(`failed to parse claude stdout: ${e.message}; stdout=${stdout.slice(0, 200)}`, 'parse');
  }
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/llm/claude-cli.test.ts
git add src/llm/claude-cli.ts tests/llm/claude-cli.test.ts
git commit -m "feat(M2): claude-cli subprocess wrapper (timeout/parse/quota detection)"
```

---

## Task 2.10 — `src/llm/gemini-embed.ts`（wrapper around 既有 `utils/embedding.ts`）

**Files：**
- Create: `src/llm/gemini-embed.ts`
- Test: `tests/llm/gemini-embed.test.ts`（實質是 re-test composeEmbeddingText behavior 未變 + wrapper exports 的 API）

**Design context：** 為了符合 design doc §Architecture 的「`src/llm/gemini-embed.ts`」路徑約定，把 embedding 包一層 namespaced facade。實作上 delegate 到既有 `src/utils/embedding.ts`（不重寫，也不遷檔——遷檔會影響 Phase A 所有 import）。

- [ ] **Step 1：實作（trivial delegation）**

```typescript
// src/llm/gemini-embed.ts
// Facade on top of src/utils/embedding.ts — 給 Phase C capture-runner / refine / reinject 使用，
// 讓 architecture doc 的 "src/llm/gemini-embed.ts" 路徑名對得上實際程式。
// 不搬家、不改行為：Phase A 的 imports 繼續走 src/utils/embedding.ts。
export {
  generateEmbedding,
  generateQueryEmbedding,
  composeEmbeddingText,
  normalizeVector,
  isEmbeddingEnabled,
} from '../utils/embedding.js';

export type { EmbeddingConfig } from '../utils/embedding.js';
```

- [ ] **Step 2：trivial test 驗 re-export 不 break**

```typescript
// tests/llm/gemini-embed.test.ts
import { describe, it, expect } from 'vitest';
import * as facade from '../../src/llm/gemini-embed.js';

describe('gemini-embed facade', () => {
  it('re-exports composeEmbeddingText', () => {
    expect(facade.composeEmbeddingText('a', ['b'], ['c'])).toContain('a');
  });
  it('re-exports isEmbeddingEnabled', () => {
    expect(typeof facade.isEmbeddingEnabled).toBe('function');
  });
});
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/llm/gemini-embed.test.ts
git add src/llm/gemini-embed.ts tests/llm/gemini-embed.test.ts
git commit -m "feat(M2): gemini-embed namespaced facade (delegates to utils/embedding)"
```

---

## Task 2.11 — `src/services/summaries.ts`（`upsertSessionSummary`）

**Files：**
- Create: `src/services/summaries.ts`
- Modify: `src/services/types.ts`
- Test: `tests/services/summaries.test.ts`

**Design context：** Design doc §Upsert 行為。核心：
- IF exists active row with same `(project_id, session_id)` → UPDATE summary/keywords/.../embedding，`summarize_count += 1`、`updated_at = now()`
- ELSE IF `session_id IS NULL` → INSERT 新 row（不走 upsert）
- ELSE → INSERT 首次摘要本 session

- [ ] **Step 1：types.ts 加 type**

```typescript
export interface UpsertSessionSummaryInput {
  projectId: string;
  sessionId: string | null;
  summary: string;
  keywords?: string[];
  decisions?: string[];
  nextSteps?: string[];
  captureSource: 'auto-stop-hook';
  captureHook: 'stop';
  writerHost: string;
  idempotencyKey: string;
  embedding?: number[] | null;
  metadata?: Record<string, unknown>;
}

export interface UpsertSessionSummaryResult {
  id: string;
  created: boolean;  // true = INSERT, false = UPDATE
  summarizeCount: number;
}
```

- [ ] **Step 2：測（RED）**

```typescript
// tests/services/summaries.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, isNull } from 'drizzle-orm';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { sessionSummaries } from '../../src/db/schema.js';
import { upsertSessionSummary } from '../../src/services/summaries.js';

let sql: Sql;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => { sql = await connectTestDb(); db = drizzle(sql); });
afterAll(async () => { await sql?.end(); });
beforeEach(async () => { await resetAllTables(sql); });

const BASE = {
  projectId: 'p1', sessionId: 's1', summary: 'first',
  captureSource: 'auto-stop-hook' as const, captureHook: 'stop' as const,
  writerHost: 'hostA', idempotencyKey: 'k1',
};

describe('upsertSessionSummary', () => {
  it('首次 INSERT → created=true, summarizeCount=1', async () => {
    const r = await upsertSessionSummary(db, BASE);
    expect(r.created).toBe(true);
    expect(r.summarizeCount).toBe(1);
  });

  it('同 session 再跑 → UPDATE、summarize_count=2、summary 被覆蓋', async () => {
    await upsertSessionSummary(db, BASE);
    const r = await upsertSessionSummary(db, { ...BASE, summary: 'second', idempotencyKey: 'k2' });
    expect(r.created).toBe(false);
    expect(r.summarizeCount).toBe(2);
    const rows = await db.select().from(sessionSummaries)
      .where(and(eq(sessionSummaries.projectId, 'p1'), eq(sessionSummaries.sessionId, 's1')));
    expect(rows.length).toBe(1);  // 仍只有一筆 active
    expect(rows[0].summary).toBe('second');
  });

  it('sessionId=null 永遠 INSERT 新 row（不 upsert）', async () => {
    await upsertSessionSummary(db, { ...BASE, sessionId: null, idempotencyKey: 'n1' });
    await upsertSessionSummary(db, { ...BASE, sessionId: null, idempotencyKey: 'n2', summary: 'two' });
    const rows = await db.select().from(sessionSummaries).where(isNull(sessionSummaries.sessionId));
    expect(rows.length).toBe(2);
  });

  it('已 archived 的 row 不影響 upsert 決策（新 INSERT）', async () => {
    const first = await upsertSessionSummary(db, BASE);
    await db.update(sessionSummaries).set({ status: 'archived' }).where(eq(sessionSummaries.id, first.id));
    const r = await upsertSessionSummary(db, { ...BASE, summary: 'after-archive', idempotencyKey: 'k3' });
    expect(r.created).toBe(true);  // 舊 archived 不占 active slot，應 INSERT 新 row
  });
});
```

- [ ] **Step 3：實作**

```typescript
// src/services/summaries.ts
import { and, eq } from 'drizzle-orm';
import { sessionSummaries } from '../db/schema.js';
import type { DbClient } from './types.js';
import type { UpsertSessionSummaryInput, UpsertSessionSummaryResult } from './types.js';

export async function upsertSessionSummary(
  db: DbClient,
  input: UpsertSessionSummaryInput
): Promise<UpsertSessionSummaryResult> {
  // null session → 永遠 INSERT
  if (input.sessionId === null) {
    const [inserted] = await db.insert(sessionSummaries).values({
      projectId: input.projectId,
      sessionId: null,
      summary: input.summary,
      keywords: input.keywords ?? [],
      decisions: input.decisions ?? [],
      nextSteps: input.nextSteps ?? [],
      captureSource: input.captureSource,
      captureHook: input.captureHook,
      writerHost: input.writerHost,
      idempotencyKey: input.idempotencyKey,
      embedding: input.embedding ?? null,
      metadata: input.metadata ?? {},
    }).returning();
    return { id: inserted.id, created: true, summarizeCount: inserted.summarizeCount };
  }

  // 查有沒有同 project+session active row
  const [existing] = await db.select().from(sessionSummaries).where(
    and(
      eq(sessionSummaries.projectId, input.projectId),
      eq(sessionSummaries.sessionId, input.sessionId),
      eq(sessionSummaries.status, 'active'),
    )
  );

  if (existing) {
    const newCount = existing.summarizeCount + 1;
    await db.update(sessionSummaries).set({
      summary: input.summary,
      keywords: input.keywords ?? [],
      decisions: input.decisions ?? [],
      nextSteps: input.nextSteps ?? [],
      embedding: input.embedding ?? existing.embedding,
      metadata: { ...(existing.metadata as Record<string, unknown> ?? {}), ...(input.metadata ?? {}) },
      idempotencyKey: input.idempotencyKey,
      summarizeCount: newCount,
      updatedAt: new Date(),
    }).where(eq(sessionSummaries.id, existing.id));
    return { id: existing.id, created: false, summarizeCount: newCount };
  }

  const [inserted] = await db.insert(sessionSummaries).values({
    projectId: input.projectId,
    sessionId: input.sessionId,
    summary: input.summary,
    keywords: input.keywords ?? [],
    decisions: input.decisions ?? [],
    nextSteps: input.nextSteps ?? [],
    captureSource: input.captureSource,
    captureHook: input.captureHook,
    writerHost: input.writerHost,
    idempotencyKey: input.idempotencyKey,
    embedding: input.embedding ?? null,
    metadata: input.metadata ?? {},
  }).returning();

  return { id: inserted.id, created: true, summarizeCount: inserted.summarizeCount };
}
```

- [ ] **Step 4：run + commit**

```bash
npx vitest run tests/services/summaries.test.ts
git add src/services/summaries.ts src/services/types.ts tests/services/summaries.test.ts
git commit -m "feat(M2): upsertSessionSummary (first-insert/update-branch + null-session orphan path)"
```

---

## Task 2.12 — MCP `cc_memory_save_summary` + register

**Files：**
- Create: `src/tools/save-summary.ts`
- Modify: `src/tools/index.ts`、`src/index.ts`
- Test: `tests/mcp-handler.test.ts`（append）

- [ ] **Step 1：tool handler**

```typescript
// src/tools/save-summary.ts
import { z } from 'zod';
import { upsertSessionSummary } from '../services/summaries.js';
import type { DbClient } from '../services/types.js';

export const saveSummarySchema = z.object({
  project_id: z.string(),
  session_id: z.string().nullable(),
  summary: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
  writer_host: z.string(),
  idempotency_key: z.string(),
  embedding: z.array(z.number()).length(1536).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function handleSaveSummary(db: DbClient, args: unknown) {
  const input = saveSummarySchema.parse(args);
  const result = await upsertSessionSummary(db, {
    projectId: input.project_id,
    sessionId: input.session_id,
    summary: input.summary,
    keywords: input.keywords,
    decisions: input.decisions,
    nextSteps: input.next_steps,
    captureSource: 'auto-stop-hook',
    captureHook: 'stop',
    writerHost: input.writer_host,
    idempotencyKey: input.idempotency_key,
    embedding: input.embedding ?? null,
    metadata: input.metadata,
  });
  return {
    content: [{ type: 'text', text: JSON.stringify({
      id: result.id, created: result.created, summarize_count: result.summarizeCount,
    }) }],
  };
}

export const saveSummaryToolDefinition = {
  name: 'cc_memory_save_summary',
  description: 'Upsert 一筆 session summary（capture-runner 專用；同 (project, session) active 只會有一筆）',
  inputSchema: { /* 對應 schema 欄位，省略 */ },
};
```

- [ ] **Step 2：註冊到 `src/index.ts` + export**

（同 Task 1.9 Step 4 pattern）

- [ ] **Step 3：integration test**

```typescript
// tests/mcp-handler.test.ts（append）
it('cc_memory_save_summary upsert 兩輪只留一筆', async () => {
  await callTool('cc_memory_save_summary', { project_id: 'p', session_id: 's-t', summary: '1st', writer_host: 'h', idempotency_key: 'a' });
  await callTool('cc_memory_save_summary', { project_id: 'p', session_id: 's-t', summary: '2nd', writer_host: 'h', idempotency_key: 'b' });
  const rows = await sql`SELECT summary, summarize_count FROM session_summaries WHERE session_id='s-t' AND status='active'`;
  expect(rows.length).toBe(1);
  expect(rows[0].summary).toBe('2nd');
  expect(rows[0].summarize_count).toBe(2);
});
```

- [ ] **Step 4：Commit**

```bash
npm run test:ci
git add src/tools/save-summary.ts src/tools/index.ts src/index.ts tests/mcp-handler.test.ts
git commit -m "feat(M2): MCP cc_memory_save_summary (upsert-by-session facade)"
```

---

## Task 2.13 — `scripts/capture-runner.ts` 組合主流程

**Files：**
- Create: `scripts/capture-runner.ts`
- Test: `tests/scripts/capture-runner.test.ts`

**Design context：** Design doc §Stop hook 流程（a-n 步驟）。本 task 是 M2 的最核心 integration point，組合前面 8 個 helper + 4 個 service。

- [ ] **Step 1：E2E-level integration test（RED，用 fixture + env override）**

```typescript
// tests/scripts/capture-runner.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { sessionSummaries } from '../../src/db/schema.js';

// 以子模組 import runner 主函式（實作時 export runCapture(env)）
vi.mock('../../src/llm/claude-cli.js', () => ({
  callClaudeCli: vi.fn(async () => ({
    summary: 'auto summary', keywords: ['k1'], decisions: ['d1'], next_steps: ['n1'],
  })),
  ClaudeCliError: class extends Error {},
}));
vi.mock('../../src/utils/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/embedding.js')>()),
  generateEmbedding: vi.fn(async () => new Array(1536).fill(0.01)),
}));

import { runCapture } from '../../scripts/capture-runner.js';

let sql: Sql;
let stateDir: string;
beforeAll(async () => { sql = await connectTestDb(); });
afterAll(async () => { await sql?.end(); });
beforeEach(async () => {
  await resetAllTables(sql);
  stateDir = await mkdtemp(resolve(tmpdir(), 'capture-state-'));
});

async function makeTranscript(events: any[]): Promise<string> {
  const path = resolve(stateDir, 'transcript.jsonl');
  await writeFile(path, events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  return path;
}

describe('runCapture', () => {
  it('非純工具輪 + 過節流 → 寫入一筆 row', async () => {
    const trPath = await makeTranscript([
      { type: 'user', content: 'do X' },
      { type: 'tool_use', name: 'Edit' },
      { type: 'assistant', content: 'done' },
    ]);
    const result = await runCapture({
      projectId: 'p1',
      sessionId: 's1',
      transcriptPath: trPath,
      stateBaseDir: stateDir,
      queueBaseDir: stateDir,
      env: {
        CC_MEMORY_AUTO_CAPTURE: 'on',
        CC_MEMORY_CLAUDE_MODEL: 'claude-sonnet-4-5',
        CC_MEMORY_STOP_MIN_INTERVAL_SEC: '0',      // 測試跳過間隔
        CC_MEMORY_STOP_MIN_DELTA_TOKENS: '0',      // 測試跳過 token 門檻
      },
    });
    expect(result.outcome).toBe('written');
    const rows = await sql`SELECT * FROM session_summaries WHERE session_id='s1' AND status='active'`;
    expect(rows.length).toBe(1);
  });

  it('AUTO_CAPTURE=off → 直接 exit，DB 無寫入', async () => {
    const trPath = await makeTranscript([{ type: 'tool_use', name: 'Edit' }]);
    const result = await runCapture({
      projectId: 'p1', sessionId: 's2', transcriptPath: trPath,
      stateBaseDir: stateDir, queueBaseDir: stateDir,
      env: { CC_MEMORY_AUTO_CAPTURE: 'off' },
    });
    expect(result.outcome).toBe('skipped-flag');
    const rows = await sql`SELECT * FROM session_summaries WHERE session_id='s2'`;
    expect(rows.length).toBe(0);
  });

  it('純工具輪（只叫 TodoWrite）→ skip', async () => {
    const trPath = await makeTranscript([{ type: 'tool_use', name: 'TodoWrite' }]);
    const result = await runCapture({
      projectId: 'p1', sessionId: 's3', transcriptPath: trPath,
      stateBaseDir: stateDir, queueBaseDir: stateDir,
      env: { CC_MEMORY_AUTO_CAPTURE: 'on' },
    });
    expect(result.outcome).toBe('skipped-tools');
  });

  it('節流未過 → skip', async () => {
    const trPath = await makeTranscript([{ type: 'tool_use', name: 'Edit' }]);
    // 先跑一次建 state
    await runCapture({
      projectId: 'p1', sessionId: 's4', transcriptPath: trPath,
      stateBaseDir: stateDir, queueBaseDir: stateDir,
      env: { CC_MEMORY_AUTO_CAPTURE: 'on', CC_MEMORY_STOP_MIN_INTERVAL_SEC: '0', CC_MEMORY_STOP_MIN_DELTA_TOKENS: '0' },
    });
    const result = await runCapture({
      projectId: 'p1', sessionId: 's4', transcriptPath: trPath,
      stateBaseDir: stateDir, queueBaseDir: stateDir,
      env: { CC_MEMORY_AUTO_CAPTURE: 'on', CC_MEMORY_STOP_MIN_INTERVAL_SEC: '180', CC_MEMORY_STOP_MIN_DELTA_TOKENS: '500' },
    });
    expect(result.outcome).toBe('skipped-throttle');
  });

  it('Claude CLI throw → 寫 queue、DB 無寫入', async () => {
    const { callClaudeCli } = await import('../../src/llm/claude-cli.js');
    (callClaudeCli as any).mockRejectedValueOnce(new Error('fake CLI fail'));
    const trPath = await makeTranscript([{ type: 'tool_use', name: 'Edit' }]);
    const result = await runCapture({
      projectId: 'p1', sessionId: 's5', transcriptPath: trPath,
      stateBaseDir: stateDir, queueBaseDir: stateDir,
      env: { CC_MEMORY_AUTO_CAPTURE: 'on', CC_MEMORY_STOP_MIN_INTERVAL_SEC: '0', CC_MEMORY_STOP_MIN_DELTA_TOKENS: '0' },
    });
    expect(result.outcome).toBe('queued');
    const rows = await sql`SELECT * FROM session_summaries WHERE session_id='s5'`;
    expect(rows.length).toBe(0);
  });
});
```

- [ ] **Step 2：實作 `runCapture`**

```typescript
// scripts/capture-runner.ts
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { readTranscript, extractToolsFromTranscript, truncateTranscript, hashTranscript } from '../src/utils/transcript.js';
import { DEFAULT_SKIP_TOOLS, parseSkipToolsEnv, shouldSkipBySkipTools } from '../src/utils/skip-tools.js';
import { DEFAULT_MIN_INTERVAL_SEC, DEFAULT_MIN_DELTA_TOKENS, shouldThrottle } from '../src/utils/throttle.js';
import { computeSummaryIdempotencyKey } from '../src/utils/idempotency-summary.js';
import { readSessionState, writeSessionState } from '../src/utils/session-state.js';
import { enqueueCaptureFailure, listPendingQueue, popQueueItem, markDead } from '../src/utils/capture-queue.js';
import { isClaudeCliMissing, setClaudeCliMissing, setQuotaExceeded, isQuotaExceededRecently } from '../src/utils/flag-files.js';
import { callClaudeCli, ClaudeCliError } from '../src/llm/claude-cli.js';
import { generateEmbedding, composeEmbeddingText } from '../src/llm/gemini-embed.js';
import { upsertSessionSummary } from '../src/services/summaries.js';
import { resolveWriterHost } from '../src/utils/writer-host.js';

export type CaptureOutcome =
  | 'skipped-flag' | 'skipped-tools' | 'skipped-throttle'
  | 'skipped-cli-missing' | 'skipped-quota' | 'written' | 'queued';

export interface RunCaptureOpts {
  projectId: string;
  sessionId: string | null;
  transcriptPath: string;
  stateBaseDir?: string;
  queueBaseDir?: string;
  env: NodeJS.ProcessEnv;
  databaseUrl?: string;  // override 測試用
}

export interface RunCaptureResult { outcome: CaptureOutcome; summaryId?: string; }

function estimateTokens(text: string): number {
  // 粗估：4 chars ~ 1 token
  return Math.ceil(text.length / 4);
}

export async function runCapture(opts: RunCaptureOpts): Promise<RunCaptureResult> {
  const { projectId, sessionId, transcriptPath, env } = opts;
  const stateOpts = { baseDir: opts.stateBaseDir };
  const queueOpts = { baseDir: opts.queueBaseDir };

  if ((env.CC_MEMORY_AUTO_CAPTURE ?? 'off') === 'off') {
    return { outcome: 'skipped-flag' };
  }
  if (await isClaudeCliMissing(stateOpts)) {
    return { outcome: 'skipped-cli-missing' };
  }
  if (await isQuotaExceededRecently(stateOpts)) {
    return { outcome: 'skipped-quota' };
  }

  // 讀 transcript
  const rawEvents = await readTranscript(transcriptPath);
  const rawContent = (await readFile(transcriptPath, 'utf8'));
  const transcript = truncateTranscript(rawContent);
  const transcriptHash = hashTranscript(transcript);

  // SKIP_TOOLS filter
  const skipList = parseSkipToolsEnv(env.CC_MEMORY_SKIP_TOOLS);
  const toolsUsed = extractToolsFromTranscript(rawEvents);
  if (shouldSkipBySkipTools(toolsUsed, skipList)) {
    if (sessionId) {
      const prev = await readSessionState(sessionId, stateOpts);
      await writeSessionState(sessionId, {
        lastSummaryAtMs: prev?.lastSummaryAtMs ?? null,
        lastTranscriptHash: prev?.lastTranscriptHash ?? null,
        summarizeCount: prev?.summarizeCount ?? 0,
        nullSessionStreak: 0,
        lastTools: toolsUsed,
      }, stateOpts);
    }
    return { outcome: 'skipped-tools' };
  }

  // Throttle
  const minIntervalSec = parseInt(env.CC_MEMORY_STOP_MIN_INTERVAL_SEC ?? String(DEFAULT_MIN_INTERVAL_SEC), 10);
  const minDeltaTokens = parseInt(env.CC_MEMORY_STOP_MIN_DELTA_TOKENS ?? String(DEFAULT_MIN_DELTA_TOKENS), 10);
  const state = sessionId ? await readSessionState(sessionId, stateOpts) : null;
  const deltaTokens = estimateTokens(transcript) - estimateTokens(state?.lastTranscriptHash ? '' : '');  // 簡化：實際用 state.lastTranscriptHash 取對應 transcript 是 MVP 過度工程，就直接用本次 transcript tokens 判斷
  if (shouldThrottle({
    lastSummaryAtMs: state?.lastSummaryAtMs ?? null,
    deltaTokens: estimateTokens(transcript),
    nowMs: Date.now(),
    minIntervalSec, minDeltaTokens,
  })) {
    return { outcome: 'skipped-throttle' };
  }

  // 算 idempotency
  const idempotencyKey = computeSummaryIdempotencyKey({ projectId, sessionId, transcriptHash });

  // 載 prompt
  const promptSpec = JSON.parse(await readFile(resolve(import.meta.dirname ?? __dirname, '..', 'prompts/code.json'), 'utf8'));
  const fullPrompt = buildPromptFromSpec(promptSpec, transcript);

  // Claude CLI
  let cliOutput;
  try {
    cliOutput = await callClaudeCli({
      prompt: fullPrompt,
      model: env.CC_MEMORY_CLAUDE_MODEL ?? 'claude-sonnet-4-5',
      timeoutMs: 60_000,
    });
  } catch (e) {
    if (e instanceof ClaudeCliError && e.kind === 'quota') await setQuotaExceeded(stateOpts);
    await enqueueCaptureFailure({
      idempotencyKey, projectId, sessionId,
      transcriptSnapshotPath: transcriptPath,
      captureHook: 'stop',
      timestampMs: Date.now(),
      attempts: 1,
    }, queueOpts);
    return { outcome: 'queued' };
  }

  // Gemini embed
  const textForEmbed = composeEmbeddingText(cliOutput.summary, cliOutput.keywords, cliOutput.decisions);
  const embedding = await generateEmbedding(textForEmbed);

  // Upsert via service
  const client = postgres(opts.databaseUrl ?? env.DATABASE_URL ?? '');
  const db = drizzle(client);
  try {
    const r = await upsertSessionSummary(db, {
      projectId, sessionId,
      summary: cliOutput.summary,
      keywords: cliOutput.keywords, decisions: cliOutput.decisions, nextSteps: cliOutput.next_steps,
      captureSource: 'auto-stop-hook', captureHook: 'stop',
      writerHost: resolveWriterHost(),
      idempotencyKey,
      embedding,
      metadata: {
        last_tools: toolsUsed,
        llm_provider: 'claude-cli',
        llm_model: env.CC_MEMORY_CLAUDE_MODEL ?? 'claude-sonnet-4-5',
        embed_model: 'gemini-embedding-001',
      },
    });
    if (sessionId) {
      await writeSessionState(sessionId, {
        lastSummaryAtMs: Date.now(),
        lastTranscriptHash: transcriptHash,
        summarizeCount: r.summarizeCount,
        nullSessionStreak: 0,
        lastTools: toolsUsed,
      }, stateOpts);
    }
    return { outcome: 'written', summaryId: r.id };
  } finally {
    await client.end();
  }
}

function buildPromptFromSpec(spec: any, transcript: string): string {
  // 根據 claude-mem code.json 的 XML 範本結構組字串。實作依 Task 0.2 context7 查 code.json 欄位後定案。
  // 先給一個 placeholder 版本：直接把 transcript 包在 spec.user_prompt_template 裡。
  const systemPrompt = spec.system_prompt ?? '';
  const userTemplate = spec.user_prompt_template ?? '{{transcript}}';
  return `${systemPrompt}\n\n${userTemplate.replace('{{transcript}}', transcript)}`;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  runCapture({
    projectId: env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    sessionId: env.CLAUDE_SESSION_ID ?? null,
    transcriptPath: env.CLAUDE_TRANSCRIPT_PATH ?? '',
    env,
  }).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(0);
  }).catch((e) => {
    console.error(e);
    process.exit(0);  // 不阻塞 Claude Code
  });
}
```

注意：`projectId` 實際會走 `resolveProjectId(cwd)`（Phase A 現有 helper），這裡寫成直接傳 `CLAUDE_PROJECT_DIR` 是 M2 最小實作；實際 wiring 在 Task 2.14 hook 做。

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/scripts/capture-runner.test.ts
git add scripts/capture-runner.ts tests/scripts/capture-runner.test.ts
git commit -m "feat(M2): capture-runner main pipeline (skip-tools/throttle/CLI/embed/upsert/queue)"
```

---

## Task 2.14 — `hooks/stop-capture.sh` + settings.json 註冊

**Files：**
- Create: `hooks/stop-capture.sh`
- Modify: `hooks/session-end.json`（如果之前 placeholder；否則新加 `hooks/stop.json`）

**Design context：** Design doc §Hook 事件選擇：Stop hook（每輪結束），`set +e` 吞錯不阻塞。

- [ ] **Step 1：寫 shell script**

```bash
#!/usr/bin/env bash
# hooks/stop-capture.sh
# Claude Code Stop hook entry — 呼叫 capture-runner.ts、錯誤吞掉不阻塞 Claude Code。
set +e
cd "$(dirname "$0")/.."
node --loader tsx ./scripts/capture-runner.ts > /tmp/cc-memory-capture-$$.log 2>&1
exit 0
```

- [ ] **Step 2：chmod + 註冊到 Claude Code settings**

```bash
chmod +x hooks/stop-capture.sh
```

加 hook config（`hooks/stop.json`，或寫入 `.claude/settings.json` 的 `hooks.Stop`）：

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/stop-capture.sh" }] }
    ]
  }
}
```

具體路徑 / schema 以 Task 0.2 context7 查 Claude Code hook settings 結構為準。

- [ ] **Step 3：手動 smoke test**

```bash
# 先確保 CC_MEMORY_AUTO_CAPTURE=on 在 env（或 .env）
export CLAUDE_PROJECT_DIR="$PWD"
export CLAUDE_SESSION_ID="manual-smoke-$(date +%s)"
export CLAUDE_TRANSCRIPT_PATH="tests/fixtures/transcript-sample.jsonl"
export CC_MEMORY_AUTO_CAPTURE=on
export CC_MEMORY_STOP_MIN_INTERVAL_SEC=0
export CC_MEMORY_STOP_MIN_DELTA_TOKENS=0
bash hooks/stop-capture.sh
cat /tmp/cc-memory-capture-*.log | tail -5
psql "$DATABASE_URL" -c "SELECT session_id, summary FROM session_summaries ORDER BY updated_at DESC LIMIT 1;"
```

預期：DB 多一筆，session_id=`manual-smoke-*`。

- [ ] **Step 4：Commit**

```bash
git add hooks/stop-capture.sh hooks/stop.json
git commit -m "feat(M2): hooks/stop-capture.sh + Claude Code Stop registration"
```

---

## Task 2.15 — M2 Gate（simplify + review + codex-review + 驗收）

- [ ] **Step 1：跑完整測試套件**

```bash
npm run test:ci 2>&1 | tail -10
```
預期：tests ≥ 262（M1）+ 25（M2：skip 5 + throttle 4 + transcript 5 + idempotency 3 + session-state 3 + queue 3 + flag 3 + claude-cli 4 + embed 2 + summaries 4 + capture-runner 5）= ≥ 287。

- [ ] **Step 2：design doc §端對端驗收 Capture 4 項逐一驗**

- [ ] 在 Claude Code 內實際跑一輪對話 → 手動看 DB 有新 row、`writer_host` 正確
- [ ] 連跑兩輪對話（transcript 有新增） → DB 只有一筆 active、`summarize_count=2`
- [ ] 設 `CC_MEMORY_AUTO_CAPTURE=off` 跑一輪 → DB 無新 row
- [ ] 斷網（停 postgres container）→ 跑一輪 → `~/.cc-memory/capture-queue/` 多一筆 → 連網重觸 hook → queue 清空、DB 有 row

- [ ] **Step 3：Simplify（DRY / efficiency / reuse）**

- `capture-runner.ts` 內 `estimateTokens` 簡化寫法若導致 throttle 不準 → 換真的 token counter 或刪掉複雜度
- 8 個 util 模組看有沒有 duplicate 的 fs pattern 可抽 `withBaseDir` helper

- [ ] **Step 4：coderabbit review + codex-review**

- [ ] **Step 5：更新 handoff + commit tag**

```bash
git add docs/next-session-handoff.md
git commit -m "docs(M2): gate passed, update handoff"
git tag v0.4-m2
```

---

# Milestone 3 — Retrieval Integration + 跨專案（~1.5d）

> **開工對齊：** M3 不動 capture pipeline；只擴 `cc_memory_search` 和 `search_feedback`。
>
> **TDD 紀律：** 每個新增參數（project_ids / include_auto / weights）先寫測看到 fail → 實作到綠。
>
> **Commit 節奏：** schema/weights 一個 commit，跨表查一個，跨專案一個，feedback breakdown 一個，MCP schema 擴展一個，共 5 個 commit。

## Task 3.1 — schema 擴 `search_feedback.resultSourceBreakdown` + migration 0007

**Files：**
- Modify: `src/db/schema.ts`（`searchFeedback` 加欄位）
- Create: `sql/migrations/0007_search_feedback_source_breakdown.sql`
- Test: `tests/db/v04-search-feedback-breakdown.test.ts`

- [ ] **Step 1：測（RED）**

```typescript
// tests/db/v04-search-feedback-breakdown.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, type Sql } from '../helpers/db.js';

let sql: Sql;
beforeAll(async () => { sql = await connectTestDb(); });
afterAll(async () => { await sql?.end(); });

describe('search_feedback.result_source_breakdown', () => {
  it('欄位存在且型別 jsonb', async () => {
    const rows = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name='search_feedback' AND column_name='result_source_breakdown'
    `;
    expect(rows[0]?.data_type).toBe('jsonb');
  });
});
```

- [ ] **Step 2：schema.ts 加欄位**

```typescript
// src/db/schema.ts（searchFeedback 內 append）
    // v0.4 Phase C M3：每 rank 對應 manual/promoted/auto 的來源分佈
    resultSourceBreakdown: jsonb('result_source_breakdown'),
```

- [ ] **Step 3：generate + apply migration**

```bash
npx drizzle-kit generate --name=search_feedback_source_breakdown
# 應產 sql/migrations/0007_*.sql
npx drizzle-kit push --config drizzle.test.config.ts
DATABASE_URL="<prod>" npx drizzle-kit push --config drizzle.config.ts
```

- [ ] **Step 4：run + commit**

```bash
npm run test:ci
git add src/db/schema.ts sql/migrations/0007_*.sql tests/db/v04-search-feedback-breakdown.test.ts
git commit -m "feat(M3): search_feedback.result_source_breakdown jsonb (migration 0007)"
```

---

## Task 3.2 — `src/utils/weights.ts`

**Files：**
- Create: `src/utils/weights.ts`
- Test: `tests/utils/weights.test.ts`

- [ ] **Step 1：測（RED）**

```typescript
// tests/utils/weights.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_WEIGHTS, loadWeightsFromEnv } from '../../src/utils/weights.js';

describe('weights', () => {
  it('default = 1.0 / 0.85 / 0.65', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ manual: 1.0, promoted: 0.85, auto: 0.65 });
  });
  it('env override', () => {
    expect(loadWeightsFromEnv({
      CC_MEMORY_WEIGHT_MANUAL: '1.2',
      CC_MEMORY_WEIGHT_PROMOTED: '0.9',
      CC_MEMORY_WEIGHT_AUTO: '0.5',
    })).toEqual({ manual: 1.2, promoted: 0.9, auto: 0.5 });
  });
  it('bad env value fallback 到 default', () => {
    expect(loadWeightsFromEnv({
      CC_MEMORY_WEIGHT_MANUAL: 'not-a-number',
    }).manual).toBe(1.0);
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/utils/weights.ts
export interface RetrievalWeights {
  manual: number;
  promoted: number;
  auto: number;
}

export const DEFAULT_WEIGHTS: RetrievalWeights = {
  manual: 1.0, promoted: 0.85, auto: 0.65,
};

function parseFloat2(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

export function loadWeightsFromEnv(env: NodeJS.ProcessEnv = process.env): RetrievalWeights {
  return {
    manual: parseFloat2(env.CC_MEMORY_WEIGHT_MANUAL, DEFAULT_WEIGHTS.manual),
    promoted: parseFloat2(env.CC_MEMORY_WEIGHT_PROMOTED, DEFAULT_WEIGHTS.promoted),
    auto: parseFloat2(env.CC_MEMORY_WEIGHT_AUTO, DEFAULT_WEIGHTS.auto),
  };
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/utils/weights.test.ts
git add src/utils/weights.ts tests/utils/weights.test.ts
git commit -m "feat(M3): retrieval weights (1.0/0.85/0.65 defaults + env override)"
```

---

## Task 3.3 — `services/memories.ts` 擴展跨兩表加權 rerank

**Files：**
- Modify: `src/services/memories.ts`（`searchMemories` 函式）
- Modify: `src/services/types.ts`（`SearchMemoriesInput` 加 `project_ids?` + `include_auto?`）
- Test: `tests/services/search-weighted.test.ts`

**Design context：** Design doc §Retrieval Integration。跨兩表 candidate fetch → `projectMemories.base_score × W_MANUAL`、`sessionSummaries WHERE promoted_to_memory_id IS NOT NULL × W_PROMOTED`、其餘 auto × `W_AUTO`。合併 top-K。

- [ ] **Step 1：types.ts 擴**

```typescript
// src/services/types.ts
export interface SearchMemoriesInput {
  query: string;
  projectId?: string;
  projectIds?: string[];       // NEW：跨專案
  mode: SearchMode;
  limit: number;
  includeAuto?: boolean;       // NEW：預設 true（除非 env INCLUDE_AUTO=off）
  filterType?: string;         // 既有
}

export interface WeightedSearchResult {
  id: string;
  projectId: string;
  source: 'manual' | 'promoted' | 'auto';
  summary: string;
  score: number;  // 加權後
  baseScore: number;
  // ... 其他既有欄位
}
```

- [ ] **Step 2：測（RED，要 seed 三種來源 row）**

```typescript
// tests/services/search-weighted.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { projectMemories, sessionSummaries } from '../../src/db/schema.js';
import { searchMemories } from '../../src/services/memories.js';

vi.mock('../../src/utils/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/embedding.js')>()),
  generateQueryEmbedding: vi.fn(async () => new Array(1536).fill(0.01)),
  isEmbeddingEnabled: () => true,
}));

let sql: Sql; let db: ReturnType<typeof drizzle>;
beforeAll(async () => { sql = await connectTestDb(); db = drizzle(sql); });
afterAll(async () => { await sql?.end(); });
beforeEach(async () => { await resetAllTables(sql); });

async function seed() {
  const embed = new Array(1536).fill(0.01);
  // manual
  const [m] = await db.insert(projectMemories).values({
    projectId: 'p1', type: 'decision', summary: 'manual about AUTH',
    writerHost: 'h', idempotencyKey: 'pm-m', embedding: embed,
  }).returning();
  // promoted：先插 session_summaries，再插對應 project_memories + promoted_to_memory_id
  const [srcSummary] = await db.insert(sessionSummaries).values({
    projectId: 'p1', sessionId: 's-promoted', summary: 'promoted src about AUTH',
    captureSource: 'auto-stop-hook', captureHook: 'stop', writerHost: 'h', idempotencyKey: 'ss-p',
    embedding: embed,
  }).returning();
  const [pm2] = await db.insert(projectMemories).values({
    projectId: 'p1', type: 'decision', summary: 'promoted about AUTH',
    writerHost: 'h(promoted)', idempotencyKey: 'pm-p', embedding: embed,
    sourceSummaryId: srcSummary.id,
  }).returning();
  await db.update(sessionSummaries).set({ promotedToMemoryId: pm2.id })
    .where(eq(sessionSummaries.id, srcSummary.id));
  // 純 auto
  await db.insert(sessionSummaries).values({
    projectId: 'p1', sessionId: 's-auto', summary: 'auto about AUTH',
    captureSource: 'auto-stop-hook', captureHook: 'stop', writerHost: 'h', idempotencyKey: 'ss-a',
    embedding: embed,
  });
  return { manualId: m.id, promotedPmId: pm2.id, promotedSummaryId: srcSummary.id };
}

describe('searchMemories weighted (cross-table)', () => {
  it('include_auto=true 時 manual 排第一（W_MANUAL 最高）', async () => {
    await seed();
    const r = await searchMemories(db, {
      query: 'auth', projectId: 'p1', mode: 'semantic', limit: 10, includeAuto: true,
    });
    expect(r.items[0].source).toBe('manual');
  });

  it('include_auto=false 只回 project_memories', async () => {
    await seed();
    const r = await searchMemories(db, {
      query: 'auth', projectId: 'p1', mode: 'semantic', limit: 10, includeAuto: false,
    });
    expect(r.items.every((x) => x.source === 'manual' || x.source === 'promoted')).toBe(true);
    expect(r.items.every((x) => x.tableSource !== 'session_summaries')).toBe(true);
  });

  it('promoted score > auto score（同 baseScore 時 0.85 > 0.65）', async () => {
    await seed();
    const r = await searchMemories(db, {
      query: 'auth', projectId: 'p1', mode: 'semantic', limit: 10, includeAuto: true,
    });
    const promoted = r.items.find((x) => x.source === 'promoted');
    const auto = r.items.find((x) => x.source === 'auto');
    if (promoted && auto) expect(promoted.score).toBeGreaterThan(auto.score);
  });
});
```

(需 `import { eq } from 'drizzle-orm';`)

- [ ] **Step 3：實作擴展（在 `searchMemories` 加 cross-table branch）**

在 `src/services/memories.ts` `searchMemories` 函式內：

```typescript
// 偽代碼 skeleton —— 實作時保留原有 manual-only path（feature flag 或 includeAuto=false），
// 新增 cross-table merge + reweight
import { loadWeightsFromEnv } from '../utils/weights.js';
import { sessionSummaries } from '../db/schema.js';

export async function searchMemories(db, input) {
  const includeAuto = input.includeAuto ?? (process.env.CC_MEMORY_INCLUDE_AUTO_IN_SEARCH !== 'off');
  const weights = loadWeightsFromEnv(process.env);
  const projectScope = input.projectIds ?? (input.projectId ? [input.projectId] : []);
  // ... （舊 manual search 的 embedding / keyword branch 照跑，回傳候選 A）
  const manualCandidates = await searchProjectMemories(db, input, projectScope);
  if (!includeAuto) {
    return rerankAndFormat(manualCandidates, weights, 'manual-only');
  }
  const summaryCandidates = await searchSessionSummaries(db, input, projectScope);
  // 合併：promoted 判斷靠 row.promotedToMemoryId IS NOT NULL（session_summaries）
  // 或 project_memories.sourceSummaryId IS NOT NULL
  const merged = [
    ...manualCandidates.map((r) => ({ ...r, source: r.sourceSummaryId ? 'promoted' : 'manual' })),
    ...summaryCandidates.map((r) => ({ ...r, source: r.promotedToMemoryId ? 'promoted' : 'auto' })),
  ];
  return rerankAndFormat(merged, weights, 'weighted');
}

function rerankAndFormat(candidates, weights, mode) {
  const weighted = candidates.map((c) => ({
    ...c,
    baseScore: c.score,
    score: c.score * weights[c.source],
  }));
  weighted.sort((a, b) => b.score - a.score);
  return { items: weighted.slice(0, c.limit) /* ...其他 meta */ };
}
```

具體實作要搬 `src/services/memories.ts` 當前 `searchMemories` 的 drizzle query 建構細節。保留現有 manual-only path（包在 `if (!includeAuto)` 分支內）。

- [ ] **Step 4：run + commit**

```bash
npx vitest run tests/services/search-weighted.test.ts
git add src/services/memories.ts src/services/types.ts tests/services/search-weighted.test.ts
git commit -m "feat(M3): cross-table weighted rerank (manual>promoted>auto with includeAuto flag)"
```

---

## Task 3.4 — `project_ids[]` 跨專案查詢

**Files：**
- Modify: `src/services/memories.ts`（上 task 已加 `projectIds` 參數，本 task 實作多專案 SQL）
- Test: `tests/services/search-cross-project.test.ts`

- [ ] **Step 1：測（RED）**

```typescript
// tests/services/search-cross-project.test.ts
describe('searchMemories cross-project', () => {
  it('project_ids=[A,B] 同時查兩個 project', async () => {
    // seed：p_A 一筆 manual memory、p_B 一筆 manual memory
    // 搜尋 → 回 2 筆、各標 projectId
  });

  it('project_ids=["*"] 回 ALL project', async () => {
    // ... seed 三個 project 各一筆 → 結果 3 筆
  });

  it('省略 projectId/projectIds → 走預設 single project（回歸 Phase A 行為）', async () => {
    // ...
  });
});
```

- [ ] **Step 2：實作（drizzle `inArray` + 或 `IS ANY($1::text[])`）**

```typescript
// src/services/memories.ts 內 searchProjectMemories 大致：
function buildProjectScopeWhere(scope: string[]) {
  if (scope.length === 0) return undefined;
  if (scope.length === 1 && scope[0] === '*') return undefined;  // no filter
  return inArray(projectMemories.projectId, scope);
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/services/search-cross-project.test.ts
git add src/services/memories.ts tests/services/search-cross-project.test.ts
git commit -m "feat(M3): searchMemories project_ids=[A,B]|['*'] cross-project support"
```

---

## Task 3.5 — `services/feedback.ts` 填 `result_source_breakdown`

**Files：**
- Modify: `src/services/feedback.ts`（`recordSearchQuery`）
- Test: `tests/services/feedback.test.ts` 擴

- [ ] **Step 1：測 append**

```typescript
it('recordSearchQuery 寫入 result_source_breakdown', async () => {
  await recordSearchQuery(db, {
    query: 'x', querySurface: 'mcp', queryProjectId: 'p1', mode: 'hybrid', limit: 5,
    resultIds: ['id1', 'id2'], resultProjectIds: ['p1', 'p1'],
    rankPositions: [1, 2], scores: [0.9, 0.7],
    resultSourceBreakdown: { '1': 'manual', '2': 'auto' },
  });
  const [row] = await db.select().from(searchFeedback).orderBy(desc(searchFeedback.createdAt)).limit(1);
  expect(row.resultSourceBreakdown).toEqual({ '1': 'manual', '2': 'auto' });
});
```

- [ ] **Step 2：`recordSearchQuery` input + insert 加欄位**

```typescript
// src/services/feedback.ts（修改 recordSearchQuery signature + insert）
interface RecordSearchQueryInput {
  // ... 既有欄位 ...
  resultSourceBreakdown?: Record<string, 'manual' | 'promoted' | 'auto'>;
}
// insert 時：
//   resultSourceBreakdown: input.resultSourceBreakdown ?? null,
```

- [ ] **Step 3：caller `searchMemories` 產 breakdown 並傳進來**

- [ ] **Step 4：run + commit**

```bash
npx vitest run tests/services/feedback.test.ts
git add src/services/feedback.ts src/services/memories.ts tests/services/feedback.test.ts
git commit -m "feat(M3): recordSearchQuery writes result_source_breakdown"
```

---

## Task 3.6 — MCP `cc_memory_search` tool schema 擴展 + M3 Gate

**Files：**
- Modify: `src/tools/search.ts`（input schema 加 `project_ids` / `include_auto`）
- Modify: `src/index.ts`（tool definition）

- [ ] **Step 1：zod schema 擴**

```typescript
// src/tools/search.ts
export const searchSchema = z.object({
  query: z.string().min(1),
  project_id: z.string().optional(),
  project_ids: z.array(z.string()).optional(),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('hybrid'),
  limit: z.number().int().min(1).max(50).default(5),
  include_auto: z.boolean().default(true),
  filter_type: z.enum(['session', 'decision']).optional(),
});
```

- [ ] **Step 2：MCP tool definition 更新 description/properties/required**

- [ ] **Step 3：整體跑測（含 M1+M2+M3 全測）**

```bash
npm run test:ci 2>&1 | tail -10
```
預期 ≥ 300 tests 綠。

- [ ] **Step 4：手動 MCP smoke**

在 Claude Code 內：
```
cc_memory_search({query: 'M1 refine tools', project_ids: ['cc-memory'], include_auto: true})
```
預期回傳結果每筆標 `source` / `project_id`。

- [ ] **Step 5：M3 Gate verification**

- [ ] manual / auto 同 query cosine 接近時，加權後 manual 排前 — 在 Claude Code 真實查一 query 驗人眼看
- [ ] `project_ids=['*']` 能回 ALL 專案（先手動 seed 兩個 project 記憶驗）
- [ ] `INCLUDE_AUTO_IN_SEARCH=off` env 退回 Phase A 行為 → 跑 `npm run test:ci` 含原 248 tests 全綠

- [ ] **Step 6：Simplify + review + codex-review**

- [ ] **Step 7：Commit + tag**

```bash
git add src/tools/search.ts src/index.ts
git commit -m "feat(M3): MCP cc_memory_search accepts project_ids[] + include_auto"
git tag v0.4-m3
```

---

# Milestone 4 — SessionStart Re-inject（~1d）

> **開工對齊：** M4 要依賴 Task 0.2 context7 查到的 Claude Code hook protocol（`SessionStart` matcher、`additionalContext` JSON schema）。
>
> **實作前再查一次 hook protocol** — hook schema 可能在 Claude Code 新版微調，M1-M3 已經過了 1-2 週，容易過期。

## Task 4.1 — 再查 context7（hook protocol + additionalContext）

- [ ] **Step 1：context7 查最新 hook protocol**

```
Use: mcp__plugin_context7_context7__query-docs
Topic: "SessionStart hook additionalContext JSON schema matcher startup|clear|compact"
```

- [ ] **Step 2：更新 `docs/context7-snapshot-*.md`**

附上 current snapshot，commit。

---

## Task 4.2 — `src/services/reinject.ts`

**Files：**
- Create: `src/services/reinject.ts`
- Test: `tests/services/reinject.test.ts`

**Design context：** Design doc §SessionStart Re-inject Pipeline。查近 N 筆 active summary + 近 M 筆 manual/promoted，格式化成 `additionalContext` 字串。

- [ ] **Step 1：測（RED）**

```typescript
// tests/services/reinject.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { projectMemories, sessionSummaries } from '../../src/db/schema.js';
import { buildReinjectPayload } from '../../src/services/reinject.js';

let sql: Sql; let db: ReturnType<typeof drizzle>;
beforeAll(async () => { sql = await connectTestDb(); db = drizzle(sql); });
afterAll(async () => { await sql?.end(); });
beforeEach(async () => { await resetAllTables(sql); });

describe('buildReinjectPayload', () => {
  it('回近 N 筆 summary + 近 M 筆 manual', async () => {
    // seed 5 summaries + 3 manual
    // ...
    const p = await buildReinjectPayload(db, { projectId: 'p1', nSummaries: 3, mManual: 2 });
    expect(p.summaries.length).toBe(3);
    expect(p.manual.length).toBe(2);
    expect(p.additionalContext).toContain('Recent session summaries');
  });

  it('空 project → additionalContext 為空字串', async () => {
    const p = await buildReinjectPayload(db, { projectId: 'empty', nSummaries: 3, mManual: 2 });
    expect(p.additionalContext).toBe('');
  });

  it('只拉 status=active 的 summary', async () => {
    // seed 一筆 active + 一筆 archived
    // ...
    const p = await buildReinjectPayload(db, { projectId: 'p1', nSummaries: 10, mManual: 10 });
    expect(p.summaries.every((s) => s.status === 'active')).toBe(true);
  });

  it('summary 按 updatedAt DESC 排序', async () => {
    // ...
  });
});
```

- [ ] **Step 2：實作**

```typescript
// src/services/reinject.ts
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { sessionSummaries, projectMemories } from '../db/schema.js';
import type { DbClient } from './types.js';

export interface BuildReinjectInput {
  projectId: string;
  nSummaries: number;
  mManual: number;
}

export interface ReinjectPayload {
  summaries: Array<{ id: string; summary: string; keywords: string[]; nextSteps: string[]; updatedAt: Date; status: string }>;
  manual: Array<{ id: string; summary: string; keywords: string[]; decisions: string[]; updatedAt: Date }>;
  additionalContext: string;
}

export async function buildReinjectPayload(
  db: DbClient,
  input: BuildReinjectInput
): Promise<ReinjectPayload> {
  const summaries = await db.select().from(sessionSummaries).where(
    and(eq(sessionSummaries.projectId, input.projectId), eq(sessionSummaries.status, 'active'), isNotNull(sessionSummaries.sessionId))
  ).orderBy(desc(sessionSummaries.updatedAt)).limit(input.nSummaries);

  const manual = await db.select().from(projectMemories).where(
    and(eq(projectMemories.projectId, input.projectId), eq(projectMemories.status, 'active'))
  ).orderBy(desc(projectMemories.updatedAt)).limit(input.mManual);

  const additionalContext = formatAsMarkdown(input.projectId, summaries, manual);
  return { summaries, manual, additionalContext };
}

function formatAsMarkdown(projectId: string, summaries: any[], manual: any[]): string {
  if (summaries.length === 0 && manual.length === 0) return '';
  const lines: string[] = [`## CC-memory: Recent context (${projectId})`, ''];
  if (manual.length > 0) {
    lines.push('### Manual / promoted memories (curated)', '');
    for (const m of manual) {
      lines.push(`- [mem-${m.id.slice(0, 8)}] ${m.updatedAt.toISOString().split('T')[0]}: ${m.summary}`);
      if (m.keywords?.length) lines.push(`  Keywords: ${m.keywords.join(', ')}`);
      if (m.decisions?.length) lines.push(`  Decisions: ${m.decisions.join('; ')}`);
    }
    lines.push('');
  }
  if (summaries.length > 0) {
    lines.push(`### Recent session summaries (auto, latest ${summaries.length})`, '');
    for (const s of summaries) {
      lines.push(`- [ss-${s.id.slice(0, 8)}] ${s.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}: ${s.summary}`);
      if (s.nextSteps?.length) lines.push(`  Next steps: ${s.nextSteps.join('; ')}`);
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/services/reinject.test.ts
git add src/services/reinject.ts tests/services/reinject.test.ts
git commit -m "feat(M4): buildReinjectPayload (N summaries + M manual, markdown formatted)"
```

---

## Task 4.3 — MCP `cc_memory_recent_summaries`（read-only）

**Files：**
- Create: `src/tools/recent-summaries.ts`
- Modify: `src/tools/index.ts`、`src/index.ts`

- [ ] **Step 1：tool handler + registration（照 Task 1.9 pattern）**

```typescript
// src/tools/recent-summaries.ts
import { z } from 'zod';
import { buildReinjectPayload } from '../services/reinject.js';
import type { DbClient } from '../services/types.js';

export const recentSummariesSchema = z.object({
  project_id: z.string(),
  limit: z.number().int().min(1).max(50).default(5),
});

export async function handleRecentSummaries(db: DbClient, args: unknown) {
  const input = recentSummariesSchema.parse(args);
  const payload = await buildReinjectPayload(db, {
    projectId: input.project_id,
    nSummaries: input.limit,
    mManual: 0,
  });
  return { content: [{ type: 'text', text: JSON.stringify({ summaries: payload.summaries }) }] };
}

export const recentSummariesToolDefinition = {
  name: 'cc_memory_recent_summaries',
  description: '讀近 N 筆 active session summaries（reinject-runner 使用；read-only 不寫 audit）',
  inputSchema: { /* project_id / limit */ },
};
```

- [ ] **Step 2：run + commit**

```bash
npm run test:ci
git add src/tools/recent-summaries.ts src/tools/index.ts src/index.ts
git commit -m "feat(M4): MCP cc_memory_recent_summaries (read-only, reinject consumer)"
```

---

## Task 4.4 — `scripts/reinject-runner.ts`

**Files：**
- Create: `scripts/reinject-runner.ts`
- Test: `tests/scripts/reinject-runner.test.ts`

**Design context：** Design doc §SessionStart Re-inject Pipeline。讀 env、查 N+M、stdout 輸出 hook protocol JSON。feature flag `REINJECT=off` exit。

- [ ] **Step 1：測（RED）**

```typescript
// tests/scripts/reinject-runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReinject } from '../../scripts/reinject-runner.js';

// mock service 避免 DB 連線（reinject-runner test 走純邏輯測；服務層另有 DB 測）
vi.mock('../../src/services/reinject.js', () => ({
  buildReinjectPayload: vi.fn(async () => ({
    summaries: [], manual: [],
    additionalContext: '## CC-memory...\n- ss-abc',
  })),
}));

describe('runReinject', () => {
  it('REINJECT=off → stdout 空', async () => {
    const out = await runReinject({ projectId: 'p1', env: { CC_MEMORY_REINJECT: 'off' } });
    expect(out).toBe('');
  });

  it('REINJECT=on → stdout 是 hook protocol JSON 字串', async () => {
    const out = await runReinject({ projectId: 'p1', env: { CC_MEMORY_REINJECT: 'on' } });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('CC-memory');
  });

  it('空 payload → stdout 空（不注入 placeholder）', async () => {
    const { buildReinjectPayload } = await import('../../src/services/reinject.js');
    (buildReinjectPayload as any).mockResolvedValueOnce({ summaries: [], manual: [], additionalContext: '' });
    const out = await runReinject({ projectId: 'p1', env: { CC_MEMORY_REINJECT: 'on' } });
    expect(out).toBe('');
  });
});
```

- [ ] **Step 2：實作**

```typescript
// scripts/reinject-runner.ts
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { buildReinjectPayload } from '../src/services/reinject.js';
import { resolveProjectId } from '../src/services/projects.js';

export interface RunReinjectOpts {
  projectId: string;
  env: NodeJS.ProcessEnv;
  databaseUrl?: string;
}

export async function runReinject(opts: RunReinjectOpts): Promise<string> {
  if ((opts.env.CC_MEMORY_REINJECT ?? 'off') === 'off') return '';

  const nSummaries = parseInt(opts.env.CC_MEMORY_REINJECT_SUMMARIES ?? '3', 10);
  const mManual = parseInt(opts.env.CC_MEMORY_REINJECT_MANUAL ?? '2', 10);

  const client = postgres(opts.databaseUrl ?? opts.env.DATABASE_URL ?? '');
  const db = drizzle(client);
  try {
    const payload = await buildReinjectPayload(db, {
      projectId: opts.projectId, nSummaries, mManual,
    });
    if (!payload.additionalContext) return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: payload.additionalContext,
      },
    });
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const projectId = env.CLAUDE_PROJECT_DIR ?? process.cwd();
  runReinject({
    projectId: (typeof projectId === 'string') ? projectId : process.cwd(),
    env,
  }).then((s) => { process.stdout.write(s); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(0); });  // 吞錯不阻塞
}
```

- [ ] **Step 3：run + commit**

```bash
npx vitest run tests/scripts/reinject-runner.test.ts
git add scripts/reinject-runner.ts tests/scripts/reinject-runner.test.ts
git commit -m "feat(M4): reinject-runner (REINJECT flag + hook protocol JSON)"
```

---

## Task 4.5 — `hooks/session-start-reinject.sh` + settings 註冊

**Files：**
- Create: `hooks/session-start-reinject.sh`
- Modify: `hooks/session-start.json`（現有檔案，改掉 Phase A 的 disabled placeholder）

- [ ] **Step 1：寫 shell**

```bash
#!/usr/bin/env bash
# hooks/session-start-reinject.sh
# Claude Code SessionStart hook — 呼叫 reinject-runner；stdout 寫回 hook protocol JSON
set +e
cd "$(dirname "$0")/.."
node --loader tsx ./scripts/reinject-runner.ts 2>/tmp/cc-memory-reinject-$$.err
exit 0  # 不阻塞 session 啟動
```

- [ ] **Step 2：chmod + 改 settings**

```bash
chmod +x hooks/session-start-reinject.sh
```

`hooks/session-start.json`（matcher = `startup|clear|compact`）：

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|clear|compact",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-reinject.sh" }] }
    ]
  }
}
```

具體 schema 以 Task 4.1 context7 查到為準。

- [ ] **Step 3：手動 smoke（要 Claude Code 支援 matcher，不然改用現有 settings）**

```bash
# 先插一些 session_summaries 到 test/prod DB，設 CC_MEMORY_REINJECT=on
export CC_MEMORY_REINJECT=on
export CLAUDE_PROJECT_DIR="$PWD"
bash hooks/session-start-reinject.sh
# stdout 應吐出 JSON 含 "CC-memory: Recent context"
```

重開 Claude Code session 驗 context 有注入（Claude 回答時能提到插的 summary 內容）。

- [ ] **Step 4：Commit**

```bash
git add hooks/session-start-reinject.sh hooks/session-start.json
git commit -m "feat(M4): hooks/session-start-reinject.sh + Claude Code SessionStart registration"
```

---

## Task 4.6 — M4 Gate

- [ ] **Step 1：完整測試**

```bash
npm run test:ci 2>&1 | tail -10
```
預期 tests ≥ 310（M3 基線 + reinject service 4 + runner 3 + recent-summaries smoke 1 + hook protocol schema 1）。

- [ ] **Step 2：端對端驗收 Re-inject**

- [ ] `/clear` 或 `/compact` 觸發 → 新 context 含近 3 筆 summary + 2 筆 manual（從 Claude 的 recollection 驗證）
- [ ] `CC_MEMORY_REINJECT=off` 時 `/clear` → 新 context 不含注入
- [ ] 空 project（無任何記憶）→ reinject-runner stdout 為空、session 正常啟動

- [ ] **Step 3：Simplify + review + codex-review**

- [ ] **Step 4：Commit + tag**

```bash
git tag v0.4-m4
```

---

# Milestone 5 — Benchmark Harness + 觀察期進入（~0.5d dev）

> **目的：** M5 只產出「能跑的 benchmark 腳本 + 固定 5 query fixture + 人工標註 template」。觀察期（≥ 2 週 + ≥ 30 筆 auto summary）結束才驗品質閘，**不在 M5 scope 內**。
>
> **TDD 紀律：** fixture parser + 比對 harness 的 smoke test 即可，benchmark 產出品質驗靠人工。

## Task 5.1 — `docs/benchmark/fixtures.md`（固定 5 query）

**Files：**
- Create: `docs/benchmark/fixtures.md`

**Design context：** Design doc §Success Criteria 品質閘「10 組 query（真 5 + 固 5）」。固定 5 由人工維護 expected top-3 manual memory id（使用者寫這 5 query 時手動標 ground truth）。

- [ ] **Step 1：產出 fixture template**

```markdown
# CC-memory benchmark fixtures（固定 5 query）

> 這 5 組 query 是為品質閘穩定對比設計的。Expected top-3 是「在 benchmark 當下 manual memory 庫中，人工判定最該排前的 3 筆 id」。每次跑 benchmark 前若 project_memories 有大變動（merge/edit）→ 要重標 expected。

## Query 1 — 「Phase A schema 改動」
- Expected top-3 manual memory ids: （填 project_memories 中相關 id）
- Topic tags: schema, phase-a, v0.3

## Query 2 — 「Claude CLI subprocess」
- Expected top-3: ...
- Tags: capture, claude-cli, v0.4

## Query 3 — ...
## Query 4 — ...
## Query 5 — ...
```

- [ ] **Step 2：Commit**

```bash
git add docs/benchmark/fixtures.md
git commit -m "docs(M5): benchmark fixtures template (5 fixed queries)"
```

---

## Task 5.2 — `docs/benchmark/manual-template.md`（人工標註 template）

- [ ] **Step 1：產出 template**

```markdown
# Manual annotation template — benchmark YYYY-MM-DD

對每組 query 的 CC-memory top-5 與 claude-mem top-5，人工標註「相關 / 不相關」，並在 rank 欄填「第一個相關結果出現的 rank」（1-5；未命中= ∞ 記 11）。

## Query 1: <query text>

### CC-memory top-5
| rank | id prefix | source | summary 摘頭 | 相關? (y/n) |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

First relevant rank: __

### claude-mem top-5
<同上>

## Query 2: ...
```

- [ ] **Step 2：Commit**

```bash
git add docs/benchmark/manual-template.md
git commit -m "docs(M5): manual annotation template for benchmark runs"
```

---

## Task 5.3 — `scripts/benchmark.ts`

**Files：**
- Create: `scripts/benchmark.ts`
- Modify: `package.json`（加 `benchmark:run` script）

**Design context：** Design doc §Success Criteria 品質閘。跑 10 組 query（從 `--fixtures` 固定 5 + 近 7 日 search_feedback 抽真 5）對比 CC-memory / claude-mem。輸出 markdown 報告（交集、rank、錯抓率 placeholder）。

- [ ] **Step 1：實作**

```typescript
// scripts/benchmark.ts
import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { desc, sql as dsql } from 'drizzle-orm';
import { searchFeedback } from '../src/db/schema.js';
import { searchMemories } from '../src/services/memories.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturesPath = args.fixtures ?? 'docs/benchmark/fixtures.md';
  const fixtureQueries = await parseFixtures(fixturesPath);
  const recentQueries = await getRecentRealQueries();
  const allQueries = [...fixtureQueries, ...recentQueries].slice(0, 10);

  const client = postgres(process.env.DATABASE_URL ?? '');
  const db = drizzle(client);

  const results: Array<{ query: string; ccmemTop5: any[]; claudeMemTop5: any[]; intersection: number }> = [];
  try {
    for (const q of allQueries) {
      const ccmem = await searchMemories(db, { query: q, mode: 'hybrid', limit: 5, includeAuto: true });
      const claudeMem = await queryClaudeMem(q);  // 讀 ~/.claude-mem/claude-mem.db 或 chroma
      const intersection = countIntersection(
        ccmem.items.map((i) => i.summary.slice(0, 80)),
        claudeMem.map((i) => i.summary.slice(0, 80)),
      );
      results.push({ query: q, ccmemTop5: ccmem.items, claudeMemTop5: claudeMem, intersection });
    }
  } finally {
    await client.end();
  }

  const report = formatReport(results);
  const outPath = `docs/benchmark-${new Date().toISOString().split('T')[0]}.md`;
  await mkdir('docs', { recursive: true });
  await writeFile(outPath, report, 'utf8');
  console.log(`Report written to ${outPath}`);
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function parseFixtures(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  return [...raw.matchAll(/^## Query \d+ — 「(.+?)」/gm)].map((m) => m[1]);
}

async function getRecentRealQueries(): Promise<string[]> {
  // 讀近 7 日 search_feedback distinct query
  // 省略；MVP 回空陣列
  return [];
}

async function queryClaudeMem(query: string): Promise<Array<{ summary: string }>> {
  // 讀 ~/.claude-mem/claude-mem.db SQLite + vector search
  // MVP：回 [] 當 placeholder；實作時用 better-sqlite3 + cosine sim
  return [];
}

function countIntersection(a: string[], b: string[]): number {
  const sa = new Set(a);
  return b.filter((x) => sa.has(x)).length;
}

function formatReport(results: any[]): string {
  const lines: string[] = [
    `# Benchmark report — ${new Date().toISOString()}`, '',
    '## Summary',
    `- Total queries: ${results.length}`,
    `- Avg CC-memory top-5 ∩ claude-mem top-5: ${(results.reduce((s, r) => s + r.intersection, 0) / results.length).toFixed(2)}`,
    `- Queries with intersection ≥ 3: ${results.filter((r) => r.intersection >= 3).length}/${results.length}`,
    '',
    '## Per-query results',
  ];
  for (const r of results) {
    lines.push(`### Query: ${r.query}`, '');
    lines.push(`Intersection = ${r.intersection}`, '');
    lines.push('#### CC-memory top-5');
    r.ccmemTop5.forEach((i: any, idx: number) => lines.push(`${idx + 1}. [${i.source}] ${i.summary.slice(0, 120)}`));
    lines.push('', '#### claude-mem top-5');
    r.claudeMemTop5.forEach((i: any, idx: number) => lines.push(`${idx + 1}. ${i.summary.slice(0, 120)}`));
    lines.push('');
  }
  lines.push(
    '## 人工標註區（複製 docs/benchmark/manual-template.md 到此逐 query 填）',
    '',
    '## 錯抓率統計（觀察期結束填）',
    '- 抽最近 50 筆 auto session_summaries（capture_source=auto-stop-hook 且 promoted_to_memory_id IS NULL）',
    '- 人工判定錯抓比例：___%',
  );
  return lines.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2：package.json**

```json
"scripts": {
  "benchmark:run": "npx tsx scripts/benchmark.ts"
}
```

- [ ] **Step 3：smoke test（fixture parse 正確）**

```bash
npm run benchmark:run -- --fixtures docs/benchmark/fixtures.md
ls docs/benchmark-*.md
```
預期產出一個 markdown 檔（含空的 per-query results）。

- [ ] **Step 4：Commit**

```bash
git add scripts/benchmark.ts package.json
git commit -m "feat(M5): benchmark script (fixtures + recent queries + claude-mem diff report)"
```

---

## Task 5.4 — M5 Gate + 進入觀察期

- [ ] **Step 1：完整測試**

```bash
npm run test:ci 2>&1 | tail -10
```
預期 tests 和 M4 一樣（M5 沒加測），≥ 310。

- [ ] **Step 2：M5 Gate**

- [ ] `npm run benchmark:run -- --fixtures docs/benchmark/fixtures.md` 可跑完並產 markdown 檔
- [ ] 產出報告含「Summary / Per-query results / 人工標註區 / 錯抓率統計」四節
- [ ] 手動 hosts scratch：跑一次 benchmark → 確認報告可人工閱讀 / 填空位

- [ ] **Step 3：進入觀察期 checklist**

- [ ] `CC_MEMORY_AUTO_CAPTURE=on` 設在使用者 shell env（或 `.claude/settings.json`）
- [ ] `CC_MEMORY_REINJECT=on` 設上（optional；看使用者接受度）
- [ ] claude-mem **繼續跑**（併用期不停用）
- [ ] 在 `docs/next-session-handoff.md` 加「觀察期起點」日期 + 「結束日期（起點 + 14d）」
- [ ] 每週跑一次 `npm run benchmark:run` 並 commit 報告

- [ ] **Step 4：更新三檔（spec / plan / task）**

- [ ] spec.md Phase C 段落加 ✅ 勾（M1-M5 全完）
- [ ] task.md Phase C M1-M5 checklist 逐項勾上
- [ ] plan.md Rollout Order 表更新實際完工日期

- [ ] **Step 5：Commit + tag**

```bash
git add docs/spec.md docs/plan.md docs/task.md docs/next-session-handoff.md
git commit -m "docs(M5): v0.4 Phase C implementation complete, enter observation window"
git tag v0.4-phase-c-dev-complete
```

---

# 品質閘（Phase C 結束後 2 週）— **非 M5 Gate，獨立決策點**

> 這段不在本 plan 的 Task 清單內，但記錄給觀察期結束後的未來 session 照著做。

**條件：** 觀察期 ≥ 14 天 AND `session_summaries` 累積 ≥ 30 筆。

**動作：**
1. `npm run benchmark:run` 一次（真實 5 來自近 7 日 search_feedback）
2. 人工用 `docs/benchmark/manual-template.md` 標註
3. 統計三指標（design doc §Success Criteria）：
   - Top-5 交集 ≥ 3 筆（≥ 7/10 組達標）
   - 人工平均 first-relevant rank：CC-memory ≤ claude-mem
   - 錯抓率（最近 50 筆 auto summary、未 promoted）< 10%
4. 三指標 AND 滿足 → 產 `docs/claude-mem-switchoff-decision.md`（含證據）→ 停 claude-mem
5. 不滿足 → 分析原因、開 v0.5 spec 調參數、繼續併用

---

# Phase C 端對端驗收（對照 design doc §端對端驗收）

> 每個 Milestone Gate 已包含部分；此清單是 plan 收尾整合檢核。

## Capture（M2 涵蓋）

- [ ] A 機跑一輪對話 → Stop hook → B 機 `cc_memory_search` 查得到、`writer_host`=A
- [ ] 長 session 跑 N 輪 → 只有一筆 active row、`summarize_count` 合理
- [ ] `CC_MEMORY_AUTO_CAPTURE=off` → DB 無新 row
- [ ] 斷網 capture → queue 有 row → 連網重觸 → queue 清空、DB 有 row

## Re-inject（M4 涵蓋）

- [ ] `/clear` 或 `/compact` 觸發 → 新 context 含近 3 筆 summary + 2 筆 manual
- [ ] `REINJECT=off` → 新 context 不含注入
- [ ] 空 project → stdout 空、session 正常啟動

## Retrieval（M3 涵蓋）

- [ ] `include_auto=true` / `false` 結果差異符合加權
- [ ] 手動 save + auto 抓同主題 → manual 排前
- [ ] promote 一筆 auto → 該筆排名上升
- [ ] `project_ids=['CC-memory','AI_Copilot']` 跨專案結果每筆標 `project_id`

## Refine（M1 涵蓋）

- [ ] 四個 refine MCP tool 各 happy path + audit log 有一筆
- [ ] CLI `refine list/delete/promote/merge/edit/audit` 都能跑

## Benchmark（M5 涵蓋）

- [ ] `scripts/benchmark.ts --fixtures ...` 可產報告
- [ ] 觀察期結束後（v0.4 plan 範圍外）三指標達標 → 產 `docs/claude-mem-switchoff-decision.md`

---

# Plan Self-Review Checklist（writing-plans skill 要求）

## 1. Spec Coverage

| Design doc 章節 | 對應 plan task |
|---|---|
| Goals 1（自動抓摘要）| M2 Task 2.1-2.14 |
| Goals 2（compact 後 re-inject）| M4 Task 4.1-4.6 |
| Goals 3（召回不感知兩表分裂）| M3 Task 3.3-3.6 |
| Goals 4（refine feedback loop）| M1 Task 1.5-1.10 |
| Goals 5（品質閘決定 claude-mem 切換）| M5 Task 5.1-5.4 + 品質閘區塊 |
| US-1（自動留記憶）| M2 Task 2.13（capture-runner） |
| US-2（compact re-inject）| M4 Task 4.4-4.5 |
| US-3（hook 失敗不阻塞）| M2 Task 2.7（queue）+ Task 2.8（flags）+ 2.14（set +e） |
| US-4（manual 永遠排前）| M3 Task 3.2（weights）+ 3.3（rerank） |
| US-5（單一入口查記憶）| M3 Task 3.3+3.6 |
| US-6（refine delete）| M1 Task 1.5 + 1.9 |
| US-7（refine promote）| M1 Task 1.6 + 1.9 |
| US-8（refine merge）| M1 Task 1.7 + 1.9 |
| US-9（refine edit）| M1 Task 1.8 + 1.9 |
| US-10（CLI 批次）| M1 Task 1.10 |
| US-11（品質閘 benchmark）| M5 Task 5.3 |
| US-12（feature flag 退場）| M2 Task 2.13（AUTO_CAPTURE）+ M3 Task 3.3（INCLUDE_AUTO）+ M4 Task 4.4（REINJECT） |
| US-13（跨專案）| M3 Task 3.4 |
| Constraints 1-12 | 分散在各 Milestone；重點：非回歸（所有 Gate 跑全測）、precision-first（queue+flag）、Claude CLI subprocess（Task 2.9）、Gemini 獨立（Task 2.10）、SKIP_TOOLS（2.2）、雙節流（2.3）、upsert canonical（2.11）、idempotency（2.5 + schema unique index） |
| Data Model：session_summaries | Task 1.1 |
| Data Model：refine_audit_log | Task 1.2 |
| Data Model：source_summary_id FK | Task 1.3 |
| Capture pipeline | Task 2.13 組合；子模組 Task 2.2-2.11 |
| Upsert 行為 | Task 2.11 + schema partial unique index Task 1.1 |
| Queue resume | Task 2.7 + 2.13 內呼叫 listPendingQueue |
| SessionStart re-inject | Task 4.2-4.5 |
| Retrieval `cc_memory_search` 擴展 | Task 3.3-3.6 |
| Refine tools（MCP + CLI）| Task 1.5-1.10 |
| Error Handling 表 | 分散：queue（2.7）、flag（2.8）、set +e（2.14/4.5）、CHECK constraint（1.1） |
| Testing Strategy 分層 | Unit test 每個 helper；Integration 測 service+DB；E2E capture-runner test |
| Success Criteria（功能）| Gate 清單 M1-M4 + 端對端驗收區塊 |
| Success Criteria（品質閘）| M5 + 品質閘獨立區塊 |
| Rollout Plan M1-M5 | 本 plan 的 Milestone 結構 1:1 |

覆蓋完整 ✅，**無 spec 需求未對應 task**。

## 2. Placeholder Scan

Plan 中「TBD / 省略 / 照 pattern」pattern 出現的地方及判斷：

- Task 1.9 Step 2「其他 3 個 clone 此 pattern 換 service function」— **可接受**：給完整 pattern + 三個目標 service function 名稱都已在 Task 1.5-1.8 列出；讀此 plan 的人有能力依樣 clone。
- Task 1.10 `runPromote / runMerge / runEdit` 比照 pattern — **同上**，pattern 已給完整（`runDelete`）。
- Task 3.3 Step 3「實作擴展」用偽代碼 skeleton — **可接受但邊緣**：讀者需要看 `src/services/memories.ts` 現有 query 結構才能套；本 plan 在 Task 3.3 已要求「保留現有 manual-only path 包在 `if (!includeAuto)` 分支」，加上偽代碼骨架，對 senior dev 足夠。
- Task 3.4 Step 1 測試僅列 describe 標題沒完整 expect — **需要補**（見下方「fix」段）
- Task 3.5 / 3.6 / 4.3 「照 Task 1.9 pattern」— 可接受（pattern 已完整）
- Task 5.3 `queryClaudeMem` 給 MVP placeholder 回 `[]` — **可接受**：plan 明確標「MVP：回空；實作時用 better-sqlite3 + cosine sim」——告訴 dev 有 TODO，但在 MVP scope 內可留。

### Fix：Task 3.4 補完整測試

（Plan 內直接修補。位置：Task 3.4 Step 1。）

Task 3.4 Step 1 的三個測試原 placeholder，改成：

```typescript
// tests/services/search-cross-project.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { projectMemories } from '../../src/db/schema.js';
import { searchMemories } from '../../src/services/memories.js';

vi.mock('../../src/utils/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/embedding.js')>()),
  generateQueryEmbedding: vi.fn(async () => new Array(1536).fill(0.01)),
  isEmbeddingEnabled: () => true,
}));

let sql: Sql; let db: ReturnType<typeof drizzle>;
beforeAll(async () => { sql = await connectTestDb(); db = drizzle(sql); });
afterAll(async () => { await sql?.end(); });
beforeEach(async () => { await resetAllTables(sql); });

async function seedProjects() {
  const embed = new Array(1536).fill(0.01);
  await db.insert(projectMemories).values([
    { projectId: 'pA', type: 'decision', summary: 'A about AUTH', writerHost: 'h', idempotencyKey: 'A', embedding: embed },
    { projectId: 'pB', type: 'decision', summary: 'B about AUTH', writerHost: 'h', idempotencyKey: 'B', embedding: embed },
    { projectId: 'pC', type: 'decision', summary: 'C about AUTH', writerHost: 'h', idempotencyKey: 'C', embedding: embed },
  ]);
}

describe('searchMemories cross-project', () => {
  it('projectIds=[A,B] 同時查兩個 project，每筆有 projectId', async () => {
    await seedProjects();
    const r = await searchMemories(db, { query: 'auth', projectIds: ['pA', 'pB'], mode: 'semantic', limit: 10 });
    const ids = new Set(r.items.map((i) => i.projectId));
    expect(ids.has('pA')).toBe(true);
    expect(ids.has('pB')).toBe(true);
    expect(ids.has('pC')).toBe(false);
  });

  it("projectIds=['*'] 回 ALL project", async () => {
    await seedProjects();
    const r = await searchMemories(db, { query: 'auth', projectIds: ['*'], mode: 'semantic', limit: 10 });
    const ids = new Set(r.items.map((i) => i.projectId));
    expect(ids.has('pA') && ids.has('pB') && ids.has('pC')).toBe(true);
  });

  it('省略 projectId/projectIds → 從 cwd 解析當前 project（預設行為不變）', async () => {
    await seedProjects();
    const r = await searchMemories(db, { query: 'auth', mode: 'semantic', limit: 10 /* no projectId */ });
    // 當前 project 假設 = 'cc-memory'（由 resolveProjectId）；seed 內沒這 project → 結果為空
    expect(r.items.length).toBe(0);
  });
});
```

Plan 內 Task 3.4 以此為準。

## 3. Type Consistency

掃描 plan 中跨 Task 的 type / method 名稱：

| 名稱 | 定義位置 | 被引用位置 | 一致? |
|---|---|---|---|
| `deleteRecord` | Task 1.5 | Task 1.9/1.10 | ✅ |
| `promoteSummary` | Task 1.6 | Task 1.9/1.10 | ✅ |
| `mergeRecords` | Task 1.7 | Task 1.9/1.10 | ✅ |
| `editRecord` | Task 1.8 | Task 1.9/1.10 | ✅ |
| `upsertSessionSummary` | Task 2.11 | Task 2.12/2.13 | ✅ |
| `callClaudeCli` | Task 2.9 | Task 2.13 | ✅ |
| `runCapture` | Task 2.13 | Task 2.14 | ✅ |
| `buildReinjectPayload` | Task 4.2 | Task 4.3/4.4 | ✅ |
| `runReinject` | Task 4.4 | Task 4.5 | ✅ |
| `RefineDeleteInput / -Promote / -Merge / -Edit` | Task 1.5-1.8 | MCP tool schema Task 1.9 | ✅（zod schema 欄位名對齊） |
| `UpsertSessionSummaryInput` | Task 2.11 | Task 2.12 handler parse | ✅ |
| `SessionState.lastSummaryAtMs` | Task 2.6 | Task 2.3 throttle + 2.13 runner | ✅ |
| `CaptureQueueItem.attempts` | Task 2.7 | Task 2.13 runner enqueue | ✅ |
| `RetrievalWeights.{manual,promoted,auto}` | Task 3.2 | Task 3.3 rerank | ✅ |
| `SearchMemoriesInput.projectIds / includeAuto` | Task 3.3 types.ts | Task 3.4/3.6 | ✅ |

**無不一致**，全綠。

## 4. Skill Alignment（`sdd-workflow.md §每個 Phase 執行紀律`）

| 階段 skill | Plan 中對應位置 |
|---|---|
| brainstorming | Task 0（不重跑，已在 design doc 完成）|
| context7 | Task 0.2（M1 開工前 4 份）+ Task 4.1（M4 前再查 hook protocol） |
| TDD | 每個 feature task 都是 RED → GREEN → COMMIT 步驟結構 |
| simplify | M1 Task 1.11 Step 5 / M2 Task 2.15 Step 3 / M3 3.6 Step 6 / M4 4.6 Step 3 |
| code review（coderabbit）| M1-M4 每個 Gate 的 Step 6-7 |
| codex-review（大顆粒）| M1 1.11 Step 7 / M2 2.15 Step 4（和 review 合一 step） |
| Gate + commit | 每個 Milestone 尾段獨立 Task（1.11/2.15/3.6/4.6/5.4） |

---

**Plan Status：** Complete（Prereq + M1–M5 + Self-Review 全過）

**估時總結：**
- Task 0（Prereq）：~0.5d
- M1：~1d
- M2：~2.5d
- M3：~1.5d
- M4：~1d
- M5：~0.5d
- **Dev 總和：~7d**（不含觀察期 14d）

**執行方式（使用者指示 = Inline）：**
- 使用者已明確指示「從 M1 開工」，跳過 writing-plans skill 的 Execution Handoff offer
- Review 通過後使用 `superpowers:executing-plans`（inline，batch execution with checkpoints）或 `superpowers:subagent-driven-development`（fresh subagent per task）執行本 plan，任選
- 每個 Milestone Gate 是自然 checkpoint
