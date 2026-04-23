# 下 session 接手清單（v0.4 Phase C 規劃完成 → pending implementation）

> 本 session（2026-04-23）完成 v0.4 設計 + 三檔同步。下 session（可能換電腦）從乾淨狀態接手 Phase C 實作。

## 當前狀態快照

### ✅ 已完成（本 session 2026-04-23）

1. **v0.4 brainstorm 三輪收斂**（superpowers:brainstorming）：
   - Q1：Phase B 取消 → 採 option (a)
   - Q2：升 v0.4 新 spec → 採 option (c)
   - Q3：Stage 1 only（session_summaries + refine tools）+ Future Roadmap non-binding → 採 option (a)
   - Q4：品質閘切換 claude-mem（Top-5 交集 / 人工命中度 / 錯抓率 <10%）+ 真實 5 + 固定 5 benchmark
   - Q5：refine = MCP + CLI 兩者；delete + promote + merge + edit 全做；capture_source 欄位

2. **design doc 寫完 + 三輪修正**（1056 行）：
   - v1：初稿（SessionEnd + PreCompact + Gemini LLM）
   - v2：使用者質疑 → 改 Stop + SessionStart(compact) re-inject（抄 claude-mem）
   - v3：使用者質疑 Gemini 必要性 → 改 Claude CLI subprocess（subscription 免費）+ SKIP_TOOLS；Gemini 只留 embedding
   - 路徑：`docs/superpowers/specs/2026-04-22-auto-capture-design.md`
   - commit `13b9da3`

3. **三檔同步到 v0.4**（commit `30eadc7`）：
   - `docs/spec.md`：Phase B ❌、新增 Phase C US 對照、Goals 擴 8 條、Constraints 分段
   - `docs/plan.md`：Data Model 加 2 新表、Service Layer 加 Phase C 模組、Env Vars 13 個 Phase C 變數、Rollout M1-M5 表
   - `docs/task.md`：Phase B ❌、新增 Phase C M1-M5 任務清單 + Gate、端對端驗收 Phase C 區塊

## 下 session 該做什麼：啟動 writing-plans skill 進 implementation

### 正確順序（照 brainstorming skill 的 checklist）

1. **讀 design doc + 三檔現況**（5-10 分鐘）：
   - `docs/superpowers/specs/2026-04-22-auto-capture-design.md`（source of truth）
   - `docs/spec.md` / `docs/plan.md` / `docs/task.md`（Phase 骨架）
   - `docs/next-session-handoff.md`（本檔）

2. **啟動 `superpowers:writing-plans` skill**（brainstorm 的 terminal state）：
   - 輸入 source：design doc + task.md 的 M1-M5
   - 產出：implementation plan（細分到可執行 step，每步有 test / verification）
   - 放在：`docs/superpowers/plans/2026-04-XX-v04-phase-c-implementation.md`（skill 預設）

3. **從 M1 開工**（schema + refine tools）：
   - 讀 `~/.claude/rules/sdd-workflow.md` §「每個 Phase 執行紀律」
   - 順序：brainstorm 開工對齊 → context7 查 Drizzle + pgvector 語法 → TDD red-green → simplify → code review → M1 Gate 驗收

### 不要做的事

- ❌ **不要重跑 brainstorm** — 五題已收斂、三輪設計已經 user approved
- ❌ **不要改 design doc 的核心決策**（Phase C = Stage 1 / LLM=Claude CLI / Embedding=Gemini / 三個 feature flag 預設值），只能改實作細節
- ❌ **不要回頭碰 Phase B**（HTTP / Telegram 已正式取消）

## Phase C 五題決策對照（換電腦需要快速上手）

| 決策 | 結論 | 來源 |
|---|---|---|
| Phase B vs Phase C 順序 | Phase B 取消，轉向自動採集 | Q1=a |
| 版號 | 升 v0.4 新 spec | Q2=c |
| Scope | Stage 1 only（session_summaries + refine）+ non-binding roadmap | Q3=a |
| claude-mem 切換條件 | 品質閘（三指標 AND）+ 真實 5 + 固定 5 benchmark | Q4=c + iii |
| Refine 工具 | MCP + CLI 兩者，delete/promote/merge/edit 全做，加 capture_source | Q5-A=c / Q5-B=全 / Q5-C=a |
| Hook 事件選擇 | Stop（抓）+ SessionStart(compact)（re-inject） | 照 claude-mem |
| LLM 摘要 provider | Claude CLI subprocess（吃 subscription） | 使用者直覺對，v3 修正 |
| Embedding provider | Gemini `text-embedding-004` 沿用 | 沒得選（Claude 無 embedding API） |
| SKIP_TOOLS 清單 | 抄 claude-mem：ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion | Q-y=照抄 |
| Feature flag 預設 | AUTO_CAPTURE=off / INCLUDE_AUTO=on / REINJECT=off（opt-in 派） | 待 user 明示決定 |

## 6 個 Open Questions（design doc §Open Questions）

這些實作時才需要決定，spec 都有預設值，不阻擋 M1 開工：

1. transcript size cap 截尾策略（預設 head 500KB + tail 1MB）
2. Claude model（預設 `claude-sonnet-4-5`）
3. CLI refine `list` 是否寫 audit log（預設不寫）
4. Feature flag 預設值（上表）
5. reinject N=5/M=3 數量（或 N=3/M=2 更保守）
6. Stop 節流參數（min-interval=180s / min-tokens=500）
7. SKIP_TOOLS 擴充策略（env 或 hardcode）

## 技術 artifacts 盤點

| 東西 | 路徑 / 值 |
|---|---|
| design doc (source of truth) | `docs/superpowers/specs/2026-04-22-auto-capture-design.md`（1056 行）|
| claude-mem prompt spec（抄的對象） | `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/modes/code.json` |
| claude-mem hook 配置（選 Stop + SessionStart 的依據） | `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/hooks/*.json` |
| claude-mem provider 預設值 | `~/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/scripts/worker-cli.js`（env defaults）+ `~/.claude-mem/settings.json` |
| claude-mem SQLite（併用期參考）| `~/.claude-mem/claude-mem.db`（observations 7,313 / session_summaries 2,673）|
| Production DATABASE_URL | `~/.claude.json` → `mcpServers.cc-memory.env.DATABASE_URL`（含密碼）|
| GEMINI_API_KEY | `~/.claude.json` → 同上（embedding 用）|
| Phase A tag | `v0.3-phase-a`（commit `a7b15dd`）|
| v0.4 brainstorm commits | `13b9da3`（design doc）+ `30eadc7`（三檔同步）|

## 跨電腦接手 checklist

換電腦後：

1. `git pull origin main` → 應該看到兩個新 commit（`13b9da3` + `30eadc7`）
2. 確認 `claude mcp list` 看得到 `cc-memory: ✓ Connected`（user scope，會從 `~/.claude.json` 繼承）
3. 跑 `npm test` 確認 248 tests 綠（Phase A 基線）
4. 確認 `claude --help` 能跑（Phase C 核心相依：Claude CLI subprocess）
5. 讀 design doc 前 200 行（Context / Goals / User Stories）
6. 啟動 `/superpowers:writing-plans`（當前階段的 brainstorming skill terminal state）

## 本 session 未完成（下 session 接手）

- [ ] 啟動 `superpowers:writing-plans` skill 產 Phase C implementation plan
- [ ] M1 開工（schema + refine tools MVP，~1d）
- [ ] M2~M5 依 `docs/task.md` 順序執行
- [ ] 觀察期（2 週 + 30 筆 auto summary）
- [ ] 品質閘驗收 → claude-mem 切換決策

## 開場建議（下 session 第一句 prompt）

```
讀 docs/next-session-handoff.md，然後啟動 superpowers:writing-plans
為 v0.4 Phase C 寫 implementation plan（source: design doc + task.md M1-M5）。
plan 寫完從 M1 開工（schema + refine tools）。
```
