# CC-memory 設定指南

## 前置需求

- Node.js 18+
- Claude Code CLI
- Supabase 帳號（免費）

## 步驟 1: 安裝專案

```bash
git clone https://github.com/yourusername/CC-memory.git
cd CC-memory
npm install
npm run build
```

## 步驟 2: 設定 Supabase

### 2.1 建立專案

1. 前往 [Supabase](https://supabase.com)
2. 建立新專案（免費方案）
3. 等待專案初始化完成

### 2.2 執行 Schema

1. 進入 Supabase Dashboard
2. 點選 SQL Editor
3. 複製 `sql/schema.sql` 的內容
4. 執行 SQL

### 2.3 取得連線資訊

1. 進入 Settings > API
2. 複製：
   - Project URL（`SUPABASE_URL`）
   - anon public key（`SUPABASE_KEY`）

## 步驟 3: 配置 Claude Code

### 3.1 加入 MCP Server

```bash
claude mcp add cc-memory \
  -e SUPABASE_URL=https://your-project.supabase.co \
  -e SUPABASE_KEY=your-anon-key \
  -- node /path/to/CC-memory/build/index.js
```

### 3.2 驗證安裝

```bash
claude mcp list
# 應該看到 cc-memory
```

### 3.3 安裝 Skill

```bash
# 複製 skill 到 Claude Code skills 目錄
cp skills/extract-memory.md ~/.claude/skills/
```

## 步驟 4: 測試

啟動 Claude Code 並測試：

```
# 測試儲存
請幫我儲存一個測試記憶到 CC-memory

# 測試搜尋
搜尋 CC-memory 中關於 "測試" 的記憶

# 測試列出專案
列出所有有記憶的專案
```

## 環境變數

| 變數 | 說明 | 必填 |
|------|------|------|
| `SUPABASE_URL` | Supabase 專案 URL | ✅ |
| `SUPABASE_KEY` | Supabase anon key | ✅ |

## 多台電腦設定

在每台電腦上：

1. Clone 專案並 build
2. 使用**相同的** Supabase URL 和 Key
3. 加入 MCP Server

所有電腦會自動共享同一個資料庫，記憶自動同步。

## Dev Container 設定

在 `.devcontainer/devcontainer.json` 中加入：

```json
{
  "mounts": [
    "source=${localEnv:HOME}/.claude,target=/root/.claude,type=bind"
  ],
  "containerEnv": {
    "SUPABASE_URL": "${localEnv:SUPABASE_URL}",
    "SUPABASE_KEY": "${localEnv:SUPABASE_KEY}"
  }
}
```

## 故障排除

### MCP Server 無法啟動

檢查：
- Node.js 版本是否 >= 18
- 環境變數是否正確設定
- build 是否成功

### 資料庫連線失敗

檢查：
- Supabase URL 是否正確
- Supabase Key 是否正確
- 網路是否能連到 Supabase

### 向量搜尋無結果

確認：
- schema.sql 已執行
- pgvector 擴展已啟用
- 記憶有包含 embedding
