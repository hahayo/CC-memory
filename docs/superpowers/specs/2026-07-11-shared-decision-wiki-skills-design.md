# Shared Decision Wiki Skills Design

> Status：APPROVED（已核准）。使用者於 2026-07-11 書面核准本設計並授權進入實作。

## 目標

把 CC-memory 已落地的 decision-aware Wiki（理解決策脈絡的 Wiki）流程封裝成兩個可重用 skill（技能），由同一份 Git canonical（版本控制權威來源）安裝給 Claude Code 與 Codex：

1. `setup-decision-wiki`：在 Git repo（程式碼儲存庫）建立或升級決策 Wiki。
2. `save-decision`：把已明確拍板的高價值決策存成草稿，經人審後接受、建立關係與提交。

不新增 DB（資料庫）、MCP（模型情境協定）、hook（事件掛鉤）或 session-end（工作階段結束）自動寫卡。

## 現況與問題

目前 `save-decision/SKILL.md` 同時存在於 `~/.claude/skills`、`~/.codex/skills` 與 `CC_project/doc/claude-codex-port/skills`。三份 hash（雜湊）相同，但只是獨立 copy（複本），且沒有 Git 權威來源；既有 installer（安裝器）可把後續新版覆蓋回舊版。

舊 skill 也與新契約不相容：使用 `YYYY-MM-DD-slug`、`SCHEMA.md`、Python validator（驗證器）與舊 supersede（取代）欄位，而 CC-memory 現行契約使用 `DEC-<UTC>-<slug>`、`docs/decisions/README.md`、四種持久化關係及 `npm run decisions:validate`。

## 方案比較與裁決

| 方案 | 優點 | 風險 | 裁決 |
|---|---|---|---|
| 以 `~/.claude/skills` 為權威再複製 | 延續現況 | 不在 Git；跨機器與回滾弱 | 不採用 |
| Claude／Codex 都 symlink（符號連結）到單一目錄 | 真正單份檔案 | 路徑綁機器；installer 與 discovery（技能發現）相容風險 | 不採用 |
| 以 CC-memory `skills/` 為 Git 權威，安全 installer 複製 | 可 review、回滾、跨裝置；符合現有 repo 所有權 | 安裝後仍需 drift check（漂移檢查） | **採用** |

## 架構與檔案

```text
CC-memory/
├── skills/
│   ├── setup-decision-wiki/
│   │   ├── SKILL.md
│   │   ├── agents/openai.yaml
│   │   └── assets/
│   │       ├── docs/decisions/...
│   │       ├── scripts/validate-decisions.mjs
│   │       └── tests/validate-decisions.test.mjs
│   └── save-decision/
│       ├── SKILL.md
│       └── agents/openai.yaml
└── scripts/install-decision-skills.sh
```

Canonical skill 只使用跨 client（客戶端）共同欄位 `name`、`description`；不保留 Claude 專屬 `allowed-tools`，也不依賴 `/commit` 或 `AskUserQuestion` 等單一 runtime（執行環境）介面。

安裝目標：

- `~/.claude/skills/{setup-decision-wiki,save-decision}`
- `~/.codex/skills/{setup-decision-wiki,save-decision}`
- `CC_project/doc/claude-codex-port/skills/{setup-decision-wiki,save-decision}`（相容既有 port installer）

Installer 預設比較 source/destination tree hash（來源／目的目錄樹雜湊）：完全相同即成功；目的端不同則顯示差異並停止，不靜默覆寫。明確 `--install` 時先備份既有兩個 skill 至 `$HOME/backups/decision-skills/<timestamp>/`，再同步並驗證三端 hash 一致；不刪除其他 skill。

## `setup-decision-wiki` 行為

1. 從 `git rev-parse --show-toplevel` 定位 repo，先讀 `AGENTS.md`、`CLAUDE.md`、`docs/INDEX.md` 與既有 decision/ADR（決策紀錄）。
2. 若 `docs/decisions/README.md` 已存在，走 upgrade（升級）盤點，不重建、不覆寫；現有正式卡保持原位。
3. 若尚未安裝，先在暫存目錄產生完整 patch（修補內容）：決策契約、INDEX、`_draft/README.md`、portable validator（可攜驗證器）與測試。
4. 新 repo 預設使用零相依 Node.js 18+ `.mjs` validator 與 `node:test`；若 repo 已有自己的有效 validator，沿用而不複製。若沒有 Node.js 18+，停止並要求使用者選擇驗證 runtime，不做 docs-only 半套安裝。
5. `CLAUDE.md`／`AGENTS.md` 的共同規則一定 draft-first（先起草），全文或 diff 經人審後才套用。
6. 只把明確既有 ADR 登錄為 accepted（已接受）；其他 spec／plan／memory 決策只能去重後放 `_draft/`，不得自動接受。
7. 套用後執行 portable validator、測試與 repo 既有 gate；不自動 commit 或 push（推送），除非使用者另行明確授權。

## `save-decision` 行為

1. 觸發於「存決策／save decision／記這個決策／開決策卡／翻案」或高價值選型已明確拍板時；討論選項但未拍板時不得自動寫卡。
2. 每次都重新讀 repo 的 `docs/decisions/README.md` 與 INDEX，以 repo 契約為準；缺少骨架時轉交 `setup-decision-wiki`，不自行造半套。
3. 一張卡只記一個決策。建立 `DEC-YYYYMMDDTHHMMSSZ-<slug>`、`status: proposed` 草稿，包含背景、替代方案、決策、理由、後果及來源。
4. 來源只保留已 redaction（遮罩）的短摘錄、locator（定位資訊）及 SHA-256；不保存完整 transcript（逐字紀錄）。敏感內容須二次確認。
5. Semantic similarity（語意相似度）只可標為未持久化推測；`supersedes`、`depends_on`、`conflicts_with`、`related_to` 都須人工確認。
6. 顯示完整草稿。只有使用者明確接受後，才改為 `active`、移出 `_draft/`、以精確 `./<id>.md` 更新 INDEX 並執行 validator。
7. 翻案建立新卡，以 `supersedes` 指向舊卡，舊卡只改狀態，不改寫正文。
8. Validator 非零即停止；提交只包含卡片、必要的舊卡 status 與 INDEX，且必須另有明確提交授權。

## Skill TDD（技能測試驅動開發）

寫 skill 前先用 fresh subagent（全新子代理）跑無 skill baseline（基準）：

- 安裝情境：已有 `CLAUDE.md`、ADR 與髒工作樹，要求建立決策 Wiki；觀察是否覆寫規則、漏人審、加入 DB/MCP 或沒有 validator。
- 存卡情境：只有討論、尚未拍板；觀察是否過早建立正式卡或自動 commit。
- 翻案／敏感情境：新決策取代舊卡且摘錄含密鑰樣式；觀察是否改寫歷史、漏遮罩或把相似度直接存成關係。

GREEN（通過）標準：skill 能在隔離 fixture（測試夾具）中遵守 draft-first、來源 hash、正式／草稿邊界、四種人工關係、validator gate 與無自動 commit。每個 skill 通過 `quick_validate.py`、portable validator 自測，以及至少一輪 fresh-context forward test（全新情境前向測試）。

## 相容性、回滾與非目標

- Skill 內不寫死 `/home/haha` 或 CC-memory repo 絕對路徑；installer 才從自身位置推導 canonical root。
- 安裝前備份目的端；回滾可由 Git checkout（版本取回）canonical 版本後重新安裝，或還原 timestamp backup（時間戳備份）。
- 不把 validator 邏輯重寫進 SKILL.md；以 asset（輸出資產）執行，降低 context（情境）消耗。
- v1 不做自動 session 掃描、語意搜尋服務、跨 repo 關係、團隊 RBAC（角色權限）或完整 transcript 儲存。

## 驗收

1. Canonical 兩個 skill 通過 `quick_validate.py`，且沒有 placeholder（佔位內容）。
2. Portable validator 與測試在空白 fixture 通過。
3. Installer 的 check、drift refusal（漂移拒絕）、backup、install、三端 hash 一致均有 shell 測試。
4. Claude Code 與 Codex 的已安裝 `SKILL.md` hash 均等於 canonical。
5. 使用兩個 fresh agent 分別跑 setup 與 save forward test，沒有 Critical／Important finding（嚴重／重要問題）。
6. CC-memory 現行 `npm run decisions:validate`、47 個決策測試、typecheck（型別檢查）、lint（靜態檢查）與 build（建置）維持通過。
