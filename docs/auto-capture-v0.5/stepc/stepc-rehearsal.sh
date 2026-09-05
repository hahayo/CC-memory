#!/usr/bin/env bash
# Step C 彩排（只打本機測試 PG；呼叫端 export TEST_DATABASE_URL，值同 npm test 用的測試 PG 5438 埠）。情境：
#   1. happy path：fixture → build（唯讀）→ preflight → execute（單一交易）→ 後狀態斷言 → 重複 execute 被拒 → rollback → 快照＝原狀
#   2. 竄改計畫一列 content_hash → preflight 抓到；跳過 preflight 直接進交易 → ROW_COUNT=0 → RAISE → 整筆 ROLLBACK、無 applied.json
#   3. 計畫過期：build 之後 worker 又對目標寫了一個 window（改 metadata.capture）→ execute 在交易內被 ROW_COUNT=0 擋下 → DB 不變
#   4. writer 介入後拒絕自動回滾：execute → (a) 新 observation 指向目標 → 拒；(b) 目標 updated_at 撥後 → 拒；(c) 目標 capture 被改 → 拒；還原後 rollback 成功＝原狀
set -euo pipefail
SP=/home/haha/.cache/cc-memory/stepc-2026-09-05
export STEPC_DATABASE_URL="${TEST_DATABASE_URL:?export TEST_DATABASE_URL first}"
case "$STEPC_DATABASE_URL" in *localhost:5438/cc_memory_test*) ;; *) echo "refuse: not the local test DB"; exit 1;; esac
BUILD="$SP/stepc-merge-build.py"; APPLY="$SP/stepc-merge-apply.py"
REMAP="$SP/stepc-rehearsal-remap.jsonl"; PLAN="$SP/stepc-rehearsal-plan.jsonl"
printf '%s\n' "SELECT system_identifier FROM pg_control_system();" > "$SP/stepc-rehearsal-sysid.sql"
export STEPC_EXPECTED_SYSTEM_ID="$(psql "$STEPC_DATABASE_URL" -X -q -A -t -f "$SP/stepc-rehearsal-sysid.sql")"
echo "test DB system_identifier=$STEPC_EXPECTED_SYSTEM_ID"
SNAP="$SP/stepc-rehearsal-snapshot.sql"
cat > "$SNAP" <<'SQL'
SELECT 'pm', id, project_id, idempotency_key, status, merged_into, metadata->'capture'->'transcript_sources', metadata->'capture'->'observation_ids' FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-c-%' ORDER BY id;
SELECT 'obs', id, project_id, rollup_memory_id, status, content_hash FROM observations WHERE session_id LIKE 'sess-c-%' ORDER BY id;
SQL
snap() { psql "$STEPC_DATABASE_URL" -X -q -A -t -f "$SNAP"; }
sql() { printf '%s\n' "$1" > "$SP/stepc-rehearsal-adhoc.sql"; psql "$STEPC_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$SP/stepc-rehearsal-adhoc.sql"; }
reset_fixture() {
  rm -f "$SP"/stepc-rehearsal-plan*.applied.json "$SP"/stepc-rehearsal-plan*.rolled-back.json "$SP"/stepc-rehearsal-plan*.executing.json
  sql "DELETE FROM observations WHERE project_id LIKE '\\_%' AND session_id NOT LIKE 'sess-c-%'; DELETE FROM project_memories WHERE project_id LIKE '\\_%' AND (idempotency_key IS NULL OR idempotency_key NOT LIKE 'capture:v05:%:sess-c-%');"
  psql "$STEPC_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$SP/stepc-rehearsal-fixture.sql" >/dev/null
  python3 "$BUILD" "$REMAP" "$PLAN" --rehearsal
}
assert_eq() { if [ "$1" != "$2" ]; then echo "ASSERT FAIL: $3"; echo "--- got"; echo "$1"; echo "--- want"; echo "$2"; exit 1; fi; echo "assert ok: $3"; }
must_fail() { if "$@" >"$SP/stepc-rehearsal-lastfail.txt" 2>&1; then echo "ASSERT FAIL: expected failure: $*"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; fi; }

echo "== scenario 1: happy path + rollback"
reset_fixture
BEFORE="$(snap)"
python3 "$APPLY" "$PLAN" "$REMAP" --preflight --rehearsal
python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal
AFTER="$(snap)"
# sess-c-1：x1,x2,x3 → AI_Copilot 指向 T1；O1,O2 archived merged_into T1；T1 sources 合併成 [h1 0-200]、observation_ids = a1,x1,x2,x3
assert_eq "$(echo "$AFTER" | grep '^obs' | grep -c '|AI_Copilot|10000000-0000-0000-0000-000000000001|')" "4" "sess-c-1: 4 obs under AI_Copilot pointing at T1"
assert_eq "$(echo "$AFTER" | grep '^pm|10000000-0000-0000-0000-00000000000[23]' | grep -c '|archived|10000000-0000-0000-0000-000000000001|')" "2" "sess-c-1: O1,O2 archived, merged_into=T1"
assert_eq "$(echo "$AFTER" | grep '^pm|10000000-0000-0000-0000-000000000001|' | cut -d'|' -f7)" '[{"end": 200, "start": 0, "path_hash": "h1"}]' "sess-c-1: T1 transcript_sources normalized to one range"
assert_eq "$(echo "$AFTER" | grep '^pm|10000000-0000-0000-0000-000000000001|' | cut -d'|' -f8)" '["a1000000-0000-0000-0000-000000000001", "e1000000-0000-0000-0000-000000000001", "e1000000-0000-0000-0000-000000000002", "e1000000-0000-0000-0000-000000000003"]' "sess-c-1: T1 observation_ids union"
# sess-c-2：存活者 O3 → AI_Copilot 新 key；O4 archived merged_into O3；x4,x5,x6 → AI_Copilot 指向 O3
assert_eq "$(echo "$AFTER" | grep -c '^pm|10000000-0000-0000-0000-000000000004|AI_Copilot|capture:v05:AI_Copilot:sess-c-2|active|')" "1" "sess-c-2: survivor O3 re-keyed"
assert_eq "$(echo "$AFTER" | grep -c '^pm|10000000-0000-0000-0000-000000000005|___|capture:v05:___:sess-c-2|archived|10000000-0000-0000-0000-000000000004|')" "1" "sess-c-2: O4 archived merged_into O3"
assert_eq "$(echo "$AFTER" | grep '^obs' | grep -c '|AI_Copilot|10000000-0000-0000-0000-000000000004|')" "3" "sess-c-2: 3 obs → O3"
# sess-c-3 不動
assert_eq "$(echo "$AFTER" | grep -c 'sess-c-3\||e1000000-0000-0000-0000-000000000007|__|')" "2" "sess-c-3 untouched"
[ -f "$SP/stepc-rehearsal-plan.applied.json" ] && echo "assert ok: applied.json written" || { echo "ASSERT FAIL: applied.json missing"; exit 1; }
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal; echo "assert ok: re-execute refused"
python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal
assert_eq "$(snap)" "$BEFORE" "rollback restores exact snapshot"

echo "== scenario 2: tampered plan row → all-or-nothing"
reset_fixture
BEFORE="$(snap)"
BAD="$SP/stepc-rehearsal-plan-bad.jsonl"
python3 - "$PLAN" "$BAD" <<'PY'
import sys, json
rows=[json.loads(l) for l in open(sys.argv[1],encoding='utf-8') if l.strip()]
done=False
for p in rows:
    if p['action']=='merge' and not done:
        p['observations'][-1]['content_hash']='wrong-hash'; done=True
open(sys.argv[2],'w',encoding='utf-8').write('\n'.join(json.dumps(r,ensure_ascii=False) for r in rows)+'\n')
PY
must_fail python3 "$APPLY" "$BAD" "$REMAP" --preflight --rehearsal; echo "assert ok: preflight catches tampered row"
STEPC_REHEARSAL_SKIP_PREFLIGHT=1 must_fail python3 "$APPLY" "$BAD" "$REMAP" --execute --rehearsal
grep -q "affected 0 rows" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: ROW_COUNT=0 raised" || { echo "ASSERT FAIL: wrong reason"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap)" "$BEFORE" "all-or-nothing: snapshot unchanged"
[ ! -f "$SP/stepc-rehearsal-plan-bad.applied.json" ] && echo "assert ok: no applied.json" || { echo "ASSERT FAIL"; exit 1; }

echo "== scenario 3: stale plan (worker wrote a new window to the target after build)"
reset_fixture
BEFORE="$(snap)"
sql "UPDATE project_memories SET metadata = jsonb_set(metadata, '{capture,transcript_sources}', '[{\"path_hash\":\"h1\",\"start\":100,\"end\":300}]'), updated_at=now() WHERE id='10000000-0000-0000-0000-000000000001';"
DRIFT="$(snap)"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --preflight --rehearsal; echo "assert ok: preflight detects target drift"
STEPC_REHEARSAL_SKIP_PREFLIGHT=1 must_fail python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal
grep -q "affected 0 rows" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: in-txn guard raised on drifted target" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap)" "$DRIFT" "DB unchanged (still drifted state)"

echo "== scenario 4: writer intervention after execute → rollback refused"
reset_fixture
BEFORE="$(snap)"
python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal
AFTER="$(snap)"
sql "INSERT INTO observations (id, project_id, session_id, rollup_memory_id, type, title, narrative, discovery_tokens, source_hook, content_hash, writer_host, status, observed_at) VALUES ('bbbbbbbb-0000-0000-0000-000000000001','AI_Copilot','sess-c-1','10000000-0000-0000-0000-000000000001','change','late','late',1,'r','hash-late','r','active',now());"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal
grep -q "outside the plan point at the target" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: refused (a) outside observation" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap | grep -v bbbbbbbb)" "$AFTER" "DB unchanged after refusal (a)"
sql "DELETE FROM observations WHERE id='bbbbbbbb-0000-0000-0000-000000000001';"
sql "UPDATE project_memories SET updated_at = now() + interval '1 minute' WHERE id='10000000-0000-0000-0000-000000000001';"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal
grep -q "updated after execute" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: refused (b) updated_at" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
sql "UPDATE project_memories SET updated_at = '2020-01-01' WHERE id='10000000-0000-0000-0000-000000000001';"
sql "UPDATE project_memories SET metadata = jsonb_set(metadata, '{capture,summarize_count}', '9') WHERE id='10000000-0000-0000-0000-000000000004';"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal; grep -q "PREFLIGHT FAILED" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: advisory preflight catches capture change"
STEPC_REHEARSAL_SKIP_PREFLIGHT=1 must_fail python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal
grep -q "differs from planned after-state" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: refused (c) capture changed" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
sql "UPDATE project_memories SET metadata = jsonb_set(metadata, '{capture,summarize_count}', '1') WHERE id='10000000-0000-0000-0000-000000000004';"
assert_eq "$(snap)" "$AFTER" "DB back to after-state"
python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal
assert_eq "$(snap)" "$BEFORE" "rollback succeeds once no writer intervention remains"

echo "== scenario 5 (Codex R2 #1): another project's rollup for the same session must not hijack the target"
reset_fixture
sql "INSERT INTO project_memories (id, project_id, type, summary, status, idempotency_key, metadata) VALUES ('10000000-0000-0000-0000-000000000099','Wrong','session','wrong target','active','capture:v05:Wrong:sess-c-2','{\"capture\":{\"version\":\"0.5\",\"session_id\":\"sess-c-2\",\"observation_ids\":[],\"spool_offsets\":[],\"transcript_sources\":[],\"summarize_count\":1,\"discovery_tokens\":1,\"empty_observation_windows\":[]}}');"
python3 "$BUILD" "$REMAP" "$PLAN" --rehearsal
assert_eq "$(python3 -c "import json;print(['guarded' if p['action']=='skip' and p['reason'].startswith('session also has active rollups under other projects') else 'NOT' for p in map(json.loads,open('$PLAN')) if p['session_id']=='sess-c-2'][0])")" "guarded" "sess-c-2 skipped when a Wrong-project rollup exists"
assert_eq "$(python3 -c "import json;print([p['new_project_id'] for p in map(json.loads,open('$PLAN')) if p['session_id']=='sess-c-1'][0])")" "AI_Copilot" "sess-c-1 still targets the map-intended project"
sql "DELETE FROM project_memories WHERE id='10000000-0000-0000-0000-000000000099';"

echo "== scenario 6 (Codex R2 #3): merged-source rollup capture drift after build → in-txn guard"
reset_fixture
BEFORE="$(snap)"
sql "UPDATE project_memories SET metadata = jsonb_set(metadata, '{capture,summarize_count}', '9') WHERE id='10000000-0000-0000-0000-000000000002';"
DRIFT="$(snap)"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --preflight --rehearsal; echo "assert ok: preflight detects source drift"
STEPC_REHEARSAL_SKIP_PREFLIGHT=1 must_fail python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal
grep -q "affected 0 rows" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: in-txn guard raised on drifted source" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap)" "$DRIFT" "DB unchanged"
[ -f "$SP/stepc-rehearsal-plan.executing.json" ] && echo "assert ok: executing marker RETAINED after server error (Codex R3 #1)" || { echo "ASSERT FAIL: executing marker missing"; exit 1; }
python3 "$APPLY" "$PLAN" "$REMAP" --check-state --rehearsal > "$SP/stepc-rehearsal-checkstate.txt"; grep -q "VERDICT: NEITHER" "$SP/stepc-rehearsal-checkstate.txt" && echo "assert ok: check-state says NEITHER on drifted DB (counts present, no crash)" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-checkstate.txt"; exit 1; }
grep -q '"_missing_counts": \[\]' "$SP/stepc-rehearsal-checkstate.txt" && echo "assert ok: tolerant check-state returned all counts" || { echo "ASSERT FAIL: counts missing"; cat "$SP/stepc-rehearsal-checkstate.txt"; exit 1; }

echo "== scenario 7 (Codex R2 #4): real target key conflict must fail preflight with a count"
reset_fixture
sql "INSERT INTO project_memories (id, project_id, type, summary, status, idempotency_key, metadata) VALUES ('10000000-0000-0000-0000-000000000098','AI_Copilot','session','stealer','active','capture:v05:AI_Copilot:sess-c-2','{}');"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --preflight --rehearsal
grep -q '"pm_target_key_conflict": "1"' "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: preflight reports pm_target_key_conflict=1" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
! grep -q "PREFLIGHT OK" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: no false PREFLIGHT OK"
sql "DELETE FROM project_memories WHERE id='10000000-0000-0000-0000-000000000098';"

echo "== scenario 8 (Codex R2 #2): leftover executing marker blocks execute; --check-state is read-only"
reset_fixture
BEFORE="$(snap)"
echo '{"note":"fake leftover"}' > "$SP/stepc-rehearsal-plan.executing.json"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal
grep -q "executing.json exists" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: execute refused with leftover marker" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
python3 "$APPLY" "$PLAN" "$REMAP" --check-state --rehearsal > "$SP/stepc-rehearsal-checkstate.txt"
grep -A8 'before_state' "$SP/stepc-rehearsal-checkstate.txt" | grep -q '"rows_not_matching_before_state": "0"' && echo "assert ok: check-state says before-state" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-checkstate.txt"; exit 1; }
assert_eq "$(snap)" "$BEFORE" "check-state changed nothing"
rm -f "$SP/stepc-rehearsal-plan.executing.json"

echo "== scenario 9 (Codex R3 #1): COMMIT succeeded but the trailing query failed → marker kept, check-state says AFTER-STATE, manual applied.json, rollback works"
reset_fixture
BEFORE="$(snap)"
STEPC_REHEARSAL_FAIL_AFTER_COMMIT=1 must_fail python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal
grep -q "COMMIT OUTCOME INDETERMINATE" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: reported INDETERMINATE (not 'DB unchanged')" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
[ -f "$SP/stepc-rehearsal-plan.executing.json" ] && [ ! -f "$SP/stepc-rehearsal-plan.applied.json" ] && echo "assert ok: executing marker kept, no applied.json" || { echo "ASSERT FAIL: marker state"; exit 1; }
must_fail bash -c "cd $SP && STEPC_RUN_INNER=1 bash stepc-run.sh $REMAP $PLAN"; grep -q "refuse to rebuild" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: driver refuses to rebuild over the marker" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
python3 "$APPLY" "$PLAN" "$REMAP" --check-state --rehearsal > "$SP/stepc-rehearsal-checkstate.txt"
grep -q "VERDICT: AFTER-STATE" "$SP/stepc-rehearsal-checkstate.txt" && echo "assert ok: check-state says AFTER-STATE" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-checkstate.txt"; exit 1; }
# 人工依標記補 applied.json（executed_at 用標記的 started_at：比真值早，回滾的 updated_at 檢查只會更嚴）
python3 - "$SP" <<'PY'
import json, sys, hashlib
from pathlib import Path
sp=Path(sys.argv[1]); m=json.loads((sp/'stepc-rehearsal-plan.executing.json').read_text())
(sp/'stepc-rehearsal-plan.applied.json').write_text(json.dumps({**m, 'system_id': __import__('os').environ['STEPC_EXPECTED_SYSTEM_ID'], 'executed_at': m['started_at'], 'note': 'reconstructed by hand from executing marker after check-state=AFTER-STATE'}))
(sp/'stepc-rehearsal-plan.executing.json').unlink()
PY
python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal
assert_eq "$(snap)" "$BEFORE" "rollback after reconstructed applied.json restores snapshot"

echo "== scenario 10 (Codex R3 #2): corrupt applied.json → check-state still runs; execute/rollback refuse"
reset_fixture
printf '{"plan_sha256": "abc' > "$SP/stepc-rehearsal-plan.applied.json"
python3 "$APPLY" "$PLAN" "$REMAP" --check-state --rehearsal > "$SP/stepc-rehearsal-checkstate.txt"
grep -q "CORRUPT" "$SP/stepc-rehearsal-checkstate.txt" && grep -q "VERDICT: BEFORE-STATE" "$SP/stepc-rehearsal-checkstate.txt" && echo "assert ok: check-state reports CORRUPT and still gives a verdict" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-checkstate.txt"; exit 1; }
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --rollback --rehearsal; grep -q "corrupt" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: rollback refuses on corrupt applied.json"
must_fail python3 "$APPLY" "$PLAN" "$REMAP" --execute --rehearsal; echo "assert ok: execute refuses on corrupt applied.json"
rm -f "$SP/stepc-rehearsal-plan.applied.json"

echo "== scenario 11 (advisor): driver outer path — dry-run passes; tampered approved plan → refuse"
reset_fixture
BEFORE="$(snap)"
cp "$PLAN" "$SP/stepc-rehearsal-approved.jsonl"
bash "$SP/stepc-run.sh" "$REMAP" "$SP/stepc-rehearsal-approved.jsonl" --dry-run --rehearsal > "$SP/stepc-rehearsal-driver.txt" 2>&1 || { echo "ASSERT FAIL: driver dry-run failed"; cat "$SP/stepc-rehearsal-driver.txt"; exit 1; }
grep -q "approved plan == rebuilt plan structurally (2 merge sessions)" "$SP/stepc-rehearsal-driver.txt" && grep -q "DRY RUN complete" "$SP/stepc-rehearsal-driver.txt" && echo "assert ok: driver dry-run (flock+pgrep+snapshot+compare+preflight) passed" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-driver.txt"; exit 1; }
assert_eq "$(snap)" "$BEFORE" "dry-run wrote nothing"
[ ! -f "$SP/stepc-rehearsal-approved.executing.json" ] && echo "assert ok: dry-run left no executing marker"
# 竄改核准計畫：拿掉一個 session
python3 - "$SP/stepc-rehearsal-approved.jsonl" <<'PY'
import json, sys
rows=[json.loads(l) for l in open(sys.argv[1],encoding='utf-8') if l.strip()]
rows=[r for r in rows if r['session_id']!='sess-c-2']
open(sys.argv[1],'w',encoding='utf-8').write('\n'.join(json.dumps(r,ensure_ascii=False) for r in rows)+'\n')
PY
must_fail bash "$SP/stepc-run.sh" "$REMAP" "$SP/stepc-rehearsal-approved.jsonl" --rehearsal
grep -q "APPROVED PLAN != REBUILT PLAN" "$SP/stepc-rehearsal-lastfail.txt" && echo "assert ok: driver refuses when approved != rebuilt" || { echo "ASSERT FAIL"; cat "$SP/stepc-rehearsal-lastfail.txt"; exit 1; }
assert_eq "$(snap)" "$BEFORE" "refusal wrote nothing"
rm -f "$SP"/stepc-rehearsal-approved*.jsonl "$SP"/snapshots/approved-plan.*.jsonl "$SP"/snapshots/remap.*.jsonl 2>/dev/null; chmod -R u+w "$SP/snapshots" 2>/dev/null; rm -rf "$SP/snapshots"

echo "== cleanup"
sql "DELETE FROM observations WHERE session_id LIKE 'sess-c-%'; DELETE FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-c-%';"
rm -f "$SP"/stepc-rehearsal-plan*.applied.json "$SP"/stepc-rehearsal-plan*.rolled-back.json "$SP"/stepc-rehearsal-plan*.executing.json "$SP"/stepc-rehearsal-plan*.txn.sql "$SP"/stepc-rehearsal-plan*.preflight.sql "$BAD"
echo "REHEARSAL PASSED"
