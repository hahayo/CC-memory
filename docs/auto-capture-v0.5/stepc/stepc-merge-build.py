#!/usr/bin/env python3
"""Step C：把 Step B 殘餘（needs_human）中「同 session 多個 rollup」的類 (1)(2)[(4)] 產成合併計畫（唯讀：只讀對照表＋唯讀查 DB）。

用法：
  stepc-merge-build.py <remap.jsonl> <out-plan.jsonl> [--include-class4] [--rehearsal]
    --include-class4  把類 (4)（transcript 已刪、但新 id 下已有 rollup）中「只有一個候選目標」的 session 也納入；預設不納入
    --rehearsal       允許 STEPC_DATABASE_URL（必須是 localhost:5438/cc_memory_test）；正式模式只讀 ~/.ccm-project-url

哪些列（which）以對照表 skip 列為準；每列「現況」（before-state）一律唯讀查 DB 取得，寫進計畫，執行時逐列比對。

合併規則（Codex 2026-09-05 R1 修正版 a）：
  N 個舊 rollup → 1 個目標 rollup。
  目標 = 新 id 下既有 active rollup（類 1／4）；沒有（類 2）→ 選存活者：linked observations 最多者，同分取 created_at 最早，再同分取 id 最小；
         存活者改 project_id／idempotency_key。
  其餘舊 rollup：status='archived'、merged_into=<目標 id>；project_id／idempotency_key／metadata 全部保留原值（archived 不佔 partial unique index）。
  該 session 所有崩塌 observations：同一 UPDATE 改 project_id=<新 id>＋rollup_memory_id=<目標 id>。
  目標 metadata.capture：transcript_sources = 依 worker 的 normalizeTranscriptSources 規則（同 path_hash、依 start 排序、相鄰／重疊合併）併入被合併 rollup 的區段；
                         observation_ids = 目標原有 + 被合併者（去重、保序）；spool_offsets／summarize_count／discovery_tokens／summary／embedding 一律不動。
計畫每個 session 一列，含：target（含 before-state：metadata.capture 全文、updated_at、既有 linked obs id 清單）、merge_rollups、survivor、observations、patch。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

PROD_DB_NAME = 'cc_memory_project'
TEST_DB_NAME = 'cc_memory_test'


def q(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def psql_json(url: str, sql: str) -> list[dict]:
    """唯讀執行一段 SELECT，要求 SQL 以 `SELECT json_agg(...)` 形式回單一 JSON 陣列。"""
    env = dict(os.environ)
    env['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=120000'
    proc = subprocess.run(['psql', url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                          env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f'psql failed: {proc.stderr[-2000:]}')
    out = proc.stdout.strip()
    return json.loads(out) if out else []


def classify(reason: str) -> int:
    if '需人工合併' in reason or '已有 active rollup' in reason:
        return 1
    if '自撞' in reason:
        return 2
    if 'encoded-dir' in reason:
        return 3
    if '對不到' in reason:
        return 4
    return 0


def normalize_sources(sources: list[dict]) -> list[dict]:
    """與 capture-worker.ts normalizeTranscriptSources 同構：過濾 end<=start、依 (path_hash, start, end) 排序、同 path 相鄰／重疊合併。"""
    items = [dict(s) for s in sources if isinstance(s, dict) and s.get('end', 0) > s.get('start', 0)]
    items.sort(key=lambda s: (s['path_hash'], s['start'], s['end']))
    merged: list[dict] = []
    for s in items:
        prev = merged[-1] if merged else None
        if prev and prev['path_hash'] == s['path_hash'] and s['start'] <= prev['end']:
            prev['end'] = max(prev['end'], s['end'])
        else:
            merged.append({'path_hash': s['path_hash'], 'start': s['start'], 'end': s['end']})
    return merged


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if len(args) != 2:
        raise SystemExit(__doc__)
    remap_path, out_path = Path(args[0]), Path(args[1])
    include4 = '--include-class4' in flags
    rehearsal = '--rehearsal' in flags
    if rehearsal:
        url = os.environ.get('STEPC_DATABASE_URL', '')
        if f'localhost:5438/{TEST_DB_NAME}' not in url:
            raise SystemExit(f'rehearsal requires STEPC_DATABASE_URL pointing at localhost:5438/{TEST_DB_NAME}')
        expected_db = TEST_DB_NAME
    else:
        url = (Path.home() / '.ccm-project-url').read_text(encoding='utf-8').strip()
        expected_db = PROD_DB_NAME

    rows = [json.loads(l) for l in remap_path.read_text(encoding='utf-8').splitlines() if l.strip()]
    skip = [r for r in rows if r.get('action') != 'update']
    by_session: dict[str, dict] = defaultdict(lambda: {'pm': [], 'obs': [], 'classes': set()})
    for r in skip:
        c = classify(r.get('reason', ''))
        s = by_session[r['session_id']]
        s['classes'].add(c)
        (s['pm'] if r['table'] == 'project_memories' else s['obs']).append(r)

    # 現況（唯讀）：所有崩塌列 + 這些 session 在非崩塌 id 下的 active rollup
    sids = sorted(by_session)
    sid_vals = ','.join(q(s) for s in sids)
    ident = psql_json(url, "SELECT json_agg(x) FROM (SELECT current_database() AS db, system_identifier::text AS system_id FROM pg_control_system()) x")[0]
    if ident['db'] != expected_db:
        raise SystemExit(f"wrong database {ident['db']} (expected {expected_db})")
    pm_rows = psql_json(url, f"""
      SELECT json_agg(x) FROM (
        SELECT id, project_id, idempotency_key, status, merged_into, created_at::text AS created_at, updated_at::text AS updated_at,
               split_part(idempotency_key, ':', 4) AS session_id,
               metadata->'capture' AS capture,
               (SELECT coalesce(json_agg(o.id ORDER BY o.observed_at, o.id), '[]'::json) FROM observations o WHERE o.rollup_memory_id = p.id) AS linked_obs
        FROM project_memories p
        WHERE idempotency_key LIKE 'capture:v05:%' AND split_part(idempotency_key, ':', 4) IN ({sid_vals})
        ORDER BY project_id, id) x""")
    obs_rows = psql_json(url, f"""
      SELECT json_agg(x) FROM (
        SELECT id, project_id, session_id, rollup_memory_id, status, content_hash
        FROM observations WHERE session_id IN ({sid_vals}) AND project_id LIKE '\\_%'
        ORDER BY project_id, id) x""")
    pm_by_id = {p['id']: p for p in pm_rows}
    obs_by_id = {o['id']: o for o in obs_rows}

    plan: list[dict] = []
    report = defaultdict(int)
    for sid in sids:
        s = by_session[sid]
        classes = s['classes']
        cls = min(classes) if classes else 0
        old_pm_ids = [r['id'] for r in s['pm']]
        old_obs_ids = [r['id'] for r in s['obs']]
        missing = [i for i in old_pm_ids if i not in pm_by_id] + [i for i in old_obs_ids if i not in obs_by_id]
        if missing:
            plan.append({'session_id': sid, 'class': cls, 'action': 'skip', 'reason': f'map rows missing in DB: {missing[:3]}'})
            report['skip_missing'] += 1
            continue
        old_pm = [pm_by_id[i] for i in old_pm_ids]
        if any(p['status'] != 'active' or not p['project_id'].startswith('_') for p in old_pm):
            plan.append({'session_id': sid, 'class': cls, 'action': 'skip', 'reason': 'old rollup no longer active/collapsed (already handled?)'})
            report['skip_state'] += 1
            continue
        all_targets = [p for p in pm_rows if p['session_id'] == sid and not p['project_id'].startswith('_') and p['status'] == 'active']
        # Codex R2 #1：先從對照表（有來源證據）固定「目的專案」，再只在該專案下找完整目標鍵；其他專案的 rollup 不得劫走歸屬
        intended = set()
        for r in s['pm']:
            rs = r.get('reason', '')
            m = re.search(r'新 id (\S+) 已有 active rollup', rs) or re.search(r'合併到 (\S+) 會撞', rs)
            if m:
                intended.add(m.group(1))
            if r.get('new_project_id'):
                intended.add(r['new_project_id'])
        if cls == 3:
            plan.append({'session_id': sid, 'class': 3, 'action': 'skip', 'reason': 'encoded-dir only; needs human approval of candidate id'})
            report['skip_class3'] += 1
            continue
        if cls == 4 and not include4:
            plan.append({'session_id': sid, 'class': 4, 'action': 'skip', 'reason': 'class 4 excluded (no --include-class4)',
                         'existing_targets': [{'id': t['id'], 'project_id': t['project_id']} for t in all_targets]})
            report['skip_class4'] += 1
            continue
        if cls == 4:
            # 類 4 對照表沒有目的專案；唯一證據是既有 rollup，且必須恰好一個專案（--include-class4 = 使用者核准這條規則）
            pids = {t['project_id'] for t in all_targets}
            if len(pids) != 1:
                plan.append({'session_id': sid, 'class': 4, 'action': 'skip', 'reason': 'multiple candidate targets; needs human pick',
                             'existing_targets': [{'id': t['id'], 'project_id': t['project_id']} for t in all_targets]})
                report['skip_multi_target'] += 1
                continue
            intended = pids
        if len(intended) != 1:
            plan.append({'session_id': sid, 'class': cls, 'action': 'skip', 'reason': f'cannot fix intended project from map: {sorted(intended)}'})
            report['skip_no_target_pid'] += 1
            continue
        new_pid = next(iter(intended))
        full_key = f'capture:v05:{new_pid}:{sid}'
        targets = [t for t in all_targets if t['project_id'] == new_pid and t['idempotency_key'] == full_key]
        others = [t for t in all_targets if t['project_id'] != new_pid]
        if others:
            plan.append({'session_id': sid, 'class': cls, 'action': 'skip', 'reason': f'session also has active rollups under other projects {sorted({t["project_id"] for t in others})}; needs human',
                         'existing_targets': [{'id': t['id'], 'project_id': t['project_id']} for t in all_targets]})
            report['skip_multi_target'] += 1
            continue
        if len(targets) > 1:
            plan.append({'session_id': sid, 'class': cls, 'action': 'skip', 'reason': 'duplicate active target keys (should be impossible)'})
            report['skip_multi_target'] += 1
            continue
        # 類 1：對照表寫的 existing_new_rollup_id 必須與 DB 現況一致
        if cls == 1:
            want = {r.get('existing_new_rollup_id') for r in s['pm'] if r.get('existing_new_rollup_id')}
            if not targets or (want and want != {targets[0]['id']}):
                plan.append({'session_id': sid, 'class': 1, 'action': 'skip', 'reason': f'map existing_new_rollup_id {sorted(want)} != DB target {[t["id"] for t in targets]}'})
                report['skip_target_drift'] += 1
                continue
        if targets:
            target = targets[0]
            mode = 'existing'
            survivor = None
            merge = old_pm
        else:
            ranked = sorted(old_pm, key=lambda p: (-len(p['linked_obs']), p['created_at'], p['id']))
            target = ranked[0]
            mode = 'survivor'
            survivor = {'id': target['id'], 'old_project_id': target['project_id'], 'old_idempotency_key': target['idempotency_key'],
                        'new_project_id': new_pid, 'new_idempotency_key': f'capture:v05:{new_pid}:{sid}',
                        'rule': 'most linked observations, then earliest created_at, then smallest id',
                        'ranking': [{'id': p['id'], 'linked_obs': len(p['linked_obs']), 'created_at': p['created_at']} for p in ranked]}
            merge = ranked[1:]
        cap_before = target.get('capture') or {}
        merged_sources = normalize_sources(list(cap_before.get('transcript_sources') or []) +
                                           [src for p in merge for src in ((p.get('capture') or {}).get('transcript_sources') or [])])
        seen: set[str] = set()
        obs_ids_after: list[str] = []
        for oid in list(cap_before.get('observation_ids') or []) + [oid for p in sorted(merge, key=lambda p: p['created_at']) for oid in ((p.get('capture') or {}).get('observation_ids') or [])]:
            if oid not in seen:
                seen.add(oid); obs_ids_after.append(oid)
        obs = [obs_by_id[i] for i in old_obs_ids]
        # 崩塌 obs 必須指向本 session 的舊 rollup（或 NULL）
        bad = [o['id'] for o in obs if o['rollup_memory_id'] and o['rollup_memory_id'] not in old_pm_ids]
        if bad or any(o['status'] != 'active' for o in obs):
            plan.append({'session_id': sid, 'class': cls, 'action': 'skip', 'reason': f'observation state unexpected (rollup outside session or not active): {bad[:3]}'})
            report['skip_obs_state'] += 1
            continue
        plan.append({
            'session_id': sid, 'class': cls, 'action': 'merge', 'new_project_id': new_pid,
            'target': {'id': target['id'], 'mode': mode, 'project_id': target['project_id'], 'idempotency_key': target['idempotency_key'],
                       'updated_at': target['updated_at'], 'capture_before': cap_before, 'linked_obs_before': target['linked_obs']},
            'survivor': survivor,
            'merge_rollups': [{'id': p['id'], 'old_project_id': p['project_id'], 'old_idempotency_key': p['idempotency_key'],
                               'old_status': p['status'], 'old_merged_into': p['merged_into'], 'linked_obs': len(p['linked_obs']),
                               'capture_before': p.get('capture') or {},  # Codex R2 #3：來源 capture 也在交易內比對
                               'transcript_sources': (p.get('capture') or {}).get('transcript_sources') or []} for p in merge],
            'observations': [{'id': o['id'], 'old_project_id': o['project_id'], 'session_id': o['session_id'], 'content_hash': o['content_hash'],
                              'old_rollup_memory_id': o['rollup_memory_id'], 'old_status': o['status']} for o in obs],
            'patch': {'transcript_sources_after': merged_sources, 'observation_ids_after': obs_ids_after},
        })
        report[f'merge_class{cls}'] += 1
    out_path.write_text('\n'.join(json.dumps(p, ensure_ascii=False) for p in plan) + '\n', encoding='utf-8')
    n_merge = sum(1 for p in plan if p['action'] == 'merge')
    n_pm = sum(len(p['merge_rollups']) + (1 if p['survivor'] else 0) for p in plan if p['action'] == 'merge')
    n_obs = sum(len(p['observations']) for p in plan if p['action'] == 'merge')
    n_target_patch = sum(1 for p in plan if p['action'] == 'merge')
    print(json.dumps({'db': ident['db'], 'system_id': ident['system_id'], 'sessions': len(plan), 'merge_sessions': n_merge,
                      'rollups_touched': n_pm, 'observations_repointed': n_obs, 'targets_patched': n_target_patch, **report}, ensure_ascii=False))
    print(f'wrote {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
