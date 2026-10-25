"""recall-exam 共用工具：隔離的 claude -p 執行、兩套記憶系統的資料池、盲評遮罩。

設計原則（2026-10-23，Codex 對審後定案）：
- 作答者只拿得到「一套」記憶系統的 MCP 工具，沒有 Bash／Read；出題者只讀原始對話檔，沒有任何記憶工具。
  出題者的 Bash 理論上仍能讀任何檔，這層只靠 prompt 約束，不是硬隔離。
- 每次 claude -p 都帶 --setting-sources local、--no-session-persistence、CC_MEMORY_CAPTURE_CHILD=1，
  避免考試本身被 claude-mem／cc-memory 的 hooks 錄進去（已實測：sdk_sessions 與 spool 都不增加）。
- 評分前把會洩漏系統身分的工具名遮掉，兩位評分者拿到的答案順序相反。
- 任何 DB 錯誤只印回傳碼，不印連線字串（9/20 曾把 DSN 印進對話紀錄）。
"""
from __future__ import annotations

import json
import os
import random
import re
import sqlite3
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HOME = Path.home()
STATE_DIR = HOME / '.cache' / 'cc-memory' / 'recall-exam'
LEDGER = STATE_DIR / 'ledger.jsonl'
PROJECT_URL_FILE = HOME / '.ccm-project-url'
CLAUDE_MEM_DB = HOME / '.claude-mem' / 'claude-mem.db'
CLAUDE_MEM_WORKER = 'http://127.0.0.1:37777'
CC_MEMORY_WRAPPER = HOME / 'run-cc-memory-project.sh'
PLUGIN_CACHE = HOME / '.claude' / 'plugins' / 'cache' / 'thedotmack' / 'claude-mem'

SYSTEMS = ('cc-memory', 'claude-mem')
VERDICTS = ('correct', 'partial', 'wrong', 'confident_wrong', 'no_answer')
VERDICT_SCORE = {'correct': 3, 'partial': 2, 'no_answer': 1, 'wrong': 0, 'confident_wrong': -1}

# 遮罩：答案裡會透露是哪套系統的字串
LEAK_PATTERNS = [
    r'mcp__[a-z_\-]+__', r'cc[_\-]memory[_a-z]*', r'claude[\-_]mem[a-z\-_]*', r'mcp-search',
    r'chroma[\-_a-z]*', r'smart_(search|outline|unfold)', r'get_observations', r'cc_task_[a-z]*',
    r'cc_reminders_due', r'rollup', r'spool', r'observation[s]?\b',
]


@dataclass
class ClaudeRun:
    result: str
    cost_usd: float
    turns: int
    session_id: str
    is_error: bool
    raw: dict[str, Any]


def claude_mem_plugin_root() -> Path:
    versions = sorted(PLUGIN_CACHE.glob('*/scripts/mcp-server.cjs'))
    if not versions:
        raise SystemExit('找不到 claude-mem plugin（~/.claude/plugins/cache/thedotmack/claude-mem/*/）')
    return versions[-1].parent.parent


def write_mcp_configs(out_dir: Path) -> dict[str, Path]:
    """產生兩套各只含一個 server 的 MCP 設定檔。cc-memory 走 CC_READ_ONLY=1（寫入工具不露出）。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    root = claude_mem_plugin_root()
    configs = {
        'claude-mem': {'mcpServers': {'mcp-search': {
            'type': 'stdio', 'command': str(root / 'scripts' / 'mcp-server.cjs'),
            'env': {'CLAUDE_PLUGIN_ROOT': str(root)}}}},
        'cc-memory': {'mcpServers': {'cc-memory': {
            'type': 'stdio', 'command': str(CC_MEMORY_WRAPPER), 'env': {'CC_READ_ONLY': '1'}}}},
    }
    paths: dict[str, Path] = {}
    for name, cfg in configs.items():
        p = out_dir / f'mcp-{name}.json'
        p.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding='utf-8')
        paths[name] = p
    return paths


def run_claude(prompt: str, *, model: str, cwd: Path, mcp_config: Path | None, tools: str,
               allowed: str, budget_usd: float, timeout_s: int = 600,
               extra_env: dict[str, str] | None = None) -> ClaudeRun:
    cmd = ['claude', '-p', '--model', model, '--setting-sources', 'local', '--strict-mcp-config',
           '--tools', tools, '--allowedTools', allowed, '--permission-mode', 'bypassPermissions',
           '--no-session-persistence', '--max-budget-usd', f'{budget_usd:.2f}', '--output-format', 'json']
    if mcp_config is not None:
        cmd += ['--mcp-config', str(mcp_config)]
    env = {**os.environ, 'CC_MEMORY_CAPTURE_CHILD': '1', **(extra_env or {})}
    try:
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=str(cwd),
                              env=env, timeout=timeout_s, check=False)
    except subprocess.TimeoutExpired:
        return ClaudeRun(result='', cost_usd=0.0, turns=0, session_id='', is_error=True,
                         raw={'error': f'timeout after {timeout_s}s'})
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return ClaudeRun(result=proc.stdout[-2000:], cost_usd=0.0, turns=0, session_id='', is_error=True,
                         raw={'error': 'non-json output', 'rc': proc.returncode, 'stderr': proc.stderr[-1000:]})
    return ClaudeRun(result=str(data.get('result', '')), cost_usd=float(data.get('total_cost_usd') or 0.0),
                     turns=int(data.get('num_turns') or 0), session_id=str(data.get('session_id', '')),
                     is_error=bool(data.get('is_error')), raw=data)


def extract_json_block(text: str) -> dict[str, Any] | None:
    """從回覆抓第一個 ```json 區塊（或整段是 JSON）。"""
    m = re.search(r'```json\s*(\{.*?\})\s*```', text, re.S)
    candidates = [m.group(1)] if m else []
    candidates.append(text.strip())
    for c in candidates:
        try:
            obj = json.loads(c)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def redact(text: str) -> str:
    out = text
    for pat in LEAK_PATTERNS:
        out = re.sub(pat, '[工具]', out, flags=re.I)
    return out


# ---------- 資料池 ----------

def psql_rows(sql: str) -> list[list[str]]:
    """唯讀查 cc-memory 正式 DB。失敗只回報 rc，絕不印 DSN。"""
    dsn = PROJECT_URL_FILE.read_text(encoding='utf-8').strip()
    proc = subprocess.run(['psql', dsn, '-At', '-F', '\t', '-c', sql], capture_output=True, text=True,
                          check=False, timeout=120)
    if proc.returncode != 0:
        raise SystemExit(f'psql failed rc={proc.returncode}: {proc.stderr.strip()[:200]}')
    return [line.split('\t') for line in proc.stdout.splitlines() if line]


def cc_memory_sessions(days: int, min_obs: int) -> dict[str, dict[str, Any]]:
    """近 N 天、觀察 ≥ min_obs、且 rollup 已收尾（finalized_at 非空）的 session。"""
    rows = psql_rows(
        "SELECT o.session_id, o.project_id, COUNT(*) AS n, "
        "BOOL_OR(pm.metadata->'capture'->>'finalized_at' IS NOT NULL) AS finalized, "
        "MAX(o.created_at)::text "
        "FROM observations o LEFT JOIN project_memories pm "
        "ON pm.metadata->'capture'->>'session_id' = o.session_id AND pm.project_id = o.project_id "
        "AND pm.type='session' AND pm.status='active' "
        f"WHERE o.created_at > now() - interval '{int(days)} days' AND o.session_id IS NOT NULL "
        f"GROUP BY 1,2 HAVING COUNT(*) >= {int(min_obs)}")
    out: dict[str, dict[str, Any]] = {}
    for sid, pid, n, fin, last in rows:
        out[sid] = {'project': pid, 'obs': int(n), 'finalized': fin == 't', 'last': last}
    return out


def claude_mem_sessions(days: int, min_obs: int) -> dict[str, dict[str, Any]]:
    con = sqlite3.connect(f'file:{CLAUDE_MEM_DB}?mode=ro', uri=True)
    since_ms = int((time.time() - days * 86400) * 1000)
    out: dict[str, dict[str, Any]] = {}
    q = ('SELECT s.content_session_id, s.project, COUNT(o.id) FROM sdk_sessions s '
         'LEFT JOIN observations o ON o.memory_session_id = s.memory_session_id '
         'WHERE s.started_at_epoch > ? GROUP BY s.content_session_id HAVING COUNT(o.id) >= ?')
    for sid, proj, n in con.execute(q, (since_ms, min_obs)):
        out[sid] = {'project': proj, 'obs': int(n)}
    con.close()
    return out


def transcript_path(session_id: str) -> Path | None:
    hits = list((HOME / '.claude' / 'projects').glob(f'*/{session_id}.jsonl'))
    hits = [h for h in hits if 'claude-mem-observer' not in h.parent.name]
    return hits[0] if hits else None


def used_session_ids() -> set[str]:
    if not LEDGER.exists():
        return set()
    ids: set[str] = set()
    for line in LEDGER.read_text(encoding='utf-8').splitlines():
        try:
            ids.add(json.loads(line)['session_id'])
        except (json.JSONDecodeError, KeyError):
            continue
    return ids


def sample_pool(days: int, n: int, *, cc_min_obs: int = 15, cm_min_obs: int = 5,
                require_finalized: bool = True, seed: int | None = None) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """兩邊都抓到、cc 已收尾、沒考過的 session，按專案分層隨機抽 n 個。回傳 (樣本, 計數)。"""
    cc = cc_memory_sessions(days, cc_min_obs)
    cm = claude_mem_sessions(days, cm_min_obs)
    both = [s for s in cc if s in cm]
    finalized = [s for s in both if cc[s]['finalized']]
    used = used_session_ids()
    eligible = [s for s in (finalized if require_finalized else both)
                if s not in used and transcript_path(s) is not None]
    counts = {'cc': len(cc), 'claude_mem': len(cm), 'both': len(both), 'both_finalized': len(finalized),
              'eligible_unused_with_transcript': len(eligible)}
    rng = random.Random(seed)
    by_project: dict[str, list[str]] = {}
    for s in eligible:
        by_project.setdefault(cc[s]['project'], []).append(s)
    for lst in by_project.values():
        rng.shuffle(lst)
    picked: list[dict[str, Any]] = []
    projects = sorted(by_project, key=lambda p: -len(by_project[p]))
    while len(picked) < n and any(by_project.values()):
        for p in projects:
            if by_project[p] and len(picked) < n:
                sid = by_project[p].pop()
                # 兩套系統的專案命名規則不同（cc-memory 讀 CLAUDE.md 標記、claude-mem 用目錄名），各帶自己的
                picked.append({'session_id': sid, 'project': p, 'cm_project': cm[sid]['project'], 'cc_obs': cc[sid]['obs'],
                               'cm_obs': cm[sid]['obs'], 'transcript': str(transcript_path(sid))})
    return picked, counts


def claude_mem_healthy() -> tuple[bool, str]:
    """考前健康檢查：claude-mem worker 的 search 要真的回結果（10/23 曾因 chroma 相依飄掉壞兩天）。"""
    import urllib.request
    try:
        with urllib.request.urlopen(f'{CLAUDE_MEM_WORKER}/api/search?query=test&limit=1', timeout=30) as r:
            body = r.read().decode('utf-8', 'replace')
    except Exception as exc:  # noqa: BLE001 - 健康檢查只要知道壞了
        return False, f'worker unreachable: {exc}'[:200]
    if '"error"' in body[:200]:
        return False, body[:200]
    return True, 'ok'
