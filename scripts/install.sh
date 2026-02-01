#!/bin/bash

# CC-memory 安裝腳本

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

# 取得專案路徑
PROJECT_PATH=$(pwd)

echo ""
echo "✅ 建置完成！"
echo ""
echo "📋 接下來的步驟："
echo ""
echo "1. 設定 Supabase："
echo "   - 建立 Supabase 專案"
echo "   - 在 SQL Editor 執行: sql/schema.sql"
echo "   - 取得 URL 和 Key"
echo ""
echo "2. 加入 Claude Code MCP Server："
echo ""
echo "   claude mcp add cc-memory \\"
echo "     -e SUPABASE_URL=your-url \\"
echo "     -e SUPABASE_KEY=your-key \\"
echo "     -- node $PROJECT_PATH/build/index.js"
echo ""
echo "3. 安裝 Skill："
echo ""
echo "   cp $PROJECT_PATH/skills/extract-memory.md ~/.claude/skills/"
echo ""
echo "4. 重啟 Claude Code 並測試"
