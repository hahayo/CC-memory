#!/usr/bin/env bash
# CC-memory v0.5 M2a Stop hook wrapper.
# Local-only and best-effort: every path exits 0.

# 遞迴 capture 斷路器：capture worker spawn 的 claude 子程序帶此 marker，
# 其 Stop sentinel 不得進 spool（否則產生空 session 供下輪 worker 空轉）。
if [[ -n "${CC_MEMORY_CAPTURE_CHILD:-}" ]]; then
  exit 0
fi

payload="$(cat 2>/dev/null)"
capture_written=0

json_get_string() {
  local key="$1"
  local regex="\"${key}\"[[:space:]]*:[[:space:]]*\"((\\\\.|[^\"\\\\])*)\""
  if [[ "$payload" =~ $regex ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

sanitize_segment() {
  local value="$1"
  local sanitized="${value//[^A-Za-z0-9._-]/_}"
  if [[ "$sanitized" == .* ]]; then
    while [[ "$sanitized" == .* ]]; do
      sanitized="${sanitized#.}"
    done
    sanitized="_${sanitized}"
  fi
  if [[ -z "$sanitized" || "$sanitized" == "." || "$sanitized" == ".." ]]; then
    printf 'unknown'
  else
    printf '%s' "$sanitized"
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

json_unescape() {
  local value="$1"
  value="${value//\\\"/\"}"
  value="${value//\\\//\/}"
  value="${value//\\n/$'\n'}"
  value="${value//\\r/$'\r'}"
  value="${value//\\t/$'\t'}"
  value="${value//\\\\/\\}"
  if [[ "$value" == *'\u'* ]]; then
    printf -v value '%b' "$value" 2>/dev/null || true
  fi
  printf '%s' "$value"
}

# 對齊 src/services/projects.ts findRepoRoot：`.git/HEAD` 或 `.git` 檔（gitdir: 開頭，worktree）。
find_repo_root() {
  local dir="${1%/}" i first
  [[ -z "$dir" ]] && dir='/'
  for ((i = 0; i < 64; i++)); do
    if [[ -f "$dir/.git/HEAD" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    if [[ -f "$dir/.git" ]]; then
      IFS= read -r first <"$dir/.git" 2>/dev/null || first=''
      first="${first#"${first%%[![:space:]]*}"}"
      if [[ "$first" == gitdir:* ]]; then
        printf '%s' "$dir"
        return 0
      fi
    fi
    [[ "$dir" == '/' ]] && return 1
    dir="${dir%/*}"
    [[ -z "$dir" ]] && dir='/'
  done
  return 1
}

# 對齊 tryReadClaudeMdMarker：從 cwd 往上到 repo root 為止，取最近的 CLAUDE.md marker。
read_claude_md_marker() {
  local dir="${1%/}" root="$2" i content
  [[ -z "$dir" ]] && dir='/'
  local marker_regex='<!--[[:space:]]*cc-memory:[[:space:]]*project="([^"]+)"[[:space:]]*-->'
  for ((i = 0; i < 64; i++)); do
    if [[ -r "$dir/CLAUDE.md" ]]; then
      content="$(<"$dir/CLAUDE.md")" 2>/dev/null || content=''
      if [[ "$content" =~ $marker_regex ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
        return 0
      fi
    fi
    [[ "$dir" == "$root" || "$dir" == '/' ]] && return 1
    dir="${dir%/*}"
    [[ -z "$dir" ]] && dir='/'
  done
  return 1
}

# resolveProjectId layer 3-5：CLAUDE.md marker → repo root basename → cwd basename。
# 回傳原始字串（含非 ASCII）；spool 目錄名另外經 sanitize_segment。
resolve_project_id() {
  local cwd="${1%/}" root marker base
  if [[ -n "$cwd" ]] && root="$(find_repo_root "$cwd")"; then
    if marker="$(read_claude_md_marker "$cwd" "$root")" && [[ -n "$marker" ]]; then
      printf '%s' "$marker"
      return 0
    fi
    base="${root##*/}"
  else
    base="${cwd##*/}"
  fi
  if [[ -z "$base" ]]; then
    printf 'unknown'
  else
    printf '%s' "$base"
  fi
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
  project_id="$(resolve_project_id "$(json_unescape "$cwd")")"
  project_dir_name="$(sanitize_segment "$project_id")"
  session_id="$(sanitize_segment "$session_id")"

  if [[ -z "${CC_MEMORY_SPOOL_DIR:-}" && -z "${HOME:-}" ]]; then
    return 0
  fi
  spool_root="${CC_MEMORY_SPOOL_DIR:-${HOME}/.cache/cc-memory/spool}"
  project_dir="${spool_root}/${project_dir_name}"
  spool_file="${project_dir}/${session_id}.jsonl"

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
