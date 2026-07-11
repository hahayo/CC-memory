# Shared Decision Wiki Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `setup-decision-wiki` 與新版 `save-decision` 兩個跨 Claude Code／Codex 共用 skill（技能），以本 repo（程式碼儲存庫）為 Git canonical（版本控制權威來源），並提供安全安裝與漂移驗證。

**Architecture:** `skills/` 保存兩個 canonical skill；setup skill 夾帶零相依 Node.js 18+ 決策 Wiki 骨架、validator（驗證器）與 `node:test` 測試，save skill 每次以目標 repo 的契約為準。`scripts/install-decision-skills.sh` 只在明確 `--install` 時備份並同步到三個 client root（客戶端根目錄），預設只做 tree hash（目錄樹雜湊）檢查。

**Tech Stack:** Markdown、YAML、Bash、Node.js 18+ ESM（ECMAScript 模組）、`node:test`、Git、Python 3（僅執行官方 skill-creator 工具）。

## Global Constraints

- Canonical frontmatter（檔頭）只允許 `name` 與 `description`；不得加入 Claude 專屬 `allowed-tools`。
- `setup-decision-wiki` 與 asset（輸出資產）不得寫死 `/home/haha`、CC-memory 絕對路徑、DB（資料庫）、MCP（模型情境協定）、hook（事件掛鉤）或 session-end（工作階段結束）自動寫卡。
- 新 repo 預設安裝零相依 Node.js 18+ `.mjs` validator 與 `node:test`；缺少 Node.js 18+ 時停止，不做 docs-only 半套安裝。
- 既有 `docs/decisions/README.md`、正式決策卡、`AGENTS.md`、`CLAUDE.md` 與 ADR（架構決策紀錄）不得被靜默覆寫；共同規則一律 draft-first（先起草）並等待人工接受。
- 新決策 ID 固定為 `DEC-YYYYMMDDTHHMMSSZ-<kebab-slug>`；草稿只能是 `proposed`，正式卡只能是 `active`、`superseded` 或 `archived`。
- 持久化關係只有 `supersedes`、`depends_on`、`conflicts_with`、`related_to`，全部須人工確認；semantic similarity（語意相似度）不得自動持久化。
- 來源只保存遮罩後短摘錄、locator（定位資訊）與 SHA-256；不得保存完整 transcript（逐字紀錄）。
- 任何 skill 都不得自動 commit（提交）或 push（推送）；validator 非零即停止。
- 安裝器不得刪除其他 skill；目的端漂移時 check mode（檢查模式）失敗，`--install` 先備份再同步。
- 實際安裝後，Claude Code、Codex 與 compatibility mirror（相容鏡像）的兩個 skill tree hash 必須各自等於 canonical。

---

### Task 1: RED pressure baselines

**Files:**
- Create (scratch only): `.superpowers/skill-tests/red/setup-result.md`
- Create (scratch only): `.superpowers/skill-tests/red/save-unsettled-result.md`
- Create (scratch only): `.superpowers/skill-tests/red/save-supersede-sensitive-result.md`

**Interfaces:**
- Consumes: 核准規格與三個未載入新 skill 的隔離 fixture（測試夾具）。
- Produces: 每個 baseline（基準）實際違規、合理化語句及新 skill 必須修正的行為清單。

- [ ] **Step 1: 建立三個隔離 Git fixture**

建立 setup fixture（含既有 `AGENTS.md`、`CLAUDE.md`、ADR 與髒工作樹）、未拍板 save fixture，以及含舊卡與密鑰樣式摘錄的 supersede fixture。所有 fixture 只能位於 `/tmp`。

- [ ] **Step 2: 以 fresh subagent 執行無新 skill baseline**

對 setup agent 要求「直接完成並 commit」；對 unresolved agent 施加「雖未拍板仍正式存卡」壓力；對 supersede agent 要求「沿用相似關係並保留原文」。不得提供期望答案或新 skill 路徑。

- [ ] **Step 3: 保存原始輸出並確認 RED**

Expected: 至少一個 baseline 出現下列任一失敗：規則覆寫、未人審即正式化／commit、自造不相容 schema（資料結構）、敏感值未遮罩、改寫舊正文、或把相似度持久化。若三者全都自然合規，停止 skill 寫作並重設有效壓力情境。

### Task 2: `setup-decision-wiki` skill and portable assets

**Files:**
- Create: `skills/setup-decision-wiki/SKILL.md`
- Create: `skills/setup-decision-wiki/agents/openai.yaml`
- Create: `skills/setup-decision-wiki/assets/docs/decisions/README.md`
- Create: `skills/setup-decision-wiki/assets/docs/decisions/INDEX.md`
- Create: `skills/setup-decision-wiki/assets/docs/decisions/_draft/README.md`
- Create: `skills/setup-decision-wiki/assets/scripts/validate-decisions.mjs`
- Create: `skills/setup-decision-wiki/assets/tests/validate-decisions.test.mjs`
- Modify: `docs/superpowers/specs/2026-07-11-shared-decision-wiki-skills-design.md`

**Interfaces:**
- Consumes: Task 1 setup baseline、現行 `docs/decisions/README.md` 契約、`scripts/validate-decisions.ts` 行為。
- Produces: 可由 agent 複製到任意 Node.js 18+ Git repo 的骨架與 `node scripts/validate-decisions.mjs [repo-root]` gate（關卡）。

- [ ] **Step 1: 用官方初始化器建立 skill scaffold（骨架）**

Run:

```bash
python3 /home/haha/.codex/skills/.system/skill-creator/scripts/init_skill.py setup-decision-wiki --path skills --resources assets --interface 'display_name=Setup Decision Wiki' --interface 'short_description=Install or upgrade a Git decision wiki safely' --interface 'default_prompt=Use $setup-decision-wiki to install a reviewed decision Wiki in this repository.'
```

Expected: 產生 `SKILL.md`、`agents/openai.yaml`、`assets/`，沒有其他範例檔。

- [ ] **Step 2: 先寫 portable validator 的失敗測試**

測試使用 `node:test` 建立暫存 repo，至少覆蓋：零卡骨架、合法正式卡、來源 hash、禁止 similarity 欄位、正式卡不可指向草稿、supersedes/status 一致性、精確 INDEX local link（本機連結）、重複／未知／草稿索引列、CLI JSON 與非零 exit。

Run:

```bash
node --test skills/setup-decision-wiki/assets/tests/validate-decisions.test.mjs
```

Expected: FAIL，原因是 `../scripts/validate-decisions.mjs` 尚不存在。

- [ ] **Step 3: 建立最小 portable validator 與骨架資產**

以現行 TypeScript validator 的已測行為生成零 runtime dependency（執行期相依）ESM 檔，保留 `validateDecisionWiki(repoRoot)` export（匯出）與 direct CLI（直接命令列）入口。模板 INDEX 的正式表格為空；README 與 `_draft/README.md` 保留正式／草稿邊界、四種人工關係、來源 hash 及不可改寫沿革規則。

- [ ] **Step 4: 撰寫 skill workflow**

`SKILL.md` 必須依序要求：定位 repo → 讀既有規則／INDEX／ADR → Node 版本 gate → install/upgrade 分流 → 暫存 patch 與完整 preview（預覽）→ 規則草稿另行人審 → 套用 → 跑 asset tests、portable validator 及 repo gates。既有 validator 有效時沿用；不得自動 commit。

- [ ] **Step 5: GREEN 與 metadata 驗證**

Run:

```bash
node --test skills/setup-decision-wiki/assets/tests/validate-decisions.test.mjs
python3 /home/haha/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/setup-decision-wiki
rg -n 'TODO|PLACEHOLDER|allowed-tools|/home/haha' skills/setup-decision-wiki
```

Expected: tests 與 quick validator 通過；`rg` 沒有命中。

- [ ] **Step 6: fresh-context forward test（全新情境前向測試）**

讓 fresh agent 使用 `$setup-decision-wiki` 處理另一個含既有規則與 ADR 的 fixture。Expected: 只產生可 review patch、不覆寫規則、不加 DB/MCP、不 commit，且 validator 與 tests 可在 Node.js 18+ 執行。

- [ ] **Step 7: 提交 Task 2**

```bash
git add skills/setup-decision-wiki docs/superpowers/specs/2026-07-11-shared-decision-wiki-skills-design.md
git commit -m "feat(skills): add decision wiki setup workflow"
```

### Task 3: decision-aware `save-decision` skill

**Files:**
- Create: `skills/save-decision/SKILL.md`
- Create: `skills/save-decision/agents/openai.yaml`

**Interfaces:**
- Consumes: Task 1 save baselines；目標 repo 的 `docs/decisions/README.md` 與 `INDEX.md` 是 runtime SSOT（執行期單一真相來源）。
- Produces: 只在已拍板高價值決策下，建立一張待人審草稿並安全接受／取代的跨 client workflow。

- [ ] **Step 1: 用官方初始化器建立 skill scaffold**

Run:

```bash
python3 /home/haha/.codex/skills/.system/skill-creator/scripts/init_skill.py save-decision --path skills --interface 'display_name=Save Decision' --interface 'short_description=Capture an approved decision with provenance' --interface 'default_prompt=Use $save-decision to draft the settled decision from this session.'
```

- [ ] **Step 2: 撰寫只修正 RED 失敗的最小 workflow**

正文固定包含 trigger gate（觸發關卡）、讀 repo 契約、one-card/one-decision、UTC ID、遮罩與 SHA-256、完整 draft preview、敏感內容二次確認、四種人工 edge（關係邊）、接受與 validator gate、supersede append-only（只追加）及 explicit commit authorization（明確提交授權）。缺骨架時轉用 `setup-decision-wiki`；未拍板時只回報尚不能存卡。

- [ ] **Step 3: 驗證格式與禁用舊契約**

Run:

```bash
python3 /home/haha/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/save-decision
rg -n 'SCHEMA\.md|YYYY-MM-DD-<slug>|decision_card_validate|decision_index_gen|allowed-tools|/commit|cc_memory_save|superseded_by' skills/save-decision
```

Expected: quick validator 通過；`rg` 沒有命中。

- [ ] **Step 4: fresh-context forward tests**

重跑未拍板與敏感 supersede 變體。Expected: 未拍板不寫正式卡、不 commit；翻案建立新 proposed 卡、只規劃舊卡 status 更新、不改正文，密鑰遮罩後才 hash，similarity 不持久化。

- [ ] **Step 5: 提交 Task 3**

```bash
git add skills/save-decision
git commit -m "feat(skills): share decision capture workflow"
```

### Task 4: safe cross-client installer

**Files:**
- Create: `scripts/install-decision-skills.sh`
- Create: `tests/scripts/install-decision-skills.test.sh`

**Interfaces:**
- Consumes: canonical `skills/setup-decision-wiki` 與 `skills/save-decision`。
- Produces: `--check`（預設）與明確 `--install`；支援 `--claude-root`、`--codex-root`、`--port-root`、`--backup-root` 測試／部署覆寫。

- [ ] **Step 1: 先寫 installer shell test（殼層測試）**

測試在 `mktemp -d` 中驗證：缺少目的端時 check 失敗；install 建立三端；相同內容 check 成功；手動漂移後 check 拒絕；再次 install 先把舊內容備份；其他 skill 不變；三端每個 canonical tree hash 相同。

Run:

```bash
bash tests/scripts/install-decision-skills.test.sh
```

Expected: FAIL，原因是 installer 尚不存在。

- [ ] **Step 2: 實作 hash gate、backup 與同步**

腳本以自身路徑推導 repo root，hash 使用相對檔名與 SHA-256；check mode 不寫入。`--install` 對不同目的端先移到 `<backup-root>/<UTC timestamp>/<target-label>/<skill>`，再複製 canonical，最後重新 hash；不操作名單外 skill。

- [ ] **Step 3: GREEN 與 shell syntax**

Run:

```bash
bash -n scripts/install-decision-skills.sh tests/scripts/install-decision-skills.test.sh
bash tests/scripts/install-decision-skills.test.sh
```

Expected: 全部 exit 0，測試最後輸出 `install-decision-skills: PASS`。

- [ ] **Step 4: 提交 Task 4**

```bash
git add scripts/install-decision-skills.sh tests/scripts/install-decision-skills.test.sh
git commit -m "feat(skills): add safe cross-client installer"
```

### Task 5: integration verification, review, merge, install, cleanup

**Files:**
- Modify only if review finds a proven issue: files created in Tasks 2–4.
- Install outside repo after merge: Claude Code、Codex 與 compatibility mirror skill directories.

**Interfaces:**
- Consumes: Tasks 2–4 commits and independent review findings.
- Produces: merged canonical skills、three verified installed copies、removed temporary worktree。

- [ ] **Step 1: 執行完整 repo gates**

Run:

```bash
node --test skills/setup-decision-wiki/assets/tests/validate-decisions.test.mjs
bash tests/scripts/install-decision-skills.test.sh
python3 /home/haha/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/setup-decision-wiki
python3 /home/haha/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/save-decision
npm exec vitest run tests/scripts/validate-decisions.test.ts
npm run decisions:validate
npm run typecheck
npm run lint
npm run build
git diff --check main...HEAD
```

Expected: portable/installer/skill/decision/typecheck/build 通過；lint 0 errors（可保留已知既有 warnings）。

- [ ] **Step 2: independent whole-branch review**

Reviewer 逐條核對核准 spec、RED/GREEN artifacts、tree hash、安全邊界、source redaction（來源遮罩）、formal/draft boundary（正式／草稿邊界）與 no-auto-commit。Critical／Important finding 必須修正並重審。

- [ ] **Step 3: 合併到 main 並重跑關鍵 gates**

在主 repo 保留使用者既有未提交檔案，使用 fast-forward 或一般 merge（不 stash、不 reset）。合併後重跑 portable test、installer test、quick validators 與現行 decision validator。

- [ ] **Step 4: 明確安裝並驗證三端 tree hash**

Run:

```bash
scripts/install-decision-skills.sh --install --port-root ../doc/claude-codex-port/skills
scripts/install-decision-skills.sh --check --port-root ../doc/claude-codex-port/skills
```

Expected: 舊版 `save-decision` 已進 timestamp backup；六個 destination tree（2 skills × 3 targets）全部等於 canonical。

- [ ] **Step 5: 刪除 temporary worktree**

從主 repo 執行 `git worktree remove /tmp/cc-memory-decision-skills` 與 `git worktree prune`。確認 `git worktree list` 不再含該路徑，且使用者原有 dirty files（髒檔案）仍在。
