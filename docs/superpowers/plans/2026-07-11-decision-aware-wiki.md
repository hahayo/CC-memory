# Decision-aware LLM Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立由 Git 管理、Claude Code 與 Codex 共用的決策 Wiki，明確區分即時計算的語意相似與人工確認的持久化關係。

**Architecture:** `docs/decisions/` 下的 Markdown 決策卡是唯一真相來源；正式卡與 `_draft/` 候選卡以目錄和 status 雙重區分。TypeScript 驗證器只解析文件規格允許的 YAML 子集，檢查來源、關係、循環、索引與摘錄雜湊；不修改 PostgreSQL、MCP 或 capture 管線。

**Tech Stack:** Markdown、受限 YAML frontmatter、Node.js `fs`/`crypto`、TypeScript、Vitest、Git。

## Global Constraints

- 不新增或修改 PostgreSQL schema、migration、MCP tool 或 auto-capture 行為。
- 新決策卡 ID 格式固定為 `DEC-YYYYMMDDTHHMMSSZ-<kebab-slug>`；本次正式卡 ID 固定為 `DEC-20260711T052245Z-git-first-decision-wiki`。
- 持久化關係只能是 `supersedes`、`depends_on`、`conflicts_with`、`related_to`；任何 `similarity` / `semantic_similarity` / `similar_to` 欄位均非法。
- `_draft/` 內只允許 `status: proposed`；正式目錄只允許 `active`、`superseded`、`archived`。
- 正式卡至少要有一個 `verified: true` source，且每個 source 的遮罩摘錄 SHA-256 必須與正文一致。
- 正式決策的背景、替代方案、決策與理由不可原地改寫；翻案建立新卡並用 `supersedes` 指向舊卡。
- 來源只保存已遮罩短摘錄、locator 與 hash，不保存完整 transcript。
- 新增規則在 `CLAUDE.md` 與 `AGENTS.md` 採相同語意；既有 `AGENTS.md` 內容從 `/home/haha/CC_project/CC-memory/AGENTS.md` 帶入，不覆蓋或刪除原規則。
- 現有 `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md` 不搬動、不改寫，只加入新索引。

---

### Task 1: 決策卡文件模型與首張正式卡

**Files:**
- Create: `docs/decisions/README.md`
- Create: `docs/decisions/INDEX.md`
- Create: `docs/decisions/_draft/README.md`
- Create: `docs/decisions/DEC-20260711T052245Z-git-first-decision-wiki.md`

**Interfaces:**
- Produces: Task 2 驗證器要解析的 frontmatter 與正文 source excerpt 格式。

- [ ] **Step 1: 建立規格文件**

  `README.md` 必須定義：目錄角色、ID/檔名規則、完整 frontmatter schema、四種關係方向、語意相似不得持久化、固定正文六節、來源遮罩與 hash 正規化規則、draft → 人審 → move + commit 流程、accepted core 不可改寫與 supersede 流程。Hash 正規化固定為：取 `### <source-id>` 下連續 blockquote 行，移除每行 `> `，以 `\n` 連接，不加尾端換行，再以 UTF-8 計算 SHA-256。

- [ ] **Step 2: 建立草稿區說明**

  `_draft/README.md` 必須聲明候選不具決策權威、agent 不得自行移出、只有明確拍板才建卡、人工接受時才移出並提交。

- [ ] **Step 3: 建立索引與正式卡**

  `INDEX.md` 以表格列出新卡與既有 `ADR-001`，並明示 cards 才是 SSOT、INDEX 是導覽。新卡的 source metadata 固定使用：`id: S1`、`type: manual`、`client: human`、`ref: user-approval-2026-07-11`、`captured_at: 2026-07-11T13:22:45+08:00`、`excerpt_sha256: 08ee89cc272bd49b85f66a6bf0091011ee4b858d4ff27bd3a7db222289a71d65`、`verified: true`。S1 blockquote 固定為兩行：`Git 決策卡（建議）` 與 `Implement the plan.`。

- [ ] **Step 4: 自我檢查並提交**

  Run: `rg -n "semantic|supersedes|depends_on|conflicts_with|related_to|08ee89cc" docs/decisions`
  Expected: 規格、索引與正式卡均可找到，且沒有持久化 similarity 欄位。

  Commit: `docs(decisions): establish git-first decision wiki`

---

### Task 2: 決策卡驗證器

**Files:**
- Create: `scripts/validate-decisions.ts`
- Create: `tests/scripts/validate-decisions.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateDecisionWiki(repoRoot: string): Promise<ValidationReport>`。
- Produces: `ValidationReport = { ok: boolean; cards: number; issues: ValidationIssue[] }`；issue 至少含 `code`、`file`、`message`。
- Produces: `npm run decisions:validate`，成功 exit 0，任何 issue exit 1。

- [ ] **Step 1: 寫 RED 測試：合法 repo**

  用 `mkdtemp` 建立最小 `docs/decisions` fixture，包含一張具正確 source hash 的 active 卡和 INDEX；assert `ok === true`、`cards === 1`、`issues === []`。

- [ ] **Step 2: 執行 RED**

  Run: `npm run test -- tests/scripts/validate-decisions.test.ts --run`
  Expected: FAIL，原因為 `scripts/validate-decisions.js` 尚不存在。

- [ ] **Step 3: 寫其餘 RED 測試**

  分別驗證：draft/path status 不符；正式卡沒有 verified source；excerpt hash 不符；relation target 不存在；`supersedes` 形成循環；重複 ID；INDEX 缺正式卡；frontmatter 出現 `semantic_similarity`。每個測試 assert 穩定 code：`STATUS_PATH_MISMATCH`、`VERIFIED_SOURCE_REQUIRED`、`SOURCE_HASH_MISMATCH`、`DANGLING_RELATION`、`SUPERSEDES_CYCLE`、`DUPLICATE_ID`、`INDEX_ENTRY_MISSING`、`FORBIDDEN_SIMILARITY_FIELD`。

- [ ] **Step 4: 實作最小驗證器**

  只接受 README 定義的受限 YAML：top-level scalar、四個 inline array、`sources` 下的固定 scalar map。掃描正式目錄與 `_draft/` 的卡片，排除 `README.md`/`INDEX.md`；另從 `docs/**/decisions/ADR-*.md` filename 收集 legacy ID。檢查必填欄位、ID 與 filename、status/path、source 欄位與 hash、四種關係 target、自連結、supersedes cycle、正式卡索引。CLI 以 JSON 輸出 report。

- [ ] **Step 5: 執行 GREEN 與 repo 驗證**

  Run: `npm run test -- tests/scripts/validate-decisions.test.ts --run`
  Expected: 全部 PASS。

  Run: `npm run decisions:validate`
  Expected: exit 0，JSON 顯示 `ok: true`。

- [ ] **Step 6: 靜態檢查並提交**

  Run: `npm run typecheck && npm run lint`
  Expected: exit 0。

  Commit: `feat(decisions): validate decision wiki invariants`

---

### Task 3: Claude Code 與 Codex 共用規則

**Files:**
- Modify: `CLAUDE.md`
- Create/Modify: `AGENTS.md`
- Modify: `docs/INDEX.md`

**Interfaces:**
- Consumes: `docs/decisions/INDEX.md`、`docs/decisions/_draft/`、`npm run decisions:validate`。

- [ ] **Step 1: 帶入既有 AGENTS.md**

  從 `/home/haha/CC_project/CC-memory/AGENTS.md` 讀取現有內容，在 worktree 建立相同基線；不得刪減既有 contributor guide。

- [ ] **Step 2: 同步兩個 client 的決策規則**

  在 `CLAUDE.md` 與 `AGENTS.md` 各加入同義小節，要求：重大架構/行為/config 決策前先讀決策索引與相關卡；只有明確拍板才寫 `_draft`；agent 不得自行接受；相似只可標為未持久化推測；四種關係須人工確認；翻案以新卡 supersedes 舊卡；接受後同 commit 更新 INDEX 並跑 validator。

- [ ] **Step 3: 更新 docs 導覽**

  `docs/INDEX.md` Active 清單新增 `decisions/{README,INDEX,_draft/,DEC-*.md}`，說明 Git 決策卡是跨 Claude Code/Codex 的決策 SSOT；不改既有 track 狀態。

- [ ] **Step 4: 驗證並提交**

  Run: `npm run decisions:validate && npm run typecheck && npm run lint && npm run build`
  Expected: exit 0。

  Commit: `docs: share decision workflow across coding agents`

---

## Final Verification

- `npm run test -- tests/scripts/validate-decisions.test.ts --run`
- `npm run decisions:validate`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run test:ci`；允許且只允許已記錄的 baseline：未啟動 test PostgreSQL 與 `tests/services/projects.test.ts` 的既有 outside-repo marker 失敗。任何新失敗都必須修正。
