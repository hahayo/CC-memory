"""recall-exam 共用工具：隔離的 claude -p 執行、兩套記憶系統的資料池、盲評遮罩。

設計原則（2026-10-23，Codex 對審後定案；2026-10-25 資安修補）：
- 原始對話檔是不可信資料（夾帶網頁、工具輸出，可能藏提示注入）。出題者沒有任何工具：
  由 render_transcript() 先把 JSONL 轉成精簡純文字放進提示，模型讀不到其他檔、也不能執行指令。
- 作答者只拿得到「一套」記憶系統的唯讀 MCP 工具（明確清單＋dontAsk 模式：清單外一律拒），沒有 Bash／Read。
  claude-mem 的 smart_search／smart_outline／smart_unfold 能讀本機任意檔，明確封鎖。
- 子程序的環境變數走白名單（child_env），不再整包繼承 os.environ，避免把 DB 連線字串、API key 帶進去。
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
import sys
import time
import unicodedata
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

# 子程序環境變數白名單：claude CLI 登入與執行需要的。其餘（DATABASE_URL、各種 API key／token）一律不傳。
CHILD_ENV_NAMES = frozenset({
    'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'SHELL', 'TERM', 'TMPDIR', 'TZ',
    # 有代理或自簽憑證的網路才需要；不存在就不會傳
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    # claude 設定目錄若有改位置才需要；其他 CLAUDE_* 一律不傳——CLAUDE_CODE_PLUGIN_DIRS 會讓子程序載入外掛 hooks，
    # CLAUDE_CODE_MESSAGING_* 是父 session 的訊息通道（PR #57 審查）
    'CLAUDE_CONFIG_DIR',
})
# ANTHROPIC_* 要留：登入用，且 ANTHROPIC_DEFAULT_SONNET_MODEL 決定 --model sonnet 實際是哪個模型
CHILD_ENV_PREFIXES = ('LC_', 'XDG_', 'ANTHROPIC_')

# 作答者可用的 MCP 工具（明確清單）。server 名稱對應 write_mcp_configs 的 key。
# cc-memory：tool-policy.ts WRITE_TOOLS 以外、project mode 會露出的唯讀工具（todoist 只在 forced personal 才有）。
CC_MEMORY_READ_TOOLS = ('cc_memory_search', 'cc_memory_list', 'cc_memory_get', 'cc_memory_stats',
                        'cc_memory_timeline', 'cc_memory_get_observations', 'cc_task_list', 'cc_task_stats')
# claude-mem 10.5.2 mcp-server.cjs 露出 7 個工具：search／timeline 打 worker GET、get_observations 打
# worker POST /api/observations/batch（皆唯讀）；__IMPORTANT 只回說明文字；smart_* 會 readFile 本機任意路徑。
# __IMPORTANT 是靜態說明文字，描述寫「ALWAYS FOLLOW」，不給的話作答者會白白浪費一次被拒的呼叫
CLAUDE_MEM_READ_TOOLS = ('__IMPORTANT', 'search', 'timeline', 'get_observations')
CLAUDE_MEM_FILE_TOOLS = ('smart_search', 'smart_outline', 'smart_unfold')
ANSWER_ALLOWED = {
    'cc-memory': tuple(f'mcp__cc-memory__{t}' for t in CC_MEMORY_READ_TOOLS),
    'claude-mem': tuple(f'mcp__mcp-search__{t}' for t in CLAUDE_MEM_READ_TOOLS),
}
ANSWER_DISALLOWED = {
    'cc-memory': (),
    'claude-mem': tuple(f'mcp__mcp-search__{t}' for t in CLAUDE_MEM_FILE_TOOLS),
}

# 出題用對話稿的長度上限。sonnet 上下文 200k token；中文約 1 字 1 token 以上，所以同時限字元數與估算 token。
TRANSCRIPT_MAX_CHARS = 350_000
TRANSCRIPT_MAX_EST_TOKENS = 120_000
TRANSCRIPT_TOOL_RESULT_CHARS = 600
TRANSCRIPT_TOOL_INPUT_CHARS = 300
TRANSCRIPT_TEXT_CHARS = 8_000  # 單段 user／assistant 文字上限（防一段貼上的長 log 吃掉整份預算）


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
    """產生兩套各只含一個 server 的 MCP 設定檔。

    cc-memory 走 CC_READ_ONLY=1＋CC_TOOL_ALLOWLIST（server 端兩層：清單外的工具不露出、呼叫也拒）。
    claude-mem 沒有 server 端開關，只能靠 run_claude 的 --allowedTools／--disallowedTools＋dontAsk。
    wrapper 只靠 PATH 找 cat／tr、其餘路徑寫死並從檔案讀連線字串；claude-mem server 靠 HOME 找 ~/.claude-mem 設定。
    這裡的 env 會疊在 child_env() 白名單之上傳給 server。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    root = claude_mem_plugin_root()
    configs = {
        'claude-mem': {'mcpServers': {'mcp-search': {
            'type': 'stdio', 'command': str(root / 'scripts' / 'mcp-server.cjs'),
            'env': {'CLAUDE_PLUGIN_ROOT': str(root)}}}},
        'cc-memory': {'mcpServers': {'cc-memory': {
            'type': 'stdio', 'command': str(CC_MEMORY_WRAPPER),
            'env': {'CC_READ_ONLY': '1', 'CC_TOOL_ALLOWLIST': ','.join(CC_MEMORY_READ_TOOLS),
                    # 考試不在正式庫留 search_feedback 紀錄
                    'CC_SEARCH_FEEDBACK': 'off'}}}},
    }
    paths: dict[str, Path] = {}
    for name, cfg in configs.items():
        p = out_dir / f'mcp-{name}.json'
        p.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding='utf-8')
        paths[name] = p
    return paths


def child_env(extra_env: dict[str, str] | None = None,
              base: dict[str, str] | None = None) -> dict[str, str]:
    """子程序環境：只留白名單內的變數，再加 CC_MEMORY_CAPTURE_CHILD=1 與 extra_env。"""
    src = os.environ if base is None else base
    env = {k: v for k, v in src.items() if k in CHILD_ENV_NAMES or k.startswith(CHILD_ENV_PREFIXES)}
    env['CC_MEMORY_CAPTURE_CHILD'] = '1'
    env.update(extra_env or {})
    return env


def run_claude(prompt: str, *, model: str, cwd: Path, mcp_config: Path | None, tools: str,
               allowed: str, budget_usd: float, timeout_s: int = 600, disallowed: str = '',
               extra_env: dict[str, str] | None = None) -> ClaudeRun:
    """跑一次隔離的 claude -p。

    權限模式用 dontAsk：只有 --allowedTools 明列的工具能用，其餘自動拒（bypassPermissions 會讓 allowedTools
    失去限制作用，清單外的 MCP 工具照樣能呼叫）。--disallowedTools 的工具直接從模型可見的工具表移除。
    """
    cmd = ['claude', '-p', '--model', model, '--setting-sources', 'local', '--strict-mcp-config',
           '--tools', tools, '--allowedTools', allowed, '--permission-mode', 'dontAsk',
           '--no-session-persistence', '--max-budget-usd', f'{budget_usd:.2f}', '--output-format', 'json']
    if disallowed:
        cmd += ['--disallowedTools', disallowed]
    if mcp_config is not None:
        cmd += ['--mcp-config', str(mcp_config)]
    env = child_env(extra_env)
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


# ---------- 出題用對話稿 ----------

_TAG_RE = re.compile(r'(?:<|&lt;)(\s*/?\s*)(transcript)', re.I)
_ZERO_WIDTH_RE = re.compile('[\u200b-\u200f\u2060\ufeff]')
# 3-A：資料裡像段落標頭的「[L123 」改成全形，出題者才分得出哪些是程式加的標頭
_FAKE_HEAD_RE = re.compile(r'(^|\n)\s*\[(L\d)')
_CJK_RE = re.compile(r'[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]')


def _neutralize(text: str) -> str:
    """只套在資料內容上（標頭由程式另外加）：不讓內容關閉／開啟 <transcript> 區塊，也不讓它偽造段落標頭。

    零寬字元一律去掉。全形「＜／transcript＞」要 NFKC 正規化才認得出來，但 NFKC 會把中文全形標點改成半形、
    動到原文，所以只有正規化後真的出現標籤時才採用正規化版本。
    """
    text = _ZERO_WIDTH_RE.sub('', text)
    folded = unicodedata.normalize('NFKC', text)
    if folded != text and _TAG_RE.search(folded):
        text = folded
    text = _TAG_RE.sub(lambda m: '‹' + m.group(1) + m.group(2), text)
    return _FAKE_HEAD_RE.sub(lambda m: m.group(1) + '［' + m.group(2), text)


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return f'{text[:limit]}…〔後略 {len(text) - limit} 字元〕'


def _clip_middle(text: str, limit: int) -> str:
    """長文字頭尾各留一半（結論常在尾巴）。"""
    text = text.strip()
    if len(text) <= limit:
        return text
    half = limit // 2
    return f'{text[:half]}\n…〔中略 {len(text) - limit} 字元〕…\n{text[-half:]}'


def _flatten(value: Any) -> str:
    """把 tool_result 之類的 content（字串、block 陣列、dict）攤平成文字；圖片只留標記。"""
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(s for s in (_flatten(v) for v in value) if s)
    if isinstance(value, dict):
        kind = value.get('type')
        if kind == 'image':
            return '[圖片]'
        if kind == 'tool_reference':
            return f'[工具參照 {value.get("tool_name", "")}]'.strip()
        if isinstance(value.get('text'), str):
            return value['text']
        if 'content' in value:
            return _flatten(value['content'])
        return json.dumps(value, ensure_ascii=False)[:TRANSCRIPT_TOOL_RESULT_CHARS]
    return str(value)


def _est_tokens(text: str) -> int:
    cjk = len(_CJK_RE.findall(text))
    # 刻意偏保守：程式碼／JSON／路徑類 ASCII 實際約 0.35–0.4 token/字元，中文約 1.3–1.5
    return int(cjk * 1.3 + (len(text) - cjk) * 0.4) + 1


def _render_line(lineno: int, obj: dict[str, Any]) -> list[str]:
    """一行 JSONL → 0 到多段文字。只收 user／assistant；略過 thinking、isMeta、附件與狀態行。"""
    kind = obj.get('type')
    if kind not in ('user', 'assistant') or obj.get('isMeta'):
        return []
    msg = obj.get('message')
    if not isinstance(msg, dict):
        return []
    ts = str(obj.get('timestamp') or '')
    ts = f'{ts[:19]}Z' if ts.endswith('Z') else ts[:25]
    role = '對話摘要' if obj.get('isCompactSummary') else kind
    head = f'[L{lineno} {ts}'.rstrip()
    content = msg.get('content')
    blocks = [{'type': 'text', 'text': content}] if isinstance(content, str) else content
    if not isinstance(blocks, list):
        return []
    out: list[str] = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        btype = str(b.get('type') or '')
        if btype == 'text':
            text = str(b.get('text') or '').strip()
            if text:
                out.append(f'{head} {role}] {_neutralize(_clip_middle(text, TRANSCRIPT_TEXT_CHARS))}')
        elif btype in ('tool_use', 'server_tool_use'):
            args = json.dumps(b.get('input', {}), ensure_ascii=False, separators=(',', ':'))
            out.append(f'{head} tool_use] {_neutralize(str(b.get("name", "?")))} '
                       f'{_neutralize(_clip(args, TRANSCRIPT_TOOL_INPUT_CHARS))}')
        elif btype == 'tool_result' or btype.endswith('_tool_result'):
            text = _flatten(b.get('content'))
            err = ' 錯誤' if b.get('is_error') else ''
            out.append(f'{head} tool_result{err}] {_neutralize(_clip(text, TRANSCRIPT_TOOL_RESULT_CHARS))}')
        elif btype == 'image':
            out.append(f'{head} {role}] [圖片]')
        # thinking／redacted_thinking 等其他 block 不收
    return out


def render_transcript(path: Path, *, max_chars: int = TRANSCRIPT_MAX_CHARS,
                      max_est_tokens: int = TRANSCRIPT_MAX_EST_TOKENS) -> str:
    """把 Claude Code 對話 JSONL 轉成給出題者讀的精簡純文字。

    每段以 [L<原始行號> <時間戳> <角色>] 開頭，讓標準答案的 evidence 能引行號或時間。
    超過上限時保留後段（定案通常在後面）＋第一則使用者訊息（交代任務），並在截斷處註明。
    輸出仍是不可信資料：只能放在提示的 <transcript> 區塊內，且呼叫端不能給模型任何工具。
    """
    segments: list[tuple[int, str]] = []
    total_lines = 0
    with path.open(encoding='utf-8', errors='replace') as fh:
        for lineno, line in enumerate(fh, start=1):
            total_lines = lineno
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                segments.extend((lineno, s) for s in _render_line(lineno, obj))
    header = f'〔對話檔共 {total_lines} 行，轉出 {len(segments)} 段；tool_result 只留前 {TRANSCRIPT_TOOL_RESULT_CHARS} 字元〕'
    first_user = next((i for i, (_, s) in enumerate(segments) if ' user] ' in s), None)
    kept: list[str] = []
    used_chars, used_tokens = len(header), _est_tokens(header)
    reserve = _clip(segments[first_user][1], 2000) if first_user is not None else ''
    budget_chars = max_chars - len(reserve) - 200
    budget_tokens = max_est_tokens - _est_tokens(reserve) - 100
    cut_index = -1
    for idx in range(len(segments) - 1, -1, -1):
        seg = segments[idx][1]
        c, t = len(seg) + 1, _est_tokens(seg)
        if used_chars + c > budget_chars or used_tokens + t > budget_tokens:
            cut_index = idx
            break
        kept.append(seg)
        used_chars += c
        used_tokens += t
    kept.reverse()
    if cut_index < 0:
        return '\n'.join([header, *kept])
    first_kept_line = segments[cut_index + 1][0] if cut_index + 1 < len(segments) else total_lines
    notice = (f'〔已截斷：總長超過上限，第 L{first_kept_line} 行之前的 {cut_index + 1} 段省略，'
              f'只保留後段；開頭只留第一則使用者訊息供參考〕')
    lead = [reserve] if reserve and first_user is not None and first_user <= cut_index else []
    return '\n'.join([header, *lead, notice, *kept])


# ---------- 資料池 ----------

def psql_rows(sql: str) -> list[list[str]]:
    """唯讀查 cc-memory 正式 DB。失敗只回報 rc，絕不印 DSN。"""
    dsn = PROJECT_URL_FILE.read_text(encoding='utf-8').strip()
    proc = subprocess.run(['psql', dsn, '-At', '-F', '\t', '-c', sql], capture_output=True, text=True,
                          check=False, timeout=120)
    if proc.returncode != 0:
        # stderr 可能含 host／user，不印（PR #54 審查 F4）
        raise SystemExit(f'psql failed rc={proc.returncode}')
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
    q = ('SELECT s.content_session_id, s.project, COUNT(o.id), s.started_at_epoch FROM sdk_sessions s '
         'LEFT JOIN observations o ON o.memory_session_id = s.memory_session_id '
         'WHERE s.started_at_epoch > ? GROUP BY s.content_session_id HAVING COUNT(o.id) >= ?')
    for sid, proj, n, started in con.execute(q, (since_ms, min_obs)):
        out[sid] = {'project': proj, 'obs': int(n), 'started_ms': int(started or 0)}
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
                require_finalized: bool = True, seed: int | None = None,
                since_ms: int | None = None) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """兩邊都抓到、cc 已收尾、沒考過的 session，按專案分層隨機抽 n 個。回傳 (樣本, 計數)。

    since_ms：只收這個時間點之後才開始的對話（看 claude-mem 記的開始時間），用來只考某次改版後抓的資料。
    """
    if since_ms is not None and since_ms < (time.time() - days * 86400) * 1000:
        print(f'[pool] 警告：--since 早於 --days {days} 的範圍，實際只看近 {days} 天', file=sys.stderr)
    cc = cc_memory_sessions(days, cc_min_obs)
    cm = claude_mem_sessions(days, cm_min_obs)
    both = [s for s in cc if s in cm and (since_ms is None or cm[s]['started_ms'] >= since_ms)]
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
