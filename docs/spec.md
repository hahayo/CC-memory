# CC-memory Spec（v0.3 Phase A 已交付 + v0.4 自動採集規劃）

> **🔀 Track 分流（2026-06-05）**：本檔 v0.4 Phase C auto-capture 為**規劃完成、實作 deferred**（**非進行中**）。目前 in-flight 的是獨立 initiative **personal-hub**（CC-memory 升格跨工具個人記憶+待辦中樞），其 SDD 三件套在 `docs/personal-hub/{spec,plan,task}.md`，Phase 0 安全核心已交付（commit `01dd5e4`）。兩條 track 互不污染：本檔保留 v0.3/v0.4 歷史，個人中樞內容一律在 `docs/personal-hub/`。

> **當前版本：v0.4 draft**（2026-04-23 升版）· Phase A 已交付（tag `v0.3-phase-a`）；**Phase B 已取消**；新增 **Phase C — v0.4 自動採集（Stage 1）**。
>
> **完整 Phase C 設計請見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md`**（1056 行、13 User Stories、5 Milestones、7 Risks）。本 spec 保留 Phase A 既有內容、Phase B 標記為取消、新增 Phase C 骨架對照 design doc。
>
> change log：
> - v1.3.1（2026-04-21）：拆分 Phase A (MCP) / Phase B (HTTP + Telegram)；新增 `## Constraints`
> - **v0.4（2026-04-23）**：Phase B 取消；轉向 claude-mem 風格自動採集；Stage 1 = session_summaries + refine tools；LLM 摘要走 Claude CLI subprocess（subscription）；embedding 沿用 Gemini
>
> v1.3 原 change log（存檔）：
> - P0-1：bot 不直連 DB（走 HTTP）； P0-2：`idempotency_key text UNIQUE`； P0-3：`BOT_API_TOKEN` + `X-Telegram-User-Id` 雙重檢查
> - P1-2：`project_id` 優先序 `explicit > env > marker > repo_name > basename`
> - 兩張寫入表加 `writer_host text` 欄位

---

## Context

### 為什麼做這個改動

CC-memory 目前（v0.1）透過 MCP stdio 只對 **Claude Code** 開放。使用者的原始需求是：

1. 跨 session / 跨專案 / 跨電腦 — 現有 PG 雲端已達成
2. **跨工具**：Claude Code + Codex CLI 都能讀寫
3. **Telegram 介面**：隨時查詢記憶、輸入代辦事項

目前架構只能讓 Claude Code 用。缺的是**工具不可知的介面層**與**代辦事項資料模型**。

### 為什麼選路線 A（最保守）— 原 v1.3 決策

Codex 魔鬼代言人審查指出三個「3-6 個月會重寫」的陷阱：

1. todo 併入 memory 表遲早補第二套 schema
2. Stop hook 自動抽取未驗證 retrieval 可信前就平台化 → 長期記憶汙染
3. Telegram「最後活躍專案」會悄悄錯 project，信任一崩整個 bot 死

路線 A 的核心原則：**先證明 retrieval 可信 + 手動寫入夠用，再談自動化**。

### v0.4 方向調整（2026-04-23）

Phase A 已完工（tag `v0.3-phase-a`，248 tests 綠），但使用者決策：
- **Phase B 取消**：HTTP REST API + Telegram bot + thumbs feedback 整塊放棄
- **轉向自動採集**：走 claude-mem 10.5.2 實戰路線（Stop hook + SessionStart re-inject），與 Phase A 的 manual save 併存
- **驗證機制調整**：原依賴 Phase B 的 thumbs/selected_rank 迴路 → 改為**品質閘（真實 5 + 固定 5 benchmark query）+ refine tools** 承擔精準度驗證
- **Phase C = v0.4 Stage 1**：session_summaries 單表 + refine tools（delete/promote/merge/edit）+ Re-inject push 注入
- 本 spec 的 Phase C 章節是骨架，完整設計見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md`

### v1.3 修訂重點（詳情見 plan.md）

| 主題 | v1.1 | v1.3 |
|---|---|---|
| bot ↔ DB | bot 允許 `src/bot/state.ts` 直連 DB | bot **完全**不碰 DB，走 `/api/bot/state` HTTP |
| memory 冪等 | 靠 `metadata.idempotency_key` JSONB scan | `project_memories.idempotency_key text UNIQUE` |
| bot ACL | 只靠 client 傳 `project` 參數 | server 讀 `X-Telegram-User-Id` → 查 bot_user_state |
| project_id 優先序 | `marker > env > basename` | `explicit > env > marker > repo_name > basename` |
| 跨電腦穩定 id | 無 | 加入 `git remote get-url origin` 抽 repo name |
| 寫入稽核 | 無 | 兩表加 `writer_host text`（env 或 `os.hostname()`）|

---

## Goals（使用者原始 3 個需求 + v0.4 延伸）

### Phase A / v0.3 已達成
1. 跨 session / 跨專案 / 跨電腦 — 現有 PG 雲端已達成
2. **跨工具**：Claude Code + Codex CLI 都能讀寫（MCP stdio）

### 原目標 3（Telegram）— **取消**
3. ~~Telegram 介面：隨時查詢記憶、輸入代辦事項~~ → v0.4 放棄 Phase B

### v0.4 Phase C 新 Goals（詳見 design doc §Goals）
4. **Stop hook 自動抓摘要**（SKIP_TOOLS 過濾 + 雙節流 + upsert）
5. **SessionStart re-inject 推送記憶**（啟動 / clear / compact 時主動注入）
6. **retrieval 跨表跨專案**（`cc_memory_search` 加 manual > promoted > auto 加權 + `project_ids[]`）
7. **refine 工具一等公民**（delete / promote / merge / edit，MCP + CLI 並行）
8. **品質閘決定切換 claude-mem**（top-5 交集 + 平均 rank + 錯抓率三項硬指標）

---

## User Stories

使用者：本專案開發者（單人）。脈絡分兩組介面：

- **Phase A — MCP**（v0.2 本期交付）：終端機（Claude Code / Codex MCP stdio）
- **Phase B — HTTP REST API + Telegram bot**（後續階段 / 可由其他 agent 承接，本期不綁排程）

每個 US 皆對應具體驗收條件與 Goal / Design Principle。

---

### Phase A — MCP（本期 Priority）

#### US-1 — 桌機記的東西，筆電開著就看得到

**作為** 在多台電腦切換工作的開發者，**我希望** A 電腦 `cc_memory_save` 寫入的記憶，B 電腦 `cc_memory_list` 馬上看得到，**以便** 不用靠 git 或手抄同步。

- A save 後 B list 立刻有該筆（PG 雲端單一真實來源）
- 每筆 row `writer_host` 能看出寫入來源電腦
- 對應 Goal 1

#### US-2 — 同 repo 不同電腦 clone 路徑 → 同 project_id

**作為** 會把同一個 repo clone 到 `/home/me/x` 或 `/workspace/x` 的使用者，**我希望** 兩邊 cc-memory 都解析到同一個 `project_id`，**以便** 跨電腦不會被誤判成兩個專案。

- 優先序 `explicit > env > marker > repo_name > basename`
- `repo_name` 從 `git remote get-url origin` 抽取（https / ssh 兩種格式）
- 非 git 或無 remote → fallback basename
- 對應 Goal 1 + Design Principle「跨電腦 project_id 穩定」

#### US-3 — Claude Code 和 Codex CLI 同一份記憶

**作為** Claude Code + Codex CLI 都會用的開發者，**我希望** 兩個 MCP client 看到同一份資料，**以便** 不用切工具就清掉 context。

- `codex mcp add cc-memory` 即可複用，無須寫專屬整合
- 兩邊寫入、讀取共用一個 PG；MCP tool 格式向後相容
- 對應 Goal 2

---

### ~~Phase B — HTTP + Telegram~~ ❌ **已於 2026-04-23 取消**

> **取消原因**：使用者決策轉向 claude-mem 風格自動採集（見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §Context）。HTTP API + Telegram bot + thumbs feedback 整塊放棄。下方 US-4 ~ US-6 保留為歷史紀錄，**不再驗收**。

> 本期先實作 Phase A 的 MCP 與 service layer 抽出，HTTP API 與 Telegram bot 皆延後到 Phase B。資料面支援（`idempotency_key`、`writer_host`、`bot_user_state`、`search_feedback`）在 Phase A 已準備好，確保之後串接時不需再改 schema 或重跑 migration。

#### US-4 — 手機也能查記憶 / 記 TODO

**作為** 離開電腦時會想查或新增的人，**我希望** 用 Telegram bot `/search`、`/note`、`/todo`、`/todos`，**以便** 不用每次都回去開電腦。

- `/search <q>` 限 active project（無 active 時拒絕，提示 `/switch`；跨專案查詢改由 admin HTTP API `/api/memories?project=X` 提供）
- `/note`、`/todo` 寫入後桌機 `cc_memory_list` / `cc_task_list` 即時可見
- `/todos` 列當前 project 未完成任務；`/done <id前6>` / `/cancel <id前6>` 完成或取消
- 對應 Goal 3

#### US-5 — Telegram bot 寫入約束（server 不信任 client）

**作為** 會把 bot 放在 Telegram 的使用者，**我希望** 任何來自 bot 的寫入都必須通過三重檢查：白名單 user id、合法 active project、只能動自己的 state，**以便** 不會被陌生人塞垃圾訊息、不會 silent miswrite、不會跨 user 互相污染。

**白名單**
- 非白名單 telegram user → bot silent ignore + log（不回應）
- HTTP bot scope 無 `X-Telegram-User-Id` → 401

**沒選 project 一律拒寫（silent miswrite 防線）**
- 無 active project 時任何 write → 403 `SWITCH_REQUIRED`
- `/switch <name>` 僅接受 `listProjects()` 中已存在的 id；不存在不自動建立
- Server 端不信任 client 傳來的 `project` 參數（由 server 查 `bot_user_state`）

**身分隔離**
- Bot scope 只能讀寫自己 `telegram_user_id` 的 `bot_user_state`（跨身分讀寫 → 403）

對應 Design Principle「未選 project 一律拒寫」「Server 不信任 client 傳來的 project」「Token 分權」。

#### US-6 — 打錯字能撤銷

**作為** 手機輸入容易打錯的使用者，**我希望** 剛送出的 `/note`、`/todo` 10 秒內能按 `[撤銷]` 收回，**以便** 不用去 DB 手動刪。

- 10 秒內撤銷 → 刪除該筆（靠 `idempotency_key UNIQUE` 精準找）
- 超過 10 秒 → 403（不靠 in-memory timer，靠 `created_at` 差）
- 重複按撤銷 / 重送同訊息 → no-op（第二次 DELETE 同 key 回 200 / 第二次 POST 同 key 回舊 id）
- 對應 Design Principle「Undo 靠資料層 idempotency_key UNIQUE」

---

### Phase C — v0.4 自動採集（Stage 1）

> **完整 User Stories（US-1 ~ US-13）見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §User Stories。** 以下列主題對照表。

| US# | 主題 | 對應 design doc §US |
|---|---|---|
| US-C1 | Stop hook 自動抓 summary（SKIP_TOOLS + 雙節流 + upsert） | US-1 |
| US-C2 | SessionStart re-inject 推送記憶（startup/clear/compact） | US-2 |
| US-C3 | Hook 失敗不阻塞使用者工作流 | US-3 |
| US-C4 | 手動記的記憶永遠排前面（加權） | US-4 |
| US-C5 | 單一入口查記憶（manual + auto 融合） | US-5 |
| US-C6 | 錯抓能立刻 refine delete | US-6 |
| US-C7 | 有用 auto 能 promote 到 manual | US-7 |
| US-C8 | 重複多筆能 merge | US-8 |
| US-C9 | 記憶能 edit 修正 | US-9 |
| US-C10 | CLI 批次 refine | US-10 |
| US-C11 | benchmark 決定是否停用 claude-mem | US-11 |
| US-C12 | 三個 feature flag（auto_capture / include_auto / reinject） | US-12 |
| US-C13 | 跨專案查詢 `project_ids[]` | US-13 |

**Phase C 技術選型摘要**：
- **LLM 摘要**：Claude CLI subprocess（`claude -p --model claude-sonnet-4-5 --output-format json`），吃 subscription
- **Embedding**：Gemini `text-embedding-004`（沿用 Phase A，`vector(768)`）
- **Hook 事件**：`Stop`（抓）+ `SessionStart(matcher=startup|clear|compact)`（re-inject）
- **SKIP_TOOLS 預設清單**（抄 claude-mem）：`ListMcpResourcesTool, SlashCommand, Skill, TodoWrite, AskUserQuestion`
- **Feature flags 預設值**：`AUTO_CAPTURE=off`（opt-in）、`INCLUDE_AUTO_IN_SEARCH=on`、`REINJECT=off`（opt-in）

---

## Non-goals（Out of Scope，明確不做）

### Phase A / v0.3 原 Non-goals（仍有效）

- ❌ ~~Stop hook 自動抽取~~ → **v0.4 Phase C 已啟動**（session_summaries only，不做 observations 細粒度）
- ❌ `candidate_memories` 表與 `/promote` 流程 → v0.4 Phase C 用 `session_summaries.promoted_to_memory_id` 實現
- ❌ provenance / temporal validity 欄位
- ❌ Layer 3 topic compilation
- ❌ 多 bot 平台 / 語音 / 圖片 / 檔案
- ❌ 衝突合併 / conflict resolution
- ❌ Web UI / 完整 i18n
- ❌ ~~任何 LLM 自動抽取~~ → **v0.4 Phase C 用 Claude CLI 抽**
- ❌ Sentry / Datadog（log 夠用）
- ❌ Rate limit 細緻化（MVP 單人使用）

### v0.4 Phase C 新 Non-goals

- ❌ `observations` 細粒度表（Stage 2）
- ❌ claude-mem 歷史 import（品質閘過後才做）
- ❌ Batch tag refine 操作
- ❌ LLM 自動 refine 候選建議
- ❌ HTTP REST API / Telegram bot / thumbs feedback（**原 Phase B 整塊放棄**）
- ❌ 調整 / fork claude-mem（原樣併用，品質閘後再決定）

---

## Scope 摘要

| 項目 | 階段 | 說明 |
|---|---|---|
| **Day 0 Schema alignment** ✅ | Phase A | 刪 `sql/schema.sql`，Drizzle 當唯一真實來源 |
| **Schema 擴充 Phase 1** ✅ | Phase A | `tasks`、`search_feedback`、`bot_user_state` 上線 |
| **Schema 補完 Phase 2** | Phase A | `project_memories` 加 `idempotency_key` + `writer_host`；`tasks` 加 `writer_host` |
| **Service layer 抽出** | Phase A | `src/services/` 純業務邏輯，MCP 直接使用；HTTP / bot 屆時共用 |
| **Canonical project id** | Phase A | `explicit > env > marker > repo_name > basename` 統一解析 |
| **Writer attribution** | Phase A | `writer_host` = env `CC_MEMORY_WRITER` ?? `os.hostname()` |
| **MCP task tools** | Phase A | `cc_task_create` / `cc_task_list` / `cc_task_update`（optimistic locking） |
| **Retrieval 評估（被動記錄 + 離線腳本）** | Phase A | MCP `cc_memory_search` 自動寫 `search_feedback`；`scripts/eval-retrieval.ts` 跑報告 |
| **Codex MCP** | Phase A | 不寫專用整合；使用者 `codex mcp add cc-memory` 即可複用 |
| ~~**HTTP REST API**~~ | ~~Phase B~~ ❌ | 取消 |
| ~~**Telegram bot**~~ | ~~Phase B~~ ❌ | 取消 |
| ~~**Feedback 回寫（thumbs / selected）**~~ | ~~Phase B~~ ❌ | 取消；品質驗證改靠 Phase C 品質閘 + refine delete 頻率 |
| **`session_summaries` 新表** | Phase C | upsert 同 session（Stop hook），`vector(768)` embedding、`capture_source`/`capture_hook`/`summarize_count` |
| **`refine_audit_log` 新表** | Phase C | refine 四操作的 audit log，保留 before/after snapshot |
| **capture-runner + Claude CLI** | Phase C | `scripts/capture-runner.ts` + `src/llm/claude-cli.ts`（subprocess）+ SKIP_TOOLS 過濾 + 雙節流 |
| **reinject-runner** | Phase C | `scripts/reinject-runner.ts` + `hooks/session-start-reinject.sh` → `additionalContext` hook protocol |
| **`cc_memory_search` 擴展** | Phase C | 跨表（manual+auto）、跨專案（`project_ids[]`）、加權 rerank（1.0 / 0.85 / 0.65） |
| **Refine tools** | Phase C | `cc_memory_refine_{delete,promote,merge,edit}` + `scripts/refine.ts` CLI |
| **Benchmark harness** | Phase C | `scripts/benchmark.ts`：真實 5 + 固定 5 query → 對比 claude-mem |

---

## Constraints

### Phase A 原 Constraints（v0.4 保留）
- **技術**：沿用現有 Drizzle ORM + PostgreSQL (Zeabur)；不得引入新 DB 或 ORM
- **預算**：單人開發；不接 Sentry / Datadog，log 夠用
- **相容性**：現有 6 個 memory MCP tool 輸入輸出格式不得變更（向後相容）
- **安全**：SQL 一律 parameterized（Drizzle ORM 保證）；shell call 用 `execFileSync`；API key 用環境變數
- **規模**：MVP 單人使用；不做細緻 rate limit
- ~~架構隔離 / bot 進程~~ → Phase B 取消後此條失效

### Phase C 新 Constraints（詳見 design doc §Constraints 12 條）
- **不回歸**：現有 248 tests 全綠，v0.4 不得造成既有測試失敗
- **Precision-first**：寧漏不要錯抓；Claude CLI 失敗寫 queue 不強寫 DB
- **LLM 摘要走 Claude CLI subprocess**：不呼叫 Anthropic API、不呼叫 Gemini LLM API
- **Embedding 獨立走 Gemini**：`text-embedding-004` 只管 embedding，與 LLM 解耦
- **SKIP_TOOLS 過濾是節流第 0 關**：純工具輪次直接 skip
- **Stop hook 雙節流**：min-interval 180s AND min-tokens 500 任一不過即跳過
- **同 session upsert**：一筆 active canonical，後寫覆蓋前寫
- **三個獨立 feature flag**：`AUTO_CAPTURE` / `INCLUDE_AUTO_IN_SEARCH` / `REINJECT`
- **Hook 失敗不阻塞 Claude Code**：`set +e` 吞錯誤

---

## Design Principles

### Phase A 必守

- **先證明 retrieval 可信 + 手動寫入夠用，再談自動化**
- **跨電腦 project_id 穩定**：優先用 git repo name，不同電腦 path 不影響
- **所有寫入留下 writer_host 稽核軌跡**：debugging / audit / 同步除錯時能知道哪台電腦
- **Drizzle 為唯一真實來源**：禁止手寫 SQL 維護 schema
- **Undo 靠資料層 `idempotency_key UNIQUE`**：不靠 timer，不用 JSONB scan
- **向後相容**：現有 6 個 memory MCP tool 輸入輸出格式不動
- **Phase A 的 schema / service 設計不得阻斷 Phase B 落地下述 runtime invariant**（idempotency_key UNIQUE、bot_user_state 表、9 欄 search_feedback 皆 Phase A 就位）

### ~~Phase B 開工時適用~~ ❌ 已取消（原則保留為歷史紀錄）

### Phase C 必守
- **抄 claude-mem 不重發明**：prompt (`code.json`)、hook 事件（Stop + SessionStart）、LLM provider（Claude CLI）、SKIP_TOOLS 清單皆抄 claude-mem 10.5.2
- **兩表並存不合表**：`project_memories`（curated）與 `session_summaries`（auto）分表，retrieval 層統一
- **同 session upsert**：不保留 session 中間版本，避免污染 top-K
- **Push + Pull 雙模召回**：Pull = `cc_memory_search`；Push = SessionStart re-inject
- **Refine 一級動作**：不是事後工具，介面與 save/search 同等
- **LLM + Human 雙管道**：MCP tool（LLM）+ CLI（human 批次）共用 handler

---

## Success Criteria（Retrieval Evaluation 2 週評估點）

### Phase A 指標（MCP-only 可量測）

| 指標 | 目標 | 來源 |
|---|---|---|
| 每日查詢數 | > 3 | `search_feedback` count per day |
| Mode 分佈 | semantic / keyword / hybrid 各有 signal | breakdown by `mode` |
| 結果穩定度 | 同 query 兩次結果重疊 > 70% | result_ids 交集 / 併集 |

Phase A 靠 MCP `cc_memory_search` 被動寫入 `search_feedback`（query / query_surface='mcp' / query_project_id / mode / limit / result_ids / result_project_ids / rank_positions / scores），但**無 thumbs / selected_rank**（沒有 bot inline button，MCP client 無互動回饋層）。

### ~~Phase B 指標~~ ❌ 取消

### Phase C 品質閘（claude-mem 切換 Go/No-Go）

> 完整細節見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §Success Criteria。

**觀察窗**：併用 claude-mem 至少 2 週 + 累積 ≥ 30 筆 session_summaries，兩條件都滿足才跑品質閘。

**硬指標（AND 全達才停用 claude-mem）**：
- **Top-5 交集**：10 組 benchmark query（真實 5 + 固定 5）中，≥ 7 組的 CC-memory top-5 與 claude-mem top-5 交集 ≥ 3 筆
- **人工命中度**：抽樣 10 組 query，CC-memory 平均首個相關結果 rank ≤ claude-mem 平均 rank
- **錯抓率**：人工檢視最近 50 筆 `capture_source='auto-stop-hook'` 且 `promoted_to_memory_id IS NULL` 的 auto summary，錯抓比例 < 10%

不過 → 繼續併用、分析原因、v0.5 再嘗試

---

## 端對端（多電腦 / 跨工具）驗收

### Phase A（本期必過）

- [ ] A 電腦 Claude Code `cc_memory_save` → B 電腦 `cc_memory_list` 能看到，`writer_host` 顯示 A hostname
- [ ] A 電腦 `cc_task_create` → B 電腦 `cc_task_list` 能看到，`writer_host` 顯示 A hostname
- [ ] Codex CLI `codex mcp add cc-memory` 後能呼叫 `cc_memory_search`
- [ ] B 電腦 clone 到不同路徑 → 自動解析到相同 `project_id`（repo_name 生效）
- [ ] MCP `cc_memory_search` 每次呼叫後 `search_feedback` 多一筆（含 query / mode / result_ids）

### ~~Phase B 驗收~~ ❌ 取消（以下歷史紀錄）

- [ ] Telegram `/todos` 能看到 A 剛建的 task
- [ ] Telegram `/todo X` → A 電腦 `cc_task_list` 能看到
- [ ] Bot 設 `CC_MEMORY_WRITER=telegram-bot` → 寫入 row 的 `writer_host` 為 `telegram-bot`
- [ ] 未設 active project 的 Telegram user 發 `/note` → 收 403 + `/switch` 提示
- [ ] Telegram 10 秒內撤銷成功、超時 403、重複按 no-op

### Phase C（v0.4 本期必過）

> 完整端對端驗收清單見 `docs/superpowers/specs/2026-04-22-auto-capture-design.md` §端對端驗收。

**Capture**
- [ ] Stop hook 實測觸發 → Claude CLI subprocess → Gemini embed → DB upsert 端到端通
- [ ] 同 session 跑兩輪 Stop（transcript 有新增） → DB 只有一筆 active、`summarize_count=2`
- [ ] SKIP_TOOLS 驗證（上輪只叫 TodoWrite）→ 不觸發摘要
- [ ] 節流驗證（兩輪間隔 < min-interval 且 delta < min-tokens）→ 不觸發摘要
- [ ] A 機 session 結束 → B 機 `cc_memory_search` 能查到，`writer_host` = A hostname
- [ ] `CC_MEMORY_AUTO_CAPTURE=off` 重跑 → DB 無新 row

**Re-inject**
- [ ] `/clear` 或 `/compact` 觸發 → 新 context 含近 5 筆 summary + 近 3 筆 manual
- [ ] `CC_MEMORY_REINJECT=off` 時 `/clear` → context 不含注入

**Retrieval**
- [ ] `cc_memory_search(include_auto=true)` 跨表結果，manual > promoted > auto 加權排序
- [ ] `cc_memory_search(project_ids=['CC-memory','AI_Copilot'])` 能跨兩 project 查，每筆標 `project_id`

**Refine**
- [ ] `cc_memory_refine_{delete,promote,merge,edit}` 四個 MCP tool happy path 綠
- [ ] `scripts/refine.ts` CLI list/delete/promote/merge/edit/audit 都能跑

**Benchmark / 品質閘**
- [ ] `scripts/benchmark.ts` 跑完 10 組 query → 產出 `docs/benchmark-YYYY-MM-DD.md`
- [ ] 觀察期結束、三項硬指標全達 → 產出 `docs/claude-mem-switchoff-decision.md`
