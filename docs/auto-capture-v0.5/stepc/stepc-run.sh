#!/usr/bin/env bash
# Step C 驅動：在 worker 同一把 flock 內一口氣「重建計畫（唯讀）→ 與核准計畫比對 → preflight → execute」，避免計畫在 build 與 execute 之間過期
# （目標 rollup 是 9 月的 session，worker 可能還在對它們寫新 window）。用法：
#   bash stepc-run.sh <remap.jsonl> <approved-plan.jsonl> [--dry-run] [--include-class4] [--rehearsal]
#   --dry-run   只做到 preflight（不寫 executing 標記、不 execute）；正式執行前先跑一次給人看
# 只在使用者明確說「執行」後才跑正式模式。任何檢查不符 → 交易整筆 ROLLBACK、DB 不變、本腳本非零退出。
# 核准計畫（$PLAN）先原封複製到 snapshots/（chmod 400），重建結果與核准版比對：session 集合、目標 id／模式、目的專案、被合併 rollup 集合、
# observations 集合 任一不同 → 印差異、exit 3、不執行（使用者不在場無法即時重新核准；改由人重看新計畫）。
set -euo pipefail
SP=/home/haha/.cache/cc-memory/stepc-2026-09-05
LOCK=/home/haha/.cache/cc-memory/auto-capture-run.lock
REMAP="${1:?remap.jsonl}"; PLAN="${2:?approved-plan.jsonl}"; shift 2
DRY=0; BUILD_FLAGS=(); APPLY_FLAGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --rehearsal) BUILD_FLAGS+=("$a"); APPLY_FLAGS+=("$a") ;;
    --include-class4) BUILD_FLAGS+=("$a") ;;
    *) echo "[stepc-run] unknown flag $a"; exit 2 ;;
  esac
done
if [ "${STEPC_RUN_INNER:-}" != "1" ]; then
  exec env STEPC_RUN_INNER=1 flock -w 120 "$LOCK" bash "$0" "$REMAP" "$PLAN" "$@"
fi
echo "[stepc-run] flock held $LOCK at $(date -u +%FT%TZ) dry_run=$DRY"
for f in "${PLAN%.jsonl}.applied.json" "${PLAN%.jsonl}.executing.json"; do
  [ -e "$f" ] && { echo "[stepc-run] $f exists — refuse to rebuild/overwrite (Codex R2 #2). Run --check-state first."; exit 3; }
done
# 未持鎖的 worker 入口（run-auto-capture / drain）不受 flock 保護：有在跑就拒絕（Codex R2 #3；pgrep 只是輔助，契約才是保證）
# 樣式只認實際腳本路徑（scripts/<name>.ts），避免命中含這些字樣的 shell／編輯器命令列（2026-09-05 彩排實際誤命中過）
PAT='scripts/(run-auto-capture|drain-capture-backlog)[.]ts'
if pgrep -f "$PAT" >/dev/null 2>&1; then
  echo "[stepc-run] a capture process is running outside our lock — refuse"; pgrep -af "$PAT"; exit 3
fi
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$SP/snapshots"
cp -n "$PLAN" "$SP/snapshots/approved-plan.$TS.jsonl"; cp -n "$REMAP" "$SP/snapshots/remap.$TS.jsonl"; chmod 400 "$SP/snapshots/"*.jsonl
echo "[stepc-run] immutable copies: $SP/snapshots/approved-plan.$TS.jsonl  remap.$TS.jsonl"
REBUILT="${PLAN%.jsonl}.rebuilt.$TS.jsonl"
python3 "$SP/stepc-merge-build.py" "$REMAP" "$REBUILT" "${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"}" | tee "$SP/stepc-run-build.$TS.out"
# 核准 vs 重建：結構必須完全相同（before-state 允許不同，那正是重建的目的）
python3 - "$PLAN" "$REBUILT" <<'PY'
import json, sys
def load(p):
    rows=[json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
    return {r['session_id']: r for r in rows if r.get('action')=='merge'}
a, b = load(sys.argv[1]), load(sys.argv[2])
def sig(r):
    return {'target': r['target']['id'], 'mode': r['target']['mode'], 'new_project_id': r['new_project_id'],
            'merge_rollups': sorted(m['id'] for m in r['merge_rollups']), 'observations': sorted(o['id'] for o in r['observations']),
            'survivor_key': (r.get('survivor') or {}).get('new_idempotency_key')}
diff=[]
for sid in sorted(set(a)|set(b)):
    if sid not in a: diff.append(f'+ {sid[:8]} only in rebuilt'); continue
    if sid not in b:
        reason=[json.loads(l) for l in open(sys.argv[2], encoding='utf-8') if l.strip()]
        why=next((x.get('reason','') for x in reason if x['session_id']==sid), '?')
        diff.append(f'- {sid[:8]} dropped in rebuilt: {why[:90]}'); continue
    if sig(a[sid])!=sig(b[sid]): diff.append(f'~ {sid[:8]} structure differs: approved={sig(a[sid])} rebuilt={sig(b[sid])}')
if diff:
    print('[stepc-run] APPROVED PLAN != REBUILT PLAN — refuse to execute; re-present the rebuilt plan to the user:')
    print('\n'.join(diff)); sys.exit(3)
print(f'[stepc-run] approved plan == rebuilt plan structurally ({len(a)} merge sessions)')
PY
cp "$REBUILT" "$PLAN"   # 執行用重建版（fresh before-state）；核准原件已在 snapshots/
sha256sum "$PLAN" "$SP/snapshots/approved-plan.$TS.jsonl"
STEPC_LOCK_INHERITED=1 python3 "$SP/stepc-merge-apply.py" "$PLAN" "$REMAP" --preflight "${APPLY_FLAGS[@]+"${APPLY_FLAGS[@]}"}" | tee "$SP/stepc-run-preflight.$TS.out"
if [ "$DRY" = "1" ]; then echo "[stepc-run] DRY RUN complete — nothing written; executing marker not created"; exit 0; fi
STEPC_LOCK_INHERITED=1 python3 "$SP/stepc-merge-apply.py" "$PLAN" "$REMAP" --execute "${APPLY_FLAGS[@]+"${APPLY_FLAGS[@]}"}" | tee "$SP/stepc-run-execute.$TS.out"
