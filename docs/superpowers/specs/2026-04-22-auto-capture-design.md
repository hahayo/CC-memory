> **[SUPERSEDED（已被取代）2026-07-05]** 本 v0.4 auto-capture design 已被 `docs/auto-capture-v0.5/spec.md` 取代。保留本文作為架構思路與決策歷史溯源；不要依本文開工實作。

# CC-memory v0.4 — 自動採集（Auto-capture）Design Spec

**建立日期**：2026-04-22
**狀態**：Draft（待 user review）
**取代**：`docs/spec.md` 原 Phase B（HTTP + Telegram）區塊
**前置里程碑**：`v0.3-phase-a` tag（commit `a7b15dd`，248 tests 綠）

> 本文件是 brainstorm 產出的 design spec。User review 通過後會再同步更新 `docs/spec.md`、`docs/plan.md`、`docs/task.md`（依 `~/.claude/rules/sdd-workflow.md` Phase 同步規則）。

---

## Context

### 為何升版 v0.4（而非 v0.3 Phase C）

`v0.3` 原 Phase B 是 HTTP REST API + Telegram bot + 寫入 feedback loop（thumbs / selected_rank）。使用者決定放棄 Phase B，轉向「claude-mem 風格的自動採集」。原 `spec.md` line 34 明確警告「Stop hook 自動抽取未驗證 retrieval 可信前就平台化 → 長期記憶汙染」，而 Phase B 原本就是這個驗證迴路。現在 Phase B 取消，驗證改靠**品質閘 + refine tools**承擔。

方向轉彎夠大 → 升版 v0.4 比延用 v0.3 Phase C 乾淨（見 `sdd-workflow.md` Phase 邊界同步規則，兩個方向不宜共享同一 Phase banner）。

### 兩條 Hard Constraint（使用者指定）

1. **主動採集權重 > 自動採集**：`cc_memory_save`（manual）與 `promote`（auto 升等後）的 retrieval 權重嚴格高於 auto-capture 原生結果
2. **整理 DB 能力為一等公民**：delete / promote / merge / edit 必做，不是事後工具

### 技術前提

- claude-mem 10.5.2 的 prompt spec 公開可抄：`~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json`（6 type / 7 concept tags / system prompt / XML template / 31 語言版）
- Zeabur PG + pgvector 0.8.2 已部署（DATABASE_URL 在 `~/.claude.json`）；`GEMINI_API_KEY` 已註冊進 MCP env（Phase A 用於 embedding，v0.4 繼續給 embedding 用）；LLM 摘要改走 Claude CLI（使用者機器需已登入 Claude Pro/Max）
- `project_memories` / `search_feedback` 現存欄位（`writer_host` / `idempotency_key`）與本設計直接相容

---

## Goals

1. **對話過程中自動抓摘要**：每輪 `Stop` hook 觸發時，runner 先走 SKIP_TOOLS 過濾（跳過純工具輪次），再走節流條件（transcript 新增量 / 距上次摘要時間），兩關都過才 spawn Claude CLI subprocess 抽摘要並 upsert 到 DB；同 session 最終只保留一筆 canonical。**LLM 摘要吃 Claude Pro/Max subscription**（subprocess 模式、無額外 API 費用，照抄 claude-mem `CLAUDE_MEM_PROVIDER=claude` + `CLAUDE_MEM_CLAUDE_AUTH_METHOD=cli` 設計）。
2. **重開 / compact 後自動把記憶塞回 context**：`SessionStart` hook（matcher `startup|clear|compact`）載入近 N 筆 active summaries + 近 M 筆 manual/promoted 記憶，注入 Claude Code context，使模型不必主動搜尋也能「記得事情」。
3. **召回時感覺不到兩表分裂**：`cc_memory_search` 一個介面回傳 manual + auto 結果，透過加權實現「主動 > 自動」；同一介面支援跨專案查詢。
4. **refine 工具填補 Phase B 缺席的 feedback loop**：使用者能即時 delete / promote / merge / edit 錯抓內容；錯抓率 < 10% 是 Go/No-Go 的硬指標。
5. **能用可靠的品質閘決定是否取代 claude-mem**。

---

## User Stories

使用者：本專案開發者（單人），同時在桌機 / 筆電 / 公司電腦切換工作，併用 Claude Code + Codex CLI。

### Capture 相關

> **Hook 選擇說明**：不使用 `SessionEnd`（`/quit`、強制關閉終端等情境不保證給 hook 足夠時間；claude-mem 10.5.2 實測避開），也不使用 `PreCompact`（context 已到壓縮邊緣才觸發，時機太晚）。改採 claude-mem 實測過的 `Stop` hook（每輪對話結束）+ `SessionStart(matcher=startup|clear|compact)` re-inject 組合。

#### US-1 — 我邊用邊自動留下記憶，不必 `/save-memory`

**作為** 每天跑很多 session 但懶得手動寫 `/save-memory` 的開發者，**我希望** 我打完一輪對話、Claude 回完我準備輸入下個 prompt 時（`Stop` hook），runner 自動判斷本輪內容是否值得摘要，值得就抓一筆進 DB，**以便** 就算我 `/quit`、強制關終端、斷電，只要上一輪結束後 hook 已跑完，記憶就保得住。

- `Stop` hook 每輪觸發 runner；runner 讀本 session transcript（`$CLAUDE_TRANSCRIPT_PATH` 或等效）
- **節流條件（任一不滿足即跳過本次）**：距本 session 上次摘要超過 `CC_MEMORY_STOP_MIN_INTERVAL_SEC`（預設 180s）；本輪 transcript 新增 ≥ `CC_MEMORY_STOP_MIN_DELTA_TOKENS`（預設 500）
- 通過 SKIP_TOOLS 過濾 + 節流 → Claude CLI subprocess 抽摘要 → Gemini 產生 embedding → DB **upsert**（同 session_id 一筆 canonical，已有則 UPDATE 並重算 embedding、舊 row 不留歷史版本以避免汙染 retrieval）
- 摘要欄位至少包含 `summary` + `keywords` + `decisions` + `next_steps`
- `writer_host` 填本機主機名稱
- `CC_MEMORY_AUTO_CAPTURE=off` 時整個 runner 直接 exit，不抓
- 對應 Goal 1

#### US-2 — 重開 session 或 compact 後，Claude 不用搜尋也記得事

**作為** 習慣 `/clear` 或讓 Claude 自動 compact 的使用者，**我希望** `SessionStart` hook 觸發時自動把近 N 筆 active summary + 近 M 筆 manual/promoted 記憶注入新 context，**以便** Claude 不必主動叫 `cc_memory_search` 也能「記得」上次結論（對等 claude-mem 核心價值）。

- Matcher：`startup|clear|compact`（startup=開 Claude Code、clear=`/clear`、compact=auto/手動 compact 完成後重建 context）
- 注入內容（可調 env）：近 `CC_MEMORY_REINJECT_SUMMARIES`（預設 5）筆 active summary（同 project_id，按 `updated_at` DESC）+ 近 `CC_MEMORY_REINJECT_MANUAL`（預設 3）筆 manual/promoted
- 注入格式：透過 hook stdout 依 Claude Code hook protocol 返回 `additionalContext`（見 Capture Pipeline 段落範例）
- `CC_MEMORY_REINJECT=off` 可關掉此行為
- 對應 Goal 2（取代 claude-mem 核心戰場）

#### US-3 — Hook 或網路出錯不阻塞使用者工作流

**作為** 不希望 CC-memory 把 Claude Code 搞爆的使用者，**我希望** capture 過程 Claude CLI / Gemini embedding / DB / MCP 任一環節失敗都不會讓 Claude Code 報錯，**以便** 不論採集是否成功，我都能繼續工作，等環境恢復再補寫。

- Claude CLI subprocess 失敗 / 配額超限 / 未安裝 → 寫 flag 或 queue，下次 hook 觸發時先檢查 / 重試
- Gemini embedding API 失敗 → row 仍寫入但 embedding=NULL，下次 refine edit 觸發重 embed
- MCP / DB 失敗 → retry 3 次 → 仍敗 → 寫入 `~/.cc-memory/capture-queue/`，log 記錄
- 下次 hook 觸發時 runner 先清 queue（FIFO），斷網期的記憶補得回來
- attempts ≥ 5 的 queue 檔改名 `.dead` 放棄，不無限重試
- Hook wrapper 內 `set +e` 吞掉錯誤訊息
- 對應 Goal 1 + Design Principle「Hook 失敗不阻塞 Claude Code」

### Retrieval 相關

#### US-4 — 手動記的記憶永遠排前面

**作為** 信任自己手動 `/save-memory` 的內容勝於 LLM 自動抽取的使用者，**我希望** 同一 query 中 manual 寫入的記憶永遠排在 auto summary 前面，**以便** LLM 抓歪時不會把我手寫的重要決策擠出 top-K。

- `cc_memory_search` 回傳時，score 排序滿足 manual（W=1.0） > promoted（W=0.85） > auto（W=0.65）
- 當 manual 和 auto 對同 query 原始 similarity 相近時，manual 透過加權穩定排前
- `CC_MEMORY_WEIGHT_*` 環境變數可調整權重
- 對應 Goal 3 + Hard Constraint 1（主動 > 自動）

#### US-5 — 單一入口查記憶，不需要知道 manual / auto 分裂

**作為** 只想查一次就拿到結果的使用者，**我希望** `cc_memory_search` 一個介面跨兩表查（不必記得還有 `cc_memory_search_summaries`），**以便** Claude / Codex 工作時不用分兩次搜尋。

- 預設 `include_auto=true`，回傳 manual + auto 混合結果
- `include_auto=false` 或 `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off` 可退回純 manual 行為（原 248 tests 不回歸）
- 同 session 僅一筆 canonical summary（Stop hook upsert 保證），不需要折疊邏輯
- 對應 Goal 3

### Refine 相關

#### US-6 — 錯抓的記憶能立刻刪掉

**作為** 看到 auto summary 寫錯 / 幻覺 / 無價值內容的使用者，**我希望** 對話中直接叫 Claude 用 `cc_memory_refine_delete` 把它軟刪除，**以便** 不用另開 DB client 下 SQL、也不用等到週末批次整理。

- 軟刪除（`status='archived'`），保留 row 可追溯
- retrieval 不再命中 archived
- `refine_audit_log` 多一筆記錄操作者 / 前後快照 / 理由
- 對 archived row 重 delete → 409 冪等 noop
- 對應 Goal 4 + Hard Constraint 2（refine 一等公民）

#### US-7 — 有用的 auto summary 能升等為 manual

**作為** 發現某筆 auto 抓得好到想列為長期正典的使用者，**我希望** `cc_memory_refine_promote` 把它升進 `project_memories`，**以便** 下次同 query 時它的權重從 0.65 升到 0.85（或經 overrides 編輯後升 1.0）。

- `project_memories` 新增一筆，`source_summary_id` 指回原 summary
- 原 summary 的 `promoted_to_memory_id` 填入新 memory id
- 重複 promote 同一筆 → 409（不重複升等）
- 升等後同 query retrieval 該筆排名上升
- 對應 Goal 3 + Goal 4 + Hard Constraint 1

#### US-8 — 重複 / 相關的多筆能合併成一筆

**作為** 看到 session 跨多天但主題相同、產出多筆 auto summary 的使用者，**我希望** `cc_memory_refine_merge` 選中 N 筆合併成一筆新 row、原始 N 筆 archive，**以便** retrieval 不被重複內容淹沒，且原始資料仍可追溯。

- 新 row 寫入指定 target table（`session_summaries` 或 `project_memories`）
- 原 N 筆 `status='archived'`、`metadata.merged_into` 指向新 row
- 跨 project / 跨 table 合併 → 400 拒絕
- 對應 Goal 4 + Risk 2（session boundary 不穩）對策

#### US-9 — 記憶內容能手動修正

**作為** 看到 summary 內容大致對但關鍵字 / 決策寫歪的使用者，**我希望** `cc_memory_refine_edit` 能改 `summary` / `keywords` / `decisions` / `next_steps`，**以便** 不必先刪再重寫（丟失 created_at / session_id 脈絡）。

- UPDATE 指定欄位、`updated_at` 更新
- 若改動影響 embedding（改 summary 或 keywords）→ 自動重算 embedding
- `refine_audit_log` 記錄 before / after snapshot
- 對應 Goal 4

#### US-10 — 批次整理能走 CLI，不必一筆筆叫 LLM

**作為** 週末想清掉一個月前所有 auto summary 的使用者，**我希望** `npx tsx scripts/refine.ts delete --where 'created_at < $1' --params 2026-03-01 --dry-run`，**以便** 在終端機看 diff 預覽後再確認執行。

- CLI 支援 `delete` / `promote` / `merge` / `edit` / `list` / `audit` 六操作
- `--dry-run` 不動 DB 只印預覽
- `--yes` 跳過確認、`--project` 指定 project_id
- CLI 後端和 MCP tool 共用同一 handler（行為一致）
- `list` / `audit` 為 read-only，不寫 `refine_audit_log`
- 對應 Goal 4 + Hard Constraint 2

### 品質閘 / 觀察期相關

#### US-11 — 能用資料決定是否停用 claude-mem

**作為** 併用 claude-mem 兩週後要決定是否停用它的使用者，**我希望** `npx tsx scripts/benchmark.ts` 跑完 10 組 query（真實 5 + 固定 5）對比 CC-memory vs claude-mem，**以便** 不靠感覺、靠三個硬指標（交集 ≥3、平均 rank、錯抓率 <10%）做決定。

- benchmark 跑完產出 `docs/benchmark-YYYY-MM-DD.md`
- 人工命中度標註 template 可重複使用
- 三項指標 AND 條件全滿足 → 產出 `docs/claude-mem-switchoff-decision.md` 記錄證據
- 不過關 → 繼續併用、分析原因、v0.5 再嘗試
- 對應 Goal 5

#### US-12 — 自動採集可一鍵退場不綁死系統

**作為** 萬一 auto capture 產出品質糟到污染 retrieval 的使用者，**我希望** 兩個 feature flag 能分別關掉「寫入」和「讀取混合」，**以便** 不必改 code 就能隔離問題。

- `CC_MEMORY_AUTO_CAPTURE=off` → hook 觸發但 runner 不寫 DB
- `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off` → 寫入繼續，但 retrieval 退回純 manual
- `CC_MEMORY_REINJECT=off` → SessionStart 不注入記憶
- 三個 flag 獨立，可分別測試問題在採集 / 檢索 / 注入哪一端
- 對應 Goal 5 + Risk 3（retrieval UX 碎化）對策

### 跨專案查詢

#### US-13 — 一次查多個 project 的記憶，不必切 cwd

**作為** 在 `CC-memory` 寫 feature 時想參考以前在 `AI_Copilot` 的類似決策的使用者，**我希望** `cc_memory_search` 接受 `project_ids?: string[]` 參數一次查多個專案（`['*']` 查全部），**以便** 跨專案知識能自然流動，不必手動 `cd` 切到別的目錄再查。

- `project_ids` 省略 → 沿用現行行為（當前 project only，向後相容）
- `project_ids: ['A', 'B']` → 同時跨兩個 project 查，結果標註 `project_id` 欄位
- `project_ids: ['*']` → 全 project 查（CLI / LLM 須帶明確 consent 避免誤查）
- 加權仍按 manual > promoted > auto；跨專案結果不因此打折（保留使用者判斷）
- `search_feedback` 寫入時 `query_project_id` 記呼叫者當前 project，`result_project_ids` 記實際命中
- 對應 Goal 3 + Hard Constraint「跨 session / 跨專案 / 跨電腦」（原 spec.md Goal 1）

---

## Non-goals（v0.4 明確不做）

- ❌ `observations` 表（細粒度 atom）— 留 Stage 2
- ❌ 從 claude-mem SQLite / chroma 匯入歷史資料（2,673 summaries + 7,313 observations）— 併用期不做，取代 claude-mem 後才討論
- ❌ Batch tag refine 操作 — 留 Stage 2
- ❌ 自動推薦 refine 候選（LLM 找出該 merge / 該 delete 的項目）— 留 Stage 2
- ❌ HTTP REST API / Telegram bot / thumbs feedback — 原 Phase B 整塊放棄
- ❌ 調整 claude-mem 或 fork claude-mem — 原樣併用，v0.4 結束後再決定
- ❌ Multi-session concurrency 最佳化（多 Claude Code 同時跑同一 project）— MVP 用 idempotency_key 處理衝突即可

---

## Scope 摘要

| 模組 | 範圍 | 階段 |
|---|---|---|
| Schema | 新增 `session_summaries` 表 + 必要索引 + `refine_audit_log` | v0.4 |
| Capture pipeline | `Stop` hook → capture-runner（SKIP_TOOLS 過濾 + 節流 + Claude CLI 摘要 + upsert） → MCP `cc_memory_save_summary` | v0.4 |
| LLM provider | Claude CLI subprocess（`claude -p --output-format json --model <model>`），吃 subscription；**不用 Anthropic API**；**不用 Gemini LLM** | v0.4 |
| Embedding provider | Gemini `text-embedding-004`（現有 Phase A 已建，`vector(768)`，~$0.01/月成本，不動） | 沿用 |
| Re-inject pipeline | `SessionStart(startup\|clear\|compact)` hook → 拉近 N 筆 summary + M 筆 manual/promoted → 透過 `additionalContext` 注入 | v0.4 |
| Retrieval 擴展 | `cc_memory_search` 跨表查、跨專案 `project_ids` 參數、加權（manual > promoted > auto） | v0.4 |
| Refine tools (MCP) | `cc_memory_refine_delete` / `_promote` / `_merge` / `_edit` | v0.4 |
| Refine CLI | `scripts/refine.ts`（條件過濾批次處理） | v0.4 |
| Benchmark harness | 固定 5 query + 真實 5 query 的跑分 + 錯抓率人工標註 | v0.4 |
| `observations` 細粒度 (PostToolUse) | — | Stage 2（Future Roadmap） |
| 歷史 import | — | 品質閘過後 |

---

## Constraints

1. **不回歸**：現有 248 tests 全綠，v0.4 不得造成任何既有測試失敗
2. **Precision-first**：寧漏抓不要錯抓；capture-runner 的 Claude CLI call 失敗時寫 queue 不強寫 DB
3. **LLM 摘要走 Claude CLI subprocess**：不呼叫 Anthropic API、不呼叫 Gemini LLM API；只走 `claude -p --output-format json --model <model>` 的 subprocess。前提是使用者的機器已登入 Claude CLI 並有 Pro/Max subscription
4. **Embedding 獨立走 Gemini**：`text-embedding-004` 只給 embedding，與 LLM 摘要 provider 完全解耦；`GEMINI_API_KEY` 在 MCP env 保留
5. **SKIP_TOOLS 過濾（節流第 0 關）**：上一輪若僅使用指定清單內的工具（預設：`ListMcpResourcesTool, SlashCommand, Skill, TodoWrite, AskUserQuestion`，抄自 claude-mem 10.5.2），runner 直接 exit 不摘要。env `CC_MEMORY_SKIP_TOOLS`（逗號分隔）可覆蓋
6. **Stop hook 雙節流是硬要求**：過 SKIP_TOOLS 後還要過 min-interval（預設 180s）+ min-delta-tokens（預設 500），任一不過即跳過
7. **同 session upsert 原則**：同 `session_id` 永遠只有一筆 active canonical summary，後寫覆蓋前寫（不存歷史版本，避免 retrieval 污染）
8. **Idempotency**：同 transcript 狀態算出同 `idempotency_key` → DB 層 UNIQUE 擋重複；upsert 流程下主要是 `session_id` + `project_id` 定位，idempotency_key 是 backup
9. **加權數字可調**：manual / promoted / auto 的 score multiplier 寫在 env 或 config，不硬寫在 SQL
10. **Feature flag（3 個獨立）**：`CC_MEMORY_AUTO_CAPTURE`（預設 `off`，opt-in 採集）；`CC_MEMORY_INCLUDE_AUTO_IN_SEARCH`（預設 `on`，異常可退）；`CC_MEMORY_REINJECT`（預設 `off`，opt-in 注入）
11. **跨電腦穩定**：`writer_host` 必填，與現有 `project_memories` 一致
12. **Hook 失敗不阻塞 Claude Code**：capture / re-inject 出錯只寫 log + queue，不噴錯訊息干擾使用者；Hook wrapper `set +e`

---

## Design Principles

1. **抄 claude-mem 能抄的，不重發明**：
   - Prompt spec 直接用 `code.json`
   - Hook 事件選擇（`Stop` + `SessionStart(compact)`）照 claude-mem 10.5.2 實測配置
   - **LLM provider = Claude CLI**（抄 `CLAUDE_MEM_PROVIDER=claude` + `CLAUDE_MEM_CLAUDE_AUTH_METHOD=cli`）
   - **SKIP_TOOLS 清單**抄 `CLAUDE_MEM_SKIP_TOOLS` 預設值
   - 不發明新路，讓「CC-memory 取代 claude-mem」的品質閘能公平對比（同 LLM、同 prompt）
2. **兩表並存，不合表**：`project_memories`（curated）和 `session_summaries`（auto）分表，避免 schema 相互污染；只在 retrieval 層統一
3. **同 session 一筆 canonical（upsert 覆蓋）**：不保留 session 進行中的中間版本，避免「同主題多筆接近內容」污染 retrieval top-K
4. **Push + Pull 雙模召回**：Pull = Claude 主動叫 `cc_memory_search`；Push = `SessionStart` 注入近 N 筆。兩者可獨立開關，預設採集 opt-in、注入 opt-in
5. **Refine 是一級使用者動作**，不是「事後工具」— 介面品質要和 save / search 同等
6. **LLM 可呼叫 + 人類可批次**：MCP tool（LLM 場景）+ CLI（批次場景）並行，同一 DB 操作

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code session                                             │
│                                                                  │
│  ┌─────────────┐    ┌──────────────────┐   ┌───────────────────┐ │
│  │ Stop hook   │    │ SessionStart     │   │ additionalContext │ │
│  │ (每輪對話   │    │ (startup|clear|  │──▶│ injected into     │ │
│  │  結束觸發)  │    │  compact)        │   │ Claude's context  │ │
│  └──────┬──────┘    └────────┬─────────┘   └───────────────────┘ │
│         │                    │                                   │
│         ▼                    ▼                                   │
│  ┌───────────────┐    ┌──────────────────────┐                   │
│  │ capture-      │    │ reinject-runner.ts   │                   │
│  │ runner.ts     │    │  • load recent       │                   │
│  │  • SKIP_TOOLS │    │    summaries (N)     │                   │
│  │    filter     │    │  • load recent       │                   │
│  │  • throttle   │    │    manual/promoted   │                   │
│  │    check      │    │    (M)               │                   │
│  │  • read       │    │  • format as         │                   │
│  │    transcript │    │    additionalContext │                   │
│  │  • spawn      │    └──────────┬───────────┘                   │
│  │    Claude CLI │◀──────┐       │                               │
│  │    (subproc)  │       │       │                               │
│  │  • Gemini     │       │       │                               │
│  │    embed only │◀── Gemini API (embedding 768-dim) ─           │
│  │  • upsert     │                                               │
│  └───────┬───────┘                                               │
│          │                                                       │
└──────────┼───────────────────────┼───────────────────────────────┘
           ▼                       │
   ┌─────────────────┐             │
   │ MCP cc_memory_  │             │
   │ save_summary    │             │
   │ (upsert by      │             │
   │  session_id)    │             │
   └────────┬────────┘             │
            ▼                      │
   ┌────────────────────────┐      │
   │ PostgreSQL (Zeabur)    │◀─────┘ (read)
   │ • project_memories     │
   │ • session_summaries    │ NEW
   │ • refine_audit_log     │ NEW
   │ • search_feedback      │
   └──────────┬─────────────┘
              ▲
              │
   ┌──────────┴──────────────┐     ┌────────────────────────────┐
   │ cc_memory_search        │     │ Refine layer                │
   │  • cross-table          │     │  MCP:                       │
   │  • cross-project        │     │   cc_memory_refine_delete   │
   │    (project_ids[])      │     │   _promote / _merge / _edit │
   │  • weighted rerank      │     │  CLI: scripts/refine.ts     │
   │    (manual>promoted>auto)│    │   (同操作 + 批次過濾)       │
   └─────────────────────────┘     └─────────────────────────────┘
```

### 元件職責

| 元件 | 路徑 | 職責 | 相依 |
|---|---|---|---|
| capture-runner | `scripts/capture-runner.ts` | SKIP_TOOLS 過濾 → 節流檢查 → 讀 transcript → spawn Claude CLI 抽摘要 → Gemini embed summary → MCP upsert；失敗寫 queue | Claude CLI（subscription）、Gemini embedding API、`code.json`、MCP server、state/queue dir |
| LLM caller | `src/llm/claude-cli.ts` | 封裝 `spawn claude -p ... --output-format json --model <m>`，處理 timeout / retry / stdout parse；輸入 prompt + transcript，輸出 JSON | Node `child_process`、Claude CLI binary |
| Embedder | `src/llm/gemini-embed.ts` | 封裝 Gemini `text-embedding-004` 呼叫（Phase A 已有，沿用） | Gemini API、`GEMINI_API_KEY` |
| reinject-runner | `scripts/reinject-runner.ts` | 查近 N 筆 summary + 近 M 筆 manual → 輸出 hook protocol JSON（`additionalContext`）| DB via MCP |
| hook wrappers | `hooks/stop-capture.sh`、`hooks/session-start-reinject.sh` | 呼叫對應 runner、錯誤吞掉 | runners |
| MCP `cc_memory_save_summary` | `src/tools/save-summary.ts` | 驗 input → upsert `session_summaries`（以 `(project_id, session_id)` 為 key） | DB |
| MCP `cc_memory_search`（擴展） | `src/tools/search.ts` | 跨兩表 candidate fetch、跨專案（`project_ids[]`）、加權 rerank | DB、config |
| MCP `cc_memory_recent_summaries` | `src/tools/recent-summaries.ts` | reinject 專用 read 端點：按 `updated_at` DESC 取近 N 筆 active | DB |
| MCP refine tools | `src/tools/refine-*.ts` | delete / promote / merge / edit（每個一個檔） | DB |
| Refine CLI | `scripts/refine.ts` | 條件過濾 + 批次呼叫 MCP tools | MCP client |
| Per-session state | `~/.cc-memory/state/<session_id>.json` | 記錄本 session 上次摘要時間、上次 transcript hash、累積 summarize 次數、上一輪工具清單 | fs |

---

## Data Model

### 新表：`session_summaries`

```sql
CREATE TABLE session_summaries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        text NOT NULL,
  session_id        text,                                  -- claude-code session uuid（Stop hook 穩定取得；若取不到 → 視為單次性 row）
  summary           text NOT NULL,
  keywords          text[] NOT NULL DEFAULT '{}',
  decisions         text[] NOT NULL DEFAULT '{}',
  next_steps        text[] NOT NULL DEFAULT '{}',
  capture_source    text NOT NULL,                         -- MVP only: 'auto-stop-hook'
  capture_hook      text NOT NULL,                         -- MVP only: 'stop'
  summarize_count   int  NOT NULL DEFAULT 1,               -- 本 session 累計摘要次數（upsert 時 ++）
  promoted_to_memory_id uuid,                              -- FK → project_memories.id（promote 後填）
  embedding         vector(768),                           -- Gemini text-embedding-004 維度
  writer_host       text NOT NULL,
  idempotency_key   text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'active',        -- CHECK in ('active', 'archived')
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,    -- 診斷資訊：last_transcript_hash、llm_provider、llm_model（如 `claude-sonnet-4-5`）、embed_model（`text-embedding-004`）、last_tools（上輪 tools list，SKIP_TOOLS 判斷用）
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT capture_source_chk CHECK (capture_source IN ('auto-stop-hook')),
  CONSTRAINT capture_hook_chk   CHECK (capture_hook IN ('stop')),
  CONSTRAINT status_chk         CHECK (status IN ('active', 'archived'))
);

-- 索引
CREATE INDEX ss_project_active_idx    ON session_summaries (project_id, updated_at DESC) WHERE status = 'active';
CREATE INDEX ss_session_idx           ON session_summaries (project_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ss_keywords_gin          ON session_summaries USING gin (keywords);
CREATE INDEX ss_embedding_hnsw        ON session_summaries USING hnsw (embedding vector_cosine_ops);
-- 同 project_id + session_id 只能有一筆 active（upsert 的核心保證）
CREATE UNIQUE INDEX ss_active_per_session_uniq
  ON session_summaries (project_id, session_id)
  WHERE status = 'active' AND session_id IS NOT NULL;
```

#### 欄位說明

| 欄位 | 說明 |
|---|---|
| `session_id` | Claude Code session uuid（Stop hook env 應穩定提供）；若取不到 → 寫單次性 row（session_id 留 null，不走 upsert） |
| `capture_source` | MVP 實寫 `auto-stop-hook`；欄位+CHECK 為 Stage 2（如 `observations-extract`）保留擴充空間 |
| `capture_hook` | MVP 實寫 `stop`；同上為 Stage 2 擴充 |
| `summarize_count` | 本 session 被摘要幾次（每次 Stop 通過節流並 upsert 時 +1）；觀察觸發頻率與品質相關性 |
| `promoted_to_memory_id` | Promote 不搬表；`project_memories` 插新 row、此欄記錄對應；retrieval 時升至 promoted 權重 |
| `idempotency_key` | `sha256(project_id + session_id + last_transcript_hash)`；upsert 流程下主要靠 `(project_id, session_id)` unique 定位，本欄作 backup |
| `status` | MVP 僅 `active` / `archived`（refine delete 用）。upsert 直接 UPDATE 同一列，不產生歷史 row |

#### `session_id` 取不到的降級策略

Claude Code `Stop` hook 正常情況下 env 提供 session uuid。若極少數取不到：
1. runner 日誌記錄 warning
2. 寫入的 row `session_id = NULL` → **不走 upsert**（partial unique index 對 NULL 不作用），每次都 INSERT 新 row
3. 這種 row 進 retrieval 但不被 reinject 模組拉取（reinject 只撈有 session_id 的 canonical）
4. 若 runner 連續 `CC_MEMORY_MAX_NULL_SESSION_STREAK`（預設 5）次取不到 → exit 並寫 `.dead` 標記，避免雜訊塞滿 DB

### `project_memories` 補欄

```sql
ALTER TABLE project_memories
  ADD COLUMN source_summary_id uuid REFERENCES session_summaries(id);  -- Promote 時填，用於回溯
```

---

## Capture Pipeline

### Hook 事件選擇理由

採 claude-mem 10.5.2 實測配置的 `Stop` hook，**不用** `SessionEnd`（`/quit`、terminal force-kill 等不保證給 hook 時間）或 `PreCompact`（context 已到壓縮邊緣才觸發，時機太晚）。

### Stop hook 流程

```
1. Claude Code 每輪對話結束 → Stop hook 觸發 hooks/stop-capture.sh
2. stop-capture.sh 設 `set +e`，呼叫 capture-runner.ts（錯誤吞掉）
3. capture-runner.ts：
   a. 讀 env：$CLAUDE_SESSION_ID, $CLAUDE_TRANSCRIPT_PATH, $CLAUDE_PROJECT_DIR
   b. 若 CC_MEMORY_AUTO_CAPTURE=off → exit 0
   c. 讀 ~/.cc-memory/state/<session_id>.json（無 → 視為新 session）：
        { last_summary_at, last_transcript_hash, summarize_count, null_session_streak, last_tools }
   d. **SKIP_TOOLS 過濾（節流第 0 關）**：
      - 從 transcript 抽本輪實際用到的 tool 清單
      - 若 tool 集合 ⊆ CC_MEMORY_SKIP_TOOLS（預設 claude-mem 清單）→ exit 0
      - 更新 state.last_tools（供下次診斷）
   e. 節流檢查（兩門檻任一不過即 exit 0）：
      - now - last_summary_at >= CC_MEMORY_STOP_MIN_INTERVAL_SEC（預設 180s）
      - tokens(transcript_delta since last_summary) >= CC_MEMORY_STOP_MIN_DELTA_TOKENS（預設 500）
   f. 讀 transcript（size cap：> 2MB 截尾取 head 500KB + tail 1MB，保留意圖 + 近期）
   g. 算 transcript_hash + idempotency_key = sha256(project_id + session_id + transcript_hash)
   h. 載 code.json prompt（mode=code）
   i. **spawn Claude CLI subprocess**（見下「Claude CLI 呼叫」）：
      - `claude -p "<prompt+transcript>" --output-format json --model $CC_MEMORY_CLAUDE_MODEL`
      - timeout 60s（CLI spawn 比直 API 慢）、retry 3 次指數退避
      - 失敗 → 寫 ~/.cc-memory/capture-queue/<idempotency_key>.json + log，exit 0
   j. parse stdout JSON（照 code.json XML 範本預期格式）
   k. **Gemini embed summary**（獨立一步，Phase A 現有機制）：
      - call Gemini `text-embedding-004` → 768-dim vector
      - 失敗 → 寫 row 但 embedding=NULL，稍後 refine edit 觸發重 embed
   l. 呼叫 MCP cc_memory_save_summary（見下「Upsert 行為」）
   m. 成功 → 更新 state 檔（last_summary_at=now、last_transcript_hash、++summarize_count）
   n. 刪 queue 檔（若有）
4. Queue resume：runner 啟動前先掃 ~/.cc-memory/capture-queue/，各自 retry（上限 attempts=5 → `.dead`）
```

### Claude CLI 呼叫（封裝在 `src/llm/claude-cli.ts`）

```typescript
// 概念示意
const child = spawn('claude', [
  '-p', promptWithTranscript,
  '--output-format', 'json',
  '--model', env.CC_MEMORY_CLAUDE_MODEL ?? 'claude-sonnet-4-5',
], { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });

// 收 stdout → parse JSON → 驗 schema → return
// 非零 exit code / timeout / parse 失敗 → throw，由 runner 寫 queue
```

**為何用 `claude -p`（subprocess）而非 Claude Code SDK / Anthropic API**：
- 吃 subscription 配額，不另外花 API 錢（核心原則）
- claude-mem 10.5.2 實測配置（`CLAUDE_MEM_CLAUDE_AUTH_METHOD=cli`）已驗證此路可行
- Node SDK / API 都需要 API key，和「不花錢」原則相衝

**子程序不會循環觸發 hook**：`claude -p` 是 print mode（非互動 session），Claude Code hooks 不掛在 print 模式上。claude-mem 10.5.2 的實戰證明無遞迴問題。

### SKIP_TOOLS 過濾（抄 claude-mem）

**預設跳過清單**（`CC_MEMORY_SKIP_TOOLS` env，逗號分隔）：

```
ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion
```

**判斷邏輯**：
- 從 transcript 的最近一組 assistant turn 抽「實際呼叫過的 tool name 集合」
- 若集合 ⊆ SKIP_TOOLS（純工具輪次、沒有程式碼 / 檔案 / 對話產出）→ 不摘要
- 若集合有 SKIP_TOOLS 外的 tool（Edit / Write / Bash / 或純對話）→ 進入節流檢查

**範例**：
- 本輪只叫 `TodoWrite` → SKIP
- 本輪叫 `Skill(deep-research)` → SKIP
- 本輪叫 `Edit + Bash + Read` → 不 SKIP、進節流
- 本輪純文字對話（無 tool call）→ 不 SKIP、進節流

**擴充彈性**：env 可加自定 tool name（例如你寫的某個耗資源 MCP tool，不希望每次呼叫都摘要）。

### Upsert 行為（`cc_memory_save_summary` 實作）

- Input：`{ project_id, session_id, summary, keywords, decisions, next_steps, writer_host, idempotency_key, embedding, metadata }`
- 邏輯（pseudocode）：
  ```
  IF exists row WHERE project_id=$1 AND session_id=$2 AND status='active':
      UPDATE summary=$3, keywords=$4, ..., embedding=$N,
             summarize_count = summarize_count + 1,
             updated_at = now(),
             idempotency_key = $K
      WHERE project_id=$1 AND session_id=$2 AND status='active'
      RETURNING id
  ELSE IF session_id IS NULL:
      INSERT ... (不走 upsert 避免 null collision)
  ELSE:
      INSERT ... (首次摘要本 session)
  ```
- `idempotency_key` UNIQUE 衝突（完全相同的 transcript_hash 重跑）→ 回 409，runner 視為成功（state 也不再寫，因無變動）

### Queue resume 設計

- 位置：`~/.cc-memory/capture-queue/`
- 檔名：`<idempotency_key>.json`
- 內容：`{project_id, session_id, transcript_snapshot_path, capture_hook, timestamp, attempts}`
- 每次 hook 觸發 runner 時，**先掃 queue 重試舊的，再處理當下**
- attempts ≥ 5 → 改名 `.dead` 放棄、log
- 不處理 claude-mem 10,000+ 筆歷史 import（非 v0.4 scope）

### Per-session state 檔

- 位置：`~/.cc-memory/state/<session_id>.json`
- 內容：
  ```json
  {
    "last_summary_at": "2026-04-22T14:02:31Z",
    "last_transcript_hash": "sha256:...",
    "summarize_count": 3,
    "null_session_streak": 0
  }
  ```
- session_id null 的 row 不產生 state 檔（無 key 可 index）
- 清理策略：session_id 對應 row 若被 refine delete 且無其他 row → CLI `refine` 可選擇同步刪 state 檔；MVP 不自動清

---

## SessionStart Re-inject Pipeline

### 觸發時機

`SessionStart` hook，matcher = `startup|clear|compact`：
- **startup**：開新 Claude Code session
- **clear**：使用者輸入 `/clear`
- **compact**：使用者 `/compact` 或 auto-compact 完成後 re-build context

### 流程

```
1. hooks/session-start-reinject.sh 被觸發（set +e）
2. reinject-runner.ts：
   a. 讀 env：$CLAUDE_PROJECT_DIR（解出 project_id）、$CLAUDE_SESSION_ID（新 session）
   b. 若 CC_MEMORY_REINJECT=off → exit 0（空 stdout，不注入）
   c. 呼叫 MCP cc_memory_recent_summaries(project_id, limit=N)
      - N = CC_MEMORY_REINJECT_SUMMARIES（預設 5）
      - 排序：updated_at DESC，status='active'，session_id IS NOT NULL
   d. 呼叫 MCP cc_memory_list(project_id, limit=M, status='active')
      - M = CC_MEMORY_REINJECT_MANUAL（預設 3）
      - 只拉 manual + promoted（project_memories 全是，不需額外過濾）
   e. 格式化成 Claude Code hook 規範的 additionalContext JSON
   f. 寫到 stdout（Claude Code 會解析並注入 context）
3. 失敗 / 空結果 → stdout 空，不影響 session 啟動
```

### 注入格式（Claude Code hook protocol）

stdout 輸出 JSON，Claude Code 解析後將 `additionalContext` 塞進 session context：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "## CC-memory: Recent context (cc-memory project)\n\n### Manual / promoted memories (curated)\n\n- [mem-abc123] 2026-04-20: <summary>\n  Keywords: X, Y, Z\n  Decisions: ...\n\n### Recent session summaries (auto, latest 5)\n\n- [ss-def456] 2026-04-22 14:02: <summary>\n  Next steps: ...\n..."
  }
}
```

實際 JSON 欄位以 Claude Code 官方 hook protocol 文件為準（實作時 context7 查 `anthropics/claude-code` 最新規格確認）。

### Re-inject vs Pull 對比

| 維度 | Re-inject (push) | cc_memory_search (pull) |
|---|---|---|
| 觸發 | SessionStart 一次 | Claude 隨時主動呼叫 |
| 內容 | 固定近 N + 近 M 筆 | 語意相關 top-K |
| 成本 | 每 session start 一次 DB read | 每次 search 一次 |
| 精準度 | 低（不看當前 prompt） | 高（看 query） |
| 價值 | Claude 不必主動搜也有基礎記憶 | 動態、精準 |

兩者互補，都開啟時 Claude 有一層「啟動時的常識」+ 一層「需要時的精確查找」。

---

## Retrieval Integration

### `cc_memory_search` 擴展行為

原 `cc_memory_search` 只查當前 project 的 `project_memories`。擴展後：

```
input: {
  query,
  project_id?,                         -- 省略則從 cwd 解析（既有行為）
  project_ids?: string[],              -- NEW：跨專案；優先級 > project_id
  mode: 'semantic'|'keyword'|'hybrid',
  limit,
  include_auto?: bool,                 -- 預設 true
}

1. 決定要查的 project 集合（project scope）：
   - project_ids=['*'] → ALL（全 project；CLI / LLM 須 explicit，LLM 應先向使用者確認）
   - project_ids=[A,B] → 該集合
   - project_id='X'    → [X]
   - 都沒給           → 從 cwd 解析的當前 project
2. 若 include_auto=false 或 CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off
   → 只查 project_memories（在上述 project scope），return
3. 否則：
   a. 平行查 project_memories + session_summaries（status='active'，過濾同 project scope）
   b. 算 score：
      - project_memories.base_score                               × W_MANUAL  (default 1.0)
      - session_summaries WHERE promoted_to_memory_id IS NOT NULL  × W_PROMOTED (default 0.85)
      - session_summaries (rest)                                   × W_AUTO    (default 0.65)
   c. 合併取 top-K（K = limit）
   d. 結果每筆標 `project_id` 欄位（跨專案查詢時 LLM / 使用者能分辨來源）
   e. 寫 search_feedback：
      - `query_project_id` = 呼叫者當前 project
      - `result_project_ids` = 實際命中 project 集合
      - `result_source_breakdown` JSON = 每 rank 對應 manual/promoted/auto
```

### 為何不再需要「同 session dedupe」

因 Stop hook 採 upsert、同 `project_id + session_id` 只能有一筆 active（partial unique index 保證），retrieval 不會撈到同 session 多筆。若 `session_id IS NULL` 的 orphan row 存在，本來就視為獨立記憶（不折疊）。

### 加權設計

- **環境變數可調**：`CC_MEMORY_WEIGHT_MANUAL` / `_PROMOTED` / `_AUTO`
- **預設值**：1.0 / 0.85 / 0.65
  - 差距 0.15 是刻意的：太大會讓 promoted 永遠打不過 manual（失去 promote 意義）；太小 auto 會污染頂端
  - v0.4 啟用後用 benchmark 跑分調整，寫回 spec update
- **加權前提**：base_score 已 normalize 到 [0, 1]（semantic cosine sim 和 keyword BM25 各自 normalize）

### `search_feedback` 擴展

既有表加一欄 `result_source_breakdown jsonb`，記每筆 result 是來自 manual / promoted / auto，供事後分析「用戶點了哪類結果」。這欄在 v0.4 寫入但不消費（消費是未來 Stage 的事）。

---

## Refine Tools

### MCP Tools（LLM 呼叫）

#### `cc_memory_refine_delete`

```
input: { id: uuid, table: 'session_summaries' | 'project_memories', reason?: text }
action:
  - 將 row 的 status 改為 'archived'（軟刪除，沿用既有慣例）
  - log 到 refine_audit_log（見下）
output: { ok: true, archived_at }
```

#### `cc_memory_refine_promote`

```
input: { summary_id: uuid, overrides?: { summary?, keywords?, decisions? } }
action:
  - 從 session_summaries 讀該筆
  - overrides 優先，否則用原內容
  - 在 project_memories 插新 row（writer_host = current host + `(promoted)`）
  - 設 project_memories.source_summary_id = summary_id
  - 設 session_summaries.promoted_to_memory_id = new_memory_id
  - log 到 refine_audit_log
output: { ok: true, memory_id }
```

#### `cc_memory_refine_merge`

```
input: { source_ids: uuid[], target_table: 'session_summaries' | 'project_memories',
         merged: { summary, keywords, decisions, next_steps? } }
action:
  - 驗 source_ids 全部屬同 project_id、同 table
  - 在 target_table 插新 row（writer_host = current host + `(merged-from-N)`）
  - source_ids 的 status 改 'archived'，metadata 加 {merged_into: new_id}
  - log 到 refine_audit_log
output: { ok: true, merged_id }
```

**為何 merge 走「新插 + 舊 archive」而非「改其中一筆」**：保留歷史、retrieval 只打到 active、還能 undo（把 archived 的改回 active + 刪 merged_id）。

#### `cc_memory_refine_edit`

```
input: { id: uuid, table: 'session_summaries' | 'project_memories',
         patch: { summary?, keywords?, decisions?, next_steps? } }
action:
  - UPDATE 該 row 指定欄位，updated_at 更新
  - 若有 embedding 欄位且 summary 或 keywords 被改 → 重算 embedding
  - log 到 refine_audit_log
output: { ok: true, updated_at }
```

### Refine Audit Log

```sql
CREATE TABLE refine_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation   text NOT NULL,       -- delete/promote/merge/edit
  actor       text NOT NULL,       -- 'mcp' | 'cli' | writer_host
  target_ids  uuid[] NOT NULL,
  payload     jsonb NOT NULL,      -- 完整 input + before/after snapshot
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ral_created_idx ON refine_audit_log (created_at DESC);
```

### CLI：`scripts/refine.ts`

```
npx tsx scripts/refine.ts <op> [options]

ops:
  delete   --where 'created_at < $1' --params 2026-04-01
  delete   --ids id1,id2,id3
  promote  --id <uuid>
  merge    --ids id1,id2 --summary "..." --keywords a,b
  edit     --id <uuid> --summary "..."
  list     --where 'status=$1 AND project_id=$2' --params active,cc-memory --limit 20  (read-only)
  audit    --since 2026-04-20                                                           (read refine_audit_log)

通用 flags:
  --dry-run     不動 DB，只印要做什麼
  --yes         跳過確認
  --project     指定 project_id（預設從 cwd 解析）
```

CLI 背後呼叫 MCP server 用 stdio（或直接 import tool handler），行為和 MCP tool 完全一致。

---

## Error Handling

| 情境 | 行為 |
|---|---|
| SKIP_TOOLS 命中（本輪純工具） | exit 0，不摘要、不更新 last_summary_at |
| Stop hook 節流未達門檻 | exit 0，不 spawn Claude CLI、不寫 DB |
| session_id 從 env 取不到 | 寫 null session_id row；若連續 ≥ `CC_MEMORY_MAX_NULL_SESSION_STREAK`（預設 5） → log + `.dead` 標記 + exit |
| **Claude CLI 不存在 / 未認證** | 首次偵測 → log error + 寫 `.cc-memory/state/claude-cli-missing.flag` + exit 0；後續 runner 先檢查 flag，直接 skip（避免每輪都測） |
| **Claude CLI subprocess 失敗**（exit code 非 0 / timeout / stdout 非 JSON） | Retry 3 次指數退避 → 仍失敗 → 寫 queue + log + exit 0 |
| **Claude CLI 配額超限**（輸出含特定錯訊） | 識別後寫 queue 並設 `quota-exceeded.flag`（含時戳），下次 runner 先看 flag，若 < 1 小時前 → skip；超過 1 小時 → 刪 flag 重試 |
| Gemini embedding API 失敗 | log warning，row 仍寫入但 embedding=NULL；下次 refine edit 觸發重 embed |
| MCP server 不在線 | capture-runner 寫 queue；refine tools 直接 error 回 LLM/CLI |
| DB 連線失敗 | 同上寫 queue |
| Transcript 讀不到 | Log warning，exit 0（不抓不報錯） |
| Idempotency key 衝突 | DB 層 UNIQUE 擋，MCP 回 409，runner 視為成功（本就重跑） |
| Hook 本身 bash 出錯 | hook wrapper `set +e`，錯誤吞掉 + log，不阻塞 Claude Code |
| Claude CLI 回傳無法 parse | Log raw response + exit 0（不寫 DB、不寫 queue，避免死循環） |
| Reinject MCP 查詢失敗 | stdout 空 → Claude Code 視為無 additionalContext，session 正常啟動 |
| Reinject 結果為空（無記憶可注入） | stdout 空，不注入佔位字串 |
| Refine delete 對已 archived row | 回 409（冪等：第二次 delete 視為成功但 noop） |
| Refine promote 對已 promoted summary | 回 409（不重複 promote） |
| Refine merge source_ids 不同 project | 回 400 |

---

## Testing Strategy

### 分層

1. **Unit**
   - capture-runner SKIP_TOOLS：mock transcript 只含 TodoWrite → 驗 skip；混 Edit → 驗 proceed
   - capture-runner 節流：mock state + transcript → 驗 skip / proceed 判斷正確
   - claude-cli caller：mock `child_process.spawn` → 驗 args 組裝、stdout parse、timeout 處理、retry 邏輯
   - claude-cli missing / quota flag：mock flag 檔 → 驗 runner 正確 skip
   - idempotency_key 算法、queue 寫入路徑
   - Upsert 邏輯：mock DB session → 驗首次 INSERT、二次 UPDATE（summarize_count++、updated_at 更新、embedding 重算）
   - Gemini embedding 失敗：mock API error → 驗 row 仍寫入、embedding=NULL
   - Reinject-runner：mock MCP → 驗 stdout JSON 格式符合 Claude Code hook protocol
   - Refine tools：mock DB、驗狀態轉換、驗 audit log 寫入
   - Retrieval 加權：固定 candidate 輸入 → 驗 score × multiplier
   - Retrieval 跨專案：`project_ids=['A','B']` 結果集正確標註
2. **Integration**（沿用現有 test DB 配置：local PG for dev，CI 用 ephemeral schema；不打 Zeabur production DB）
   - capture-runner 真跑一次 transcript fixture → 驗 DB 有對應 row
   - 同 session 跑兩輪 Stop hook（transcript 有新增） → 驗 DB 只有一筆 active（upsert）、summarize_count=2
   - 節流未過門檻重跑 → 驗 DB 無變動、無新 row
   - session_id=null 路徑 → 驗獨立 INSERT、不與其他 null collide
   - Reinject 整鏈：插 5 筆 summary + 3 筆 manual → reinject-runner stdout 含所有 8 筆
   - Refine 四操作各一個 happy path + 邊界 case
3. **E2E**
   - 模擬 Claude Code `Stop` hook 觸發（直接呼叫 hook wrapper）→ 驗整鏈到 DB
   - 模擬 `SessionStart(matcher=compact)` 觸發 → 驗 stdout additionalContext 有內容
   - Feature flag `AUTO_CAPTURE=off` → 驗不寫入；`REINJECT=off` → 驗 stdout 空
4. **Benchmark**（Go/No-Go 用）
   - 固定 5 query + 真實 5 query 集（fixture 檔）
   - 對比 CC-memory `cc_memory_search(include_auto=true)` vs `claude-mem` 的結果
   - 人工標註每個結果「相關 / 不相關」→ 算錯抓率

### 目標

- Unit + Integration 新增 ≥ 40 tests（本期全綠）
- 原 248 tests 不回歸
- Benchmark harness 可重複跑、每次產出 `docs/benchmark-<date>.md`

---

## Success Criteria

### 功能完備（v0.4 交付必過）

- [ ] `session_summaries` + `refine_audit_log` migrate 成功；現有 248 tests 綠
- [ ] `Stop` hook 實測觸發，transcript → DB upsert 端到端通
- [ ] 同 session 跑兩輪 Stop（transcript 有新增） → DB 只有一筆 active、summarize_count=2
- [ ] 節流驗證：兩輪 Stop 間隔 < min-interval 且 delta < min-tokens → 第二輪不寫入
- [ ] `SessionStart(startup|clear|compact)` 實測觸發、stdout JSON 符合 hook protocol、context 注入生效
- [ ] `cc_memory_search(include_auto=true)` 能回傳跨表結果，加權排序符合 manual > promoted > auto
- [ ] `cc_memory_search(project_ids=['A','B'])` 能跨兩個 project 查，結果標註 project_id
- [ ] 四個 refine MCP tools 各一條 integration test 通
- [ ] `scripts/refine.ts` list / delete / promote / merge / edit / audit 都能跑
- [ ] Queue resume 驗證：斷網跑 capture → 恢復後能補寫
- [ ] 三個 feature flag（AUTO_CAPTURE / INCLUDE_AUTO / REINJECT）off 時各自行為符合預期

### 品質閘（claude-mem 切換 Go/No-Go）

> 以下三項 AND 條件全滿足才停用 claude-mem。

- [ ] **Top-5 交集**：10 組 benchmark query（真 5 + 固 5），每組 CC-memory top-5 與 claude-mem top-5 交集 ≥ 3 筆，至少 7/10 組達標
- [ ] **人工命中度**：抽樣 10 組 query，人工標「第一個相關結果出現的 rank」（1 = 首位，未命中 = rank=∞ 記為 11）；CC-memory 平均 rank ≤ claude-mem 平均 rank
- [ ] **錯抓率**：人工檢視最近 50 筆 auto session_summaries（`capture_source='auto-stop-hook'` 且 `promoted_to_memory_id IS NULL`），錯抓（不該抓）比例 < 10%

### 觀察窗

- 併用 claude-mem 至少 **2 週 + 累積 ≥ 30 筆 session_summaries**（兩條件都要）才跑品質閘
- 品質閘不過 → 分析原因，v0.5 再嘗試；claude-mem 繼續跑

---

## 端對端驗收

### Capture

- [ ] A 機器實際跑一輪對話（`claude -p "..."` 或互動）→ Stop hook 觸發 → B 機器 `cc_memory_search` 能查到該 session summary，`writer_host` 顯示 A
- [ ] 長 session 跑 N 輪對話 → `session_summaries` 只有一筆 active（同 session_id）、`summarize_count=N` 或更少（節流跳過的不算）
- [ ] `CC_MEMORY_AUTO_CAPTURE=off` 重跑 → DB 無新 row、state 檔無更新
- [ ] 斷網跑 capture → `~/.cc-memory/capture-queue/` 有一筆 → 連網重觸 hook → queue 清空、DB 有 row

### Re-inject

- [ ] `/clear` 或 `/compact` 觸發 → 新 context 包含近 5 筆 summary + 近 3 筆 manual（檢查 Claude 自己的 recollection 或輸出調試 log）
- [ ] `CC_MEMORY_REINJECT=off` 時 `/clear` → 新 context 不含注入記憶
- [ ] 空 project（無任何記憶）→ reinject-runner stdout 空，session 正常啟動

### Retrieval

- [ ] `cc_memory_search` 同 query 分別跑 `include_auto=true` / `false`，結果差異符合加權（manual 排第一穩定）
- [ ] 手動 `cc_memory_save` 一筆 + 自動抓一筆同主題 → search 時 manual 排前
- [ ] Promote 一筆 auto summary → 同 query 再查，該筆排名上升（因加權從 0.65 → 0.85）
- [ ] `cc_memory_search(project_ids=['CC-memory', 'AI_Copilot'])` 能回傳兩 project 混合結果，每筆標 `project_id`

### Refine

- [ ] MCP `cc_memory_refine_delete` 一筆 auto summary → retrieval 查不到、`refine_audit_log` 有一筆
- [ ] MCP `cc_memory_refine_promote` 一筆 → `project_memories` 多一筆、`source_summary_id` 填對、原 summary `promoted_to_memory_id` 填對
- [ ] MCP `cc_memory_refine_merge` 兩筆 auto → 新 row 出現、原兩筆 archived、metadata 有 merged_into
- [ ] MCP `cc_memory_refine_edit` 改 summary → retrieval 命中新內容、embedding 有更新
- [ ] CLI `refine list --where ...` 可讀、`refine delete --ids ...` 可批次

### 品質閘（觀察窗結束才驗）

- [ ] `npx tsx scripts/benchmark.ts` 能跑完 10 組 query、輸出 `docs/benchmark-YYYY-MM-DD.md`
- [ ] 品質閘 3 項指標達標 → 產出 `docs/claude-mem-switchoff-decision.md` 記錄證據

---

## Rollout Plan（Phase 劃分）

每個 Milestone 開工依 `sdd-workflow.md` 的「每個 Phase 執行紀律」（brainstorm → context7 → TDD → simplify → review → Gate）。

> **命名註記**：v0.4 整體對齊 handoff 的「Stage 1」，內部以 Milestone M1~M4 分段（避免和 v0.3 Phase A/B/C 混淆）。

### M1 — Schema + Refine Tools MVP（~1 day）

- drizzle migration：新增 `session_summaries` + `refine_audit_log`、擴 `project_memories.source_summary_id`
- MCP refine tools 四個 + audit log 寫入
- CLI `scripts/refine.ts` 基本操作
- Unit + Integration tests

**Gate**：migration 在 local / Zeabur 都成功；refine 四個 tool happy path 過；248 原有 tests 綠。

### M2 — Capture Pipeline（~2.5 days）

- `scripts/capture-runner.ts`（SKIP_TOOLS + 節流 + upsert 流程） + `hooks/stop-capture.sh`
- `src/llm/claude-cli.ts`（subprocess 封裝 + timeout / retry / parse）
- `src/llm/gemini-embed.ts`（沿用 Phase A 的 embedding，拆抽成獨立模組）
- MCP `cc_memory_save_summary`（upsert 實作）
- Per-session state 檔管理（`~/.cc-memory/state/`），含 `last_tools` 追蹤
- code.json prompt 載入 + XML → JSON parse
- Queue resume 機制、claude-cli-missing.flag / quota-exceeded.flag 機制
- Idempotency + null-session 降級

**Gate**：E2E 模擬 Stop hook 觸發 → Claude CLI subprocess 成功 → Gemini embed → DB 有 row；SKIP_TOOLS 測試（只叫 TodoWrite 不摘要）；節流測試（同 session 兩輪間隔太短不摘要）；斷網重連能 resume queue；`AUTO_CAPTURE=off` 驗證無寫入；Claude CLI 不存在的 flag 機制 integration test 綠。

### M3 — Retrieval Integration + 跨專案（~1.5 day）

- `cc_memory_search` 擴展：跨兩表 query、`project_ids[]` 參數、加權 rerank、`project_id` 標註
- `search_feedback` 擴展：`result_source_breakdown` jsonb 欄位
- Config 加權環境變數

**Gate**：加權排序 unit test 綠；跨兩個 project 查 integration test 綠；`INCLUDE_AUTO_IN_SEARCH=off` 可退回舊行為；原 248 tests 不回歸。

### M4 — SessionStart Re-inject（~1 day）

- `scripts/reinject-runner.ts` + `hooks/session-start-reinject.sh`
- MCP `cc_memory_recent_summaries` 新 tool（read-only）
- Hook protocol 格式化（context7 查 Claude Code `additionalContext` 最新規格）

**Gate**：`/clear` 觸發能注入記憶（Claude 能 recall 注入內容）；`REINJECT=off` 不注入；空 project 不注入佔位字串。

### M5 — Benchmark + 觀察期（半 day dev + 2+ 週 observe）

- `scripts/benchmark.ts`（跑 10 組 query 對比 claude-mem）
- 固定 5 query fixture
- 人工標註 template

**Gate**：benchmark 可跑、進入觀察期。觀察期結束後才決定是否停用 claude-mem（不是 M5 本身的 gate）。

### 總工時

- Dev：**~6.5 日人工**（M1=1 + M2=2.5 + M3=1.5 + M4=1 + M5=0.5）+ 測試 buffer 1 日 = **~7.5 日**
- Observe：2 週（平行跑，不占 dev 時間）
- 取代 claude-mem：觀察期結束後的單獨決策點，不算 v0.4 工時

---

## Risks & Open Questions

### Risk 1：Stop hook 每輪觸發 → 品質污染

Stop hook 每輪對話結束都觸發（claude-mem 同款機制）。**成本風險已透過選 Claude CLI subprocess（subscription 吃到飽、無額外 API 費用）移除**，剩下的是品質風險：不節流的話每輪產出摘要 → 大量重複 → 即便有 upsert 覆蓋，也會每輪叫一次 LLM 吃配額。

**對策（三層過濾）**：
- **第 0 層 SKIP_TOOLS 過濾**（抄 claude-mem 實戰清單）：純工具輪次（TodoWrite / Skill / SlashCommand 等）直接 skip
- **第 1 層雙門檻節流**（硬要求）：min-interval 180s AND min-delta-tokens 500 任一不過即跳過
- **第 2 層 upsert 覆蓋**：同 session 不累積多筆，直接 UPDATE 同一列
- `summarize_count` 欄位觀察實際觸發頻率，異常（例如 1 session > 10 次摘要）→ 調節流參數
- 單 session 每小時最多摘要次數上限（預設 10，未達上限也要 min-interval 過）

### Risk 1b：Claude Pro/Max subscription 配額爆掉

理論可能（subscription 配額雖大但仍有上限），claude-mem 實戰在 Max 5x/20x 下運作良好。

**實證**：你的 claude-mem 累積 7,313 observations + 2,673 session_summaries（假設 6 個月 → 每月 ~450 次 LLM 呼叫），配額從未見爆。SKIP_TOOLS + 節流設計下，v0.4 預期摘要頻率和 claude-mem 同級。

**對策**：
- Claude CLI 回傳「quota exceeded」錯訊時，runner 寫 `quota-exceeded.flag`（含時戳）
- 下次 runner 啟動先檢查 flag；時戳 < 1 hr 內 → skip；超過 → 重試
- 極端情況可臨時 `CC_MEMORY_AUTO_CAPTURE=off` 關一下，本業優先

### Risk 1c：Claude CLI 不存在或未認證

例如新電腦、subscription 過期、或 claude CLI 還沒安裝。

**對策**：
- 首次偵測不存在 → 寫 `claude-cli-missing.flag` + log，後續 runner 先檢查 flag 直接 skip
- Manual recovery：使用者跑 `claude auth login`（或等效）、刪 flag、下次 hook 觸發自動恢復
- SessionStart 時可以 context7 查 Claude CLI 安裝狀態，但 v0.4 MVP 不做自動化修復

### Risk 2：Session boundary 不穩（Codex round 3 警告）

同一個「主題」可能跨多個 Claude Code session（中斷、reopen、重啟）→ 一個主題變成多筆分散 row。

**對策**：
- `promoted_to_memory_id` + refine `merge` 是第一類對策
- 若觀察期內發現頻繁 → Stage 2 加自動 merge 候選偵測

### Risk 3：Retrieval UX 碎化（Codex round 3 警告）

結果從一個源變成兩個源 → 頂端幾筆可能都是 auto 冗餘。

**對策**：
- 加權預設偏向 manual / promoted（0.15 差距）
- `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=off` 一鍵退回
- Upsert + unique index 保證同 session 不重複
- 觀察期每週看 `search_feedback.result_source_breakdown` 統計

### Risk 4：Precision-first 壓力 vs LLM 錯抓

Claude 抽的 summary 可能包含幻覺 / 錯誤歸因 / 雜訊（任何 LLM 皆然，即便是 sonnet 4.5）。

**對策**：
- Prompt 直接抄 claude-mem `code.json`（已實戰驗證）
- Queue + DB 是寫入側關卡；refine delete 是消費側關卡
- 錯抓率 < 10% 是 Go/No-Go 硬指標，不過就不切換

### Risk 5：`session_id` 在 Stop hook env 取不到

機率低於舊方案的 PreCompact，但極少數情況仍可能發生。

**對策**：
- 降級為 null session_id INSERT（不走 upsert）
- 連續 N 次取不到 → exit 並報警
- 觀察期驗證實際可取得率

### Risk 6：同 project 兩機同時 capture 競爭

A 機和 B 機同 project 同時跑 session，session_id 不同 → 各寫一筆（無衝突，各是獨立 session）。**不再是風險**。

若兩機跑**同 session_id**（不應發生，Claude Code session uuid 應全域唯一）→ 競爭 upsert，PG row-level lock 確保一致性、後寫覆蓋前寫（資料不壞，只是可能丟一次寫入），可接受。

### Risk 7：SessionStart re-inject 注入太多 / 不精準影響 Claude 判斷力

注入固定 5+3 筆，不看當前使用者 prompt，可能塞入無關記憶佔用 context。

**對策**：
- 數量可調（env `REINJECT_SUMMARIES` / `REINJECT_MANUAL`）
- `CC_MEMORY_REINJECT=off` 一鍵關
- 觀察期若發現 Claude 回答受無關記憶影響 → 調低數字或改 Stage 2 做動態 RAG
- 不在 MVP 做「依 prompt 動態 top-K」，避免 SessionStart 延遲 + 複雜度

### Open Questions（需 user review 時決定）

1. **transcript size cap 截尾策略**：預設截尾保留 `head 500KB + tail 1MB`（保留意圖 + 近期）；實作時 context7 查 claude-mem 對應做法再校準
2. **Claude model 選擇**：預設 `claude-sonnet-4-5`（抄 `CLAUDE_MEM_MODEL`，品質閘對比最公平）；env `CC_MEMORY_CLAUDE_MODEL` 可改（例如臨時切 haiku 省配額）
3. **CLI refine 的 `list` 是否寫 audit log**：預設**不寫**（read-only 不留 audit noise）
4. **Feature flag 三個的預設值**：
   - `CC_MEMORY_AUTO_CAPTURE=off`（需 opt-in，避免升級即自動採集驚嚇）
   - `CC_MEMORY_INCLUDE_AUTO_IN_SEARCH=on`（啟用採集後查詢預設混合）
   - `CC_MEMORY_REINJECT=off`（需 opt-in，避免 context 被預期外內容佔用）
5. **reinject 數量 N=5、M=3 合不合理**：沒人知道，觀察期再調；env 可動。初期建議 N=3、M=2 更保守
6. **Stop hook 節流參數 min-interval=180s、min-tokens=500**：同上，觀察期再調
7. **SKIP_TOOLS 清單**：預設抄 claude-mem 10.5.2（`ListMcpResourcesTool, SlashCommand, Skill, TodoWrite, AskUserQuestion`）；`CC_MEMORY_SKIP_TOOLS` env 可加減，例如加自訂 MCP tool name

---

## Future Roadmap（non-binding，不在 v0.4 驗收）

此段記錄方向，給未來 session 接手參考。**任何項目若要做都需新開 v0.5+ spec 重新規劃**。

| 項目 | 觸發條件 |
|---|---|
| `observations` 細粒度表（Codex Option F 的 Stage 2）| v0.4 品質閘過 + session_summaries 覆蓋度不足 |
| 每 session 觀察值 N 筆上限 + 3 種 high-value type（decision/bugfix/feature）| 同上 |
| claude-mem 歷史 import（2,673 session_summaries + 7,313 observations）| 品質閘過 + 決定取代 claude-mem |
| Batch tag refine 操作 | 觀察期內有 > 100 筆 auto summary 需批次整理 |
| LLM 自動 refine 候選建議 | 手動 refine 超載（> 每週 10 次） |
| Observations 類型放寬（Codex Stage 3）| Stage 2 實測後 |
| Retrieval UX 前端（真的需要看 result source breakdown 才調參） | 觀察期指標持續偏離 |
| Embedding provider 替換（Voyage AI / local sentence-transformers / OpenAI） | Gemini embedding 出現 rate limit / 成本突增 / 品質不符 |
| LLM provider fallback（Gemini / OpenRouter 當 Claude CLI 失效時的退路）| Claude CLI 配額頻繁撞上（連續 > 3 天 quota 爆），或 subscription 預期將斷 |

---

## References

- `docs/spec.md`（v0.3）— Phase A 已交付 scope
- `docs/plan.md`（v0.3）— 設計決策歷史
- `docs/next-session-handoff.md`（2026-04-22）— 本 spec 輸入的 brainstorm 前置
- `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json` — 抽取 prompt 原始檔
- `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/hooks/*.json` — hook 配置（Stop + SessionStart(compact) 選擇來源）
- `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/scripts/worker-cli.js`（env defaults 段） — LLM provider / SKIP_TOOLS / model 預設值參照
- `~/.claude-mem/settings.json` — 實際執行時的 provider 設定實例（`CLAUDE_MEM_PROVIDER=claude` + `CLAUDE_MEM_CLAUDE_AUTH_METHOD=cli`）
- `~/.claude/rules/sdd-workflow.md` — Phase 同步規則（改 spec.md / plan.md / task.md 時遵循）
- Claude Code hooks 官方 protocol — 實作 reinject `additionalContext` 格式時以 context7 查最新
- Claude CLI 文件（`claude --help`） — 實作 `claude -p --output-format json` 時確認 flags 格式
