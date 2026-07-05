> **[ARCHIVED（已歸檔）2026-07-05]** v0.1 部署前置 checklist（2026-02），項目已全數完成且內容過時，2026-02-07 後未再維護。僅供歷史參考；現況入口見 `docs/INDEX.md`。

# CC-memory 待完成清單

## 已完成功能

### pgvector + Gemini Embedding 整合（2026-02-02）

- [x] 安裝 `@google/genai` 依賴
- [x] 新增 `src/utils/embedding.ts` - Embedding 工具模組
- [x] 更新 `src/config.ts` - 新增 Gemini API 設定
- [x] 更新 `src/db/schema.ts` - 新增 embedding 欄位和 HNSW 索引
- [x] 修改 `src/tools/save.ts` - 儲存時自動生成 embedding
- [x] 修改 `src/tools/search.ts` - 支援 keyword/semantic/hybrid 搜尋模式
- [x] 更新 `src/index.ts` - MCP 工具新增 mode 參數
- [x] 新增 `scripts/backfill-embeddings.ts` - 批次生成 embedding 腳本
- [x] 更新測試和文件

---

## 部署前置作業

### 1. 設定 PostgreSQL 資料庫

- [x] 在 Zeabur 建立 PostgreSQL 服務（2026-02-03）
  - Host: cgk1.clusters.zeabur.com:27784
  - Database: zeabur

### 2. 啟用 pgvector 擴充

- [x] 已啟用（2026-02-03）

### 3. 建立 .env 檔案

- [x] 已建立（2026-02-03）

### 4. 推送 Schema 到資料庫

- [x] 已推送（2026-02-03）
  - project_memories 表已建立（14 欄位含 embedding）

### 5. 驗證資料庫連線

- [x] 已驗證（2026-02-03）

---

## Claude Code 整合

### 6. 配置 MCP Server

- [x] 已配置全域 MCP Server（2026-02-07）

### 7. 安裝 Skills

- [x] 已安裝至 `~/.claude/skills/`（2026-02-07）

### 8. 配置 Hooks

- [x] SessionEnd hook 已配置（2026-02-07）
  - 提醒用戶執行 `/save-memory`
- session-start hook 維持關閉（避免增加啟動時間）

### 8.5. 為所有專案加入 Project ID 標記

- [x] 12 個專案的 CLAUDE.md 皆已加入 `<!-- cc-memory: project="xxx" -->` 標記（2026-02-07）

---

## 功能驗證

### 9. 測試 MCP Tools

- [x] `cc_memory_save` - 儲存記憶 + embedding 生成 ✓
- [x] `cc_memory_search` - 搜尋記憶
  - [x] mode=keyword - 關鍵字搜尋 ✓
  - [x] mode=semantic - 語義搜尋 ✓（Gemini embedding 已啟用）
  - [x] mode=hybrid - 混合搜尋 ✓
- [x] `cc_memory_list` - 列出專案記憶
- [x] `cc_memory_get` - 取得單一記憶
- [x] `cc_memory_stats` - 查看統計
- [x] `cc_memory_delete` - 刪除記憶（軟刪除確認正常）

### 10. Backfill Embeddings（如果有舊資料）

```bash
npm run backfill:embeddings
```

為現有記憶批次生成 embedding。

### 11. 測試 Skills

- [x] `/save-memory` - 已安裝，端對端流程驗證通過（手動模擬）
- [x] `/load-memory` - 已安裝，端對端流程驗證通過（手動模擬）
- 注意：Skills 需在新 session 才會自動載入

---

## 完成日期

- 基礎功能實作完成：2026-02-01
- 語義搜尋功能實作完成：2026-02-02
- 部署完成：2026-02-07
