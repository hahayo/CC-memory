#!/usr/bin/env python3
"""Step C：依合併計畫（stepc-merge-build.py 產出）套用「N 個舊 rollup → 1 個目標」合併，或回滾。骨架沿用 Step B v3（單一交易＋資料表鎖）。

用法：
  stepc-merge-apply.py <plan.jsonl> <remap.jsonl> --preflight            唯讀：DB 身分、崩塌集合＝對照表 skip 列（雙向）、每列現況＝計畫 before-state、目標唯一鍵、目標 capture 未漂移
  stepc-merge-apply.py <plan.jsonl> <remap.jsonl> --execute              先跑唯讀 preflight，再於 worker 同一把 flock 內單一交易：
                                                                           BEGIN → LOCK TABLE（SHARE ROW EXCLUSIVE）→ 身分 → 集合相等 → 目標鍵衝突
                                                                           → 每 session：目標 metadata patch（WHERE capture 未漂移）／存活者改 key／其餘舊 rollup archived+merged_into
                                                                                         ／observations 改 project_id+rollup_memory_id（每條 ROW_COUNT=1）
                                                                           → postcheck（FK=0、崩塌集合精確＝預期、每 session 後狀態計數）→ COMMIT；任一不符整筆 ROLLBACK
  stepc-merge-apply.py <plan.jsonl> <remap.jsonl> --rollback             單一交易反向；交易內拒絕條件（任一成立 → 不變、交人工）：
                                                                           (a) 有 observation 指向目標 rollup 但不在「計畫列 ∪ 目標原有 linked」內（worker 在 execute 後寫了新列）
                                                                           (b) 目標／存活者 updated_at > executed_at
                                                                           (c) 目標 metadata.capture ≠ 計畫後狀態（worker 又寫了新 window）
                                                                         保證範圍同 Step B：只涵蓋已知應用程式 writer；回滾窗內禁止臨時 SQL。
  加 --rehearsal：允許 STEPC_DATABASE_URL（localhost:5438/cc_memory_test）＋ STEPC_EXPECTED_SYSTEM_ID；正式模式只讀 ~/.ccm-project-url，current_database() 必須 = cc_memory_project。
不 DELETE、不動 summary／embedding／spool_offsets／summarize_count／discovery_tokens／updated_at。
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

PROD_DB_NAME = 'cc_memory_project'
PROD_SYSTEM_ID = '7656209034643652651'  # 同 Step B（t5-result.txt；Codex R2c fix 1）
TEST_DB_NAME = 'cc_memory_test'
LOCK_PATH = Path.home() / '.cache/cc-memory/auto-capture-run.lock'


def q(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def jq(obj) -> str:
    return q(json.dumps(obj, ensure_ascii=False, separators=(',', ':'))) + '::jsonb'


def uuid_(v: str) -> str:
    return f"{q(v)}::uuid"


def load_rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def merges(plan: list[dict]) -> list[dict]:
    return [p for p in plan if p.get('action') == 'merge']


def capture_after(p: dict) -> dict:
    cap = dict(p['target']['capture_before'])
    cap['transcript_sources'] = p['patch']['transcript_sources_after']
    cap['observation_ids'] = p['patch']['observation_ids_after']
    return cap


# ---------------------------------------------------------------- 集合
def ids_values(pairs: list[tuple[str, str]]) -> str:
    if not pairs:
        return "(VALUES ('none', NULL::uuid)) AS m(t, id) WHERE false"
    return "(VALUES " + ',\n'.join(f"({q(t)}, {uuid_(i)})" for t, i in pairs) + ") AS m(t, id)"


def collapsed_set_check_sql(expected: list[tuple[str, str]], label: str) -> str:
    """DB 目前 project_id LIKE '\\_%' 的 (table,id) 集合（不分 status）必須與 expected 完全相等。"""
    return f"""
DO $chk$
DECLARE n_db_only integer; n_map_only integer;
BEGIN
  WITH m AS (SELECT t, id FROM {ids_values(expected)}),
       d AS (SELECT 'observations' AS t, id FROM observations WHERE project_id LIKE '\\_%'
             UNION ALL SELECT 'project_memories', id FROM project_memories WHERE project_id LIKE '\\_%')
  SELECT (SELECT count(*) FROM (SELECT t, id FROM d EXCEPT SELECT t, id FROM m) x),
         (SELECT count(*) FROM (SELECT t, id FROM m EXCEPT SELECT t, id FROM d) y)
    INTO n_db_only, n_map_only;
  IF n_db_only <> 0 OR n_map_only <> 0 THEN
    RAISE EXCEPTION '{label}: collapsed set != expected (db_only=%, map_only=%)', n_db_only, n_map_only;
  END IF;
  RAISE NOTICE '{label}: collapsed set == expected ({len(expected)} rows)';
END $chk$;
"""


def identity_check_sql(expected_db: str, expected_system_id: str) -> str:
    return f"""
DO $id$
DECLARE sysid text;
BEGIN
  IF current_database() <> {q(expected_db)} THEN RAISE EXCEPTION 'wrong database: % (expected {expected_db})', current_database(); END IF;
  SELECT system_identifier::text INTO sysid FROM pg_control_system();
  IF sysid <> {q(expected_system_id)} THEN RAISE EXCEPTION 'wrong PostgreSQL instance: system_identifier=% (expected {expected_system_id})', sysid; END IF;
END $id$;
SELECT 'system_id' AS k, system_identifier::text AS v FROM pg_control_system();
SELECT 'identity' AS k, current_database() || ' addr=' || coalesce(inet_server_addr()::text, 'unix') || ' port=' || coalesce(inet_server_port()::text, '-')
       || ' postmaster_start=' || pg_postmaster_start_time()::text AS v;
"""


def collapsed_before(remap: list[dict]) -> list[tuple[str, str]]:
    return [(r['table'], r['id']) for r in remap if r.get('action') != 'update']


def collapsed_after(remap: list[dict], plan: list[dict]) -> list[tuple[str, str]]:
    moved = {('observations', o['id']) for p in merges(plan) for o in p['observations']}
    moved |= {('project_memories', p['survivor']['id']) for p in merges(plan) if p.get('survivor')}
    return [x for x in collapsed_before(remap) if x not in moved]


# ---------------------------------------------------------------- 每列 UPDATE（正向／反向）
def session_forward_sql(p: dict) -> list[str]:
    t = p['target']; new_pid = p['new_project_id']; tid = t['id']
    cap_b = t['capture_before']; cap_a = capture_after(p)
    out: list[str] = []
    if p.get('survivor'):
        s = p['survivor']
        out.append(f"UPDATE project_memories SET project_id={q(s['new_project_id'])}, idempotency_key={q(s['new_idempotency_key'])}, "
                   f"metadata = jsonb_set(metadata, '{{capture}}', {jq(cap_a)}) "
                   f"WHERE id={uuid_(tid)} AND project_id={q(s['old_project_id'])} AND idempotency_key={q(s['old_idempotency_key'])} AND status='active' "
                   f"AND metadata->'capture' IS NOT DISTINCT FROM {jq(cap_b)}")
    else:
        out.append(f"UPDATE project_memories SET metadata = jsonb_set(metadata, '{{capture}}', {jq(cap_a)}) "
                   f"WHERE id={uuid_(tid)} AND project_id={q(t['project_id'])} AND idempotency_key={q(t['idempotency_key'])} AND status='active' "
                   f"AND metadata->'capture' IS NOT DISTINCT FROM {jq(cap_b)}")
    for m in p['merge_rollups']:
        mi = f"{uuid_(m['old_merged_into'])}" if m.get('old_merged_into') else 'NULL'
        out.append(f"UPDATE project_memories SET status='archived', merged_into={uuid_(tid)} "
                   f"WHERE id={uuid_(m['id'])} AND project_id={q(m['old_project_id'])} AND idempotency_key={q(m['old_idempotency_key'])} "
                   f"AND status={q(m['old_status'])} AND merged_into IS NOT DISTINCT FROM {mi} "
                   f"AND metadata->'capture' IS NOT DISTINCT FROM {jq(m['capture_before'])}")
    for o in p['observations']:
        ro = uuid_(o['old_rollup_memory_id']) if o.get('old_rollup_memory_id') else 'NULL'
        out.append(f"UPDATE observations SET project_id={q(new_pid)}, rollup_memory_id={uuid_(tid)} "
                   f"WHERE id={uuid_(o['id'])} AND project_id={q(o['old_project_id'])} AND session_id={q(o['session_id'])} AND status={q(o['old_status'])} "
                   f"AND content_hash={q(o['content_hash'])} AND rollup_memory_id IS NOT DISTINCT FROM {ro}")
    return out


def session_reverse_sql(p: dict) -> list[str]:
    t = p['target']; new_pid = p['new_project_id']; tid = t['id']
    cap_b = t['capture_before']; cap_a = capture_after(p)
    out: list[str] = []
    for o in p['observations']:
        ro = uuid_(o['old_rollup_memory_id']) if o.get('old_rollup_memory_id') else 'NULL'
        out.append(f"UPDATE observations SET project_id={q(o['old_project_id'])}, rollup_memory_id={ro} "
                   f"WHERE id={uuid_(o['id'])} AND project_id={q(new_pid)} AND session_id={q(o['session_id'])} AND status={q(o['old_status'])} "
                   f"AND content_hash={q(o['content_hash'])} AND rollup_memory_id={uuid_(tid)}")
    for m in p['merge_rollups']:
        mi = f"{uuid_(m['old_merged_into'])}" if m.get('old_merged_into') else 'NULL'
        out.append(f"UPDATE project_memories SET status={q(m['old_status'])}, merged_into={mi} "
                   f"WHERE id={uuid_(m['id'])} AND project_id={q(m['old_project_id'])} AND idempotency_key={q(m['old_idempotency_key'])} "
                   f"AND status='archived' AND merged_into={uuid_(tid)} "
                   f"AND metadata->'capture' IS NOT DISTINCT FROM {jq(m['capture_before'])}")
    if p.get('survivor'):
        s = p['survivor']
        out.append(f"UPDATE project_memories SET project_id={q(s['old_project_id'])}, idempotency_key={q(s['old_idempotency_key'])}, "
                   f"metadata = jsonb_set(metadata, '{{capture}}', {jq(cap_b)}) "
                   f"WHERE id={uuid_(tid)} AND project_id={q(s['new_project_id'])} AND idempotency_key={q(s['new_idempotency_key'])} AND status='active' "
                   f"AND metadata->'capture' IS NOT DISTINCT FROM {jq(cap_a)}")
    else:
        out.append(f"UPDATE project_memories SET metadata = jsonb_set(metadata, '{{capture}}', {jq(cap_b)}) "
                   f"WHERE id={uuid_(tid)} AND project_id={q(t['project_id'])} AND idempotency_key={q(t['idempotency_key'])} AND status='active' "
                   f"AND metadata->'capture' IS NOT DISTINCT FROM {jq(cap_a)}")
    return out


def update_blocks_sql(plan: list[dict], reverse: bool) -> str:
    out: list[str] = []
    for p in merges(plan):
        stmts = session_reverse_sql(p) if reverse else session_forward_sql(p)
        sid = p['session_id'][:8]
        tag = ''.join(ch for ch in sid if ch.isalnum())  # dollar-quote 標籤只能是英數
        lines = [f"DO $s{tag}$", "DECLARE n integer; total integer := 0;", "BEGIN"]
        for i, st in enumerate(stmts):
            lines.append(f"  {st};")
            lines.append(f"  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'session {sid} stmt % affected % rows (expected 1) — plan stale or row drifted', {i}, n; END IF; total := total + n;")
        lines.append(f"  IF total <> {len(stmts)} THEN RAISE EXCEPTION 'session {sid} total % <> {len(stmts)}', total; END IF;")
        lines.append(f"  RAISE NOTICE 'session {sid}: {len(stmts)} rows ok';")
        lines.append(f"END $s{tag}$;")
        out.append('\n'.join(lines))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------- 交易內檢查
def target_conflict_check_sql(plan: list[dict], reverse: bool) -> str:
    """目標唯一鍵：存活者的新 key（正向）／舊 key（反向）不得已被別列佔用；被合併 rollup 反向恢復 active 時舊 key 亦不得被佔用。"""
    pm_vals = []
    for p in merges(plan):
        if p.get('survivor'):
            s = p['survivor']
            pm_vals.append((p['target']['id'], s['old_project_id'] if reverse else s['new_project_id'], s['old_idempotency_key'] if reverse else s['new_idempotency_key']))
        if reverse:
            for m in p['merge_rollups']:
                pm_vals.append((m['id'], m['old_project_id'], m['old_idempotency_key']))
    ob_vals = [(o['id'], o['old_project_id'] if reverse else p['new_project_id'], o['session_id'], o['content_hash'])
               for p in merges(plan) for o in p['observations']]
    pm_sql = ',\n'.join(f"({uuid_(i)}, {q(pid)}, {q(k)})" for i, pid, k in pm_vals) or "(NULL::uuid, NULL, NULL)"
    ob_sql = ',\n'.join(f"({uuid_(i)}, {q(pid)}, {q(s)}, {q(h)})" for i, pid, s, h in ob_vals) or "(NULL::uuid, NULL, NULL, NULL)"
    return f"""
DO $tc$
DECLARE n_pm integer; n_ob integer;
BEGIN
  WITH e(id, dst_pid, dst_key) AS (VALUES {pm_sql})
  SELECT count(*) INTO n_pm FROM e JOIN project_memories p ON p.project_id = e.dst_pid AND p.idempotency_key = e.dst_key AND p.status = 'active' AND p.id <> e.id;
  WITH e(id, dst_pid, session_id, content_hash) AS (VALUES {ob_sql})
  SELECT count(*) INTO n_ob FROM e JOIN observations o ON o.project_id = e.dst_pid AND o.session_id = e.session_id AND o.content_hash = e.content_hash AND o.status = 'active' AND o.id <> e.id;
  IF n_pm <> 0 THEN RAISE EXCEPTION 'in-txn precheck: % rollup target key conflict(s) — rebuild the plan', n_pm; END IF;
  IF n_ob <> 0 THEN RAISE EXCEPTION 'in-txn precheck: % observation target unique conflict(s) — rebuild the plan', n_ob; END IF;
  RAISE NOTICE 'in-txn precheck: target key conflicts pm=0 obs=0';
END $tc$;
"""


def target_conflict_counts_sql(plan: list[dict], reverse: bool) -> str:
    """唯讀 preflight 用：回傳真實衝突計數（Codex R2 #4：不能靠 NOTICE 字串判成功）。"""
    pm_vals = []
    for p in merges(plan):
        if p.get('survivor'):
            s = p['survivor']
            pm_vals.append((p['target']['id'], s['old_project_id'] if reverse else s['new_project_id'], s['old_idempotency_key'] if reverse else s['new_idempotency_key']))
        if reverse:
            for m in p['merge_rollups']:
                pm_vals.append((m['id'], m['old_project_id'], m['old_idempotency_key']))
    ob_vals = [(o['id'], o['old_project_id'] if reverse else p['new_project_id'], o['session_id'], o['content_hash'])
               for p in merges(plan) for o in p['observations']]
    pm_sql = ',\n'.join(f"({uuid_(i)}, {q(pid)}, {q(k)})" for i, pid, k in pm_vals) or "(NULL::uuid, NULL, NULL)"
    ob_sql = ',\n'.join(f"({uuid_(i)}, {q(pid)}, {q(s)}, {q(h)})" for i, pid, s, h in ob_vals) or "(NULL::uuid, NULL, NULL, NULL)"
    return f"""
WITH e(id, dst_pid, dst_key) AS (VALUES {pm_sql})
SELECT 'pm_target_key_conflict' AS check, count(*) AS n FROM e JOIN project_memories p ON p.project_id = e.dst_pid AND p.idempotency_key = e.dst_key AND p.status = 'active' AND p.id <> e.id;
WITH e(id, dst_pid, session_id, content_hash) AS (VALUES {ob_sql})
SELECT 'ob_target_unique_conflict' AS check, count(*) AS n FROM e JOIN observations o ON o.project_id = e.dst_pid AND o.session_id = e.session_id AND o.content_hash = e.content_hash AND o.status = 'active' AND o.id <> e.id;
"""


def post_invariants_sql(plan: list[dict], after_set: list[tuple[str, str]], reverse: bool) -> str:
    """FK=0；崩塌集合精確；每 session：目標 linked obs 數、archived merged 數。"""
    checks = []
    for p in merges(plan):
        tid = p['target']['id']; sid = p['session_id'][:8]
        plan_obs = [o['id'] for o in p['observations']]
        # 存活者（類 2）自己原本 linked 的 obs 也在計畫列內，取聯集避免重複計數
        known = list(dict.fromkeys(p['target']['linked_obs_before'] + plan_obs))
        n_link = len(known) if not reverse else len(p['target']['linked_obs_before'])
        n_arch = 0 if reverse else len(p['merge_rollups'])
        checks.append(f"""
  SELECT count(*) INTO n FROM observations WHERE rollup_memory_id={uuid_(tid)} AND id IN (SELECT id FROM (VALUES {','.join(f'({uuid_(x)})' for x in known)}) v(id));
  IF n <> {n_link} THEN RAISE EXCEPTION 'postcheck session {sid}: target linked obs=% (expected {n_link})', n; END IF;
  SELECT count(*) INTO n FROM project_memories WHERE merged_into={uuid_(tid)} AND status='archived' AND id IN (SELECT id FROM (VALUES {','.join(f'({uuid_(m["id"])})' for m in p['merge_rollups']) or '(NULL::uuid)'}) v(id));
  IF n <> {n_arch} THEN RAISE EXCEPTION 'postcheck session {sid}: archived merged rollups=% (expected {n_arch})', n; END IF;""")
    return f"""
DO $post$
DECLARE n integer; n_fk integer; n_dup integer;
BEGIN
  SELECT count(*) INTO n_fk FROM observations o JOIN project_memories p ON p.id = o.rollup_memory_id WHERE o.project_id <> p.project_id;
  IF n_fk <> 0 THEN RAISE EXCEPTION 'postcheck: cross_project_fk_now=% (expected 0)', n_fk; END IF;
  SELECT count(*) INTO n_dup FROM (SELECT project_id, idempotency_key FROM project_memories WHERE status='active' AND idempotency_key IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) x;
  IF n_dup <> 0 THEN RAISE EXCEPTION 'postcheck: pm_dup_active_keys=%', n_dup; END IF;
  {''.join(checks)}
  RAISE NOTICE 'postcheck ok: cross_project_fk_now=0 dup_keys=0 per-session counts ok';
END $post$;
{collapsed_set_check_sql(after_set, 'postcheck')}
"""


def rollback_refusal_sql(plan: list[dict], executed_at_utc: str) -> str:
    parts = []
    for p in merges(plan):
        tid = p['target']['id']; sid = p['session_id'][:8]
        known = p['target']['linked_obs_before'] + [o['id'] for o in p['observations']]
        parts.append(f"""
  SELECT count(*) INTO n FROM observations WHERE rollup_memory_id={uuid_(tid)} AND id NOT IN (SELECT id FROM (VALUES {','.join(f'({uuid_(x)})' for x in known)}) v(id));
  IF n <> 0 THEN RAISE EXCEPTION 'rollback refused session {sid}: % observation(s) outside the plan point at the target (worker wrote after execute) — manual split required', n; END IF;
  SELECT count(*) INTO n FROM project_memories WHERE id={uuid_(tid)} AND updated_at > {q(executed_at_utc)}::timestamptz;
  IF n <> 0 THEN RAISE EXCEPTION 'rollback refused session {sid}: target updated after execute — manual review required'; END IF;
  SELECT count(*) INTO n FROM project_memories WHERE id={uuid_(tid)} AND metadata->'capture' IS NOT DISTINCT FROM {jq(capture_after(p))};
  IF n <> 1 THEN RAISE EXCEPTION 'rollback refused session {sid}: target metadata.capture differs from planned after-state (worker wrote a new window) — manual review required'; END IF;""")
    return f"""
DO $ref$
DECLARE n integer;
BEGIN
  {''.join(parts)}
  RAISE NOTICE 'rollback refusal checks ok';
END $ref$;
"""


# ---------------------------------------------------------------- preflight（唯讀）
def collapsed_set_counts_sql(expected: list[tuple[str, str]]) -> str:
    """容錯版集合檢查（--check-state 用）：回傳雙向差集計數，不 RAISE。"""
    return f"""
WITH m AS (SELECT t, id FROM {ids_values(expected)}),
     d AS (SELECT 'observations' AS t, id FROM observations WHERE project_id LIKE '\\_%'
           UNION ALL SELECT 'project_memories', id FROM project_memories WHERE project_id LIKE '\\_%')
SELECT 'collapsed_db_only' AS check, count(*) AS n FROM (SELECT t, id FROM d EXCEPT SELECT t, id FROM m) x;
WITH m AS (SELECT t, id FROM {ids_values(expected)}),
     d AS (SELECT 'observations' AS t, id FROM observations WHERE project_id LIKE '\\_%'
           UNION ALL SELECT 'project_memories', id FROM project_memories WHERE project_id LIKE '\\_%')
SELECT 'collapsed_map_only' AS check, count(*) AS n FROM (SELECT t, id FROM m EXCEPT SELECT t, id FROM d) y;
"""


def preflight_sql(plan: list[dict], remap: list[dict], reverse: bool, tolerant: bool = False) -> str:
    before = collapsed_after(remap, plan) if reverse else collapsed_before(remap)
    parts = ["\\set ON_ERROR_STOP 1",
             "SELECT 'db' AS check, current_database() AS n;",
             "SELECT 'ro' AS check, current_setting('default_transaction_read_only') AS n;",
             "SELECT 'system_id' AS check, system_identifier::text AS n FROM pg_control_system();"]
    if tolerant:
        parts.append(collapsed_set_counts_sql(before))
    else:
        parts.append(collapsed_set_check_sql(before, 'preflight'))
        parts.append("SELECT 'collapsed_set_equal' AS check, 0 AS n;")
    # 每列現況：把正向／反向的 UPDATE 改寫成計數（WHERE 條件相同），必須每條都命中 1 列
    total = 0
    cnt_parts = []
    for p in merges(plan):
        stmts = session_reverse_sql(p) if reverse else session_forward_sql(p)
        for st in stmts:
            total += 1
            where = st.split(' WHERE ', 1)[1]
            table = 'project_memories' if st.startswith('UPDATE project_memories') else 'observations'
            cnt_parts.append(f"SELECT count(*) FROM {table} WHERE {where}")
    if cnt_parts:
        parts.append("SELECT 'rows_not_matching_before_state' AS check, " + f"{total} - (" + ' + '.join(f"({c})" for c in cnt_parts) + ") AS n;")
    parts.append(target_conflict_counts_sql(plan, reverse))
    parts.append("SELECT 'cross_project_fk_now' AS check, count(*) AS n FROM observations o JOIN project_memories p ON p.id = o.rollup_memory_id WHERE o.project_id <> p.project_id;")
    return '\n'.join(parts) + '\n'


def transaction_sql(plan: list[dict], remap: list[dict], reverse: bool, expected_db: str, expected_system_id: str, executed_at_utc: str | None) -> str:
    before = collapsed_after(remap, plan) if reverse else collapsed_before(remap)
    after = collapsed_before(remap) if reverse else collapsed_after(remap, plan)
    parts = ["\\set ON_ERROR_STOP 1", "BEGIN;", "SET LOCAL lock_timeout = '30s';", "SET LOCAL statement_timeout = '300s';",
             "LOCK TABLE project_memories, observations IN SHARE ROW EXCLUSIVE MODE;",
             identity_check_sql(expected_db, expected_system_id),
             collapsed_set_check_sql(before, 'in-txn precheck'),
             target_conflict_check_sql(plan, reverse)]
    if reverse:
        assert executed_at_utc
        parts.append(rollback_refusal_sql(plan, executed_at_utc))
    parts.append(update_blocks_sql(plan, reverse))
    parts.append(post_invariants_sql(plan, after, reverse))
    parts.append("SELECT 'executed_at' AS k, clock_timestamp()::text AS v;")
    parts.append("COMMIT;")
    if os.environ.get('STEPC_REHEARSAL_FAIL_AFTER_COMMIT') == '1':  # 彩排專用：模擬 COMMIT 成功後收尾查詢出錯
        parts.append("SELECT 1/0;")
    parts.append("SELECT 'committed' AS k, 'yes' AS v;")
    return '\n'.join(parts) + '\n'


def run_psql(url: str, sql_file: Path, read_only: bool) -> tuple[int, str]:
    env = dict(os.environ)
    env['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=120000' if read_only else ''
    proc = subprocess.run(['psql', url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', str(sql_file)], env=env, capture_output=True, text=True)
    return proc.returncode, (proc.stdout + proc.stderr)


def parse_kv(out: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in out.splitlines():
        if '|' in line and not line.startswith(('NOTICE', 'psql:')):
            k, _, v = line.partition('|')
            result[k.strip()] = v.strip()
    return result


def main() -> int:
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    plan_path, remap_path, mode = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    rehearsal = '--rehearsal' in sys.argv[4:]
    if mode not in ('--preflight', '--execute', '--rollback', '--check-state'):
        raise SystemExit('mode must be --preflight | --execute | --rollback | --check-state')
    plan = load_rows(plan_path); remap = load_rows(remap_path)
    reverse = mode == '--rollback'
    work = merges(plan)
    plan_sha = sha256_file(plan_path); remap_sha = sha256_file(remap_path)
    if rehearsal:
        url = os.environ.get('STEPC_DATABASE_URL', '')
        if f'localhost:5438/{TEST_DB_NAME}' not in url:
            raise SystemExit(f'rehearsal requires STEPC_DATABASE_URL pointing at localhost:5438/{TEST_DB_NAME}')
        expected_db = TEST_DB_NAME
        expected_system_id = os.environ.get('STEPC_EXPECTED_SYSTEM_ID', '')
        if not expected_system_id:
            raise SystemExit('rehearsal requires STEPC_EXPECTED_SYSTEM_ID')
    else:
        url = (Path.home() / '.ccm-project-url').read_text(encoding='utf-8').strip()
        expected_db = PROD_DB_NAME; expected_system_id = PROD_SYSTEM_ID
    if os.environ.get('STEPC_REHEARSAL_FAIL_AFTER_COMMIT') == '1' and not rehearsal:
        raise SystemExit('STEPC_REHEARSAL_FAIL_AFTER_COMMIT is rehearsal-only; refuse in production mode')
    n_pm = sum(len(p['merge_rollups']) + 1 for p in work)
    n_obs = sum(len(p['observations']) for p in work)
    print(f'mode={mode} rehearsal={rehearsal} merge_sessions={len(work)} rollup_rows={n_pm} observation_rows={n_obs} plan_sha256={plan_sha} remap_sha256={remap_sha}')

    applied = plan_path.with_name(f'{plan_path.stem}.applied.json')
    executing = plan_path.with_name(f'{plan_path.stem}.executing.json')  # Codex R2 #2：交易送出前先落盤，COMMIT 後才換成 applied.json
    meta = None; meta_error = None
    if applied.exists():
        try:
            meta = json.loads(applied.read_text(encoding='utf-8'))
        except Exception as e:  # Codex R3 #2：損壞的完成紀錄不能讓查核崩掉
            meta_error = f'{applied.name} unreadable/corrupt: {e!r}'
    if mode == '--check-state':
        # 唯讀：分別跑正向與反向的「容錯」preflight（集合不符回計數而非 RAISE），判定 DB 是 before-state／after-state／都不是
        required = ('collapsed_db_only', 'collapsed_map_only', 'rows_not_matching_before_state', 'pm_target_key_conflict', 'ob_target_unique_conflict', 'cross_project_fk_now')
        res = {}
        for label, rev in (('before_state(forward)', False), ('after_state(reverse)', True)):
            f = plan_path.with_name(f'{plan_path.stem}.check-{"after" if rev else "before"}.preflight.sql')
            f.write_text(preflight_sql(plan, remap, rev, tolerant=True), encoding='utf-8')
            c, o = run_psql(url, f, read_only=True)
            k = parse_kv(o)
            missing = [r for r in required if r not in k]
            k['_exit'] = c
            k['_missing_counts'] = missing
            k['_identity_ok'] = (k.get('db') == expected_db and k.get('system_id') == expected_system_id and k.get('ro') == 'on')  # Codex R4：判定前先核對 DB 身分
            k['_matches'] = (c == 0 and k['_identity_ok'] and not missing and all(k.get(r) == '0' for r in required))
            res[label] = k
        print(json.dumps(res, ensure_ascii=False, indent=2))
        if not all(v['_identity_ok'] for v in res.values()):
            print('executing marker:', 'PRESENT' if executing.exists() else 'absent', '| applied.json:', ('CORRUPT — ' + meta_error) if meta_error else ('present' if applied.exists() else 'absent'))
            print(f'VERDICT: IDENTITY MISMATCH — connected DB is not {expected_db}/{expected_system_id} (or not read-only); no state verdict')
            return 3
        print('executing marker:', 'PRESENT' if executing.exists() else 'absent', '| applied.json:', ('CORRUPT — ' + meta_error) if meta_error else ('present' if applied.exists() else 'absent'))
        b, a = res['before_state(forward)']['_matches'], res['after_state(reverse)']['_matches']
        print('VERDICT:', 'BEFORE-STATE (nothing applied)' if b and not a else 'AFTER-STATE (committed)' if a and not b else 'NEITHER / AMBIGUOUS — hand over to a human')
        return 0
    if meta_error and mode in ('--execute', '--rollback'):
        raise SystemExit(meta_error + ' — run --check-state and repair the file by hand first')
    if mode == '--execute' and meta is not None:
        raise SystemExit(f'{applied.name} exists (executed_at={meta.get("executed_at")}); refuse to re-execute.')
    if mode == '--execute' and executing.exists():
        raise SystemExit(f'{executing.name} exists: a previous execute started and did not record its outcome. Run --check-state (read-only) first; if after-state, write applied.json by hand from that marker; never re-execute or rebuild over this plan.')
    if mode == '--rollback':
        if meta is None:
            raise SystemExit(f'{applied.name} missing: cannot verify executed_at; manual reversal via the plan required')
        for k, v in (('plan_sha256', plan_sha), ('remap_sha256', remap_sha), ('db', expected_db), ('system_id', expected_system_id)):
            if meta.get(k) != v:
                raise SystemExit(f'applied.json {k}={meta.get(k)} != {v}; refuse')
    if not work:
        print('nothing to do'); return 0

    # 0) 計畫內自撞：同一目標／同一列不得出現兩次
    tgt = Counter(p['target']['id'] for p in work)
    rows_c = Counter([('pm', m['id']) for p in work for m in p['merge_rollups']] + [('obs', o['id']) for p in work for o in p['observations']])
    keys = Counter((p['survivor']['new_project_id'], p['survivor']['new_idempotency_key']) for p in work if p.get('survivor'))
    if any(v > 1 for v in tgt.values()) or any(v > 1 for v in rows_c.values()) or any(v > 1 for v in keys.values()):
        print('WITHIN-PLAN DUPLICATES — rebuild the plan'); return 3

    # 1) 唯讀 preflight
    pf_file = plan_path.with_name(f'{plan_path.stem}.{mode.strip("-")}.preflight.sql')
    pf_file.write_text(preflight_sql(plan, remap, reverse), encoding='utf-8')
    code, out = run_psql(url, pf_file, read_only=True)
    checks = parse_kv(out)
    print('preflight:', json.dumps(checks, ensure_ascii=False))
    notices = [l for l in out.splitlines() if 'NOTICE' in l or 'ERROR' in l]
    print('\n'.join(notices[-6:]))
    required = ('collapsed_set_equal', 'rows_not_matching_before_state', 'pm_target_key_conflict', 'ob_target_unique_conflict', 'cross_project_fk_now')
    ok = code == 0 and checks.get('db') == expected_db and checks.get('ro') == 'on' and checks.get('system_id') == expected_system_id and \
        all(checks.get(k) == '0' for k in required) and \
        all(checks.get(k, 'x') == '0' for k in checks if k not in ('db', 'ro', 'system_id'))
    if not ok and not (rehearsal and os.environ.get('STEPC_REHEARSAL_SKIP_PREFLIGHT') == '1' and mode != '--preflight'):
        print('PREFLIGHT FAILED'); print(out[-2000:]); return 3
    if mode == '--preflight':
        print('PREFLIGHT OK'); return 0
    if not ok:
        print('PREFLIGHT FAILED but STEPC_REHEARSAL_SKIP_PREFLIGHT=1 (rehearsal only): continuing to exercise in-transaction guards')

    # 2) worker 同一把 flock ＋ 交易內 LOCK TABLE
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    inherited = os.environ.get('STEPC_LOCK_INHERITED') == '1'  # 只由 stepc-run.sh 設：驅動腳本已用 flock(1) 持有同一把鎖
    with open(LOCK_PATH, 'w') as lock:
        if not inherited:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('worker tick in progress (lock held); try again in ~30 s'); return 4
        print(f'flock {"inherited from driver" if inherited else "acquired"} {LOCK_PATH}; started {datetime.now(timezone.utc).isoformat(timespec="seconds")}')
        sql_file = plan_path.with_name(f'{plan_path.stem}.{mode.strip("-")}.txn.sql')
        sql_file.write_text(transaction_sql(plan, remap, reverse, expected_db, expected_system_id, meta.get('executed_at') if meta else None), encoding='utf-8')
        if mode == '--execute':
            executing.write_text(json.dumps({'plan_sha256': plan_sha, 'remap_sha256': remap_sha, 'db': expected_db,
                                             'started_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                                             'note': 'transaction submitted; if this file outlives the run without applied.json, outcome is unknown — run --check-state'},
                                            ensure_ascii=False, indent=2), encoding='utf-8')
        code, out = run_psql(url, sql_file, read_only=False)
        kv = parse_kv(out)
        notices = [l for l in out.splitlines() if l.startswith('psql:') or 'NOTICE' in l or 'ERROR' in l]
        print('\n'.join(notices[-12:]))
        if kv.get('committed') != 'yes':
            # Codex R3 #1：沒有拿到 committed|yes 就一律保留 executing 標記——「有 ERROR」不能證明交易已回滾
            #（COMMIT 之後的收尾查詢也可能報 ERROR）。是否真的回滾，交 --check-state（唯讀）判定後由人處理標記。
            if any('ERROR:' in l for l in out.splitlines()) and 'executed_at' not in kv:
                print(f'server ERROR before the pre-COMMIT marker (exit={code}); most likely rolled back, but NOT proven — executing marker kept.')
            else:
                print(f'COMMIT OUTCOME INDETERMINATE (exit={code}). DO NOT RETRY.')
            print('Next: python3 stepc-merge-apply.py <plan> <remap> --check-state (read-only). before-state → remove the executing marker by hand; after-state → write applied.json by hand from the marker + check-state output.')
            print(out[-2000:]); return 2
        print(f"COMMITTED at {kv.get('executed_at')} UTC; identity: {kv.get('identity')}")
        if mode == '--execute':
            tmp = applied.with_name(applied.name + '.tmp')
            tmp.write_text(json.dumps({'plan_sha256': plan_sha, 'remap_sha256': remap_sha, 'db': expected_db, 'system_id': kv.get('system_id'),
                                           'identity': kv.get('identity'), 'executed_at': kv.get('executed_at'),
                                           'merge_sessions': len(work), 'rollup_rows': n_pm, 'observation_rows': n_obs,
                                           'rollback_note': 'automatic rollback only while no known application writer touched the targets (new linked observation / updated_at / metadata.capture); ad-hoc SQL not detected — forbidden in the rollback window; otherwise manual reversal via the plan'},
                                          ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(tmp, applied)  # Codex R3 #2：原子替換，不留半截檔
            print(f'wrote {applied.name}')
            if executing.exists():
                executing.unlink()
        else:
            rolled = plan_path.with_name(f'{plan_path.stem}.rolled-back.json')
            applied.rename(rolled); print(f'renamed {applied.name} → {rolled.name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
