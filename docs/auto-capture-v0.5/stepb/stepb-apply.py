#!/usr/bin/env python3
"""Step B v3：依對照表重歸屬既有列（或回滾）。Codex R2b 後重寫：單一交易＋資料表鎖，不再有批次 journal。

用法：
  stepb-apply.py <remap.jsonl> --preflight                  唯讀：DB 身分、崩塌集合＝對照表（雙向）、每列現況＝預期來源狀態、目標唯一鍵衝突、跨 project FK
  stepb-apply.py <remap.jsonl> --execute                    先跑唯讀 preflight（諮詢性），再在 worker 同一把 flock 內以「單一交易」套用：
                                                              BEGIN → LOCK TABLE（SHARE ROW EXCLUSIVE，讀不擋、寫全擋）→ 交易內重做完整集合檢查
                                                              → 逐條 UPDATE（每條 ROW_COUNT 必須 = 1）→ 交易內 postcheck（跨 project FK=0、殘餘崩塌列＝skip 數）
                                                              → COMMIT。任何一步不符 → RAISE → 整筆交易 ROLLBACK，DB 完全不變。
                                                            COMMIT 後才寫 <stem>.applied.json（remap sha256、DB 身分、executed_at）——只是回滾的門票，不是部分狀態的真相（單一交易沒有部分狀態）。
  stepb-apply.py <remap.jsonl> --rollback                   同樣單一交易反向套用；交易內另加兩個拒絕條件（任一成立 → RAISE，DB 不變，交人工）：
                                                              (a) 對照表以外的 observation 指向本次搬動過的 rollup（worker 在 execute 後寫了新列）
                                                              (b) 搬動過的 rollup 的 updated_at > executed_at（worker 在 execute 後 by-id 更新過該 rollup）
  加 --rehearsal：允許 STEPB_DATABASE_URL（必須是 localhost:5438/cc_memory_test）；正式模式忽略該環境變數，只讀 ~/.ccm-project-url，且 current_database() 必須精確 = cc_memory_project。

守衛（每條 UPDATE 的 WHERE）：
  observations：id ＋ project_id=來源 ＋ session_id ＋ status ＋ content_hash ＋ rollup_memory_id IS NOT DISTINCT FROM 舊值；只 SET project_id
  project_memories：id ＋ project_id=來源 ＋ idempotency_key=來源 key ＋ status；只 SET project_id、idempotency_key
  archive／repoint、encoded-dir-only：一律 needs_human（對照表 action=skip），不執行。不 DELETE。
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PROD_DB_NAME = 'cc_memory_project'
TEST_DB_NAME = 'cc_memory_test'
LOCK_PATH = Path.home() / '.cache/cc-memory/auto-capture-run.lock'
DO_BLOCK_ROWS = 500  # 只是把 UPDATE 切成多個 DO 區塊方便 psql 輸出定位，仍在同一交易內


def q(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def load_rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def actionable(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r.get('action') == 'update']


def skipped(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r.get('action') != 'update']


# ---------------------------------------------------------------- SQL 片段
def stmt(r: dict, reverse: bool) -> str:
    """一條 UPDATE，預期恰好影響 1 列（WHERE 帶 primary key）。"""
    t = r['table']
    if t == 'project_memories':
        src_pid, src_key = (r['new_project_id'], r['new_idempotency_key']) if reverse else (r['old_project_id'], r['old_idempotency_key'])
        dst_pid, dst_key = (r['old_project_id'], r['old_idempotency_key']) if reverse else (r['new_project_id'], r['new_idempotency_key'])
        return (f"UPDATE project_memories SET project_id={q(dst_pid)}, idempotency_key={q(dst_key)} "
                f"WHERE id={q(r['id'])}::uuid AND project_id={q(src_pid)} AND idempotency_key={q(src_key)} AND status={q(r['old_status'])}")
    if t == 'observations':
        src_pid = r['new_project_id'] if reverse else r['old_project_id']
        dst_pid = r['old_project_id'] if reverse else r['new_project_id']
        rollup = f"{q(r['old_rollup_memory_id'])}::uuid" if r.get('old_rollup_memory_id') else 'NULL'
        return (f"UPDATE observations SET project_id={q(dst_pid)} "
                f"WHERE id={q(r['id'])}::uuid AND project_id={q(src_pid)} AND session_id={q(r['session_id'])} "
                f"AND status={q(r['old_status'])} AND content_hash={q(r['content_hash'])} "
                f"AND rollup_memory_id IS NOT DISTINCT FROM {rollup}")
    raise SystemExit(f'unsupported row: {r}')


def ids_values(rows: list[dict]) -> str:
    """VALUES 清單：(table, id::uuid)。"""
    if not rows:
        return "(VALUES ('none', NULL::uuid)) AS m(t, id) WHERE false"
    return "(VALUES " + ',\n'.join(f"({q(r['table'])}, {q(r['id'])}::uuid)" for r in rows) + ") AS m(t, id)"


def collapsed_set_check_sql(expected_collapsed: list[dict], label: str) -> str:
    """交易內／唯讀皆可用：DB 目前 project_id LIKE '\\_%' 的 (table,id) 集合必須與 expected_collapsed 完全相等（雙向差集皆 0）。"""
    return f"""
DO $chk$
DECLARE n_db_only integer; n_map_only integer;
BEGIN
  WITH m AS (SELECT t, id FROM {ids_values(expected_collapsed)}),
       d AS (SELECT 'observations' AS t, id FROM observations WHERE project_id LIKE '\\_%'
             UNION ALL SELECT 'project_memories', id FROM project_memories WHERE project_id LIKE '\\_%')
  SELECT (SELECT count(*) FROM (SELECT t, id FROM d EXCEPT SELECT t, id FROM m) x),
         (SELECT count(*) FROM (SELECT t, id FROM m EXCEPT SELECT t, id FROM d) y)
    INTO n_db_only, n_map_only;
  IF n_db_only <> 0 OR n_map_only <> 0 THEN
    RAISE EXCEPTION '{label}: collapsed set != expected (db_only=%, map_only=%)', n_db_only, n_map_only;
  END IF;
  RAISE NOTICE '{label}: collapsed set == expected ({len(expected_collapsed)} rows)';
END $chk$;
"""


def identity_check_sql(expected_db: str) -> str:
    return f"""
DO $id$
BEGIN
  IF current_database() <> {q(expected_db)} THEN
    RAISE EXCEPTION 'wrong database: % (expected {expected_db})', current_database();
  END IF;
END $id$;
SELECT 'identity' AS k, current_database() || ' addr=' || coalesce(inet_server_addr()::text, 'unix') || ' port=' || coalesce(inet_server_port()::text, '-')
       || ' postmaster_start=' || pg_postmaster_start_time()::text AS v;
"""


def target_conflict_check_sql(work: list[dict], reverse: bool) -> str:
    """交易內：目標狀態不得撞 partial unique index（worker 在對照表產生後可能已在新 id 下建了同 session 的 rollup）。"""
    pm = [r for r in work if r['table'] == 'project_memories']
    ob = [r for r in work if r['table'] == 'observations']
    pm_vals = ',\n'.join(
        f"({q(r['id'])}::uuid, {q(r['old_project_id'] if reverse else r['new_project_id'])}, {q(r['old_idempotency_key'] if reverse else r['new_idempotency_key'])})"
        for r in pm) or "(NULL::uuid, NULL, NULL)"
    ob_vals = ',\n'.join(
        f"({q(r['id'])}::uuid, {q(r['old_project_id'] if reverse else r['new_project_id'])}, {q(r['session_id'])}, {q(r['content_hash'])})"
        for r in ob) or "(NULL::uuid, NULL, NULL, NULL)"
    return f"""
DO $tc$
DECLARE n_pm integer; n_ob integer;
BEGIN
  WITH e(id, dst_pid, dst_key) AS (VALUES {pm_vals})
  SELECT count(*) INTO n_pm FROM e JOIN project_memories p
    ON p.project_id = e.dst_pid AND p.idempotency_key = e.dst_key AND p.status = 'active' AND p.id <> e.id;
  WITH e(id, dst_pid, session_id, content_hash) AS (VALUES {ob_vals})
  SELECT count(*) INTO n_ob FROM e JOIN observations o
    ON o.project_id = e.dst_pid AND o.session_id = e.session_id AND o.content_hash = e.content_hash AND o.status = 'active' AND o.id <> e.id;
  IF n_pm <> 0 THEN RAISE EXCEPTION 'in-txn precheck: % rollup target key conflict(s) — table is stale (worker created sibling rollups); rebuild the map', n_pm; END IF;
  IF n_ob <> 0 THEN RAISE EXCEPTION 'in-txn precheck: % observation target unique conflict(s); rebuild the map', n_ob; END IF;
  RAISE NOTICE 'in-txn precheck: target key conflicts pm=0 obs=0';
END $tc$;
"""


def update_blocks_sql(work: list[dict], reverse: bool) -> str:
    """逐條 UPDATE，切成 ≤500 條的 DO 區塊（同一交易）；每條 ROW_COUNT 必須 = 1。"""
    ordered = [r for r in work if r['table'] == 'project_memories'] + [r for r in work if r['table'] == 'observations']
    out: list[str] = []
    for b in range(0, len(ordered), DO_BLOCK_ROWS):
        block = ordered[b:b + DO_BLOCK_ROWS]
        lines = [f"DO $upd{b}$", "DECLARE n integer; total integer := 0;", "BEGIN"]
        for r in block:
            lines.append(f"  {stmt(r, reverse)};")
            lines.append(f"  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'row % affected % rows (expected 1)', {q(r['id'])}, n; END IF; total := total + n;")
        lines.append(f"  IF total <> {len(block)} THEN RAISE EXCEPTION 'block total % <> expected {len(block)}', total; END IF;")
        lines.append(f"  RAISE NOTICE 'block rows {b + 1}-{b + len(block)} ok';")
        lines.append(f"END $upd{b}$;")
        out.append('\n'.join(lines))
    return '\n'.join(out) + '\n'


def post_invariants_sql(expected_after_collapsed: list[dict]) -> str:
    """交易內 postcheck：跨 project FK 必須 0；殘餘崩塌集合必須精確＝預期（execute：skip 列；rollback：全部對照表列）。"""
    n_obs = sum(1 for r in expected_after_collapsed if r['table'] == 'observations')
    n_pm = sum(1 for r in expected_after_collapsed if r['table'] == 'project_memories')
    return f"""
DO $post$
DECLARE n_fk integer; n_obs integer; n_pm integer;
BEGIN
  SELECT count(*) INTO n_fk FROM observations o JOIN project_memories p ON p.id = o.rollup_memory_id WHERE o.project_id <> p.project_id;
  SELECT count(*) INTO n_obs FROM observations WHERE project_id LIKE '\\_%';
  SELECT count(*) INTO n_pm FROM project_memories WHERE project_id LIKE '\\_%';
  IF n_fk <> 0 THEN RAISE EXCEPTION 'postcheck: cross_project_fk_now=% (expected 0)', n_fk; END IF;
  IF n_obs <> {n_obs} THEN RAISE EXCEPTION 'postcheck: obs_collapsed_remaining=% (expected {n_obs})', n_obs; END IF;
  IF n_pm <> {n_pm} THEN RAISE EXCEPTION 'postcheck: pm_collapsed_remaining=% (expected {n_pm})', n_pm; END IF;
  RAISE NOTICE 'postcheck ok: cross_project_fk_now=0 obs_collapsed_remaining=% pm_collapsed_remaining=%', n_obs, n_pm;
END $post$;
{collapsed_set_check_sql(expected_after_collapsed, 'postcheck')}
"""


def rollback_refusal_sql(work: list[dict], executed_at_utc: str) -> str:
    """回滾前（交易內）：(a) 對照表以外的 observation 指向搬動過的 rollup → 拒絕；(b) 搬動過的 rollup 在 execute 後被更新過 → 拒絕。"""
    moved_pm = [r for r in work if r['table'] == 'project_memories']
    all_obs_ids = [r for r in work if r['table'] == 'observations']
    pm_vals = ',\n'.join(f"({q(r['id'])}::uuid)" for r in moved_pm) or "(NULL::uuid)"
    obs_vals = ',\n'.join(f"({q(r['id'])}::uuid)" for r in all_obs_ids) or "(NULL::uuid)"
    return f"""
DO $ref$
DECLARE n_outside integer; n_touched integer;
BEGIN
  WITH moved(id) AS (VALUES {pm_vals}), mapped(id) AS (VALUES {obs_vals})
  SELECT count(*) INTO n_outside FROM observations o
   WHERE o.rollup_memory_id IN (SELECT id FROM moved) AND o.id NOT IN (SELECT id FROM mapped WHERE id IS NOT NULL);
  WITH moved(id) AS (VALUES {pm_vals})
  SELECT count(*) INTO n_touched FROM project_memories p
   WHERE p.id IN (SELECT id FROM moved) AND p.updated_at > {q(executed_at_utc)}::timestamptz;
  IF n_outside <> 0 THEN
    RAISE EXCEPTION 'rollback refused: % observation(s) outside the map point at moved rollups (worker wrote after execute) — manual repoint/split required', n_outside;
  END IF;
  IF n_touched <> 0 THEN
    RAISE EXCEPTION 'rollback refused: % moved rollup(s) updated after execute (updated_at > %) — manual review required', n_touched, {q(executed_at_utc)};
  END IF;
  RAISE NOTICE 'rollback refusal checks ok: outside_obs=0 touched_rollups=0';
END $ref$;
"""


# ---------------------------------------------------------------- preflight（唯讀，諮詢性；交易內檢查才是最終）
def preflight_sql(rows: list[dict], reverse: bool, expected_db: str) -> str:
    work = actionable(rows)
    expected_collapsed = rows if not reverse else skipped(rows)
    parts = ["\\set ON_ERROR_STOP 1",
             "SELECT 'db' AS check, current_database() AS n;",
             "SELECT 'ro' AS check, current_setting('default_transaction_read_only') AS n;",
             collapsed_set_check_sql(expected_collapsed, 'preflight'),
             "SELECT 'collapsed_set_equal' AS check, 0 AS n;"]
    pm = [r for r in work if r['table'] == 'project_memories']
    ob = [r for r in work if r['table'] == 'observations']
    if pm:
        vals = ',\n'.join(
            f"({q(r['id'])}::uuid, {q(r['new_project_id'] if reverse else r['old_project_id'])}, "
            f"{q(r['new_idempotency_key'] if reverse else r['old_idempotency_key'])}, {q(r['old_status'])}, "
            f"{q(r['old_project_id'] if reverse else r['new_project_id'])}, {q(r['old_idempotency_key'] if reverse else r['new_idempotency_key'])})"
            for r in pm)
        cte = f"WITH e(id, src_pid, src_key, src_status, dst_pid, dst_key) AS (VALUES\n{vals})"
        parts.append(f"""{cte}
SELECT 'pm_state_mismatch' AS check, count(*) AS n FROM e LEFT JOIN project_memories p ON p.id = e.id
 WHERE p.id IS NULL OR p.project_id <> e.src_pid OR p.idempotency_key IS DISTINCT FROM e.src_key OR p.status <> e.src_status;""")
        parts.append(f"""{cte}
SELECT 'pm_target_key_conflict' AS check, count(*) AS n FROM e JOIN project_memories p
  ON p.project_id = e.dst_pid AND p.idempotency_key = e.dst_key AND p.status = 'active' AND p.id <> e.id;""")
    if ob:
        vals = ',\n'.join(
            f"({q(r['id'])}::uuid, {q(r['new_project_id'] if reverse else r['old_project_id'])}, {q(r['session_id'])}, "
            f"{q(r['old_status'])}, {q(r['content_hash'])}, {(q(r['old_rollup_memory_id']) + '::uuid') if r.get('old_rollup_memory_id') else 'NULL::uuid'}, "
            f"{q(r['old_project_id'] if reverse else r['new_project_id'])})"
            for r in ob)
        cte = f"WITH e(id, src_pid, session_id, src_status, content_hash, rollup, dst_pid) AS (VALUES\n{vals})"
        parts.append(f"""{cte}
SELECT 'ob_state_mismatch' AS check, count(*) AS n FROM e LEFT JOIN observations o ON o.id = e.id
 WHERE o.id IS NULL OR o.project_id <> e.src_pid OR o.session_id <> e.session_id OR o.status <> e.src_status
    OR o.content_hash <> e.content_hash OR o.rollup_memory_id IS DISTINCT FROM e.rollup;""")
        parts.append(f"""{cte}
SELECT 'ob_target_unique_conflict' AS check, count(*) AS n FROM e JOIN observations o
  ON o.project_id = e.dst_pid AND o.session_id = e.session_id AND o.content_hash = e.content_hash AND o.status = 'active' AND o.id <> e.id;""")
        pm_ids = ','.join(f"{q(r['id'])}::uuid" for r in pm) if pm else "NULL::uuid"
        parts.append(f"""{cte}
SELECT 'ob_rollup_project_mismatch_after' AS check, count(*) AS n FROM e JOIN project_memories p ON p.id = e.rollup
 WHERE p.project_id <> e.dst_pid AND p.id NOT IN ({pm_ids});""")
    parts.append("SELECT 'cross_project_fk_now' AS check, count(*) AS n FROM observations o JOIN project_memories p ON p.id = o.rollup_memory_id WHERE o.project_id <> p.project_id;")
    return '\n'.join(parts) + '\n'


# ---------------------------------------------------------------- 單一交易（execute／rollback 共用）
def transaction_sql(rows: list[dict], reverse: bool, expected_db: str, executed_at_utc: str | None) -> str:
    work = actionable(rows)
    before_collapsed = rows if not reverse else skipped(rows)
    after_collapsed = skipped(rows) if not reverse else rows
    parts = ["\\set ON_ERROR_STOP 1",
             "BEGIN;",
             "SET LOCAL lock_timeout = '30s';",
             "SET LOCAL statement_timeout = '300s';",
             # 讀不擋、寫全擋（含 MCP 的 INSERT／UPDATE／archive）；worker 另有 flock
             "LOCK TABLE project_memories, observations IN SHARE ROW EXCLUSIVE MODE;",
             identity_check_sql(expected_db),
             collapsed_set_check_sql(before_collapsed, 'in-txn precheck')]
    parts.append(target_conflict_check_sql(work, reverse))
    if reverse:
        assert executed_at_utc
        parts.append(rollback_refusal_sql(work, executed_at_utc))
    parts.append(update_blocks_sql(work, reverse))
    parts.append(post_invariants_sql(after_collapsed))
    parts.append("SELECT 'executed_at' AS k, clock_timestamp()::text AS v;")  # timestamptz 文字含時區偏移，回滾比對不受 session timezone 影響
    parts.append("COMMIT;")
    parts.append("SELECT 'committed' AS k, 'yes' AS v;")
    return '\n'.join(parts) + '\n'


def run_psql(url: str, sql_file: Path, read_only: bool) -> tuple[int, str]:
    env = dict(os.environ)
    env['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=120000' if read_only else ''
    proc = subprocess.run(['psql', url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', str(sql_file)],
                          env=env, capture_output=True, text=True)
    return proc.returncode, (proc.stdout + proc.stderr)


def parse_kv(out: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in out.splitlines():
        if '|' in line and not line.startswith(('NOTICE', 'psql:')):
            k, _, v = line.partition('|')
            result[k.strip()] = v.strip()
    return result


def main() -> int:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    path = Path(sys.argv[1])
    mode = sys.argv[2]
    rehearsal = '--rehearsal' in sys.argv[3:]
    if mode not in ('--preflight', '--execute', '--rollback'):
        raise SystemExit('mode must be --preflight | --execute | --rollback')
    rows = load_rows(path)
    reverse = mode == '--rollback'
    work = actionable(rows)
    remap_sha = sha256_file(path)

    if rehearsal:
        url = os.environ.get('STEPB_DATABASE_URL', '')
        if f'localhost:5438/{TEST_DB_NAME}' not in url:
            raise SystemExit(f'rehearsal requires STEPB_DATABASE_URL pointing at localhost:5438/{TEST_DB_NAME}')
        expected_db = TEST_DB_NAME
    else:
        url = (Path.home() / '.ccm-project-url').read_text(encoding='utf-8').strip()
        expected_db = PROD_DB_NAME
    print(f'mode={mode} rehearsal={rehearsal} rows={len(rows)} actionable={len(work)} skipped={len(rows) - len(work)} remap_sha256={remap_sha}')

    applied = path.with_name(f'{path.stem}.applied.json')
    meta = json.loads(applied.read_text(encoding='utf-8')) if applied.exists() else None
    if mode == '--execute' and meta is not None:
        raise SystemExit(f'{applied.name} exists (executed_at={meta.get("executed_at")}); refuse to re-execute. Rollback first or remove the file after manual verification.')
    if mode == '--rollback':
        if meta is None:
            raise SystemExit(f'{applied.name} missing: cannot verify executed_at for the writer-intervention check; manual rollback via the committed table (PR #27) required')
        if meta.get('remap_sha256') != remap_sha:
            raise SystemExit(f'remap sha256 mismatch: applied={meta.get("remap_sha256")} now={remap_sha}; refuse')
        if meta.get('db') != expected_db:
            raise SystemExit(f'applied.json db={meta.get("db")} != {expected_db}; refuse')

    if not work:
        print('nothing to do'); return 0

    # 1) 唯讀 preflight（諮詢性；execute／rollback 也一律先跑，早失敗早知道）
    pf_file = path.with_name(f'{path.stem}.{mode.strip("-")}.preflight.sql')
    pf_file.write_text(preflight_sql(rows, reverse, expected_db), encoding='utf-8')
    code, out = run_psql(url, pf_file, read_only=True)
    checks = parse_kv(out)
    print('preflight:', json.dumps(checks, ensure_ascii=False))
    ok = code == 0 and checks.get('db') == expected_db and checks.get('ro') == 'on' and \
        all(checks.get(k, 'x') == '0' for k in checks if k not in ('db', 'ro'))
    if not ok and not (rehearsal and os.environ.get('STEPB_REHEARSAL_SKIP_PREFLIGHT') == '1' and mode != '--preflight'):
        print('PREFLIGHT FAILED'); print(out[-2000:]); return 3
    if mode == '--preflight':
        print('PREFLIGHT OK'); return 0
    if not ok:
        print('PREFLIGHT FAILED but STEPB_REHEARSAL_SKIP_PREFLIGHT=1 (rehearsal only): continuing to exercise in-transaction guards')

    # 2) 與 worker 互斥：拿 systemd unit 同一把 flock（unit 用 flock -n，拿不到會 exit 75 = 這輪 tick 直接跳過）。
    #    交易內另有 LOCK TABLE 擋所有其他 writer（MCP 等）。
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('worker tick in progress (lock held); try again in ~30 s'); return 4
        print(f'flock acquired {LOCK_PATH}; started {datetime.now(timezone.utc).isoformat(timespec="seconds")}')
        sql_file = path.with_name(f'{path.stem}.{mode.strip("-")}.txn.sql')
        sql_file.write_text(transaction_sql(rows, reverse, expected_db, meta.get('executed_at') if meta else None), encoding='utf-8')
        code, out = run_psql(url, sql_file, read_only=False)
        kv = parse_kv(out)
        notices = [l for l in out.splitlines() if l.startswith('psql:') or 'NOTICE' in l or 'ERROR' in l]
        print('\n'.join(notices[-12:]))
        if code != 0 or kv.get('committed') != 'yes':
            print(f'TRANSACTION ROLLED BACK (exit={code}); DB unchanged.')
            print(out[-2000:])
            return 2
        print(f"COMMITTED at {kv.get('executed_at')} UTC; identity: {kv.get('identity')}")
        if mode == '--execute':
            applied.write_text(json.dumps({
                'remap_sha256': remap_sha, 'db': expected_db, 'identity': kv.get('identity'),
                'executed_at': kv.get('executed_at'), 'rows_updated': len(work),
                'rollback_note': 'automatic rollback only valid while no writer touched moved rollups; otherwise manual reversal via the committed table',
            }, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f'wrote {applied.name}')
        else:
            rolled = path.with_name(f'{path.stem}.rolled-back.json')
            applied.rename(rolled)
            print(f'renamed {applied.name} → {rolled.name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
