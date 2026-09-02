#!/usr/bin/env bash
# CC-memory v0.5 capture hooks 共用 helper（由 post-tool-use-capture.sh 與 stop-capture-sentinel.sh source）。
# 純 bash、不 spawn 子程序；所有 helper 把結果寫進 REPLY（不 printf），呼叫端不需 $()——每次 $() 都要 fork。
# 取 Unicode 碼位需要 UTF-8 locale，呼叫端腳本開頭已固定 LC_ALL=C.UTF-8。

# spool 目錄／檔名編碼（與 src/services/capture-spool.ts sanitizeSpoolSegment 同構、可逆、不同 id 不碰撞）：
#   [A-Za-z0-9.-] 原樣；`_` 後面接 `u` 時編成 `_u005f`（否則原樣）；第一個字元若是 `.` 編成 `_u002e`；
#   其餘每個字元編成 `_uXXXX`（碼位十六進位，至少 4 位）；空字串 → `unknown`。
sanitize_segment() {
  local value="$1" out='' ch cp i n="${#1}"
  for ((i = 0; i < n; i++)); do
    ch="${value:i:1}"
    case "$ch" in
      _)
        if [[ "${value:i+1:1}" == 'u' ]]; then
          out+='_u005f'
        else
          out+='_'
        fi
        ;;
      .)
        if [[ -z "$out" ]]; then
          out+='_u002e'
        else
          out+='.'
        fi
        ;;
      [ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-])
        out+="$ch"
        ;;
      *)
        printf -v cp '%04x' "'$ch"
        out+="_u${cp}"
        ;;
    esac
  done
  if [[ -z "$out" ]]; then
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

# 對齊 src/services/projects.ts findRepoRoot：`.git/HEAD` 或 `.git` 一般檔（gitdir: 開頭，worktree）；最多往上 64 層。
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
# 值 trim 後為空 → 視同無 marker、不再往上找（對齊 nonEmpty 拒絕後落到下一層）。
# 只讀一般檔且最多 64 KiB（以 LC_ALL=C 讓 read -N 按位元組計；FIFO／裝置檔不讀）。
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
      LC_ALL=C IFS= read -r -d '' -N 65536 content <"$candidate" 2>/dev/null || true
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
# 刻意不做 resolveProjectId 的 git origin owner/repo 層（需 spawn git；既有 corpus 皆為目錄名）——
# 與 MCP server 的已知差異，見 docs/auto-capture-v0.5/memory-ops-cutover.md §4.1。
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
