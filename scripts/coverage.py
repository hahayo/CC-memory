"""近 N 天抽取覆蓋率（唯讀）：每個 spool session 的對話檔現在大小 vs capture-state checkpoint。

用法：python3 -I scripts/coverage.py [天數=7]
口徑：只算對話檔（.jsonl）還在、修改時間在 N 天內的 session；
     已被 Codex 壓成 .jsonl.zst 的對話檔不列入（要算的話需解壓才知道大小）。
     「抽完」＝checkpoint ≥ 檔案大小 95%；「完全沒碰」＝checkpoint 為 0。
沿革：2026-10-23 起在 scratchpad 跑，2026-11-08 使用者拍板搬進 repo。
"""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

SPOOL = Path.home() / ".cache" / "cc-memory" / "spool"
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
cutoff = time.time() - DAYS * 86400

total = done = 0
n_sessions = n_full = n_zero = 0
for state_path in SPOOL.glob("*/*.capture-state.json"):
    jsonl = state_path.with_name(state_path.name.replace(".capture-state.json", ".jsonl"))
    if not jsonl.exists():
        continue
    tp = ""
    for line in jsonl.open(encoding="utf-8", errors="replace"):
        try:
            tp = json.loads(line).get("transcript_path") or tp
        except Exception:
            pass
        if tp:
            break
    if not tp or not os.path.exists(tp):
        continue
    if os.path.getmtime(tp) < cutoff:
        continue
    size = os.path.getsize(tp)
    if size == 0:
        continue
    try:
        st = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        continue
    key = hashlib.sha256(tp.encode("utf-8")).hexdigest()
    cp = (st.get("transcripts", {}).get(key) or {}).get("checkpoint", 0)
    cp = min(cp, size)
    total += size
    done += cp
    n_sessions += 1
    if cp >= size * 0.95:
        n_full += 1
    if cp == 0:
        n_zero += 1

pct = 100 * done / total if total else 0
print(f"近 {DAYS} 天：session={n_sessions} 對話檔合計={total/1e6:.0f} MB 已抽取={done/1e6:.0f} MB 覆蓋率={pct:.1f}%")
print(f"  抽完(≥95%)={n_full}  完全沒碰={n_zero}")
