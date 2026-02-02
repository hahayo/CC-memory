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

- [ ] 在 Zeabur 建立 PostgreSQL 服務
  1. 登入 [Zeabur Dashboard](https://zeabur.com)
  2. 建立新專案或選擇現有專案
  3. Add Service → Database → PostgreSQL
  4. 取得連線字串

### 2. 啟用 pgvector 擴充

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 3. 建立 .env 檔案

```bash
# 必填
DATABASE_URL=postgresql://user:password@xxx.zeabur.app:5432/cc_memory

# 可選 - 啟用語義搜尋
GEMINI_API_KEY=your_gemini_api_key
```

### 4. 推送 Schema 到資料庫

```bash
npx drizzle-kit push
```

預期結果：成功建立 `project_memories` 表（含 embedding 欄位和 HNSW 索引）

### 5. 驗證資料庫連線

```bash
npx drizzle-kit studio
```

預期結果：可以開啟 Drizzle Studio 查看資料庫

---

## Claude Code 整合

### 6. 配置 MCP Server

```bash
claude mcp add cc-memory \
  -e DATABASE_URL=your-connection-string \
  -e GEMINI_API_KEY=your-api-key \
  -- node /path/to/CC-memory/build/index.js
```

驗證：
```bash
claude mcp list
# 應該看到 cc-memory
```

### 7. 安裝 Skills

```bash
cp skills/*.md ~/.claude/skills/
```

### 8. 安裝 Hooks（可選）

```bash
cp hooks/*.json ~/.claude/hooks/
```

---

## 功能驗證

### 9. 測試 MCP Tools

- [ ] `cc_memory_save` - 儲存一筆測試記憶（確認有/無 embedding）
- [ ] `cc_memory_search` - 搜尋記憶
  - [ ] mode=keyword - 關鍵字搜尋
  - [ ] mode=semantic - 語義搜尋（需 GEMINI_API_KEY）
  - [ ] mode=hybrid - 混合搜尋（預設）
- [ ] `cc_memory_list` - 列出專案記憶
- [ ] `cc_memory_get` - 取得單一記憶
- [ ] `cc_memory_stats` - 查看統計
- [ ] `cc_memory_delete` - 刪除記憶

### 10. Backfill Embeddings（如果有舊資料）

```bash
npm run backfill:embeddings
```

為現有記憶批次生成 embedding。

### 11. 測試 Skills

- [ ] `/save-memory` - 儲存當前 session 記憶
- [ ] `/load-memory` - 載入專案記憶上下文

---

## 完成日期

- 基礎功能實作完成：2026-02-01
- 語義搜尋功能實作完成：2026-02-02
- 部署完成：待填寫
