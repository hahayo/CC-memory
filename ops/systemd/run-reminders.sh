#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(dirname "$(dirname "$script_dir")")"
personal_url_file="${CC_MEMORY_PERSONAL_URL_FILE:-${HOME}/.ccm-personal-url}"

if [[ ! -f "$personal_url_file" ]]; then
  echo "[cc-memory-reminders] personal DB URL file not found: $personal_url_file" >&2
  exit 1
fi
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "[cc-memory-reminders] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required" >&2
  exit 1
fi

DATABASE_URL_PERSONAL="$(<"$personal_url_file")"
if [[ -z "$DATABASE_URL_PERSONAL" ]]; then
  echo "[cc-memory-reminders] personal DB URL file is empty: $personal_url_file" >&2
  exit 1
fi
export DATABASE_URL_PERSONAL
export CC_FORCE_PROJECT_ID=__personal__

exec /usr/bin/env node \
  "$repo_root/node_modules/tsx/dist/cli.mjs" \
  "$repo_root/scripts/hermes-reminder-poll.ts"
