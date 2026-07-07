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
git clone https://github.com/hahayo/CC-memory.git
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

### 2. 建 SSH tunnel 連線（取代「Make it public」）

> **設計選擇變更**：原計畫用 Coolify「Make it public」公開 PG port，**否決**——明文 PostgreSQL protocol（網路通訊協定）+ challenge-response 認證不防 query 內容竊聽。改走 **SSH tunnel + 限制權限的 `pgtunnel` user**：DB bind 127.0.0.1（loopback，不暴露公網），client 透過 SSH local port forward 到 server 的 loopback 5432。Codex 對審後拍板（每台 client 獨立 key、sshd `PermitOpen` 鎖死、DB 最小權限、autossh 監控）。

> 同樣否決的方案：Tailscale（公司網路對控制面 DPI 阻擋實測過）、自架 WireGuard（公司網路擋 UDP 機率高）。

#### 2a. Server 端：建 `pgtunnel` user（一次性，per server）

無 shell、無 TTY、只能 port forward 到 127.0.0.1:5432：

```bash
# 在 Coolify server 上(root)
sudo useradd -m -s /bin/false pgtunnel
sudo -u pgtunnel mkdir -p ~pgtunnel/.ssh
sudo -u pgtunnel touch ~pgtunnel/.ssh/authorized_keys
sudo chmod 700 ~pgtunnel/.ssh
sudo chmod 600 ~pgtunnel/.ssh/authorized_keys

# sshd_config drop-in: 把 pgtunnel user 鎖到只能轉 127.0.0.1:5432
sudo tee /etc/ssh/sshd_config.d/60-pgtunnel.conf >/dev/null <<'EOF'
Match User pgtunnel
    PermitOpen 127.0.0.1:5432
    PermitTTY no
    AllowAgentForwarding no
    AllowTcpForwarding yes
    X11Forwarding no
    ForceCommand /bin/false
EOF

# 必先 sshd -t 驗 syntax,再 reload (broken config 直接 reload 會鎖住 sshd)
sudo sshd -t && sudo systemctl reload ssh
```

> ⚠️ 改任何 `sshd_config` 都先 `sshd -t`（dry-run 驗 syntax）再 reload。broken config 直接 reload 把 sshd 鎖住，過往救援要走 OVH KVM rescue mode（救援開機模式）回主 OS。
>
> ⚠️ **絕對不要 `rm /root/.ssh/authorized_keys`** —— Coolify 自己用來連 server 的 SSH key 也在這檔，砍掉 Coolify Web Terminal 跟所有 deploy 全壞，要走 rescue mode 重新 mount 把 key 加回去。

#### 2b. Client 端：每台獨立 key + autossh

每台機器跑一次：

```bash
# 1) 產一把專屬 key (不重用個人 SSH key,方便日後單台 revoke)
ssh-keygen -t ed25519 -C "$(hostname)-cc-memory-tunnel" -f ~/.ssh/cc_memory_tunnel

# 2) 把 pubkey 內容貼給 server admin,加進 /home/pgtunnel/.ssh/authorized_keys
cat ~/.ssh/cc_memory_tunnel.pub

# 3) 裝 autossh
sudo apt install -y autossh  # 或對應 package manager (brew install autossh / 等)

# 4) 加進 ~/.bashrc (idempotent guard, 重複 source 不會啟動第二支)
cat >> ~/.bashrc <<'EOF'

# cc-memory SSH tunnel to Coolify PG (idempotent; autossh 保活, 斷線自動重連)
if command -v autossh >/dev/null 2>&1; then
    if ! pgrep -x autossh >/dev/null 2>&1; then
        autossh -M 0 -f -N \
            -o ServerAliveInterval=30 \
            -o ServerAliveCountMax=3 \
            -o ExitOnForwardFailure=yes \
            -o StrictHostKeyChecking=accept-new \
            -L 15432:127.0.0.1:5432 \
            -i "$HOME/.ssh/cc_memory_tunnel" \
            pgtunnel@<your-coolify-host> \
            >> "$HOME/.cc-memory-tunnel.log" 2>&1
    fi
fi
EOF

# 5) 開新 terminal 觸發啟動, 確認 listener
source ~/.bashrc
ss -tnl | grep 15432   # 應該看到 127.0.0.1:15432 LISTEN
pgrep -x autossh       # 應該看到 1 個 pid
```

Connection string 寫進本機 `DATABASE_URL_PERSONAL`（指 loopback、不需要 TLS）：

```
postgres://cc_memory:<password>@127.0.0.1:15432/cc_memory_personal?sslmode=disable
```

> 為什麼 `sslmode=disable`：流量已在 SSH tunnel（加密 channel）內、loopback 不過網路介面，PG 端再加 TLS 是 double-encryption（雙重加密）多餘開銷。

### 3. Restore 既有 dump（從 Zeabur 搬家）

⚠️ **Dump 來源是 Zeabur 上的 personal DB**（service `cc-memory-personal`），不是 project DB（service `postgresql`）。兩個 DB 在 Zeabur 是分開的 service，搬到 Coolify 只搬 personal；project DB 待後續另做。

⚠️ **不要塞進 `/docker-entrypoint-initdb.d`** —— 那個只在**空 volume 首次啟動**時跑一次，dump restore 該用獨立流程。

```bash
# 從 Coolify 抓到的連線字串塞進環境變數（不要 echo 出來）
read -rs -p "Paste Coolify NEW_URL: " NEW_URL
export NEW_URL

# 用對齊版本的 pg_restore：dump 是 PG 18 出的，必須 PG 18 client
docker run --rm -v "$(pwd):/work" -w /work postgres:18 \
  pg_restore --clean --if-exists --no-owner --no-acl \
  -d "$NEW_URL" zeabur-personal.dump

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
