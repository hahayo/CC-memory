#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(dirname "$(dirname "$script_dir")")"
recipient_file="${CC_MEMORY_AGE_RECIPIENT_FILE:-${HOME}/.config/cc-memory/age-recipient.txt}"

if [[ ! -f "$recipient_file" || -L "$recipient_file" ]]; then
  echo "[cc-memory-backup-freshness] age recipient file must be a regular file: $recipient_file" >&2
  exit 1
fi
CC_MEMORY_AGE_RECIPIENT="$(<"$recipient_file")"
CC_MEMORY_AGE_RECIPIENT="${CC_MEMORY_AGE_RECIPIENT//$'\r'/}"
CC_MEMORY_AGE_RECIPIENT="${CC_MEMORY_AGE_RECIPIENT//$'\n'/}"
if [[ ! "$CC_MEMORY_AGE_RECIPIENT" =~ ^age1[0-9a-z]+$ ]]; then
  echo '[cc-memory-backup-freshness] age recipient file is invalid' >&2
  exit 1
fi
export CC_MEMORY_AGE_RECIPIENT
export CC_BACKUP_MAX_AGE_HOURS="${CC_BACKUP_MAX_AGE_HOURS:-26}"

exec /usr/bin/env node \
  "$repo_root/node_modules/tsx/dist/cli.mjs" \
  "$repo_root/scripts/check-backup-freshness.ts"

