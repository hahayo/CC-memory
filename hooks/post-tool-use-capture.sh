#!/usr/bin/env bash
# CC-memory v0.5 M2a PostToolUse hook wrapper.
# Local-only and best-effort: every path exits 0.

payload="$(cat 2>/dev/null)"

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

file_size() {
  local path="$1"
  stat -c '%s' "$path" 2>/dev/null || stat -f '%z' "$path" 2>/dev/null || printf '0'
}

trim_spaces() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

should_skip_tool() {
  local tool="$1"
  local skip_csv
  if [[ ${CC_MEMORY_SKIP_TOOLS+x} ]]; then
    skip_csv="$CC_MEMORY_SKIP_TOOLS"
  else
    skip_csv='ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion'
  fi

  local IFS=','
  local item
  for item in $skip_csv; do
    item="$(trim_spaces "$item")"
    if [[ -n "$item" && "$item" == "$tool" ]]; then
      return 0
    fi
  done
  return 1
}

main() {
  umask 077

  local tool_name session_id transcript_path cwd project_base project_id spool_root project_dir spool_file
  tool_name="$(json_get_string 'tool_name')"
  if [[ -z "$tool_name" ]] || should_skip_tool "$tool_name"; then
    return 0
  fi

  session_id="$(json_get_string 'session_id')"
  transcript_path="$(json_get_string 'transcript_path')"
  cwd="$(json_get_string 'cwd')"
  project_base="${cwd%/}"
  project_base="${project_base##*/}"
  project_id="$(sanitize_segment "$project_base")"
  session_id="$(sanitize_segment "$session_id")"

  if [[ -z "${CC_MEMORY_SPOOL_DIR:-}" && -z "${HOME:-}" ]]; then
    return 0
  fi
  spool_root="${CC_MEMORY_SPOOL_DIR:-${HOME}/.cache/cc-memory/spool}"
  project_dir="${spool_root}/${project_id}"
  spool_file="${project_dir}/${session_id}.jsonl"

  mkdir -p "$project_dir" 2>/dev/null || return 0
  chmod 700 "$spool_root" "$project_dir" 2>/dev/null || true

  local timestamp offset line
  printf -v timestamp '%(%Y-%m-%dT%H:%M:%S%z)T' -1 2>/dev/null \
    || timestamp="$(date +%Y-%m-%dT%H:%M:%S%z 2>/dev/null || true)"
  offset="$(file_size "$transcript_path")"
  line=$(printf '{"session_id":"%s","project_id":"%s","tool_name":"%s","timestamp":"%s","transcript_path":"%s","transcript_offset":%s}' \
    "$(json_escape "$session_id")" \
    "$(json_escape "$project_id")" \
    "$(json_escape "$tool_name")" \
    "$(json_escape "$timestamp")" \
    "$(json_escape "$transcript_path")" \
    "$offset")

  printf '%s\n' "$line" >>"$spool_file" 2>/dev/null || return 0
  chmod 600 "$spool_file" 2>/dev/null || true
  return 0
}

main
exit 0
