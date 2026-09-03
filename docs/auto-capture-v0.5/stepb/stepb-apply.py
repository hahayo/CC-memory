#!/usr/bin/env python3
"""Step B v2：依對照表重歸屬既有列（或依套用日誌回滾）。Codex R2 後重寫。

用法：
  stepb-apply.py <remap.jsonl> --preflight                  唯讀：DB 身分、每列現況＝預期舊狀態、observations 唯一鍵衝突、跨 project FK
  stepb-apply.py <remap.jsonl> --execute                    先跑 preflight，全過才在 worker 同一把 flock 內逐批單一交易套用；每批 COMMIT 後寫 journal
  stepb-apply.py <remap.jsonl> --rollback                   只回滾 journal 記錄「已 COMMIT」的批次（反序），同樣的守衛
  加 --rehearsal：允許 STEPB_DATABASE_URL（必須是 localhost:5438/cc_memory_test）；正式模式忽略該環境變數，只讀 ~/.ccm-project-url
  環境變數 STEPB_BATCH（預設 500）只在 --rehearsal 允許改，用於多批故障注入。

規則（交接檔 Step B ＋ Codex R2）：
  observations action=update：只改 project_id；WHERE id ＋ project_id=old ＋ session_id ＋ status ＋ content_hash ＋ rollup_memory_id IS NOT DISTINCT FROM 舊值
  project_memories action=update：project_id、idempotency_key；WHERE id ＋ project_id=old ＋ idempotency_key=oldkey ＋ status=old_status
  archive／repoint、encoded-dir-only：本版一律 needs_human（不執行）。不 DELETE。
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PROD_DB_NAME = 'cc_memory_project'
LOCK_PATH = Path.home() / '.cache/cc-memory/auto-capture-run.lock'


def q(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def load_rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()]


def actionable(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r.get('action') == 'update']


# ---------------------------------------------------------------- SQL 產生
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


def batch_sql(batch: list[dict], reverse: bool) -> str:
    """單一交易；每條 UPDATE 後立刻檢查 ROW_COUNT=1，不符即 RAISE（整批 ROLLBACK）並指出 id。"""
    lines = ["\\set ON_ERROR_STOP 1", "BEGIN;", "DO $body$", "DECLARE n integer; total integer := 0;", "BEGIN"]
    for r in batch:
        lines.append(f"  {stmt(r, reverse)};")
        lines.append(f"  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'row % affected % rows (expected 1)', {q(r['id'])}, n; END IF; total := total + n;")
    lines.append(f"  IF total <> {len(batch)} THEN RAISE EXCEPTION 'total % <> expected {len(batch)}', total; END IF;")
    lines.append("  RAISE NOTICE 'batch ok: % rows', total;")
    lines.append("END $body$;")
    lines.append("COMMIT;")
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------- preflight（唯讀）
def preflight_sql(rows: list[dict], reverse: bool) -> str:
    """唯讀 SQL（read-only 交易不能 CREATE TEMP TABLE，改用 VALUES CTE）：
    每列現況是否＝預期來源狀態；目標狀態是否會撞唯一鍵；跨 project FK。"""
    parts = ["\\set ON_ERROR_STOP 1",
             "SELECT 'db' AS check, current_database() AS n;",
             "SELECT 'ro' AS check, current_setting('default_transaction_read_only') AS n;"]
    pm = [r for r in rows if r['table'] == 'project_memories']
    ob = [r for r in rows if r['table'] == 'observations']
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


def run_psql(url: str, sql_file: Path, read_only: bool) -> tuple[int, str]:
    env = dict(os.environ)
    env['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=120000' if read_only else '-c statement_timeout=120000'
    proc = subprocess.run(['psql', url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', str(sql_file)],
                          env=env, capture_output=True, text=True)
    return proc.returncode, (proc.stdout + proc.stderr)


def parse_checks(out: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in out.splitlines():
        if '|' in line:
            k, _, v = line.partition('|')
            result[k.strip()] = v.strip()
    return result


def main() -> int:
    path = Path(sys.argv[1])
    mode = sys.argv[2]
    rehearsal = '--rehearsal' in sys.argv[3:]
    rows = load_rows(path)
    reverse = mode == '--rollback'
    work = actionable(rows)
    skipped = len(rows) - len(work)
    batch_size = int(os.environ.get('STEPB_BATCH', '500')) if rehearsal else 500

    if rehearsal:
        url = os.environ.get('STEPB_DATABASE_URL', '')
        if 'localhost:5438/cc_memory_test' not in url:
            raise SystemExit('rehearsal requires STEPB_DATABASE_URL pointing at localhost:5438/cc_memory_test')
        expected_db = 'cc_memory_test'
    else:
        url = (Path.home() / '.ccm-project-url').read_text(encoding='utf-8').strip()
        expected_db = PROD_DB_NAME
    print(f'mode={mode} rehearsal={rehearsal} rows={len(rows)} actionable={len(work)} skipped={skipped} batch={batch_size}')

    journal = path.with_name(f'{path.stem}.journal.json')
    state = json.loads(journal.read_text(encoding='utf-8')) if journal.exists() else {'committed_batches': []}

    # 批次固定順序：正向 pm 先、obs 後；回滾只處理 journal 記錄已 COMMIT 的批次（反序）
    ordered = [r for r in work if r['table'] == 'project_memories'] + [r for r in work if r['table'] == 'observations']
    batches = [ordered[i:i + batch_size] for i in range(0, len(ordered), batch_size)]

    if mode == '--rollback':
        todo = [i for i in state['committed_batches']]
        todo.reverse()
        print(f'rollback of committed batches (reverse order): {[i + 1 for i in todo]}')
        target_batches = [(i, batches[i]) for i in todo]
    elif mode in ('--preflight', '--execute'):
        if state['committed_batches'] and mode == '--execute':
            raise SystemExit(f'journal shows batches already committed {state["committed_batches"]}; refuse to re-execute')
        target_batches = list(enumerate(batches))
    else:
        raise SystemExit('mode must be --preflight | --execute | --rollback')

    # preflight（唯讀）——execute／rollback 也一律先跑
    pf_rows = [r for _, b in target_batches for r in b]
    if not pf_rows:
        print('nothing to do'); return 0
    pf_file = path.with_name(f'{path.stem}.preflight.sql')
    pf_file.write_text(preflight_sql(pf_rows, reverse), encoding='utf-8')
    code, out = run_psql(url, pf_file, read_only=True)
    checks = parse_checks(out)
    print('preflight:', json.dumps(checks, ensure_ascii=False))
    # 回滾時 DB 本來就處於「部分套用」狀態（rollup 已改、observations 未改），跨 project FK 非零是預期，只列印不擋
    informational = {'cross_project_fk_now'} if reverse else set()
    ok = code == 0 and checks.get('db', '').startswith(expected_db) and checks.get('ro') == 'on' and \
        all(checks.get(k, 'x') == '0' for k in checks if k not in ('db', 'ro') and k not in informational)
    if not ok:
        print('PREFLIGHT FAILED'); print(out[-1500:]); return 3
    if mode == '--preflight':
        print('PREFLIGHT OK'); return 0

    # 與 worker 互斥：拿 systemd unit 同一把 flock（unit 用 flock -n，拿不到會 exit 75 = 這輪 tick 直接跳過）
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('worker tick in progress (lock held); try again in ~30 s'); return 4
        print(f'lock acquired {LOCK_PATH}; started {datetime.now().isoformat(timespec="seconds")}')
        for i, b in target_batches:
            sql_file = path.with_name(f'{path.stem}.{mode.strip("-")}.batch{i + 1}.sql')
            sql_file.write_text(batch_sql(b, reverse), encoding='utf-8')
            code, out = run_psql(url, sql_file, read_only=False)
            tail = out.strip()[-300:]
            print(f'batch {i + 1}/{len(batches)} ({len(b)} rows): exit={code} {tail}')
            if code != 0:
                print('STOP: batch failed (transaction rolled back). journal unchanged for this batch.')
                journal.write_text(json.dumps(state), encoding='utf-8')
                return 2
            if mode == '--execute':
                state['committed_batches'].append(i)
            else:
                state['committed_batches'].remove(i)
            journal.write_text(json.dumps(state), encoding='utf-8')
        print(f'done; journal={journal.name} committed_batches={state["committed_batches"]}')
    post = path.with_name(f'{path.stem}.postcheck.sql')
    post.write_text("SELECT 'cross_project_fk_now' AS check, count(*) AS n FROM observations o JOIN project_memories p ON p.id = o.rollup_memory_id WHERE o.project_id <> p.project_id;\n"
                    "SELECT 'obs_collapsed_remaining' AS check, count(*) AS n FROM observations WHERE project_id LIKE '\\_%';\n"
                    "SELECT 'pm_collapsed_remaining' AS check, count(*) AS n FROM project_memories WHERE project_id LIKE '\\_%';\n", encoding='utf-8')
    code, out = run_psql(url, post, read_only=True)
    print('postcheck:', json.dumps(parse_checks(out), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
