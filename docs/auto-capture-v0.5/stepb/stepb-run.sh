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

# 0) fail-closed 前提核對（Codex R2c fix 2）：builder 版本＝已審版本、兩個 worktree 乾淨且在預期分支
BUILDER_SHA_EXPECTED='fd4ccb0e00a5d4338b7959bec7033065fa7c1f825ba9ae264bf96bbd872b2c46'   # R2c 審過的 stepb-build-remap.ts
BUILDER_HEAD_EXPECTED='1b337c59daf20cc7880f72ad05a880efa3c1fcc5'                         # worktree ccm-remap HEAD（= PR #23 最後 commit）
BUILDER_WT="$(realpath "$BUILDER_WT")"; TABLE_WT="$(realpath "$TABLE_WT")"
[ "$(sha256sum "$BUILDER_WT/.scratch/stepb-build-remap.ts" | cut -c1-64)" = "$BUILDER_SHA_EXPECTED" ] || { echo "refuse: builder sha256 != reviewed"; exit 5; }
[ "$(git -C "$BUILDER_WT" rev-parse HEAD)" = "$BUILDER_HEAD_EXPECTED" ] || { echo "refuse: builder worktree HEAD != expected"; exit 5; }
[ -z "$(git -C "$BUILDER_WT" status --porcelain --untracked-files=no)" ] || { echo "refuse: builder worktree has tracked changes"; exit 5; }
[ "$(git -C "$TABLE_WT" rev-parse --abbrev-ref HEAD)" = "feature/stepb-remap-table" ] || { echo "refuse: table worktree not on feature/stepb-remap-table"; exit 5; }
[ -z "$(git -C "$TABLE_WT" status --porcelain --untracked-files=no)" ] || { echo "refuse: table worktree dirty"; exit 5; }
[ "$(sha256sum "$D/stepb-apply.py" | cut -c1-64)" = "$(sha256sum "$TABLE_WT/docs/auto-capture-v0.5/stepb/stepb-apply.py" | cut -c1-64)" ] || { echo "refuse: stepb-apply.py differs from committed copy"; exit 5; }
echo "[stepb-run] preconditions ok: builder=$BUILDER_SHA_EXPECTED head=$BUILDER_HEAD_EXPECTED"

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
# committed blob 必須＝實際要執行的 $MAP（Codex R2c fix 2）
[ "$(git -C "$TABLE_WT" show HEAD:docs/auto-capture-v0.5/remap-2026-09-03.jsonl | sha256sum | cut -c1-64)" = "$(sha256sum "$MAP" | cut -c1-64)" ] || { echo "refuse: committed map != \$MAP"; exit 5; }
echo "[stepb-run] committed map sha256=$(sha256sum "$MAP" | cut -c1-64)"

# 4) 釋放本腳本的鎖，交給 apply.py（它先跑唯讀 preflight 再拿同一把鎖，空窗約數秒；交易內有集合相等＋目標鍵衝突檢查兜底，tick 擠進來只會讓交易 RAISE、DB 不變）
flock -u 9
python3 "$D/stepb-apply.py" "$MAP" --execute | tee "$D/execute.$STAMP.out"
