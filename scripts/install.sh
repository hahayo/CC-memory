#!/bin/bash
# CC-memory 安裝腳本（v0.2 更新：移除 Supabase，改用 Drizzle + 任意 PG）

set -e

echo "🧠 CC-memory 安裝腳本"
echo "========================"

# 檢查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安裝，請先安裝 Node.js 18+"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 版本需要 18+，目前版本: $(node -v)"
    exit 1
fi
echo "✓ Node.js $(node -v)"

# 檢查 Claude Code
if ! command -v claude &> /dev/null; then
    echo "❌ Claude Code CLI 未安裝"
    exit 1
fi
echo "✓ Claude Code CLI"

# 安裝依賴
echo ""
echo "📦 安裝依賴..."
npm install

# 建置
echo ""
echo "🔨 建置專案..."
npm run build

PROJECT_PATH=$(pwd)

echo ""
echo "✅ 建置完成！"
echo ""
echo "📋 接下來的步驟："
echo ""
echo "1. 準備 PostgreSQL（Zeabur / Supabase / 自架皆可）："
echo "   - 啟用 pgvector extension（baseline migration 會自動執行，但需 superuser 權限）"
echo ""
echo "2. 設定環境變數："
echo "   export DATABASE_URL='postgresql://user:pass@host:5432/db'"
echo ""
echo "3. 套用 schema（Drizzle 為唯一真實來源）："
echo "   npx drizzle-kit push"
echo ""
echo "4. 加入 Claude Code MCP Server："
echo ""
echo "   claude mcp add cc-memory \\"
echo "     -e DATABASE_URL=your-connection-string \\"
echo "     -- node $PROJECT_PATH/build/index.js"
echo ""
echo "5. 安裝 Skills："
echo ""
echo "   cp $PROJECT_PATH/skills/save-memory.md ~/.claude/skills/"
echo "   cp $PROJECT_PATH/skills/load-memory.md ~/.claude/skills/"
echo ""
echo "6. 重啟 Claude Code 並測試 /save-memory 或 /load-memory"
