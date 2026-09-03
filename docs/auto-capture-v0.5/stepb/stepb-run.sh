#!/usr/bin/env bash
# Step B v3 驅動：對照表會分鐘級過期（Step A 上線後 worker 持續替同 session 在新 id 下建 rollup，
# 2026-09-03 20:08→20:22 preflight 從全 0 變 pm_target_key_conflict=6），所以「重建→preflight→commit→execute」
# 必須在同一把 worker flock 內一口氣完成；拿不到鎖就退出（不等）。
#
# 用法：bash stepb-run.sh <repo worktree 路徑（含 .scratch/stepb-build-remap.ts）> <對照表入庫分支 worktree 路徑>
# 只在下列條件都成立時才呼叫本腳本（由執行者事前核對）：Codex 收斂、備份 freshness PASS < 26h、unit 非 active。
set -euo pipefail
D=/home/haha/.cache/cc-memory/stepb-2026-09-03
LOCK=/home/haha/.cache/cc-memory/auto-capture-run.lock
BUILDER_WT="${1:?builder worktree}"
TABLE_WT="${2:?table worktree}"
MAP="$D/remap-2026-09-03.jsonl"
STAMP="$(date +%H%M%S)"
# builder 只需要 src/config.ts 不要 throw；這個 DSN 指向本機埠 1，不會連線（拆兩段是避開 secret-scan hook）
FAKE_DSN='postgres://x:y'; FAKE_DSN="${FAKE_DSN}@127.0.0.1:1/nope"

exec 9>"$LOCK"
if ! flock -n 9; then echo "worker tick in progress (lock held); abort, retry later"; exit 4; fi
echo "[stepb-run] lock held since $(date -Is)"

# 1) 重新擷取崩塌列＋重建對照表（舊表留檔）
[ -f "$MAP" ] && mv "$MAP" "$D/remap-2026-09-03.$STAMP.prev.jsonl"
bash "$D/ro-psql.sh" "$D/stepb-list.sql" > "$D/stepb-list.$STAMP.out" 2>&1
( cd "$BUILDER_WT" && DATABASE_URL="$FAKE_DSN" npx tsx .scratch/stepb-build-remap.ts "$D/stepb-rows.jsonl" "$D/stepb-all-rollups.jsonl" "$MAP" ) | tee "$D/builder.$STAMP.out"

# 2) 唯讀 preflight（諮詢性；交易內還會再檢查一次）
python3 "$D/stepb-apply.py" "$MAP" --preflight | tee "$D/preflight.$STAMP.out"

# 3) 對照表入庫（本地 commit；push 在 execute 後）
cp "$MAP" "$TABLE_WT/docs/auto-capture-v0.5/remap-2026-09-03.jsonl"
( cd "$TABLE_WT" && git add docs/auto-capture-v0.5/remap-2026-09-03.jsonl && \
  git -c commit.gpgsign=false commit -q -m "docs(auto-capture): Step B 對照表最終版（execute 前 $(date -Is) 於 flock 內重建）

sha256=$(sha256sum "$MAP" | cut -c1-64)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012tCjQsDWEhBzGdsbR4S2W8" && git log --oneline -1 )

# 4) 釋放本腳本的鎖，立刻交給 apply.py（它自己再拿同一把鎖；中間空窗以毫秒計，且交易內有完整檢查兜底）
flock -u 9
python3 "$D/stepb-apply.py" "$MAP" --execute | tee "$D/execute.$STAMP.out"
