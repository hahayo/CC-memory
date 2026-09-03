#!/usr/bin/env bash
# CC-memory v0.5 M4 4c SessionStart injection hook wrapper.
# Local-only and best-effort: every path exits 0. Never blocks session start.
#
# 2026-09-03 inject-fix（Codex 審查硬性條件 1–4）：
#   - DSN 一律來自 ~/.ccm-project-url（覆蓋、不信任繼承的 DATABASE_URL）；檔案須是
#     非 symlink 的一般檔、mode 0600、非空——任一不符就不注入（Node 端再以 O_NOFOLLOW+fstat 覆核）。
#   - spawn Node 前 unset CC_FORCE_PROJECT_ID / DATABASE_URL_PERSONAL / CC_MEMORY_PROJECT_ID，
#     避免 personal instance 或舊 env 汙染 project 注入。
#   - 只在 cwd 位於 git repo 內（找得到 .git/HEAD 或 worktree 指標）才注入；非 git 目錄靠
#     basename 撞名可能注入別的專案，故不注入。此為前置閘（省一次 tsx 冷啟動），
#     Node 端 resolveProjectIdDetailed 仍是最終判定。
#   - 本殼不印 DSN、不寫 log。

# 遞迴 capture 斷路器：capture worker spawn 的 claude 子程序帶此 marker，
# 其 SessionStart 不得觸發注入（否則注入內容又被下輪 worker 抽取）。
if [[ -n "${CC_MEMORY_CAPTURE_CHILD:-}" ]]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
bash "$script_dir/kick-auto-capture.sh" >/dev/null 2>&1 || true

# 注入預設關閉（CC_MEMORY_INJECT_RECENT）：非 on 一律 bash 層擋掉，不 spawn Node。
inject_flag="$(printf '%s' "${CC_MEMORY_INJECT_RECENT:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if [[ "$inject_flag" != "on" ]]; then
  exit 0
fi

export LC_ALL=C.UTF-8
# 共用 helper（json_unescape / find_repo_root，REPLY 回傳）；找不到就靜默退出（best-effort）。
# shellcheck source=hooks/capture-common.sh
source "$script_dir/capture-common.sh" 2>/dev/null || exit 0

payload="$(cat 2>/dev/null)"
cwd=''
cwd_regex='"cwd"[[:space:]]*:[[:space:]]*"((\\.|[^"\\])*)"'
if [[ "$payload" =~ $cwd_regex ]]; then
  json_unescape "${BASH_REMATCH[1]}"
  cwd="$REPLY"
fi
if [[ -z "$cwd" ]]; then
  exit 0
fi
# 非 git 目錄（無 .git/HEAD、非 worktree）→ 不注入。
find_repo_root "$cwd" || exit 0

# DSN：一律讀 ~/.ccm-project-url 覆蓋 DATABASE_URL；讀不到／不安全 → 不注入（不擋 session start）。
if [[ -z "${HOME:-}" ]]; then
  exit 0
fi
url_file="$HOME/.ccm-project-url"
if [[ -L "$url_file" || ! -f "$url_file" || ! -s "$url_file" ]]; then
  exit 0
fi
url_mode="$(stat -c '%a' "$url_file" 2>/dev/null || stat -f '%Lp' "$url_file" 2>/dev/null || printf '')"
if [[ "$url_mode" != "600" ]]; then
  exit 0
fi
database_url="$(<"$url_file")"
database_url="${database_url#"${database_url%%[![:space:]]*}"}"
database_url="${database_url%"${database_url##*[![:space:]]}"}"
if [[ -z "$database_url" ]]; then
  exit 0
fi
export DATABASE_URL="$database_url"
unset CC_FORCE_PROJECT_ID DATABASE_URL_PERSONAL CC_MEMORY_PROJECT_ID

repo_root="$(dirname "$script_dir")"

# 把 payload 原樣 pipe 給 Node（Node 自己 parse cwd 並再解析 project id）；
# Node 失敗照樣 exit 0（|| true），不擋 session start。5s 總上限涵蓋 npx/loader
# 卡住情境；Node 內部 connect/statement timeout 只涵蓋 DB 階段。
# -k 1：SIGTERM 後 1s 補 SIGKILL——沒有 kill-after 時子程序 trap TERM 可活過上限
# （對審收斂輪實測證據），硬上限才守得住「絕不擋 session start」。
( cd "$repo_root" && printf '%s' "$payload" | timeout -k 1 5 npx tsx scripts/run-session-start-inject.ts ) || true
exit 0
