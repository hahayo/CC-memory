#!/usr/bin/env bash
# CC-memory v0.5 M2a Stop hook wrapper.
# Local-only and best-effort: every path exits 0.

# 遞迴 capture 斷路器：capture worker spawn 的 claude 子程序帶此 marker，
# 其 Stop sentinel 不得進 spool（否則產生空 session 供下輪 worker 空轉）。
if [[ -n "${CC_MEMORY_CAPTURE_CHILD:-}" ]]; then
  exit 0
fi

export LC_ALL=C.UTF-8
# 共用 helper（REPLY 回傳）；找不到就靜默退出（best-effort）。
# shellcheck source=hooks/capture-common.sh
source "${BASH_SOURCE[0]%/*}/capture-common.sh" 2>/dev/null || exit 0
payload="$(cat 2>/dev/null)"
capture_written=0

json_get_string() {
  local key="$1"
  local regex="\"${key}\"[[:space:]]*:[[:space:]]*\"((\\\\.|[^\"\\\\])*)\""
  if [[ "$payload" =~ $regex ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

file_size() {
  local path="$1"
  stat -c '%s' "$path" 2>/dev/null || stat -f '%z' "$path" 2>/dev/null || printf '0'
}

main() {
  umask 077

  local session_id transcript_path cwd project_id project_dir_name spool_root project_dir spool_file hwm_offset line
  session_id="$(json_get_string 'session_id')"
  transcript_path="$(json_get_string 'transcript_path')"
  cwd="$(json_get_string 'cwd')"
  if [[ -z "$session_id" || -z "$transcript_path" ]]; then
    return 0
  fi
  json_unescape "$cwd"
  resolve_project_id "$REPLY"
  project_id="$REPLY"
  sanitize_segment "$project_id"
  project_dir_name="$REPLY"
  sanitize_segment "$session_id"
  session_id="$REPLY"

  if [[ -z "${CC_MEMORY_SPOOL_DIR:-}" && -z "${HOME:-}" ]]; then
    return 0
  fi
  spool_root="${CC_MEMORY_SPOOL_DIR:-${HOME}/.cache/cc-memory/spool}"
  project_dir="${spool_root}/${project_dir_name}"
  spool_file="${project_dir}/${session_id}.jsonl"

  if [[ -L "$project_dir" || -L "$spool_file" ]]; then
    return 0
  fi
  mkdir -p "$project_dir" 2>/dev/null || return 0
  chmod 700 "$spool_root" "$project_dir" 2>/dev/null || true

  hwm_offset="$(file_size "$transcript_path")"
  line=$(printf '{"transcript_path":"%s","hwm_offset":%s}' \
    "$(json_escape "$transcript_path")" \
    "$hwm_offset")

  printf '%s\n' "$line" >>"$spool_file" 2>/dev/null || return 0
  chmod 600 "$spool_file" 2>/dev/null || true
  capture_written=1
  return 0
}

main

if [[ "$capture_written" == "1" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  bash "$script_dir/kick-auto-capture.sh" >/dev/null 2>&1 || true
fi
exit 0
