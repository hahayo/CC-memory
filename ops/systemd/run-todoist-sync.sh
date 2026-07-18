#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(dirname "$(dirname "$script_dir")")"
personal_url_file="${CC_MEMORY_PERSONAL_URL_FILE:-${HOME}/.ccm-personal-url}"
todoist_token_file="${CC_MEMORY_TODOIST_TOKEN_FILE:-${HOME}/.ccm-todoist-token}"

if [[ ! -f "$personal_url_file" ]]; then
  echo "[cc-memory-todoist-sync] personal DB URL file not found: $personal_url_file" >&2
  exit 1
fi
if [[ ! -f "$todoist_token_file" ]]; then
  echo "[cc-memory-todoist-sync] Todoist token file not found: $todoist_token_file" >&2
  exit 1
fi

DATABASE_URL_PERSONAL="$(<"$personal_url_file")"
TODOIST_API_TOKEN="$(<"$todoist_token_file")"
if [[ -z "$DATABASE_URL_PERSONAL" ]]; then
  echo "[cc-memory-todoist-sync] personal DB URL file is empty: $personal_url_file" >&2
  exit 1
fi
if [[ -z "$TODOIST_API_TOKEN" ]]; then
  echo "[cc-memory-todoist-sync] Todoist token file is empty: $todoist_token_file" >&2
  exit 1
fi
export DATABASE_URL_PERSONAL TODOIST_API_TOKEN
export CC_FORCE_PROJECT_ID=__personal__

exec /usr/bin/env node \
  "$repo_root/node_modules/tsx/dist/cli.mjs" \
  "$repo_root/scripts/todoist-sync-poll.ts"
