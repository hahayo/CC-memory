#!/usr/bin/env bash
# CC-memory v0.5 M4 4c SessionStart injection hook wrapper.
# Local-only and best-effort: every path exits 0. Never blocks session start.

# 遞迴 capture 斷路器：capture worker spawn 的 claude 子程序帶此 marker，
# 其 SessionStart 不得觸發注入（否則注入內容又被下輪 worker 抽取）。
if [[ -n "${CC_MEMORY_CAPTURE_CHILD:-}" ]]; then
  exit 0
fi

# 注入預設關閉（CC_MEMORY_INJECT_RECENT）：非 on 一律 bash 層擋掉，不 spawn Node。
inject_flag="$(printf '%s' "${CC_MEMORY_INJECT_RECENT:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if [[ "$inject_flag" != "on" ]]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(dirname "$script_dir")"

# 原樣把 stdin pipe 給 Node（本殼不 cat stdin，交由 Node 讀 payload）；
# Node 失敗照樣 exit 0（|| true），不擋 session start。執行方式對齊 run-auto-capture 慣例。
( cd "$repo_root" && npx tsx scripts/run-session-start-inject.ts ) || true
exit 0
