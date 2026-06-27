# CC-memory

> Claude Code 專案記憶同步系統 - 跨設備、按專案隔離的智能記憶管理

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 特色

- 🧠 **智能記憶萃取** - 使用 Claude 自動分析和摘要 session 內容
- 📁 **專案隔離** - 每個專案獨立的記憶空間，互不干擾
- ☁️ **雲端同步** - PostgreSQL 後端，多台電腦自動同步
- 🔍 **關鍵字搜尋** - 快速找到相關記憶
- 🎯 **記憶分類** - Session 記憶與 Decision 決策分開管理
- 🔌 **MCP 標準** - 標準 MCP 協議，與 Claude Code 無縫整合

## 快速開始

### 1. 安裝

```bash
# Clone 專案
git clone https://github.com/yourusername/CC-memory.git
cd CC-memory

# 安裝依賴
npm install

# 建置
npm run build
```

### 2. 設定資料庫

在 Zeabur 或其他服務建立 PostgreSQL 資料庫，然後執行 migration：

```bash
# 設定環境變數
export DATABASE_URL=postgresql://user:password@host:5432/cc_memory

# 推送 schema 到資料庫
npx drizzle-kit push
```

> **Schema 真相來源**：`src/db/schema.ts`（Drizzle ORM）。
> `sql/migrations/` 目錄放 `drizzle-kit generate` 產出的版本化 SQL，**禁止手寫
> `CREATE TABLE` 或 SQL function 維護**。舊有 `sql/schema.sql`（Supabase 版）
> 已於 v0.2 Phase 0 刪除。

### 3. 配置 Claude Code

```bash
# 加入 MCP server
claude mcp add cc-memory \
  -e DATABASE_URL=your-connection-string \
  -- node /path/to/CC-memory/build/index.js
```

### 4. 安裝 Skills

```bash
cp skills/*.md ~/.claude/skills/
```

## 使用方式

### 儲存記憶

```
/save-memory
```

Claude 會分析對話內容，讓你預覽後儲存到資料庫。

### 載入記憶

```
/load-memory
```

載入當前專案的記憶上下文和近期進度。

### 搜尋記憶

Claude 會自動使用 `cc_memory_search` 工具搜尋相關記憶。

```
搜尋關於 "authentication" 的記憶
```

### 列出專案記憶

```
列出這個專案的所有記憶
```

## MCP Tools

| Tool | 說明 |
|------|------|
| `cc_memory_save` | 儲存記憶到資料庫 |
| `cc_memory_search` | 關鍵字搜尋記憶 |
| `cc_memory_list` | 列出專案的記憶 |
| `cc_memory_get` | 取得單一記憶詳情 |
| `cc_memory_stats` | 取得專案統計 |
| `cc_memory_delete` | 刪除指定記憶 |

## 架構

```
Claude Code Session
    ↓
/save-memory skill (Claude 分析摘要)
    ↓
cc_memory_save (MCP tool)
    ↓
PostgreSQL (Drizzle ORM)
    ↓
cc_memory_search / cc_memory_list
    ↓
注入相關 context
```

## 配置選項

環境變數：

| 變數 | 說明 | 必填 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 連線字串（project DB） | ✅ |
| `DATABASE_URL_PERSONAL` | 獨立 personal DB 連線字串（Phase 3；見 `docs/personal-hub/decisions/ADR-001-phase3-separate-db.md`） | forced personal instance 必填；其他 instance 禁配（偵測到 warn + 拒載入該 URL） |

## Coolify 部署（PostgreSQL + pgvector）

> 設計選擇：用 `docker-compose.coolify.yml`，不寫 Dockerfile。`pgvector/pgvector` 已是 official image，自寫 Dockerfile 純粹多出維護面；Coolify 也把 compose 當 single source of truth。

### 1. Coolify 建立 service

1. Coolify Dashboard → **New Resource → Docker Compose Empty**
2. **Source** 接這個 GitHub repo，**Compose file path** 填 `docker-compose.coolify.yml`
3. Environment Variables 區塊可留空（會用 compose 內的 default：`POSTGRES_USER=cc_memory`、`POSTGRES_DB=cc_memory_personal`），或手動覆寫
4. **Deploy** —— `SERVICE_PASSWORD_POSTGRES` 會在第一次部署時隨機生成並寫回 Coolify Environment Variables（之後 restart 不變）

### 2. 開放公網連線

本機 MCP server 是 stdio 跑、要連 Coolify 上的 DB，所以必須開公網：

1. 此 service → **Settings → Make it public**（Coolify 會配發隨機 public port + TLS proxy）
2. 從 Coolify Dashboard 抓 connection string 的 5 個欄位：

| 欄位 | 來源 |
|------|------|
| user | compose default = `cc_memory`（或 env 覆寫） |
| password | 此 service → Environment Variables → `SERVICE_PASSWORD_POSTGRES` |
| host | 此 service → Make it public 後配發的 public host |
| port | 同上配發的 public port |
| dbname | compose default = `cc_memory_personal`（或 env 覆寫） |

組成 standard PostgreSQL URL（記得加 `?sslmode=require`），寫進本機 `DATABASE_URL_PERSONAL`。

### 3. Restore 既有 dump（從 Zeabur 搬家）

⚠️ **不要塞進 `/docker-entrypoint-initdb.d`** —— 那個只在**空 volume 首次啟動**時跑一次，dump restore 該用獨立流程。

```bash
# 從 Coolify 抓到的連線字串塞進環境變數（不要 echo 出來）
read -rs -p "Paste Coolify NEW_URL: " NEW_URL
export NEW_URL

# 用對齊版本的 pg_restore：dump 是 PG 18 出的，必須 PG 18 client
docker run --rm -v "$(pwd):/work" -w /work postgres:18 \
  pg_restore --clean --if-exists --no-owner --no-acl \
  -d "$NEW_URL" zeabur-ccmemory.dump

# 驗證 schema 跟 extension
docker run --rm postgres:18 psql "$NEW_URL" -c "\dt"
docker run --rm postgres:18 psql "$NEW_URL" -c "SELECT extname, extversion FROM pg_extension;"
```

### 4. 推 schema（若 dump 落後最新 migration）

```bash
export DATABASE_URL_PERSONAL="$NEW_URL"
npx drizzle-kit push
```

### 5. MCP server 切到新 DB

把本機 MCP server 設定的 `DATABASE_URL_PERSONAL` 改成新的 Coolify URL，重啟 Claude Code / Codex 即生效。Zeabur 那邊先留著當 fallback，跑一陣子確認穩定再下線。

## 開發

```bash
# 開發模式
npm run dev

# 建置
npm run build

# Drizzle Studio
npx drizzle-kit studio
```

### 測試

Integration tests（`tests/db/v02-tdd.test.ts`）要真 PostgreSQL + pgvector 才能跑，不 silent skip。本機第一次跑測試前：

```bash
# 啟動本機 test PG（pgvector/pg16，port 5433）
docker compose -f docker-compose.test.yml up -d

# 推 schema 進 test DB
npx drizzle-kit push --config drizzle.test.config.ts

# 跑測試
npm test
```

CI 或用現成 test PG 時，設 `TEST_DATABASE_URL` 跳過本機 docker：

```bash
export TEST_DATABASE_URL=postgres://user:pass@host:port/db
npm test
```

若 test PG 不可用，測試會 **fail-loud** 並印出上面的指令作為提示。Embedding 相關測試不依賴 `GEMINI_API_KEY`（用 `vi.mock` 隔離，不會打真 Gemini API）。

## License

MIT License - 自由使用、修改、分享
