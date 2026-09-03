#!/usr/bin/env bash
# Step B v3 彩排（只打本機測試 PG；呼叫端 export TEST_DATABASE_URL）。三個情境，全部 assert：
#   1. happy path：fixture → preflight → execute（單一交易）→ 快照斷言 → 重複 execute 被 applied.json 拒 → rollback → 快照＝原狀
#   2. 交易內守衛：對照表複本竄改一列 content_hash → 跳過諮詢性 preflight 直接進交易 → 該列 ROW_COUNT=0 → RAISE → 整筆 ROLLBACK
#      → 快照＝原狀、無 applied.json（all-or-nothing）
#   3. writer 介入後拒絕自動回滾：execute → (a) 插入一筆對照表外 observation 指向搬動過的 rollup → rollback 拒絕、DB 不變
#      → 刪掉它 → (b) 把搬動過的 rollup 的 updated_at 撥到 execute 之後 → rollback 拒絕 → 撥回 → rollback 成功＝原狀
set -euo pipefail
SP=/home/haha/.cache/cc-memory/stepb-2026-09-03
export STEPB_DATABASE_URL="${TEST_DATABASE_URL:?export TEST_DATABASE_URL first}"
case "$STEPB_DATABASE_URL" in *localhost:5438/cc_memory_test*) ;; *) echo "refuse: not the local test DB"; exit 1;; esac
APPLY="$SP/stepb-apply.py"
printf '%s\n' "SELECT system_identifier FROM pg_control_system();" > "$SP/stepb-rehearsal-sysid.sql"
export STEPB_EXPECTED_SYSTEM_ID="$(psql "$STEPB_DATABASE_URL" -X -q -A -t -f "$SP/stepb-rehearsal-sysid.sql")"
echo "test DB system_identifier=$STEPB_EXPECTED_SYSTEM_ID"
REMAP="$SP/stepb-rehearsal-remap.jsonl"
SNAP="$SP/stepb-rehearsal-snapshot.sql"
cat > "$SNAP" <<'SQL'
SELECT 'pm', id, project_id, idempotency_key, status FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-rehearsal-%' ORDER BY id;
SELECT 'obs', id, project_id, rollup_memory_id, status, content_hash FROM observations WHERE session_id LIKE 'sess-rehearsal-%' ORDER BY id;
SQL
snap() { psql "$STEPB_DATABASE_URL" -X -q -A -t -f "$SNAP"; }
sql() { printf '%s\n' "$1" > "$SP/stepb-rehearsal-adhoc.sql"; psql "$STEPB_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$SP/stepb-rehearsal-adhoc.sql"; }
reset_fixture() {
  rm -f "$SP"/stepb-rehearsal-remap*.applied.json "$SP"/stepb-rehearsal-remap*.rolled-back.json
  # 測試 DB 可能殘留其他測試的崩塌列，會讓「完整集合」檢查失敗；彩排前清掉（只在測試 DB）
  sql "DELETE FROM observations WHERE project_id LIKE '\\_%' AND session_id NOT LIKE 'sess-rehearsal-%'; DELETE FROM project_memories WHERE project_id LIKE '\\_%' AND (idempotency_key IS NULL OR idempotency_key NOT LIKE 'capture:v05:%:sess-rehearsal-%');"
  psql "$STEPB_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$SP/stepb-rehearsal-fixture.sql" >/dev/null
}
assert_eq() { if [ "$1" != "$2" ]; then echo "ASSERT FAIL: $3"; echo "--- got"; echo "$1"; echo "--- want"; echo "$2"; exit 1; fi; echo "assert ok: $3"; }
must_fail() { if "$@" >"$SP/stepb-rehearsal-lastfail.txt" 2>&1; then echo "ASSERT FAIL: expected failure: $*"; cat "$SP/stepb-rehearsal-lastfail.txt"; exit 1; fi; }

echo "== scenario 1: happy path (single transaction) + rollback"
reset_fixture
BEFORE="$(snap)"
python3 "$APPLY" "$REMAP" --preflight --rehearsal
python3 "$APPLY" "$REMAP" --execute --rehearsal
AFTER="$(snap)"
# 預期：pm1 → AI_Copilot、obs1 → AI_Copilot；pm2／obs2／obs3（needs_human）與 obs9（對不到）維持 __；pm3 本來就是 AI_Copilot
assert_eq "$(echo "$AFTER" | grep -c '|AI_Copilot|')" "3" "3 rows now under AI_Copilot (pm1 + existing pm3 + obs1)"
assert_eq "$(echo "$AFTER" | grep -c '|__|')" "4" "4 needs_human/unmapped rows untouched (pm2, obs2, obs3, obs9)"
assert_eq "$(echo "$AFTER" | grep -c 'capture:v05:AI_Copilot:sess-rehearsal-1')" "1" "pm1 idempotency_key rewritten"
[ -f "$SP/stepb-rehearsal-remap.applied.json" ] && echo "assert ok: applied.json written" || { echo "ASSERT FAIL: applied.json missing"; exit 1; }
must_fail python3 "$APPLY" "$REMAP" --execute --rehearsal; echo "assert ok: re-execute refused (applied.json exists)"
python3 "$APPLY" "$REMAP" --rollback --rehearsal
assert_eq "$(snap)" "$BEFORE" "rollback restores exact snapshot"
[ -f "$SP/stepb-rehearsal-remap.rolled-back.json" ] && echo "assert ok: applied.json renamed to rolled-back" || { echo "ASSERT FAIL: rolled-back.json missing"; exit 1; }

echo "== scenario 2: in-transaction guard (tampered map row) → whole transaction rolled back, nothing applied"
reset_fixture
BEFORE="$(snap)"
BAD="$SP/stepb-rehearsal-remap-bad.jsonl"
python3 - "$REMAP" "$BAD" <<'PY'
import sys, json
rows=[json.loads(l) for l in open(sys.argv[1],encoding='utf-8') if l.strip()]
for r in rows:
    if r['table']=='observations' and r.get('action')=='update':
        r['content_hash']='wrong-hash'; break
open(sys.argv[2],'w',encoding='utf-8').write('\n'.join(json.dumps(r,ensure_ascii=False) for r in rows)+'\n')
PY
must_fail python3 "$APPLY" "$BAD" --preflight --rehearsal; echo "assert ok: advisory preflight catches tampered row"
# 跳過諮詢性 preflight，直接進交易：pm1 的 UPDATE 會成功、obs1 的 UPDATE ROW_COUNT=0 → RAISE → 整筆 ROLLBACK
STEPB_REHEARSAL_SKIP_PREFLIGHT=1 must_fail python3 "$APPLY" "$BAD" --execute --rehearsal
grep -q "affected 0 rows" "$SP/stepb-rehearsal-lastfail.txt" && echo "assert ok: failure reason is ROW_COUNT=0 on the tampered row" || { echo "ASSERT FAIL: unexpected failure reason"; cat "$SP/stepb-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap)" "$BEFORE" "all-or-nothing: snapshot unchanged (pm1 update rolled back with the rest)"
[ ! -f "$SP/stepb-rehearsal-remap-bad.applied.json" ] && echo "assert ok: no applied.json after failed transaction" || { echo "ASSERT FAIL: applied.json must not exist"; exit 1; }

echo "== scenario 3: writer intervention after execute → automatic rollback refused"
reset_fixture
BEFORE="$(snap)"
python3 "$APPLY" "$REMAP" --execute --rehearsal
AFTER="$(snap)"
# (a) worker 在 execute 後新增一筆 observation（新 project）指向搬動過的 rollup pm1
sql "INSERT INTO observations (id, project_id, session_id, rollup_memory_id, type, title, narrative, observed_at, status, discovery_tokens, source_hook, content_hash, writer_host) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'AI_Copilot', 'sess-rehearsal-1', '11111111-1111-1111-1111-111111111111', 'decision', 'late', 'late', now(), 'active', 1, 'rehearsal', 'hash-late', 'rehearsal');"
must_fail python3 "$APPLY" "$REMAP" --rollback --rehearsal
grep -q "outside the map point at moved rollups" "$SP/stepb-rehearsal-lastfail.txt" && echo "assert ok: rollback refused (outside observation)" || { echo "ASSERT FAIL: wrong refusal reason"; cat "$SP/stepb-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap | grep -v bbbbbbbb)" "$AFTER" "DB unchanged after refused rollback (a)"
sql "DELETE FROM observations WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';"
# (b) worker 在 execute 後 by-id 更新過搬動的 rollup（updated_at 往後撥）
sql "UPDATE project_memories SET updated_at = now() + interval '1 minute' WHERE id='11111111-1111-1111-1111-111111111111';"
must_fail python3 "$APPLY" "$REMAP" --rollback --rehearsal
grep -q "updated after execute" "$SP/stepb-rehearsal-lastfail.txt" && echo "assert ok: rollback refused (rollup touched after execute)" || { echo "ASSERT FAIL: wrong refusal reason"; cat "$SP/stepb-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap)" "$AFTER" "DB unchanged after refused rollback (b)"
sql "UPDATE project_memories SET updated_at = '2020-01-01' WHERE id='11111111-1111-1111-1111-111111111111';"
python3 "$APPLY" "$REMAP" --rollback --rehearsal
assert_eq "$(snap)" "$BEFORE" "rollback succeeds once no writer intervention remains"

echo "== cleanup"
sql "DELETE FROM observations WHERE session_id LIKE 'sess-rehearsal-%'; DELETE FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-rehearsal-%';"
rm -f "$SP"/stepb-rehearsal-remap*.applied.json "$SP"/stepb-rehearsal-remap*.rolled-back.json "$SP"/stepb-rehearsal-remap*.txn.sql "$SP"/stepb-rehearsal-remap*.preflight.sql "$BAD"
echo "REHEARSAL PASSED"
