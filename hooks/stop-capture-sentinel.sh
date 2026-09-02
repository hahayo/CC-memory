#!/usr/bin/env bash
# CC-memory v0.5 M2a Stop hook wrapper.
# Local-only and best-effort: every path exits 0.

# 遞迴 capture 斷路器：capture worker spawn 的 claude 子程序帶此 marker，
# 其 Stop sentinel 不得進 spool（否則產生空 session 供下輪 worker 空轉）。
if [[ -n "${CC_MEMORY_CAPTURE_CHILD:-}" ]]; then
  exit 0
fi

export LC_ALL=C.UTF-8
payload="$(cat 2>/dev/null)"
capture_written=0

json_get_string() {
  local key="$1"
  local regex="\"${key}\"[[:space:]]*:[[:space:]]*\"((\\\\.|[^\"\\\\])*)\""
  if [[ "$payload" =~ $regex ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# 下列 helper 一律把結果寫進 REPLY（不 printf），呼叫端不需 $()——每次 $() 都要 fork，會吃掉 20 ms 預算。
# spool 目錄／檔名編碼：安全字元原樣，其餘每個字元編成 _uXXXX（Unicode 碼位；可逆、不同 id 不會碰撞）。
# 依賴 UTF-8 locale 取碼位（腳本開頭已固定 LC_ALL=C.UTF-8）。
sanitize_segment() {
  local value="$1" out='' ch cp i
  for ((i = 0; i < ${#value}; i++)); do
    ch="${value:i:1}"
    case "$ch" in
      [ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-])
        out+="$ch" ;;
      *)
        printf -v cp '%04x' "'$ch"
        out+="_u${cp}" ;;
    esac
  done
  if [[ "$out" == .* ]]; then
    while [[ "$out" == .* ]]; do
      out="${out#.}"
    done
    out="_${out}"
  fi
  if [[ -z "$out" || "$out" == "." || "$out" == ".." ]]; then
    REPLY='unknown'
  else
    REPLY="$out"
  fi
}

# JSON 字串解碼（單趟；\uXXXX 含 surrogate pair；孤立 surrogate → U+FFFD；未知跳脫保留原樣）。
json_unescape() {
  local rest="$1" out='' ch hex hex2 cp lo hex8
  while [[ "$rest" == *\\* ]]; do
    out+="${rest%%\\*}"
    rest="${rest#*\\}"
    ch="${rest:0:1}"
    rest="${rest:1}"
    case "$ch" in
      u)
        hex="${rest:0:4}"
        if [[ "$hex" =~ ^[0-9A-Fa-f]{4}$ ]]; then
          rest="${rest:4}"
          cp=$((16#$hex))
          if (( cp >= 0xD800 && cp <= 0xDBFF )) && [[ "${rest:0:2}" == '\u' ]]; then
            hex2="${rest:2:4}"
            if [[ "$hex2" =~ ^[0-9A-Fa-f]{4}$ ]]; then
              lo=$((16#$hex2))
              if (( lo >= 0xDC00 && lo <= 0xDFFF )); then
                rest="${rest:6}"
                cp=$(( 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00) ))
              fi
            fi
          fi
          if (( cp >= 0xD800 && cp <= 0xDFFF )); then
            cp=$((0xFFFD))
          fi
          printf -v hex8 '%08x' "$cp"
          printf -v ch "\\U${hex8}"
        else
          ch='\u'
        fi
        ;;
      n) ch=$'\n' ;;
      r) ch=$'\r' ;;
      t) ch=$'\t' ;;
      b) ch=$'\b' ;;
      f) ch=$'\f' ;;
      '"' | '/' | \\) ;;
      '') ch='\' ;;
      *) ch="\\${ch}" ;;
    esac
    out+="$ch"
  done
  out+="$rest"
  REPLY="$out"
}

strip_trailing_slashes() {
  local value="$1"
  while [[ "$value" == */ && "$value" != '/' ]]; do
    value="${value%/}"
  done
  REPLY="$value"
}

# 對齊 src/services/projects.ts findRepoRoot：`.git/HEAD` 或 `.git` 一般檔（gitdir: 開頭，worktree）。
find_repo_root() {
  local dir i first
  strip_trailing_slashes "$1"
  dir="$REPLY"
  [[ -z "$dir" ]] && dir='/'
  for ((i = 0; i < 64; i++)); do
    if [[ -f "$dir/.git/HEAD" ]]; then
      REPLY="$dir"
      return 0
    fi
    if [[ -f "$dir/.git" ]]; then
      first=''
      IFS= read -r first <"$dir/.git" 2>/dev/null || true
      first="${first#"${first%%[![:space:]]*}"}"
      if [[ "$first" == gitdir:* ]]; then
        REPLY="$dir"
        return 0
      fi
    fi
    [[ "$dir" == '/' ]] && return 1
    dir="${dir%/*}"
    [[ -z "$dir" ]] && dir='/'
  done
  return 1
}

# 對齊 tryReadClaudeMdMarker：從 cwd 往上到 repo root 為止，取最近 CLAUDE.md 的第一個 marker；
# 值 trim 後為空 → 視同無 marker（對齊 nonEmpty）。只讀一般檔且最多 64 KiB（FIFO／裝置檔／超大檔不讀）。
read_claude_md_marker() {
  local dir root="$2" i content candidate value
  strip_trailing_slashes "$1"
  dir="$REPLY"
  [[ -z "$dir" ]] && dir='/'
  local marker_regex='<!--[[:space:]]*cc-memory:[[:space:]]*project="([^"]+)"[[:space:]]*-->'
  for ((i = 0; i < 64; i++)); do
    candidate="$dir/CLAUDE.md"
    if [[ -f "$candidate" && -r "$candidate" ]]; then
      content=''
      IFS= read -r -d '' -N 65536 content <"$candidate" 2>/dev/null || true
      if [[ "$content" =~ $marker_regex ]]; then
        value="${BASH_REMATCH[1]}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        if [[ -n "$value" ]]; then
          REPLY="$value"
          return 0
        fi
        return 1
      fi
    fi
    [[ "$dir" == "$root" || "$dir" == '/' ]] && return 1
    dir="${dir%/*}"
    [[ -z "$dir" ]] && dir='/'
  done
  return 1
}

# project_id：CLAUDE.md marker → git 根目錄名 → cwd 目錄名 → unknown。
# 刻意不做 resolveProjectId 的 git origin owner/repo 層（需 spawn git；既有 corpus 皆為目錄名）。
# 回傳原始字串（含非 ASCII）；spool 目錄名另外經 sanitize_segment。
resolve_project_id() {
  local cwd root base
  strip_trailing_slashes "$1"
  cwd="$REPLY"
  if [[ -n "$cwd" ]] && find_repo_root "$cwd"; then
    root="$REPLY"
    if read_claude_md_marker "$cwd" "$root" && [[ -n "$REPLY" ]]; then
      return 0
    fi
    base="${root##*/}"
  else
    base="${cwd##*/}"
  fi
  if [[ -z "$base" ]]; then
    REPLY='unknown'
  else
    REPLY="$base"
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
