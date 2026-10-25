#!/usr/bin/env python3
"""cc-memory vs claude-mem 盲測（recall exam）。

流程：pool（抽兩邊都抓到的 session）→ ask（出題者只讀原始對話檔，產題目＋標準答案）
→ answer（兩個作答者各只拿一套記憶工具）→ grade（兩位評分者、順序相反、系統名遮罩）→ report。

用法：
  python3 scripts/recall-exam/recall_exam.py run --fixed --rolling 6 --days 14
  python3 scripts/recall-exam/recall_exam.py run --fixed-only
  python3 scripts/recall-exam/recall_exam.py pool --days 14 --n 6      # 只看抽樣結果，不花錢
  python3 scripts/recall-exam/recall_exam.py report <run_dir>          # 重算報表

產物在 ~/.cache/cc-memory/recall-exam/runs/<時間戳>/：questions.json、answers.json、grades.json、report.md。
考過的 rolling session 記進 ledger.jsonl，下次不重抽。
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402

HERE = Path(__file__).resolve().parent
FIXED_SET = HERE / 'fixed-set.json'
ASK_MODEL = 'sonnet'
ANSWER_MODEL = 'sonnet'
GRADE_MODEL = 'sonnet'
ANSWER_BUDGET = 0.6
ASK_BUDGET = 0.8
GRADE_BUDGET = 0.3
MAX_QUERIES = 6

ASK_PROMPT = """任務：讀一份 Claude Code 原始對話檔（JSONL），出一題「記憶考題」並寫標準答案。這題會拿來評分兩套記憶系統，所以答案必須只根據對話檔原文，附出處，不可推測。

## 限制
- 只能讀這個檔：{transcript}（用 Bash 的 grep／python3 搜關鍵字再讀片段；檔案可能很大，不要整檔讀進來）。
- 禁止讀任何其他檔案、禁止讀 ~/.claude/projects/*/memory/、禁止用任何記憶工具。全程唯讀。
- JSONL 每行一個事件；文字在 message.content（字串或 [{{type:"text",text}}]／tool_use／tool_result 陣列）。
- 以 assistant 的結論文字與 tool_result 實際輸出為準；若前後說法改變，以最後定案為準並註明中途被推翻的說法。

## 出題要求
- 題目要問這場對話「最後定案」的具體事實（根因、決定、數字、欄位、流程），不是泛泛主題。
- 優先挑對話中有「中途假設被推翻」或「最後翻案」的事，這種最能分出記憶系統好壞。
- 題目要自足：讀題的人不知道這場對話，所以要寫出專案名、主題、3–6 個關鍵字。
- 標準答案列 3–6 個可查核的關鍵事實。

## 回報格式：只輸出一個 ```json 區塊
```json
{{"question": "<題目，含專案名與關鍵字>", "gold": "<標準答案，條列>", "evidence": "<出處：行號或時間戳＋原文短引>", "gold_confidence": "高|中|低", "overturned": "<中途被推翻的說法，沒有就寫 無>"}}
```"""

ANSWER_PROMPT = """你是記憶檢索作答者。你只能用現在可用的工具查「記憶系統」，不能猜、不能讀檔案。
最多查 {max_queries} 次。查不到就老實說查不到，不要編。
這題的事發生在專案 `{project}`。工具若有專案篩選參數（例如 project_id），值就填 `{project}`，不要猜路徑；
先在這個專案範圍內查，查不到再放寬到不限專案。

問題：{question}

回答格式（純文字）：
答案：<條列可查核的事實>
信心：高／中／低
查了幾次：<n>"""

GRADE_PROMPT = """你是評分者。下面是一道記憶考題、標準答案（只根據原始對話檔整理，可信），以及兩個作答者 X、Y 的答案。
兩個作答者用的是不同的記憶系統，系統名已遮成 [工具]；不要猜是哪套，只比對事實。

評分等級（每個作答者一個）：
- correct：關鍵事實都對，沒有與標準答案矛盾的內容
- partial：有對的關鍵事實，但漏了重點或有次要錯誤
- wrong：主要內容錯，且作答者自己標「信心：低」或明說不確定
- confident_wrong：主要內容錯，但作答者標「信心：高」或「中」、講得很肯定（最糟）
- no_answer：作答者明說查不到、沒有給出實質內容

## 題目
{question}

## 標準答案
{gold}

## 出處
{evidence}

## 作答者 X
{answer_x}

## 作答者 Y
{answer_y}

只輸出一個 ```json 區塊：
```json
{{"X": "<等級>", "Y": "<等級>", "reason_X": "<一句>", "reason_Y": "<一句>"}}
```"""


def now_stamp() -> str:
    return time.strftime('%Y%m%dT%H%M%S')


def load_fixed() -> list[dict[str, Any]]:
    data = json.loads(FIXED_SET.read_text(encoding='utf-8'))
    return [dict(q, source='fixed') for q in data['questions']]


def cmd_pool(args: argparse.Namespace) -> list[dict[str, Any]]:
    picked, counts = lib.sample_pool(args.days, args.n, require_finalized=not args.allow_unfinalized, seed=args.seed)
    print(json.dumps({'counts': counts, 'picked': picked}, ensure_ascii=False, indent=1))
    return picked


def make_questions(samples: list[dict[str, Any]], run_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in samples:
        run = lib.run_claude(ASK_PROMPT.format(transcript=s['transcript']), model=ASK_MODEL, cwd=run_dir,
                             mcp_config=None, tools='Bash,Read,Grep', allowed='Bash,Read,Grep',
                             budget_usd=ASK_BUDGET, timeout_s=900)
        obj = lib.extract_json_block(run.result) if not run.is_error else None
        if not obj or not obj.get('question') or not obj.get('gold'):
            print(f'[ask] {s["session_id"][:8]} 出題失敗（cost={run.cost_usd:.2f}）', file=sys.stderr, flush=True)
            continue
        out.append({'id': f'R-{s["session_id"][:8]}', 'source': 'rolling', 'session_id': s['session_id'],
                    'project': s['project'], 'transcript': s['transcript'], 'question': obj['question'],
                    'gold': obj['gold'], 'evidence': obj.get('evidence', ''),
                    'gold_confidence': obj.get('gold_confidence', '?'), 'overturned': obj.get('overturned', ''),
                    'ask_cost_usd': run.cost_usd})
        print(f'[ask] {s["session_id"][:8]} ok cost={run.cost_usd:.2f}', file=sys.stderr, flush=True)
    return out


def answer_all(questions: list[dict[str, Any]], run_dir: Path, mcp: dict[str, Path]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for q in questions:
        rec: dict[str, Any] = {'id': q['id'], 'answers': {}}
        for system in lib.SYSTEMS:
            run = lib.run_claude(ANSWER_PROMPT.format(max_queries=MAX_QUERIES, question=q['question'],
                                                      project=q.get('project') or '未知'),
                                 model=ANSWER_MODEL, cwd=run_dir, mcp_config=mcp[system], tools='',
                                 allowed='mcp__*', budget_usd=ANSWER_BUDGET)
            rec['answers'][system] = {'text': run.result, 'cost_usd': run.cost_usd, 'turns': run.turns,
                                      'is_error': run.is_error, 'session_id': run.session_id}
            print(f'[answer] {q["id"]} {system} turns={run.turns} cost={run.cost_usd:.2f} err={run.is_error}',
                  file=sys.stderr)
        out.append(rec)
    return out


def grade_all(questions: list[dict[str, Any]], answers: list[dict[str, Any]], run_dir: Path,
              rng: random.Random) -> list[dict[str, Any]]:
    by_id = {a['id']: a for a in answers}
    out: list[dict[str, Any]] = []
    for q in questions:
        a = by_id[q['id']]
        order = list(lib.SYSTEMS)
        rng.shuffle(order)
        label = {'X': order[0], 'Y': order[1]}
        redacted = {sysname: lib.redact(a['answers'][sysname]['text']) for sysname in lib.SYSTEMS}
        verdicts: dict[str, dict[str, str]] = {}
        cost = 0.0
        for grader_idx in (0, 1):
            x, y = (label['X'], label['Y']) if grader_idx == 0 else (label['Y'], label['X'])
            prompt = GRADE_PROMPT.format(question=q['question'], gold=q['gold'], evidence=q.get('evidence', ''),
                                         answer_x=redacted[x], answer_y=redacted[y])
            run = lib.run_claude(prompt, model=GRADE_MODEL, cwd=run_dir, mcp_config=None, tools='', allowed='',
                                 budget_usd=GRADE_BUDGET, timeout_s=300)
            cost += run.cost_usd
            obj = lib.extract_json_block(run.result) or {}
            vx, vy = str(obj.get('X', '?')), str(obj.get('Y', '?'))
            verdicts[f'grader{grader_idx + 1}'] = {x: vx if vx in lib.VERDICTS else '?',
                                                   y: vy if vy in lib.VERDICTS else '?',
                                                   'reason': f'X={obj.get("reason_X", "")} Y={obj.get("reason_Y", "")}'}
        final, disagreement, winner = resolve_verdicts(verdicts)
        out.append({'id': q['id'], 'label_map': label, 'graders': verdicts, 'final': final,
                    'disagreement': disagreement, 'winner': winner, 'grade_cost_usd': cost})
        print(f'[grade] {q["id"]} {final} disagree={disagreement}', file=sys.stderr, flush=True)
    return out


def resolve_verdicts(verdicts: dict[str, dict[str, str]]) -> tuple[dict[str, str], bool, str]:
    """兩位評分者等級相同就照用；等級不同但勝負順序相同，仍視為已決（取較保守的等級）；
    勝負順序不同才標 DISAGREE 留人工。回傳 (final, disagreement, winner)，winner ∈ 系統名／tie／undecided。"""
    def winner_of(v: dict[str, str]) -> str | None:
        if any(v.get(s) not in lib.VERDICT_SCORE for s in lib.SYSTEMS):
            return None
        a, b = (lib.VERDICT_SCORE[v[s]] for s in lib.SYSTEMS)
        return lib.SYSTEMS[0] if a > b else lib.SYSTEMS[1] if b > a else 'tie'
    w1, w2 = winner_of(verdicts['grader1']), winner_of(verdicts['grader2'])
    final: dict[str, str] = {}
    if w1 is None or w2 is None or w1 != w2:
        for s in lib.SYSTEMS:
            v1, v2 = verdicts['grader1'][s], verdicts['grader2'][s]
            final[s] = v1 if v1 == v2 else 'DISAGREE'
        return final, True, 'undecided'
    for s in lib.SYSTEMS:
        v1, v2 = verdicts['grader1'][s], verdicts['grader2'][s]
        final[s] = v1 if v1 == v2 else min((v1, v2), key=lambda v: lib.VERDICT_SCORE[v])
    return final, w1 != w2, w1


def render_report(run_dir: Path, meta: dict[str, Any], questions: list[dict[str, Any]],
                  answers: list[dict[str, Any]], grades: list[dict[str, Any]]) -> str:
    by_a = {a['id']: a for a in answers}
    by_g = {g['id']: g for g in grades}
    lines = [f'# recall exam {run_dir.name}', '',
             f'- claude-mem 健康檢查：{meta["claude_mem_health"]}',
             f'- 資料池：{json.dumps(meta.get("pool_counts", {}), ensure_ascii=False)}',
             f'- 模型：出題 {ASK_MODEL}／作答 {ANSWER_MODEL}／評分 {GRADE_MODEL}（兩位、順序相反）', '',
             '| 題 | 來源 | 專案 | cc-memory | claude-mem | 評分分歧 | 作答次數 cc/cm | 作答費用 cc/cm |',
             '|---|---|---|---|---|---|---|---|']
    tally = {s: {'win': 0, 'tie': 0, 'loss': 0, 'confident_wrong': 0, 'cost': 0.0, 'turns': 0} for s in lib.SYSTEMS}
    undecided = 0
    for q in questions:
        a, g = by_a[q['id']], by_g[q['id']]
        f = g['final'] if 'winner' in g else resolve_verdicts(g['graders'])[0]
        for s in lib.SYSTEMS:
            tally[s]['cost'] += a['answers'][s]['cost_usd']
            tally[s]['turns'] += a['answers'][s]['turns']
            if f[s] == 'confident_wrong':
                tally[s]['confident_wrong'] += 1
        winner = g.get('winner') or resolve_verdicts(g['graders'])[2]
        if winner == 'undecided':
            undecided += 1
        elif winner == 'tie':
            for s in lib.SYSTEMS:
                tally[s]['tie'] += 1
        else:
            tally[winner]['win'] += 1
            tally[[s for s in lib.SYSTEMS if s != winner][0]]['loss'] += 1
        lines.append(f'| {q["id"]} | {q["source"]} | {q.get("project", "")} | {f["cc-memory"]} | {f["claude-mem"]} | '
                     f'{"是" if g["disagreement"] else ""} | {a["answers"]["cc-memory"]["turns"]}/{a["answers"]["claude-mem"]["turns"]} | '
                     f'{a["answers"]["cc-memory"]["cost_usd"]:.2f}/{a["answers"]["claude-mem"]["cost_usd"]:.2f} |')
    lines += ['', '## 總計', '', '| 系統 | 贏 | 平 | 輸 | 有把握地答錯 | 作答費用 | 查詢輪數 |', '|---|---|---|---|---|---|---|']
    for s in lib.SYSTEMS:
        t = tally[s]
        lines.append(f'| {s} | {t["win"]} | {t["tie"]} | {t["loss"]} | {t["confident_wrong"]} | ${t["cost"]:.2f} | {t["turns"]} |')
    lines += ['', f'- 勝負順序兩位評分者相反、待人工仲裁：{undecided} 題（看 grades.json 的 graders 欄）；等級不同但勝負相同的題已取較保守等級計入。',
              '- 等級分數：correct 3、partial 2、no_answer 1、wrong 0、confident_wrong −1；高者勝。',
              '- 固定題（fixed）的 session 早於 2026-10-21 收尾功能上線，測的是搜尋／抽取；rolling 題才測收尾後的新資料。', '']
    return '\n'.join(lines)


def cmd_run(args: argparse.Namespace) -> None:
    run_dir = lib.STATE_DIR / 'runs' / now_stamp()
    run_dir.mkdir(parents=True, exist_ok=False)
    healthy, health_msg = lib.claude_mem_healthy()
    if not healthy and not args.ignore_health:
        raise SystemExit(f'claude-mem 搜尋不健康，考試不公平，先修：{health_msg}')
    rng = random.Random(args.seed)
    mcp = lib.write_mcp_configs(run_dir)
    questions: list[dict[str, Any]] = []
    meta: dict[str, Any] = {'claude_mem_health': health_msg, 'started': now_stamp(), 'args': {k: v for k, v in vars(args).items() if k != 'func'}}
    if args.fixed or args.fixed_only:
        questions += load_fixed()
    if not args.fixed_only and args.rolling > 0:
        samples, counts = lib.sample_pool(args.days, args.rolling, require_finalized=not args.allow_unfinalized,
                                          seed=args.seed)
        meta['pool_counts'] = counts
        questions += make_questions(samples, run_dir)
    if not questions:
        raise SystemExit('沒有題目可考')
    (run_dir / 'questions.json').write_text(json.dumps(questions, ensure_ascii=False, indent=1), encoding='utf-8')
    answers = answer_all(questions, run_dir, mcp)
    (run_dir / 'answers.json').write_text(json.dumps(answers, ensure_ascii=False, indent=1), encoding='utf-8')
    grades = grade_all(questions, answers, run_dir, rng)
    (run_dir / 'grades.json').write_text(json.dumps(grades, ensure_ascii=False, indent=1), encoding='utf-8')
    (run_dir / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    report = render_report(run_dir, meta, questions, answers, grades)
    (run_dir / 'report.md').write_text(report, encoding='utf-8')
    with lib.LEDGER.open('a', encoding='utf-8') as fh:
        for q in questions:
            if q['source'] == 'rolling':
                fh.write(json.dumps({'session_id': q['session_id'], 'run': run_dir.name, 'id': q['id']}) + '\n')
    print(report)
    print(f'\n[run] 產物：{run_dir}', file=sys.stderr, flush=True)


def cmd_report(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir)
    load = lambda name: json.loads((run_dir / name).read_text(encoding='utf-8'))  # noqa: E731
    print(render_report(run_dir, load('meta.json'), load('questions.json'), load('answers.json'), load('grades.json')))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pool', help='只抽樣，不花錢')
    p.add_argument('--days', type=int, default=14)
    p.add_argument('--n', type=int, default=6)
    p.add_argument('--seed', type=int, default=None)
    p.add_argument('--allow-unfinalized', action='store_true')
    p.set_defaults(func=cmd_pool)
    r = sub.add_parser('run', help='完整跑一輪')
    r.add_argument('--fixed', action='store_true', help='含固定回歸題')
    r.add_argument('--fixed-only', action='store_true')
    r.add_argument('--rolling', type=int, default=6, help='隨機新題數')
    r.add_argument('--days', type=int, default=14)
    r.add_argument('--seed', type=int, default=None)
    r.add_argument('--allow-unfinalized', action='store_true')
    r.add_argument('--ignore-health', action='store_true')
    r.set_defaults(func=cmd_run)
    rp = sub.add_parser('report', help='重算報表')
    rp.add_argument('run_dir')
    rp.set_defaults(func=cmd_report)
    args = ap.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
