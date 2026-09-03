#!/usr/bin/env bash
# Step B v2 彩排（只打本機測試 PG；呼叫端 export TEST_DATABASE_URL）：
#   1. fixture → preflight → execute（STEPB_BATCH=2 → 3 批）→ 快照斷言 → 重複 execute 被 journal 拒絕 → rollback → 快照＝原狀
#   2. 故障注入：fixture → 竄改第 2 批一列（讓守衛不符）→ execute（第 1 批 COMMIT、第 2 批 ROLLBACK 停止）→ rollback 只還原第 1 批 → 快照＝原狀
set -euo pipefail
SP=/home/haha/.cache/cc-memory/stepb-2026-09-03
export STEPB_DATABASE_URL="${TEST_DATABASE_URL:?export TEST_DATABASE_URL first}"
case "$STEPB_DATABASE_URL" in *localhost:5438/cc_memory_test*) ;; *) echo "refuse: not the local test DB"; exit 1;; esac
export STEPB_BATCH=2
REMAP="/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-remap.jsonl"
SNAP="/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-snapshot.sql"
cat > "$SNAP" <<'SQL'
SELECT 'pm', id, project_id, idempotency_key, status FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-rehearsal-%' ORDER BY id;
SELECT 'obs', id, project_id, rollup_memory_id, status, content_hash FROM observations WHERE session_id LIKE 'sess-rehearsal-%' ORDER BY id;
SQL
snap() { psql "$STEPB_DATABASE_URL" -X -q -A -t -f "$SNAP"; }
reset_fixture() {
  rm -f "$SP"/stepb-rehearsal-remap*.journal.json
  psql "$STEPB_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-fixture.sql" >/dev/null
}
assert_eq() { if [ "$1" != "$2" ]; then echo "ASSERT FAIL: $3"; echo "--- got"; echo "$1"; echo "--- want"; echo "$2"; exit 1; fi; echo "assert ok: $3"; }

echo "== scenario 1: happy path"
reset_fixture
BEFORE="$(snap)"
python3 "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py" "$REMAP" --preflight --rehearsal
python3 "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py" "$REMAP" --execute --rehearsal
AFTER="$(snap)"
# 預期：兩個 rollup 改成 AI_Copilot（第 2 個在本版是 needs_human，故維持 __）；obs 只有 o1 改（o2/o3 屬 needs_human session）
assert_eq "$(echo "$AFTER" | grep -c '|AI_Copilot|')" "3" "3 rows now under AI_Copilot (pm1 + existing pm3 + obs1)"
assert_eq "$(echo "$AFTER" | grep -c '^pm|22222222.*|__|')" "1" "needs_human rollup untouched"
if python3 "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py" "$REMAP" --execute --rehearsal >/dev/null 2>&1; then echo "ASSERT FAIL: re-execute must be refused by journal"; exit 1; else echo "assert ok: re-execute refused"; fi
python3 "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py" "$REMAP" --rollback --rehearsal
assert_eq "$(snap)" "$BEFORE" "rollback restores exact snapshot"

echo "== scenario 2: batch 2 fails, journal-driven partial rollback"
export STEPB_BATCH=1
reset_fixture
BEFORE="$(snap)"
# 竄改：把第 2 批（obs 批）一列的 content_hash 改掉 → 守衛不符 → 該批 ROLLBACK
printf '%s\n' "UPDATE observations SET content_hash='tampered' WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';" > "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-tamper.sql"
psql "$STEPB_DATABASE_URL" -X -q -f "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-tamper.sql"
if python3 "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py" "$REMAP" --preflight --rehearsal >/dev/null 2>&1; then echo "ASSERT FAIL: preflight must catch tampered row"; exit 1; else echo "assert ok: preflight catches tampered row (ob_state_mismatch)"; fi
# 把竄改還原，先讓 preflight 過；execute 開始後才竄改（模擬 preflight 與 execute 之間有人動了列）
printf '%s\n' "UPDATE observations SET content_hash='hash-o1' WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';" > "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-untamper.sql"
psql "$STEPB_DATABASE_URL" -X -q -f "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-untamper.sql"
# 用 batch 1 的 pm 更新讓後續 obs 批失敗：直接對 remap 複本竄改第 2 批一列的 content_hash
python3 - "$REMAP" "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-remap-bad.jsonl" <<'PY'
import sys, json
rows=[json.loads(l) for l in open(sys.argv[1],encoding='utf-8') if l.strip()]
for r in rows:
    if r['table']=='observations' and r.get('action')=='update':
        r['content_hash']='wrong-hash'; break
open(sys.argv[2],'w',encoding='utf-8').write('\n'.join(json.dumps(r,ensure_ascii=False) for r in rows)+'\n')
PY
BAD="/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-remap-bad.jsonl"
# preflight 會擋（ob_state_mismatch=1）——這正是要的；為了測「批次中途失敗」，改用 --execute 但 preflight 只檢查目標批次…
# 所以此情境改成：手動跑 batch SQL 序列（不經 preflight）驗證 journal 回滾語意
python3 - "$BAD" <<'PY'
import sys, json, subprocess, os
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
import importlib.util
spec = importlib.util.spec_from_file_location('apply', str(Path(sys.argv[1]).parent / 'stepb-apply.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
path = Path(sys.argv[1]); rows = m.load_rows(path); work = m.actionable(rows)
ordered = [r for r in work if r['table']=='project_memories'] + [r for r in work if r['table']=='observations']
batches = [ordered[i:i+1] for i in range(0, len(ordered), 1)]
url = os.environ['STEPB_DATABASE_URL']; journal = path.with_name(f'{path.stem}.journal.json'); state={'committed_batches':[]}
for i,b in enumerate(batches):
    f = path.with_name(f'{path.stem}.execute.batch{i+1}.sql'); f.write_text(m.batch_sql(b, False), encoding='utf-8')
    code, out = m.run_psql(url, f, read_only=False)
    print(f'batch {i+1}: exit={code} {out.strip()[-120:]}')
    if code != 0: break
    state['committed_batches'].append(i)
journal.write_text(json.dumps(state), encoding='utf-8')
print('journal', state)
assert state['committed_batches'] == [0], state
PY
MID="$(snap)"
assert_eq "$(echo "$MID" | grep -c '|AI_Copilot|')" "2" "after partial failure: batch 1 (pm) committed, obs untouched"
python3 "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-apply.py" "$BAD" --rollback --rehearsal
assert_eq "$(snap)" "$BEFORE" "journal-driven rollback restores exact snapshot"

echo "== cleanup"
printf '%s\n' "DELETE FROM observations WHERE session_id LIKE 'sess-rehearsal-%';" "DELETE FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-rehearsal-%';" > "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-cleanup.sql"
psql "$STEPB_DATABASE_URL" -X -q -f "/home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rehearsal-cleanup.sql"
rm -f "$SP"/stepb-rehearsal-remap*.journal.json
echo "REHEARSAL PASSED"
