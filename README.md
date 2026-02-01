# CC-memory

> Claude Code 專案記憶同步系統 - 跨設備、按專案隔離的智能記憶管理

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 特色

- 🧠 **智能記憶萃取** - 使用 Claude 自動分析和摘要 session 內容
- 📁 **專案隔離** - 每個專案獨立的記憶空間，互不干擾
- ☁️ **雲端同步** - Supabase PostgreSQL，多台電腦自動同步
- 🔍 **語義搜尋** - pgvector 向量搜尋，找到相關記憶
- 💰 **零額外成本** - 使用 Claude Code 自身做 embedding，無需外部 API
- 🔌 **MCP 標準** - 標準 MCP 協議，無端口依賴

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

### 2. 設定 Supabase

1. 建立 [Supabase](https://supabase.com) 專案（免費）
2. 在 SQL Editor 執行 `sql/schema.sql`
3. 取得連線資訊

### 3. 配置 Claude Code

```bash
# 加入 MCP server
claude mcp add cc-memory \
  -e SUPABASE_URL=your-url \
  -e SUPABASE_KEY=your-key \
  -- node /path/to/CC-memory/build/index.js
```

### 4. 安裝 Skill

```bash
cp skills/extract-memory.md ~/.claude/skills/
```

## 使用方式

### 手動萃取記憶

```
/extract-memory
```

### 搜尋記憶

Claude 會自動使用 `cc_memory_search` 工具搜尋相關記憶。

### 列出專案記憶

```
請列出這個專案的所有記憶
```

## MCP Tools

| Tool | 說明 |
|------|------|
| `cc_memory_save` | 儲存記憶到資料庫 |
| `cc_memory_search` | 語義搜尋相關記憶 |
| `cc_memory_list` | 列出專案的所有記憶 |
| `cc_memory_delete` | 刪除指定記憶 |

## 架構

```
Claude Code Session
    ↓
/extract-memory skill (Claude 分析摘要)
    ↓
cc_memory_save (MCP tool)
    ↓
Supabase PostgreSQL + pgvector
    ↓
cc_memory_search (語義搜尋)
    ↓
注入相關 context
```

## 配置選項

環境變數：

| 變數 | 說明 | 必填 |
|------|------|------|
| `SUPABASE_URL` | Supabase 專案 URL | ✅ |
| `SUPABASE_KEY` | Supabase anon key | ✅ |
| `CC_MEMORY_AUTO_EXTRACT` | 自動萃取（預設 false） | ❌ |

## 開發

```bash
# 開發模式
npm run dev

# 測試
npm test

# 建置
npm run build
```

## License

MIT License - 自由使用、修改、分享
