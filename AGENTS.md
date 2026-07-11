# Repository Guidelines

## 專案結構與模組配置

CC-memory 是以 TypeScript（型別化 JavaScript）實作的 MCP（Model Context Protocol，模型上下文協定）伺服器。`src/index.ts` 是工具註冊與分派入口；`src/services/` 放領域邏輯；`src/tools/` 放記憶工具；`src/db/` 管理 Drizzle ORM（物件關聯對映工具）與資料存取；`src/utils/` 放共用函式。維運腳本放 `scripts/`，版本化資料庫遷移放 `sql/migrations/`，Claude 整合放 `hooks/` 與 `skills/`，測試依對應模組放在 `tests/`。`build/` 是產生物，不直接編輯。先讀 `docs/INDEX.md`，只依 active（現行）規格工作。

## 建置、測試與本機開發

```bash
npm ci                 # 依鎖定檔安裝固定版本
npm run dev            # 監看並編譯
npm run build          # 編譯至 build/
npm start              # 啟動已編譯的 MCP 伺服器
npm run typecheck      # 檢查 src/、scripts/、tests/
npm run lint           # 執行 ESLint（靜態程式碼檢查）
npm run test:ci        # 單次執行 Vitest（測試執行器），對齊 CI（持續整合）
```

整合測試需要 PostgreSQL（關聯式資料庫）與 pgvector（向量擴充模組）：

```bash
docker compose -f docker-compose.test.yml up -d
npx tsx scripts/test-db-setup.ts
npm run test:ci
```

## 程式風格與命名

使用 TypeScript 嚴格模式、NodeNext ESM（ECMAScript 模組）、兩格縮排、單引號、尾逗號；相對匯入保留 `.js` 副檔名。檔名用 kebab-case（連字號命名），函式與變數用 `camelCase`，型別用 `PascalCase`，常數用具描述性的全大寫名稱。送審前執行 `npm run typecheck && npm run lint`。`src/db/schema.ts` 是 schema（資料結構定義）的唯一真相來源；用 Drizzle 產生遷移，不手寫 `CREATE TABLE` 或 SQL（結構化查詢語言）function（資料庫函式）。

## 測試規範

測試檔命名為 `*.test.ts`，置於 `tests/` 的對應區域。修正缺陷時加入回歸測試，資料範圍或安全邏輯須同時覆蓋成功與拒絕／錯誤路徑。目前沒有數字化 coverage（覆蓋率）門檻。資料庫不可用時整合測試必須明確失敗，不可靜默略過。

## 核心架構與安全界線

- 所有查詢必須以 `projectId` 隔離；`__personal__` 是保留命名空間，一般 project mode（專案模式）不得存取，包含全專案搜尋。
- 除 `cc_memory_search` 外，MCP 工具缺少 `project_id` 或 `project_path` 時須 fail-fast（遇錯立即失敗）；不可用伺服器工作目錄猜測客戶端專案。
- 刪除維持 soft delete（軟刪除），將狀態設為 `archived`。
- `CC_READ_ONLY` 與 `CC_TOOL_ALLOWLIST` 的限制必須同時落在工具清單可見性與 handler（處理器）拒絕兩層。
- `CC_FORCE_PROJECT_ID` 與 `CC_MEMORY_PROJECT_ID` 互斥；強制使用 `__personal__` 時必須設定 `DATABASE_URL_PERSONAL`。
- `cc_todoist_*` 只有在 `TODOIST_API_TOKEN` 與 forced personal（強制個人模式）同時成立時才可啟用。

## Commit（提交）與 Pull Request（合併請求）規範

沿用 Conventional Commits（約定式提交）及里程碑 scope（範圍），例如 `feat(v0.5-m4): ...`、`fix(v0.5): ...`、`test: ...`、`docs: ...`、`chore: ...`。每次提交只處理一個焦點。合併請求需交代問題、解法、相關 issue（議題）或規格、驗證命令，以及遷移、環境變數與 rollback（回復）影響；只有視覺輸出需要截圖，其餘附精簡日誌或範例。

## Agent（代理程式）與文件規則

動工前讀 `CLAUDE.md` 與 `docs/INDEX.md`，並保留工作樹中無關的既有變更。對話、文件、提交訊息與合併請求中，英文技術術語第一次出現時立即附繁體中文短註，同段同詞不重複；程式 identifier（識別字）保持原樣，且不得因簡化而改變條件、風險或責任邊界。若漏註，下一則回覆前三行內先更正。多步驟實作、長時間命令或 review（審查）流程結束時，在回覆最下方追加精簡的「本輪總結」。

## 決策文件工作流程

- 在進行重大架構、系統行為或 config（設定）決策前，先讀 `docs/decisions/INDEX.md` 與相關決策卡。
- 只有使用者或負責人明確拍板的決策，才可寫入 `docs/decisions/_draft/`；agent（代理程式）不得自行接受決策。
- 若新討論只與既有決策卡相似，只能標為「未持久化推測」，不得視為已接受的決策。
- `supersedes`（取代）、`depends_on`（依賴）、`conflicts_with`（衝突）與 `related_to`（相關）四種持久化關係都須人工確認，不得由 agent 自動判定。
- 翻案時必須建立新卡，並以 `supersedes` 指向舊卡；不得直接改寫舊卡來掩蓋歷史。
- 決策接受後，須在同一個 commit（提交）更新 `docs/decisions/INDEX.md`，並執行 `npm run decisions:validate`。
