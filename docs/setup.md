> **[PARTIALLY STALE（部分過時）2026-07-05]** 本指南以 Zeabur 時代為背景。prod 已於 2026-07-01 全面搬到 Coolify（SSH tunnel 連線，見 `README.md` Coolify 章節與 `docs/personal-hub/prod-runbook.md`）。環境變數全表見 repo 根目錄 `CLAUDE.md`；現況入口見 `docs/INDEX.md`。

# CC-memory 設定指南

## 前置需求

- Node.js 18+
- Claude Code CLI
- PostgreSQL 資料庫（Zeabur、Supabase、或自架）

## 步驟 1: 安裝專案

```bash
git clone https://github.com/yourusername/CC-memory.git
cd CC-memory
npm install
npm run build
```

## 步驟 2: 設定資料庫

### 選項 A: Zeabur（推薦）

1. 前往 [Zeabur](https://zeabur.com)
2. 建立新專案
3. Add Service → Database → PostgreSQL
4. 取得連線字串

### 選項 B: Supabase

1. 前往 [Supabase](https://supabase.com)
2. 建立新專案
3. 進入 Settings > Database
4. 取得 Connection string（Direct connection）

### 選項 C: 自架 PostgreSQL

確保資料庫版本 >= 14。

### 執行 Migration

```bash
# 設定連線字串
export DATABASE_URL=postgresql://user:password@host:5432/cc_memory

# 推送 schema
npx drizzle-kit push
```

## 步驟 3: 配置 Claude Code

### 3.1 加入 MCP Server

```bash
claude mcp add cc-memory \
  -e DATABASE_URL=postgresql://user:password@host:5432/cc_memory \
  -- node /path/to/CC-memory/build/index.js
```

### 3.2 驗證安裝

```bash
claude mcp list
# 應該看到 cc-memory
```

### 3.3 安裝 Skills

```bash
# 複製 skills 到 Claude Code skills 目錄
cp skills/*.md ~/.claude/skills/
```

### 3.4 安裝 Hooks（可選）

```bash
# 複製 hooks 到 Claude Code hooks 目錄
cp hooks/*.json ~/.claude/hooks/
```

## 步驟 4: 測試

啟動 Claude Code 並測試：

```
# 測試儲存
/save-memory

# 測試載入
/load-memory

# 測試搜尋
搜尋關於 "測試" 的記憶
```

## 環境變數

| 變數 | 說明 | 必填 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 連線字串 | ✅ |

## 多台電腦設定

在每台電腦上：

1. Clone 專案並 build
2. 使用**相同的** DATABASE_URL
3. 加入 MCP Server

所有電腦會自動共享同一個資料庫，記憶自動同步。

## 專案識別

CC-memory 會自動偵測專案 ID：

1. 優先檢查 CLAUDE.md 中的標記：
   ```markdown
   <!-- cc-memory: project="my-project" -->
   ```
2. 若無標記，使用目錄名稱

## 故障排除

### MCP Server 無法啟動

檢查：
- Node.js 版本是否 >= 18
- DATABASE_URL 環境變數是否正確設定
- build 是否成功

### 資料庫連線失敗

檢查：
- 連線字串格式是否正確
- 資料庫服務是否運行中
- 網路是否能連到資料庫主機

### 記憶無法儲存

確認：
- drizzle-kit push 已執行
- 資料庫有 project_memories 表
