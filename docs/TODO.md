# CC-memory 待完成清單

## 部署前置作業

### 1. 設定 PostgreSQL 資料庫

- [ ] 在 Zeabur 建立 PostgreSQL 服務
  1. 登入 [Zeabur Dashboard](https://zeabur.com)
  2. 建立新專案或選擇現有專案
  3. Add Service → Database → PostgreSQL
  4. 取得連線字串

### 2. 建立 .env 檔案

```bash
# 在專案根目錄建立 .env
echo "DATABASE_URL=postgresql://user:password@xxx.zeabur.app:5432/cc_memory" > .env
```

### 3. 推送 Schema 到資料庫

```bash
npx drizzle-kit push
```

預期結果：成功建立 `project_memories` 表

### 4. 驗證資料庫連線

```bash
npx drizzle-kit studio
```

預期結果：可以開啟 Drizzle Studio 查看資料庫

---

## Claude Code 整合

### 5. 配置 MCP Server

```bash
claude mcp add cc-memory \
  -e DATABASE_URL=your-connection-string \
  -- node /path/to/CC-memory/build/index.js
```

驗證：
```bash
claude mcp list
# 應該看到 cc-memory
```

### 6. 安裝 Skills

```bash
cp skills/*.md ~/.claude/skills/
```

### 7. 安裝 Hooks（可選）

```bash
cp hooks/*.json ~/.claude/hooks/
```

---

## 功能驗證

### 8. 測試 MCP Tools

- [ ] `cc_memory_save` - 儲存一筆測試記憶
- [ ] `cc_memory_search` - 搜尋記憶
- [ ] `cc_memory_list` - 列出專案記憶
- [ ] `cc_memory_get` - 取得單一記憶
- [ ] `cc_memory_stats` - 查看統計
- [ ] `cc_memory_delete` - 刪除記憶

### 9. 測試 Skills

- [ ] `/save-memory` - 儲存當前 session 記憶
- [ ] `/load-memory` - 載入專案記憶上下文

---

## 完成日期

- 程式碼實作完成：2026-02-01
- 部署完成：待填寫
