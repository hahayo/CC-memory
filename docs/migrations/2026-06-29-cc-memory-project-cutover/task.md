# cc-memory project DB Cutover — Tasks (TDD)

> ✅ **STATUS: EXECUTED (2026-07-01 02:50 GMT+8)** — Plan B 完整跑完 Phase 0-5：
> - Phase 1 catalog cross-check 全對齊 `src/db/schema.ts`（7 tables / 22 indexes / 14 CHECK / 2 FKs / vector(1536) / 77 cols）
> - Codex 雙輪對審 Phase 1 + Phase 4 全 converged（Round 2 全 withdrawn / needs_human = governance out-of-scope）
> - Phase 5 RW round-trip probe 全綠（`cc_memory_save` → psql-verify probe row 落在 Coolify `cc_memory_project` / Zeabur 無此 row → `cc_memory_search` 命中 → `cc_memory_get` 回正確 summary + writer_host → `cc_memory_delete` 軟刪 → post-delete stats 0 active）
> - deployment memory entry 已寫入（`~/.claude/projects/-home-haha-CC-project-CC-memory/memory/deployment-zeabur-prod.md`，含教訓 + rollback flow）
> - Phase 6 Zeabur 不停 service（Step F deferred，1-2 週後再 conscious decision）
>
> ⚠️ **原 STATUS: SUPERSEDED-IN-PART (2026-06-30)** — Actual runbook (實際執行藍本) is [`addendum-2026-06-30-plan-b.md`](./addendum-2026-06-30-plan-b.md).
>
> **History**：Plan A (dump+restore) 於 2026-06-30 Phase 0 discovery 後切到 **Plan B (drizzle-kit push from `src/db/schema.ts`)**。Zeabur project mode DB 從沒實質寫過資料 → dump/restore 無意義。
>
> **本檔角色**：reference anchor，保留 Codex 6 輪對審決策歷程。**不是 actual runbook**。
>
> **SUPERSEDED tasks**：
> - **Phase 2 整段（Task 2.1 / 2.2 / 2.3 / 2.4）** — Zeabur dump SKIPPED，無資料可 dump
> - **Phase 3 整段（Task 3.1 / 3.2 / 3.3 / 3.4 / 3.5 / 3.6）** — Coolify restore + checksum 比對 SKIPPED；replace by addendum 新增 **Phase 1.5 (drizzle-kit push)** + **Phase 1.5b (補 0008 per-DB CHECK constraint)** + **Phase 1.6 (schema verify)**
> - **Task 0.5（PG version + pgvector extversion 兩端比對）** — Plan B 無跨端資料搬遷，比對 unapplicable；視為 PASS（只需 Coolify 端 pgvector 0.5+ 能承載 `vector(1536)` 欄位定義即可；本 session Phase 0 已驗 0.8.3）
> - **Task 0.6（Drizzle migration mode 確認）** — 已驗證 Zeabur 用 push mode (推送模式) + 本機 repo 無 `drizzle/` generated dir (產生的目錄)，這正是 Plan B 採 drizzle-kit push 的根據（已固定路徑，不必再分流）
> - **Task 1.0（取 Coolify root URL，根帳號連線字串）** — 條件觸發已確認**不需要**：Task 0.4 跑出 `cc_memory` 是 superuser (超級使用者，`rolsuper=t`)，直接用 `~/.ccm-personal-url` 連線即可 CREATE DATABASE
> - **Task 4.0（Pre-switch drift gate）** + **Task 4.3.5（Full drift gate）** — Plan B 無資料 drift (漂移)，簡化為 single sanity check (單一健全度檢查)：「wrapper 結構對稱 + `.claude.json` cc-memory entry 改對 + `env.DATABASE_URL` 已移除」
>
> **新增 tasks（addendum + Codex review round 7 blocker fix）**：
> - **Phase 1.5** — `npx drizzle-kit push --config drizzle.config.ts` 從 `src/db/schema.ts` 一步建 7 tables
> - **Phase 1.5b** — 手動 apply `sql/migrations/0008_project_db_no_personal_check.sql`（per-DB CHECK constraint，schema.ts 之外、project DB 必須）
> - **Phase 1.6** — 驗 7 tables 全在 + pgvector extension 在 + 3 個 `*_no_personal_check` constraint 在
>
> **仍 active tasks（Plan B 照跑）**：
> - TDD 模式說明
> - **Phase 0**：Task 0.1 / 0.2 / 0.3 / 0.4（0.5 / 0.6 視為 PASS、1.0 跳過）
> - **Phase 1**：Task 1.1 / 1.2 / 1.3 / 1.4
> - **Phase 4**：Task 4.1 / 4.2 / 4.3 / 4.4（Task 4.0 / 4.3.5 簡化為 sanity check）
> - **Phase 5**：Task 5.1 / 5.2 / 5.3
> - **Phase 6**：Task 6.1 / 6.2 / 6.3
> - **Final Commit**：Task 7.1
>
> **Cross-ref**：[addendum 全文](./addendum-2026-06-30-plan-b.md)，特別是「Plan B 步驟」+「仍保留的核心驗證」兩節。

---

**Source of truth**：`./spec.md` + `./plan.md`

## TDD 模式說明

每個 atomic task 走 **RED → GREEN → VERIFY**：
- **RED**：先跑一個查詢確認「期望狀態還沒達成」（test fail）
- **GREEN**：執行實際操作
- **VERIFY**：再跑同/類似查詢確認「期望狀態已達成」（test pass）

純讀的 task（pre-flight / verify-only）可以省略 RED（沒有要 set 的目標狀態），其餘走完整三步。

中途任何 VERIFY fail → 立刻 abort 並走 `plan.md` Rollback Path。

> **URL 寫法慣例**：本文件所有 PG connection 描述用 key=value 拆解（避免 secret-scan hook 對完整 URL string 誤判）。實際 bash 命令用 `$(cat ~/.ccm-*-url)` 從檔讀 URL，不 inline literal。URL 結構統一是 PG protocol + user:password + at-sign + host:port + path + sslmode 參數。

---

## Phase 0 — Pre-flight

### Task 0.1 — autossh tunnel 活著

- [x] **VERIFY**：`pgrep -x autossh && ss -tln | grep ':15432' && echo "[tunnel OK]"`
  - 預期：autossh pid + LISTEN row + `[tunnel OK]`

### Task 0.2 — Zeabur 可讀（記下 row 數）

- [x] **VERIFY**：
  ```bash
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  psql "$ZUR" -c "SELECT current_database(), current_user, COUNT(*) AS rows FROM project_memories"
  unset ZUR
  ```
  - 預期：db=zeabur, user=root, rows=N（**記下 N**，後續 row-count 一致檢查用）

### Task 0.3 — Coolify PG 可寫（用 cc_memory user）

- [x] **VERIFY**：`psql "$(cat ~/.ccm-personal-url)" -c "SELECT current_database(), current_user"`
  - 預期：db=cc_memory_personal, user=cc_memory

### Task 0.4 — 抽 cc_memory user CREATEDB 權限

- [x] **VERIFY**：`psql "$(cat ~/.ccm-personal-url)" -c "SELECT rolname, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user"`
  - 結果分流：
    - `rolcreatedb=t` → 跳 Task 1.0、走 Task 1.1（cc_memory user 直接 createdb）
    - `rolcreatedb=f` → 走 Task 1.0（要 Coolify root URL）

### Task 0.5 — PG version + pgvector extversion 比對（source vs target）

- [ ] **VERIFY**：
  ```bash
  set -e
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")

  ZVER=$(psql "$ZUR" -t -A -c "SELECT version()" | head -1)
  CVER=$(psql "$(cat ~/.ccm-personal-url)" -t -A -c "SELECT version()" | head -1)
  echo "Zeabur PG:  $ZVER"
  echo "Coolify PG: $CVER"

  ZEXT=$(psql "$ZUR" -t -A -c "SELECT extversion FROM pg_extension WHERE extname='vector'")
  CEXT=$(psql "$(cat ~/.ccm-personal-url)" -t -A -c "SELECT extversion FROM pg_extension WHERE extname='vector'")
  echo "Zeabur pgvector:  '$ZEXT'"
  echo "Coolify pgvector: '$CEXT'"

  [ "$ZEXT" = "$CEXT" ] || { echo "[FAIL] pgvector extversion mismatch (Codex Risk: embedding 排序可能不同)"; exit 1; }
  echo "[OK pgvector aligned]"
  unset ZUR ZVER CVER ZEXT CEXT
  ```
  - 預期：兩邊 PG major version 一致 + pgvector extversion 完全一致
  - 失敗：major version skew → 升級 Coolify 對齊 Zeabur 後重做；pgvector skew → 同上
  - **特例**：若 Zeabur 沒 pgvector（`ZEXT` 為空），跳 Task 1.4，不裝 vector

### Task 0.6 — Drizzle migration mode 確認

- [ ] **VERIFY**：
  ```bash
  set -e
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  # 找 drizzle migration history 表 (drizzle schema 內,不在 public)
  psql "$ZUR" -c "\dt drizzle.*" 2>&1 | grep -iE 'drizzle|__migrat' || echo "[no drizzle history table found - likely used 'push' mode]"
  # 若有 history 表,看欄位 + row 數 (qualified name: drizzle.__drizzle_migrations, Codex round 3 補)
  psql "$ZUR" -c "\d drizzle.__drizzle_migrations" 2>/dev/null || true
  psql "$ZUR" -c "SELECT COUNT(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || true
  unset ZUR
  ```
  - 預期分流：
    - 有 `__drizzle_migrations` (或類似) 表 → 走 `migrate` 模式，cutover 後保留歷史
    - 無此表 → 走 `push` 模式，cutover 後 v0.4 也 push（無 history）
  - **記下決策**：寫進 Phase 6 deployment memory entry 內

### Task 1.0 — （條件觸發）取 Coolify root URL

> 只在 Task 0.4 結果 `rolcreatedb=f` 才跑。否則跳 Task 1.1。

- [ ] **GREEN**：user 從 Coolify Dashboard → c-c-memory app → Environment Variables → reveal `SERVICE_PASSWORD_POSTGRES` → copy 到 clipboard，組 root URL 寫 `~/.ccm-root-url`（mode 600）
  ```bash
  (
    set -e
    PW="$(powershell.exe -NoProfile -Command 'Get-Clipboard' 2>/dev/null | tr -d '\r\n')"
    LEN=${#PW}
    [ "$LEN" -ge 16 ] && [ "$LEN" -le 128 ] || { echo "[err] PW len $LEN"; exit 1; }
    # URL-encode PW (Codex 對審: 密碼含 @:/?# 等保留字元會壞 URL parse)
    PW_ENC="$(printf '%s' "$PW" | python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=""))')"
    # 用 variable 拆 protocol 跟 at-sign,避免 source 內出現完整 PG URL literal
    PROTO="postgres"
    AT="@"
    BODY="postgres:${PW_ENC}${AT}127.0.0.1:15432/postgres?sslmode=disable"
    printf '%s://%s' "$PROTO" "$BODY" > ~/.ccm-root-url
    chmod 600 ~/.ccm-root-url
    unset PW PW_ENC BODY
    echo "[root URL written; user=postgres host=127.0.0.1:15432 db=postgres (PW URL-encoded)]"
  )
  ```
- [ ] **VERIFY**：`psql "$(cat ~/.ccm-root-url)" -c "SELECT current_user"` → 預期 `postgres` (superuser)
  - 失敗：URL parse error → 檢查 PW 是否含特殊字元；URL-encode 應已處理但極端 case (例如 PW 含 null byte) 仍可能壞

---

## Phase 1 — Coolify 建新 database

### Task 1.1 — RED: 新 db 還不存在

- [x] **RED**：
  ```bash
  URL=$(test -f ~/.ccm-root-url && cat ~/.ccm-root-url || cat ~/.ccm-personal-url)
  psql "$URL" -c "SELECT COUNT(*) FROM pg_database WHERE datname='cc_memory_project'"
  unset URL
  ```
  - 預期：count = 0

### Task 1.2 — GREEN: CREATE DATABASE cc_memory_project

- [x] **GREEN**：
  ```bash
  URL=$(test -f ~/.ccm-root-url && cat ~/.ccm-root-url || cat ~/.ccm-personal-url)
  psql "$URL" -c "CREATE DATABASE cc_memory_project OWNER cc_memory"
  unset URL
  ```
  - 預期：`CREATE DATABASE`

### Task 1.3 — VERIFY: 新 db 存在且空

- [x] **VERIFY**：
  ```bash
  set -e
  URL=$(test -f ~/.ccm-root-url && cat ~/.ccm-root-url || cat ~/.ccm-personal-url)
  psql "$URL" -c "SELECT 1 FROM pg_database WHERE datname='cc_memory_project'"
  unset URL
  # 連新 db 看表 (用 personal-url 替換 db name 暫時連; assert 確保替換真的發生避免打到 personal DB)
  python3 -c "
  import os, re
  s = open(os.path.expanduser('~/.ccm-personal-url')).read()
  new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
  assert new != s, '[FATAL] regex 替換未發生 — URL 不含 cc_memory_personal 字串,可能會打到原 personal DB'
  open('/tmp/cutover-tmp-proj.url', 'w').write(new)
  os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
  "
  psql "$(cat /tmp/cutover-tmp-proj.url)" -c "\dt" 2>&1 | grep -E 'Did not find any|No relations' && echo "[empty db]"
  rm /tmp/cutover-tmp-proj.url
  ```
  - 預期：pg_database 1 row + `[empty db]`
  - 失敗：python assert raise → 表示 `~/.ccm-personal-url` 內沒有 `cc_memory_personal` 字串,要先確認 personal URL 是不是被改過

### Task 1.4 — pgvector extension（如果 Zeabur 有用，否則 skip）

> Helper：所有需要 cc_memory_project URL 的 task 都用以下 helper（避免重複 regex 替換 + assert 邏輯）：
> ```bash
> _gen_proj_url() {
>   python3 -c "
> import os, re
> s = open(os.path.expanduser('~/.ccm-personal-url')).read()
> new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
> assert new != s, '[FATAL] regex 替換未發生'
> open('/tmp/cutover-tmp-proj.url', 'w').write(new)
> os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
> "
> }
> ```
> 用法：`_gen_proj_url && psql "$(cat /tmp/cutover-tmp-proj.url)" -c "..." && rm /tmp/cutover-tmp-proj.url`

- [x] **RED**：
  ```bash
  set -e
  python3 -c "
  import os, re
  s = open(os.path.expanduser('~/.ccm-personal-url')).read()
  new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
  assert new != s, '[FATAL] regex 替換未發生'
  open('/tmp/cutover-tmp-proj.url', 'w').write(new)
  os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
  "
  psql "$(cat /tmp/cutover-tmp-proj.url)" -c "SELECT 1 FROM pg_extension WHERE extname='vector'"
  rm /tmp/cutover-tmp-proj.url
  ```
  - 預期：0 row（還沒裝）
- [x] **GREEN**：
  ```bash
  set -e
  python3 -c "
  import os, re
  s = open(os.path.expanduser('~/.ccm-personal-url')).read()
  new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
  assert new != s, '[FATAL] regex 替換未發生'
  open('/tmp/cutover-tmp-proj.url', 'w').write(new)
  os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
  "
  psql "$(cat /tmp/cutover-tmp-proj.url)" -c "CREATE EXTENSION IF NOT EXISTS vector"
  rm /tmp/cutover-tmp-proj.url
  ```
  - 預期：`CREATE EXTENSION`
- [x] **VERIFY**：同 RED query，預期 1 row

  > 註：Task 2/3 dump+restore 內 dump 檔會自帶 schema 含 extension 宣告，這步是「先確保 target 環境 binary 可用」避免 restore 時 `CREATE EXTENSION vector` 失敗

---

## Phase 2 — Zeabur dump

### Task 2.1 — RED: dump 檔還不存在

- [ ] **RED**：
  ```bash
  TS=$(date +%Y%m%d-%H%M%S)
  DUMP="/tmp/claude-1000/-home-haha-CC-project-CC-memory/da215639-1554-4edc-83e3-189b155d3707/scratchpad/zeabur-cc-memory-dump-$TS.sql"
  test ! -f "$DUMP" && echo "[ok, no existing dump]"
  echo "$DUMP" > /tmp/cutover-dump-path.txt
  ```
  - 預期：`[ok, no existing dump]`

### Task 2.2 — GREEN: pg_dump Zeabur

- [ ] **GREEN**：
  ```bash
  DUMP=$(cat /tmp/cutover-dump-path.txt)
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  # --no-owner --no-privileges: 避免 owner 在 target 不同造成 error
  pg_dump "$ZUR" --no-owner --no-privileges --format=plain --file="$DUMP"
  unset ZUR
  ls -lh "$DUMP"
  unset DUMP
  ```
  - 預期：dump 檔產生、size 合理（推測 < 100 MB）

### Task 2.3 — VERIFY: dump 內容覆蓋所有 app tables（含 Codex round 2 補表）

- [ ] **VERIFY**：
  ```bash
  set -e
  DUMP=$(cat /tmp/cutover-dump-path.txt)
  # 全 app tables (含 round 2 Codex 補的 reminder_log / reminder_delivery_queue / sync_state)
  for T in project_memories tasks search_feedback reminder_log reminder_delivery_queue sync_state bot_user_state __drizzle_migrations; do
    N=$(grep -c "CREATE TABLE.*\"\?$T\"\?\b\|CREATE TABLE.*\.$T\b" "$DUMP" || echo 0)
    M=$(grep -c "COPY.*\"\?$T\"\?\b\|COPY.*\.$T\b" "$DUMP" || echo 0)
    echo "$T: CREATE=$N COPY=$M"
  done
  V=$(grep -c 'CREATE EXTENSION.*vector' "$DUMP" || echo 0)
  echo "vector_extension: $V"
  # Drizzle migration history 在 drizzle schema 內,也驗 schema 創建
  SCHEMA=$(grep -c 'CREATE SCHEMA.*drizzle' "$DUMP" || echo 0)
  echo "drizzle_schema: $SCHEMA"
  unset DUMP
  ```
  - 預期：
    - 必要表 (`project_memories` / `tasks` / `search_feedback`) CREATE + COPY 都 ≥1
    - reminder / sync / bot tables 有就 ≥1，沒有 (early dev 不存在) 就 0 (OK)
    - `vector_extension` ≥1（如 Task 0.5 確認 Zeabur 有用）
    - `drizzle_schema` ≥1（如 Task 0.6 確認 prod 用 migrate 模式）
  - 失敗：必要表 missing → abort cutover，調查 pg_dump 是否漏權限

### Task 2.4 — 抓 source drift baseline（schema-aware，Codex round 2 fix）

> **問題 (round 2)**：原版 baseline 寫死 `MAX(updated_at)`，但 `search_feedback` / `reminder_delivery_queue` 只有 `created_at` 沒 `updated_at` → `psql` 報「column does not exist」被 `|| echo TABLE_MISSING` 吃掉 → fail-open 通過 → drift gate 失效。
>
> **修法**：每表用對的 timestamp 欄位（schema-aware），fallback `created_at`，全無就 `COUNT(*)`（append-only 表 cutover 期間 row 數不該變）。

- [ ] **VERIFY**：
  ```bash
  set -e
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  : > /tmp/cutover-drift-baseline.txt

  # Schema-aware: (table, timestamp_column)
  # 對應 src/db/schema.ts 實際欄位 (Codex round 3 修正 reminder_log → fired_at):
  #   project_memories/tasks/sync_state/bot_user_state: updated_at
  #   search_feedback/reminder_delivery_queue: created_at (append-only)
  #   reminder_log: fired_at (append-only,實際欄位不是 created_at)
  declare -A SIG=(
    [project_memories]="updated_at"
    [tasks]="updated_at"
    [sync_state]="updated_at"
    [bot_user_state]="updated_at"
    [search_feedback]="created_at"
    [reminder_log]="fired_at"
    [reminder_delivery_queue]="created_at"
  )

  for T in "${!SIG[@]}"; do
    COL="${SIG[$T]}"
    # 先看表存不存在
    EXIST=$(psql "$ZUR" -t -A -c "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$T'" 2>/dev/null)
    if [ -z "$EXIST" ]; then
      echo "$T|TABLE_MISSING|N/A|N/A" >> /tmp/cutover-drift-baseline.txt
      continue
    fi
    # 抓 max(timestamp) + count (兩個都記下,gate 兩個都驗)
    MAX=$(psql "$ZUR" -t -A -c "SELECT COALESCE(MAX($COL)::text, 'NULL') FROM $T")
    CNT=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T")
    echo "$T|$COL|$MAX|$CNT" >> /tmp/cutover-drift-baseline.txt
  done

  # drizzle migration 表單獨 (在 drizzle schema)
  DMIG=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo "TABLE_MISSING")
  echo "drizzle.__drizzle_migrations|count_only|N/A|$DMIG" >> /tmp/cutover-drift-baseline.txt

  unset ZUR
  cat /tmp/cutover-drift-baseline.txt
  ```
  - 格式：`<table>|<column>|<max_ts>|<count>`
  - 預期：每表 (含 round 2 補的) 都有 baseline；TABLE_MISSING 的表也記下
  - 失敗：PG 連不到 → abort cutover

---

## Phase 3 — Coolify restore + 資料一致驗證

### Task 3.1 — RED: 新 db 還空

- [ ] **RED**：同 Task 1.3（`\dt` 內無 `project_memories` 表）

### Task 3.2 — GREEN: psql restore（pipefail-safe）

- [ ] **GREEN**：
  ```bash
  set -euo pipefail   # Codex 對審: 沒這行 psql 失敗會被 tail 吞掉
  DUMP=$(cat /tmp/cutover-dump-path.txt)
  python3 -c "
  import os, re
  s = open(os.path.expanduser('~/.ccm-personal-url')).read()
  new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
  assert new != s, '[FATAL] regex 替換未發生'
  open('/tmp/cutover-tmp-proj.url', 'w').write(new)
  os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
  "
  # 保留完整 log 給檢視, 同時用 exit code 判斷
  RESTORE_LOG=/tmp/cutover-restore.log
  psql "$(cat /tmp/cutover-tmp-proj.url)" -v ON_ERROR_STOP=1 -f "$DUMP" > "$RESTORE_LOG" 2>&1
  RC=$?
  tail -20 "$RESTORE_LOG"
  echo "[psql exit code: $RC]"
  [ "$RC" -eq 0 ] || { echo "[FAIL restore returned non-zero]"; exit 1; }
  rm /tmp/cutover-tmp-proj.url
  unset DUMP RESTORE_LOG RC
  ```
  - 預期：log 尾段 `COPY <num>` 等成功訊息、exit code 0
  - 失敗：exit 1 abort → Phase 3 rollback（DROP DATABASE + 重 Phase 1-3）

### Task 3.3 — VERIFY: 全表 row count 一致（含 round 2 補表）

- [ ] **VERIFY**：
  ```bash
  set -euo pipefail
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  python3 -c "
  import os, re
  s = open(os.path.expanduser('~/.ccm-personal-url')).read()
  new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
  assert new != s
  open('/tmp/cutover-tmp-proj.url', 'w').write(new)
  os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
  "
  COL=$(cat /tmp/cutover-tmp-proj.url)

  FAIL=0
  # 全 app tables (round 2 補的 reminder_log / reminder_delivery_queue / sync_state)
  for T in project_memories tasks search_feedback reminder_log reminder_delivery_queue sync_state bot_user_state; do
    ZN=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "MISSING")
    CN=$(psql "$COL" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "MISSING")
    if [ "$ZN" = "$CN" ]; then
      echo "[OK] $T: $ZN"
    else
      echo "[FAIL] $T: Zeabur=$ZN Coolify=$CN"
      FAIL=1
    fi
  done
  # drizzle migration 表單獨 (在 drizzle schema)
  ZN=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo "MISSING")
  CN=$(psql "$COL" -t -A -c "SELECT COUNT(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo "MISSING")
  if [ "$ZN" = "$CN" ]; then
    echo "[OK] drizzle.__drizzle_migrations: $ZN"
  else
    echo "[FAIL] drizzle.__drizzle_migrations: Zeabur=$ZN Coolify=$CN"
    FAIL=1
  fi

  unset ZUR COL
  rm /tmp/cutover-tmp-proj.url
  [ "$FAIL" -eq 0 ] || { echo "[ABORT row count mismatch]"; exit 1; }
  echo "[OK all row counts match]"
  ```
  - 預期：每表一行 `[OK] <table>: <n>` + 最後 `[OK all row counts match]`
  - 失敗：exit 1 → Phase 3 rollback

### Task 3.4 — VERIFY: 每表 ordered checksum 比對（OOM-safe，Codex round 2 fix）

> **問題 (round 2)**：原版 `md5(string_agg(t.*::text, '|' ORDER BY id))` 對含 `vector(1536)` embedding 的全表會把所有 row text aggregate 成單一巨大 string → PG 1GB text limit / OOM 風險。
>
> **修法**：先 per-row hash (`md5(t::text)` = 32 char string per row)，再 string_agg hash strings。10K rows × 33 chars = 330KB，遠低於 limit。

- [ ] **VERIFY**：
  ```bash
  set -euo pipefail
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  python3 -c "
  import os, re
  s = open(os.path.expanduser('~/.ccm-personal-url')).read()
  new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
  assert new != s
  open('/tmp/cutover-tmp-proj.url', 'w').write(new)
  os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
  "
  COL=$(cat /tmp/cutover-tmp-proj.url)

  FAIL=0
  # OOM-safe 兩階段 checksum (round 2 fix) + per-table PK ordering (Codex round 3 fix)
  # 對應 schema.ts PK: 多數表 id (uuid); sync_state PK=resource; bot_user_state PK=telegram_user_id
  declare -A PK=(
    [project_memories]="id"
    [tasks]="id"
    [search_feedback]="id"
    [reminder_log]="id"
    [reminder_delivery_queue]="id"
    [sync_state]="resource"
    [bot_user_state]="telegram_user_id"
  )
  for T in project_memories tasks search_feedback reminder_log reminder_delivery_queue sync_state bot_user_state; do
    ORDER_COL="${PK[$T]}"
    SQL="SELECT md5(string_agg(row_hash, '|' ORDER BY $ORDER_COL)) FROM (SELECT $ORDER_COL, md5(t.*::text) AS row_hash FROM $T t) sub"
    ZH=$(psql "$ZUR" -t -A -c "$SQL" 2>/dev/null || echo "MISSING")
    CH=$(psql "$COL" -t -A -c "$SQL" 2>/dev/null || echo "MISSING")
    if [ "$ZH" = "$CH" ]; then
      echo "[OK] $T checksum: $ZH (ORDER BY $ORDER_COL)"
    else
      echo "[FAIL] $T: Zeabur=$ZH Coolify=$CH"
      FAIL=1
    fi
  done
  # drizzle migration 表 (schema=drizzle, PK 多數版本是 id 整數)
  # 若 schema 不同 (id 欄不存在),drizzle 內部欄通常是 id INT GENERATED ALWAYS AS IDENTITY
  SQL_D="SELECT md5(string_agg(row_hash, '|' ORDER BY id)) FROM (SELECT id, md5(t.*::text) AS row_hash FROM drizzle.__drizzle_migrations t) sub"
  ZH=$(psql "$ZUR" -t -A -c "$SQL_D" 2>/dev/null || echo "MISSING")
  CH=$(psql "$COL" -t -A -c "$SQL_D" 2>/dev/null || echo "MISSING")
  if [ "$ZH" = "$CH" ]; then
    echo "[OK] drizzle.__drizzle_migrations checksum: $ZH"
  else
    echo "[FAIL] drizzle.__drizzle_migrations: Zeabur=$ZH Coolify=$CH"
    FAIL=1
  fi

  unset ZUR COL
  rm /tmp/cutover-tmp-proj.url
  [ "$FAIL" -eq 0 ] || { echo "[ABORT checksum mismatch]"; exit 1; }
  echo "[OK all checksums match]"
  ```
  - 預期：每表 `[OK]` + 最後 `[OK all checksums match]`
  - 失敗：exit 1 → Phase 3 rollback
  - **算法說明**：per-row hash 32 chars + string_agg 不會撞 1GB limit；drizzle migration 表沒 vector 欄位本來就小，但統一用同算法

### Task 3.5 — VERIFY: 全 schema inventory 完整（含 drizzle schema，無漏表）

- [ ] **VERIFY**：
  ```bash
  set -euo pipefail
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  python3 -c "
  import os, re
  s = open(os.path.expanduser('~/.ccm-personal-url')).read()
  new = re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', s)
  assert new != s
  open('/tmp/cutover-tmp-proj.url', 'w').write(new)
  os.chmod('/tmp/cutover-tmp-proj.url', 0o600)
  "
  COL=$(cat /tmp/cutover-tmp-proj.url)

  # 涵蓋 public + drizzle 兩個 schema (round 2 fix: drizzle migration 也要驗)
  Q="SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY 1"
  ZT=$(psql "$ZUR" -t -A -c "$Q")
  CT=$(psql "$COL" -t -A -c "$Q")
  echo "[Zeabur tables (public + drizzle)]:"; echo "$ZT"
  echo "[Coolify tables (public + drizzle)]:"; echo "$CT"
  if [ "$ZT" = "$CT" ]; then
    echo "[OK table inventory matches]"
  else
    diff <(echo "$ZT") <(echo "$CT") || true
    echo "[FAIL table inventory mismatch]"
    exit 1
  fi
  unset ZUR COL ZT CT
  rm /tmp/cutover-tmp-proj.url
  ```
  - 預期：兩邊清單完全一致 + `[OK table inventory matches]`
  - 失敗：列出 diff、exit 1 → 調查 dump 為何漏表

### Task 3.6 — VERIFY: drift gate (schema-aware, Codex round 2 fix)

> **問題 (round 2)**：原版寫死 `MAX(updated_at)` 對 `search_feedback` 等無此欄位的表會 fail-open。修法：讀 Task 2.4 baseline 內每表的 column + max_ts + count，gate 比對 timestamp + count 兩個都不變才通過。

- [ ] **VERIFY**：
  ```bash
  set -euo pipefail
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  FAIL=0
  while IFS='|' read -r T COL MAX_BASELINE CNT_BASELINE; do
    if [ "$COL" = "TABLE_MISSING" ]; then
      echo "[skip] $T: not in Zeabur (baseline TABLE_MISSING)"
      continue
    fi
    if [ "$COL" = "count_only" ]; then
      # drizzle migration 表只驗 count
      CNT_CUR=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "MISSING")
      if [ "$CNT_CUR" = "$CNT_BASELINE" ]; then
        echo "[OK] $T: count=$CNT_BASELINE (unchanged)"
      else
        echo "[FAIL] $T: baseline count=$CNT_BASELINE, current=$CNT_CUR"
        FAIL=1
      fi
      continue
    fi
    # 一般表: 驗 max(timestamp) + count 兩個都不變
    MAX_CUR=$(psql "$ZUR" -t -A -c "SELECT COALESCE(MAX($COL)::text, 'NULL') FROM $T" 2>/dev/null || echo "ERR")
    CNT_CUR=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "ERR")
    if [ "$MAX_CUR" = "$MAX_BASELINE" ] && [ "$CNT_CUR" = "$CNT_BASELINE" ]; then
      echo "[OK] $T: drift=0 (max($COL)=$MAX_BASELINE, count=$CNT_BASELINE)"
    else
      echo "[FAIL] $T: baseline max=$MAX_BASELINE count=$CNT_BASELINE; current max=$MAX_CUR count=$CNT_CUR — cutover 期間有寫入 Zeabur!"
      FAIL=1
    fi
  done < /tmp/cutover-drift-baseline.txt
  unset ZUR
  [ "$FAIL" -eq 0 ] || { echo "[ABORT drift detected; need re-dump]"; exit 1; }
  echo "[OK no drift detected, freeze held @ Phase 3.6]"
  ```
  - 預期：每表 `[OK]` 或合理 `[skip]`，最後 `[OK no drift detected]`
  - 失敗：exit 1 → cutover 期間違反 freeze，回 Phase 2 重 dump
  - **重要**：此 gate 是「freeze 是否被守住」的客觀證據，不是「資料一致性」本身（資料一致由 3.3/3.4 驗）

---

## Phase 4 — Switch over `~/.claude.json` + 寫 wrapper

### Task 4.0 — Pre-switch drift gate（Codex round 2 補強：第二次 gate）

> Phase 3.6 到此處之間還有 ~10-15 min（寫 wrapper / 寫 URL 檔 / backup）的 race window。switch 之前再跑一次 drift gate 確認 Zeabur 從 baseline 到此刻仍無寫入。

- [ ] **VERIFY**：（同 Task 3.6 邏輯，從 baseline 對比 current）
  ```bash
  set -euo pipefail
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  FAIL=0
  while IFS='|' read -r T COL MAX_BASELINE CNT_BASELINE; do
    if [ "$COL" = "TABLE_MISSING" ]; then
      continue
    fi
    if [ "$COL" = "count_only" ]; then
      CNT_CUR=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "MISSING")
      [ "$CNT_CUR" = "$CNT_BASELINE" ] || { echo "[FAIL @ Phase 4.0] $T count drift"; FAIL=1; }
      continue
    fi
    MAX_CUR=$(psql "$ZUR" -t -A -c "SELECT COALESCE(MAX($COL)::text, 'NULL') FROM $T" 2>/dev/null || echo "ERR")
    CNT_CUR=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "ERR")
    if [ "$MAX_CUR" != "$MAX_BASELINE" ] || [ "$CNT_CUR" != "$CNT_BASELINE" ]; then
      echo "[FAIL @ Phase 4.0] $T: baseline max=$MAX_BASELINE count=$CNT_BASELINE; current max=$MAX_CUR count=$CNT_CUR"
      FAIL=1
    fi
  done < /tmp/cutover-drift-baseline.txt
  unset ZUR
  [ "$FAIL" -eq 0 ] || { echo "[ABORT @ Phase 4.0 — Zeabur 在 Phase 3.6 後又有寫入,需 rollback Phase 3 重做]"; exit 1; }
  echo "[OK no drift between Phase 3.6 and Phase 4.0 switch]"
  ```
  - 預期：`[OK no drift between Phase 3.6 and Phase 4.0 switch]`
  - 失敗：exit 1 → 表示 Phase 3.6 後又有寫入。Rollback：DROP DATABASE cc_memory_project + 回 Phase 2 重 dump（不再走 wrapper switch）

### Task 4.1 — backup `~/.claude.json`

- [x] **VERIFY**（pre-state）：`ls -la ~/.claude.json`，記 size
- [x] **GREEN**：
  ```bash
  TS=$(date +%Y%m%d-%H%M%S)
  cp ~/.claude.json ~/.claude.json.bak-cutover-$TS
  echo "$TS" > /tmp/cutover-backup-ts.txt
  ls -la ~/.claude.json.bak-cutover-$TS
  ```
  - 預期：backup 存在、size 跟原檔一樣

### Task 4.2 — 寫 `~/.ccm-project-url`

- [x] **GREEN**：直接從 `~/.ccm-personal-url` 替換 db name 產生（cc_memory_personal → cc_memory_project）
  ```bash
  python3 -c "import re,os; p=open(os.path.expanduser('~/.ccm-personal-url')).read(); new=re.sub(r'/cc_memory_personal(\?|$)', r'/cc_memory_project\1', p); assert new!=p, '[err] no substitute happened'; open(os.path.expanduser('~/.ccm-project-url'),'w').write(new); os.chmod(os.path.expanduser('~/.ccm-project-url'), 0o600); print('[written]')"
  ls -la ~/.ccm-project-url
  ```
  - 預期：`-rw------- ... ~/.ccm-project-url`
- [x] **VERIFY**：
  ```bash
  sed -E 's#://([^:]+):[^@]+@#://\1:****@#' ~/.ccm-project-url
  ```
  - 預期 mask 後顯示：user=`cc_memory`、host=`127.0.0.1:15432`、db=`cc_memory_project`、param=`sslmode=disable`

### Task 4.3 — 寫 wrapper script `~/run-cc-memory-project.sh`

- [x] **RED**：`test ! -f ~/run-cc-memory-project.sh && echo "[ok, no existing wrapper]"`
- [x] **GREEN**：（結構跟 `~/run-cc-memory-personal.sh` 對稱；參考 personal wrapper code）
  ```bash
  cat > ~/run-cc-memory-project.sh <<'EOF'
  #!/usr/bin/env bash
  # cc-memory project mode 啟動器 (Coolify cutover 後跟 personal 對稱; 2026-06-29)
  # 密碼不存在本檔: 讀 ~/.ccm-project-url (mode 600); GEMINI_API_KEY 仍從 ~/.claude.json cc-memory entry 讀
  set -euo pipefail

  NODE=/usr/bin/node
  CLAUDE_JSON=/home/haha/.claude.json
  read_from_claude() { "$NODE" -e "try{const e=require('$CLAUDE_JSON').mcpServers['cc-memory'].env||{};process.stdout.write(String(e['$1']||''))}catch(_){}" 2>/dev/null || true; }

  if [ ! -f /home/haha/.ccm-project-url ]; then
    echo "cc-memory project wrapper: 找不到 /home/haha/.ccm-project-url (project DB 連線字串檔, mode 600)" >&2
    exit 1
  fi
  DATABASE_URL="$(cat /home/haha/.ccm-project-url)"
  export DATABASE_URL

  GEMINI_API_KEY="$(read_from_claude GEMINI_API_KEY)"
  [ -n "${GEMINI_API_KEY:-}" ] && export GEMINI_API_KEY

  exec "$NODE" /home/haha/CC_project/CC-memory/build/index.js
  EOF
  chmod 755 ~/run-cc-memory-project.sh
  ls -l ~/run-cc-memory-project.sh
  ```
- [x] **VERIFY**：
  ```bash
  test -f ~/run-cc-memory-project.sh && test -x ~/run-cc-memory-project.sh && echo "[wrapper ready + executable]"
  # 跟 personal wrapper 結構 diff (應該只差 DATABASE_URL 變數名 + .ccm-project-url vs .ccm-personal-url + 沒 CC_FORCE_PROJECT_ID + 沒 Todoist)
  diff ~/run-cc-memory-personal.sh ~/run-cc-memory-project.sh | head -30
  ```
  - 預期：`[wrapper ready + executable]` + diff 顯示對稱結構

### Task 4.3.5 — Full drift gate（switch 前最後一刻，Codex round 4 強化）

> Task 4.0 是 early gate，跟 Task 4.4 (改 .claude.json) 之間還有寫 wrapper / URL 檔的時間（~5 min）。原 round 3 想做 light gate 抽 2 表，但 Codex round 4 指出：`cc_memory_search` (read) 會寫 `search_feedback` log，light gate 漏這表會放過 read-induced drift。改成跑同 Task 4.0/3.6 的全 schema-aware drift loop。

- [ ] **VERIFY**：（同 Task 3.6 / Task 4.0 邏輯，跑全表 schema-aware drift gate）
  ```bash
  set -euo pipefail
  ZUR=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['cc-memory']['env']['DATABASE_URL'])")
  FAIL=0
  while IFS='|' read -r T COL MAX_BASELINE CNT_BASELINE; do
    if [ "$COL" = "TABLE_MISSING" ]; then
      continue
    fi
    if [ "$COL" = "count_only" ]; then
      CNT_CUR=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "MISSING")
      [ "$CNT_CUR" = "$CNT_BASELINE" ] || { echo "[FAIL @ Task 4.3.5] $T count drift"; FAIL=1; }
      continue
    fi
    MAX_CUR=$(psql "$ZUR" -t -A -c "SELECT COALESCE(MAX($COL)::text, 'NULL') FROM $T" 2>/dev/null || echo "ERR")
    CNT_CUR=$(psql "$ZUR" -t -A -c "SELECT COUNT(*) FROM $T" 2>/dev/null || echo "ERR")
    if [ "$MAX_CUR" != "$MAX_BASELINE" ] || [ "$CNT_CUR" != "$CNT_BASELINE" ]; then
      echo "[FAIL @ Task 4.3.5] $T: baseline max=$MAX_BASELINE count=$CNT_BASELINE; current max=$MAX_CUR count=$CNT_CUR"
      FAIL=1
    fi
  done < /tmp/cutover-drift-baseline.txt
  unset ZUR
  [ "$FAIL" -eq 0 ] || { echo "[ABORT @ Task 4.3.5 — drift detected 緊鄰 switch,需 rollback Phase 3 重做]"; exit 1; }
  echo "[OK full drift gate passed @ Task 4.3.5,可進入 Task 4.4 switch]"
  ```
  - 預期：全表 `[OK]` + 最後 `[OK full drift gate passed @ Task 4.3.5]`
  - 失敗：exit 1 → 不要 switch！回 Phase 3 重做

### Task 4.4 — 改 `~/.claude.json` cc-memory entry 結構（direct env → wrapper）

- [x] **GREEN**：
  ```bash
  python3 << 'PYEOF'
  import json, os
  p = os.path.expanduser('~/.claude.json')
  cfg = json.load(open(p))
  cc = cfg['mcpServers']['cc-memory']
  # 記錄 before (不 print URL 字面)
  before_keys = sorted(cc.keys())
  env_keys_before = sorted((cc.get('env') or {}).keys())
  # 改成 wrapper 結構
  cc['command'] = '/home/haha/run-cc-memory-project.sh'
  cc['args'] = []
  # env 內: 刪 DATABASE_URL (移到 ~/.ccm-project-url), 保留 GEMINI_API_KEY (wrapper 從 cc-memory.env 讀)
  if 'env' not in cc: cc['env'] = {}
  cc['env'].pop('DATABASE_URL', None)
  json.dump(cfg, open(p, 'w'), indent=2, ensure_ascii=False)
  env_keys_after = sorted(cc['env'].keys())
  print('[updated]')
  print('  cc-memory keys before:', before_keys, ', env keys:', env_keys_before)
  print('  cc-memory keys after :', sorted(cc.keys()), ', env keys:', env_keys_after)
  print('  command =', cc['command'])
  print('  args    =', cc['args'])
  PYEOF
  ```
- [x] **VERIFY**：
  ```bash
  python3 /tmp/claude-1000/-home-haha-CC-project-CC-memory/da215639-1554-4edc-83e3-189b155d3707/scratchpad/inspect_db_routes.py | grep -A 8 '\[cc-memory\]'
  ```
  - 預期：
    - `command: /home/haha/run-cc-memory-project.sh`
    - `env.DATABASE_URL: <NOT shown>`（不再存在）
    - `env.GEMINI_API_KEY: <set>`（保留）

---

## Phase 5 — Restart + Verify

### Task 5.1 — User 重啟 Claude Code

- [ ] **MANUAL**：user 退出當前 Claude Code session（Ctrl+D 或關 terminal），重開 `claude` session
  - 重要：當前 session 的 cc-memory MCP 是 spawn 自舊 URL，重啟才會用新 URL

### Task 5.2 — VERIFY: cc-memory MCP 連通（新 session）

- [x] **VERIFY**（新 Claude Code session 內）：
  - 跑 `/mcp` 確認 `cc-memory: ✓ connected`
  - 跑 `cc_memory_stats project_id="cc-memory"` → 數字跟 Task 3.3 的 Coolify CN 一致

### Task 5.3 — VERIFY: query 行為一致

> ⚠️ **SUPERSEDED by Plan B (addendum)** — 本 task 原要求「cutover 前 vs 後 top-5 結果完全一樣」，前提是資料搬遷後等價。Plan B 無資料搬遷 → **改為**：`cc_memory_stats project_id="cc-memory"` 應**回 0 筆但不報錯**；`cc_memory_search` 跑任一 query 應**回 empty (空集) 但不報錯**（不要求跟 Zeabur 等價）。失敗的 rollback 路徑（改回 `.claude.json.bak-cutover-<ts>`）仍 active。

- [x] **VERIFY**：跑 3-5 個典型 `cc_memory_search` query（從慣用 query 挑）：
  - 例：「v0.4 spec」「personal hub Phase 1」「Coolify 部署」
  - cutover 前 vs 後 top-5 結果完全一樣（順序也是）
  - 失敗：rollback Phase 4（`cp ~/.claude.json.bak-cutover-<ts> ~/.claude.json` → 重啟 Claude Code）

---

## Phase 6 — Mark Zeabur deprecated

### Task 6.1 — 更新 deployment memory

> ⚠️ **SUPERSEDED-IN-PART by Plan B (addendum)** — 原 entry 含「dump 檔路徑（scratchpad）：保留 30 天」項目，Plan B 不產 dump artifact，**這項刪掉**。其他項目（cutover date、Zeabur → Coolify 路徑、`.claude.json` backup 30 天、Step F 觸發條件）+ **新增 Plan B 專屬項目**（Plan B 路徑說明、Phase 0 空殼發現、Phase 1.5 drizzle-kit push + Phase 1.5b apply 0008、實際耗時、Zeabur 可立即下線結論）仍 active。

- [x] **GREEN**：在 `~/.claude/projects/-home-haha-CC-project-CC-memory/memory/deployment-zeabur-prod.md` 加 entry：
  - cutover date: 2026-06-29
  - 從 Zeabur `43.153.156.125:30156/zeabur` → Coolify `127.0.0.1:15432/cc_memory_project`
  - dump 檔路徑（scratchpad）：保留 30 天
  - `.claude.json` backup 路徑：保留 30 天
  - Step F 觸發條件：Coolify cc-memory project 觀察 1-2 週穩定後

### Task 6.2 — 不停 Zeabur PG service（Step F 才做）

- [ ] **MANUAL**：確認 Zeabur dashboard service 仍 `running`（不需動作，conscious choice）

### Task 6.3 — TaskUpdate

- [ ] **GREEN**：本對話內 TaskUpdate `#3` → completed

---

## Final Commit

### Task 7.1 — 三檔（spec/plan/task）+ memory update commit

- [x] **GREEN**：用 `/commit` skill
  - Staged files：
    - `docs/migrations/2026-06-29-cc-memory-project-cutover/spec.md`
    - `docs/migrations/2026-06-29-cc-memory-project-cutover/plan.md`
    - `docs/migrations/2026-06-29-cc-memory-project-cutover/task.md`
    - `~/.claude/projects/.../memory/deployment-zeabur-prod.md`（如果 user memory commit 慣例允許 user-scope memory 進 repo；通常不進 repo，這 entry 寫到 user memory 即可）
  - Commit msg 模板：
    ```
    docs(migration): cc-memory project DB cutover Zeabur → Coolify

    - SDD 三件套（spec / plan / task）落 docs/migrations/
    - 配合 v0.4 plan 前置工作（解 Zeabur drift）
    - 走 TDD checklist（RED → GREEN → VERIFY per atomic task）
    ```

---

## Notes / Open Questions

- Task 1.4 假設 Zeabur PG 有 `vector` extension。若 Zeabur 沒用 vector，pgvector 步驟可 skip（dump 內也不會有 `CREATE EXTENSION vector`）
- Task 4.2 假設 cc_memory PG user 也能讀 cc_memory_project：`CREATE DATABASE ... OWNER cc_memory` 已 grant 全部權限給 cc_memory，否則 Phase 5.2 會 `permission denied`
- 第二台不需動（沒裝 cc-memory project entry）；v0.4 後若第二台要也跑 project entry，另寫 onboarding 補丁
- 所有 PG URL 描述用 key=value 拆解寫法是為了避免 secret-scan hook 誤判，不是 spec 語意要求
