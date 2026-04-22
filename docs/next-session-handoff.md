# 下 session 接手清單（v0.3 Phase A 後 → 自動採集 feature 規劃）

> 本 session（2026-04-22）在長 ctx 下結束。下 session 從乾淨狀態接手。

## 當前狀態快照

### Phase A 完工 ✅
- `main` = `origin/main`（clean）
- Tag `v0.3-phase-a` 已推到 GitHub（commit `a7b15dd` → tag sha `c84b1add`）
- 248 / 248 tests 綠
- Codex review loop round 24 收斂

### Zeabur production DB 已部署 ✅
- Project ID: `69e85cb74b844a578d958dcd`（名為 `CC-memory`）
- Service: `postgresql`（template `773OAW` = PostgreSQL with pgvector 0.8.2）
- DATABASE_URL 已存 `~/.claude.json`（user scope MCP config），含密碼
- Schema 已 push（drizzle-kit），4 tables + 5 CHECK + partial unique index 全到位
- 端對端驗收 4/4 綠（含 Gemini embedding E2E，top-1 semantic 命中）

### MCP + Skills 已裝 ✅
- `claude mcp list` 能看到 `cc-memory: ✓ Connected`（user scope）
- `GEMINI_API_KEY` 已註冊進 MCP env（semantic/hybrid search 真的可用）
- `~/.claude/skills/` 下有 `save-memory.md` + `load-memory.md`

### 全域規則已更新 ✅
- `~/.claude/CLAUDE.md` 第 3 行 + `~/.claude/rules/git-workflow.md` 第 3 條
- 新規則：**git/gh cli 優先，`mcp__github__*` 當 fallback**（原因：`push_files` 無法推 commit 歷史 / tag）

## 下 session 該做什麼：自動採集 feature 規劃

### 使用者需求（對齊過）

使用者想做 **claude-mem 風格的自動採集**（Stop hook → Gemini extract → 寫 DB），兩條 hard constraint：
1. 主動採集（`/save-memory`）**權重 > 自動採集**
2. 要能整理 DB 狀況（刪 / merge / promote auto → manual）

前提：如果效果好，會停用 claude-mem。**一開始併用**。

### 現有 spec 關係

`docs/spec.md` line 235 寫了「路線 B（Stop hook 自動抽取）」—— 但它排在 Phase B（HTTP + Telegram + feedback 回寫）**之後**：

> Phase B 全指標達標才啟動路線 B

**使用者想跳過 Phase B 直接做自動採集**，這偏離原 spec Phase 順序。

### SDD 流程（**下 session 第一件事**）

**不要直接開工寫 code**。照 `~/.claude/rules/sdd-workflow.md` 的順序：

1. **`/brainstorm`**（superpowers:brainstorming）對齊這 3 個未解問題：
   - 自動採集 vs Phase B 的順序（Phase B 延後 / 放棄 / 並行？）
   - 新 Phase 名稱（v0.3 Phase C 還是 v0.4 新 spec？）
   - Scope 邊界：只 Stop hook，還是完整複刻 claude-mem（observations + session_summaries + retrieval tools）？

2. **改 spec.md**（方案 A：改現有而非新開，理由：路線 B 本來就在原 spec scope，只是排序變）
   - 依 sdd-workflow.md：Phase 邊界變更必須**同回合同步**更新 spec / plan / task 三檔
   - 所有帶 "Phase" 字樣的段落都要同步（sdd-workflow.md 有詳細 checklist）

3. **同步 plan.md + task.md**（Phase banner、各 Phase 任務清單、Gate、端對端驗收）

4. **才開工**（per「每個 Phase 執行紀律」：brainstorm → context7 → TDD → simplify → review → Gate）

## 本 session 已做的 Codex 辯論結論（避免下 session 重跑）

跑了 3 輪 Codex debate，**收斂結論**：

### Option F > Option E（之前推的 archive layer 過度設計）

**Option F refined**（Codex round 3 採納）：
- 照抄 claude-mem schema + 加 CC-memory 特色（writer_host / source / idempotency / cross-machine）
- 三表並存：`project_memories`（現有，curated）+ `session_summaries`（新，每 session 一筆）+ `observations`（新，細粒度）
- **不用從零調 Gemini prompt**：claude-mem 的 prompt 定義完整放在 public JSON：
  - `/home/haha/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json`（6 types / 7 concept tags / system prompt / XML template）
  - 31 種語言版本（含 `code--zh.json`）
- **分 stage**：Stage 1（3 天）先 session_summaries only → Stage 2（2 天後加 observations，保守啟動每 session 最多 N 筆 + 只抽 decision/bugfix/feature 3 種 high-value type）→ Stage 3 放寬

**Codex 指出的 3 個落地重點**：
1. **Precision-first capture**（寧漏抓不要錯抓）
2. **Import 要 resume 機制**（10,000 筆重 embed 要 1~2 天背景跑，不可中斷還原）
3. **Dedupe policy**（即使兩表也要：同 session lineage 結果群組、canonical 強制排第一，不靠權重倍率）

**Codex 指出的 2 個結構風險**：
1. Session boundary 不穩（中斷 / reopen / 主題切換）
2. Retrieval UX 可能碎掉（結果更多 ≠ 更好）

### 總工時估計

- 完整 Option F（3 表）：~7~8 工作天（因為 prompt 可照抄省 3~5 天）
- Stage-1 only（2 表）：~3 天

## 技術 artifacts 盤點

| 東西 | 路徑 / 值 |
|---|---|
| claude-mem 完整 prompt spec | `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json` |
| claude-mem SQLite DB | `~/.claude-mem/claude-mem.db`（observations 7,313 / session_summaries 2,673 / sdk_sessions 1,024）|
| claude-mem chroma vectors | `~/.claude-mem/chroma/`（350MB，不能搬，重新 Gemini embed） |
| Production DATABASE_URL | `~/.claude.json` → `mcpServers.cc-memory.env.DATABASE_URL`（含密碼，別 commit） |
| GEMINI_API_KEY | `~/.claude.json` → `mcpServers.cc-memory.env.GEMINI_API_KEY` |
| 本 session 的 Codex 辯論共識 | 本檔 + git log 可追 |

## 下 session 開場建議

```
讀 docs/next-session-handoff.md 了解狀態，然後跑 /brainstorm 對齊
自動採集 feature 的 scope（Phase 順序、邊界、要不要完整複刻 claude-mem）。
brainstorm 完才改 spec.md + 同步 plan.md + task.md。
```

## 這個 handoff 要不要 commit？

**建議 commit**（原因：這是 project 進度的一部分，方便未來 audit / 其他裝置接手）。
但它不進 `origin/main` 也沒關係（這是工作紀錄不是 production feature）。

使用者決定 commit 的話，建議 commit message：
```
docs: v0.3 Phase A 後下 session 接手清單（自動採集 feature 規劃）
```
