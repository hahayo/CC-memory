#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

current_step='startup'
run_dir=''
run_id='unknown'
lock_fd_open=0

findmnt_bin="${FINDMNT_BIN:-findmnt}"
df_bin="${DF_BIN:-df}"
psql_bin="${PSQL_BIN:-psql}"
pg_dump_bin="${PG_DUMP_BIN:-pg_dump}"
pg_restore_bin="${PG_RESTORE_BIN:-pg_restore}"
age_bin="${AGE_BIN:-age}"
rclone_bin="${RCLONE_BIN:-rclone}"
curl_bin="${CURL_BIN:-curl}"
date_bin="${DATE_BIN:-date}"
flock_bin="${FLOCK_BIN:-flock}"

log_error() {
  printf '[cc-memory-backup] %s\n' "$*" >&2
}

send_failure_alert() {
  [[ "${CC_MEMORY_REQUIRE_ALERTS:-0}" == '1' ]] || return 0
  [[ -n "${CC_MEMORY_ALERT_BOT_TOKEN:-}" ]] || return 0
  [[ -n "${CC_MEMORY_ALERT_CHAT_ID:-}" ]] || return 0

  local api_base="${CC_MEMORY_ALERT_API_BASE:-https://api.telegram.org}"
  local message="CC-memory backup failed: target=${CC_BACKUP_TARGET:-unknown} run=${run_id} step=${current_step}"
  {
    printf 'url = "%s/bot%s/sendMessage"\n' "$api_base" "$CC_MEMORY_ALERT_BOT_TOKEN"
    printf 'request = "POST"\n'
    printf 'silent\nshow-error\nfail\n'
    printf 'data-urlencode = "chat_id=%s"\n' "$CC_MEMORY_ALERT_CHAT_ID"
    printf 'data-urlencode = "text=%s"\n' "$message"
  } | "$curl_bin" --config - >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -n "$run_dir" && -d "$run_dir" ]]; then
    rm -rf -- "$run_dir"
  fi
  if ((lock_fd_open == 1)); then
    "$flock_bin" -u 9 >/dev/null 2>&1 || true
    exec 9>&-
  fi
}

on_exit() {
  local status="$1"
  cleanup
  if ((status != 0)); then
    send_failure_alert
  fi
  exit "$status"
}
trap 'on_exit $?' EXIT

handle_signal() {
  current_step="${current_step}_interrupted"
  exit "$1"
}
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

fail() {
  log_error "$*"
  exit 1
}

require_env() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || fail "$name is required"
  done
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

file_size() {
  stat -c '%s' "$1"
}

main() {
  [[ "${1:-}" == 'run' && "$#" -eq 1 ]] || fail 'usage: cc-memory-backup.sh run'
  current_step='preflight'

  require_env \
    CC_BACKUP_TARGET CC_BACKUP_TMP_DIR CC_MEMORY_AGE_RECIPIENT \
    AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL AWS_DEFAULT_REGION \
    CC_MEMORY_R2_BUCKET PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD

  if [[ "${CC_MEMORY_REQUIRE_ALERTS:-0}" == '1' ]]; then
    require_env CC_MEMORY_ALERT_BOT_TOKEN CC_MEMORY_ALERT_CHAT_ID
  fi

  [[ "$CC_BACKUP_TARGET" == 'project' || "$CC_BACKUP_TARGET" == 'personal' ]] \
    || fail 'CC_BACKUP_TARGET must be project or personal'
  [[ "$CC_MEMORY_AGE_RECIPIENT" =~ ^age1[0-9a-z]+$ ]] \
    || fail 'CC_MEMORY_AGE_RECIPIENT is not a valid age X25519 recipient'
  [[ "$CC_MEMORY_R2_BUCKET" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] \
    || fail 'CC_MEMORY_R2_BUCKET is invalid'
  [[ "$AWS_ENDPOINT_URL" =~ ^https://[^[:space:]]+$ ]] \
    || fail 'AWS_ENDPOINT_URL must be an https URL without whitespace'
  [[ "$PGPORT" =~ ^[0-9]+$ ]] || fail 'PGPORT must be numeric'
  [[ -d "$CC_BACKUP_TMP_DIR" && ! -L "$CC_BACKUP_TMP_DIR" ]] \
    || fail 'CC_BACKUP_TMP_DIR must be a real directory'

  local fs_type
  fs_type="$($findmnt_bin -n -o FSTYPE --target "$CC_BACKUP_TMP_DIR")"
  [[ "$fs_type" == 'tmpfs' ]] || fail 'CC_BACKUP_TMP_DIR must be mounted as tmpfs'

  current_step='exclusive_lock'
  exec 9>"${CC_BACKUP_TMP_DIR%/}/.cc-memory-backup.lock"
  lock_fd_open=1
  "$flock_bin" -n 9 || fail 'another CC-memory backup is already running'

  current_step='orphan_cleanup'
  local stale_dir
  shopt -s nullglob
  for stale_dir in "${CC_BACKUP_TMP_DIR%/}"/cc-memory-*; do
    [[ -d "$stale_dir" && ! -L "$stale_dir" ]] || continue
    rm -rf -- "$stale_dir"
  done
  shopt -u nullglob

  local stamp created_at suffix
  stamp="$($date_bin -u +%Y%m%dT%H%M%SZ)"
  created_at="$($date_bin -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail 'date command returned an invalid UTC stamp'
  [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail 'date command returned an invalid UTC timestamp'
  suffix="${CC_BACKUP_RUN_SUFFIX:-}"
  if [[ -z "$suffix" ]]; then
    suffix="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  [[ "$suffix" =~ ^[0-9a-f]{16}$ ]] || fail 'CC_BACKUP_RUN_SUFFIX must be 16 lowercase hex characters'
  run_id="${stamp}-${suffix}"

  local database_evidence database_bytes postgres_version_num available_bytes required_bytes
  database_evidence="$($psql_bin \
    --no-psqlrc --tuples-only --no-align --field-separator=$'\t' \
    --command="SELECT pg_database_size(current_database()), current_setting('server_version_num')")"
  IFS=$'\t' read -r database_bytes postgres_version_num <<<"$database_evidence"
  database_bytes="${database_bytes//[[:space:]]/}"
  postgres_version_num="${postgres_version_num//[[:space:]]/}"
  [[ "$database_bytes" =~ ^[0-9]+$ && "$database_bytes" -gt 0 ]] \
    || fail 'PostgreSQL returned an invalid database size'
  [[ "$postgres_version_num" =~ ^[0-9]+$ ]] \
    || fail 'PostgreSQL returned an invalid server_version_num'
  ((postgres_version_num >= 180000)) || fail 'PostgreSQL server must be version 18 or newer'

  available_bytes="$($df_bin -Pk "$CC_BACKUP_TMP_DIR" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')"
  [[ "$available_bytes" =~ ^[0-9]+$ ]] || fail 'could not determine tmpfs free bytes'
  required_bytes=$((database_bytes * 3 + 64 * 1024 * 1024))
  ((available_bytes >= required_bytes)) \
    || fail "insufficient tmpfs capacity: available=${available_bytes} required=${required_bytes}"

  run_dir="$(mktemp -d "${CC_BACKUP_TMP_DIR%/}/cc-memory-${CC_BACKUP_TARGET}-${run_id}-XXXXXX")"
  local plain_path cipher_path readback_path manifest_path manifest_readback_path
  plain_path="$run_dir/${run_id}.dump"
  cipher_path="$run_dir/${run_id}.dump.age"
  readback_path="$run_dir/${run_id}.remote.age"
  manifest_path="$run_dir/${run_id}.manifest.json"
  manifest_readback_path="$run_dir/${run_id}.remote.manifest.json"

  current_step='pg_dump'
  [[ ! -e "$plain_path" ]] || fail 'fresh dump destination already exists'
  "$pg_dump_bin" \
    --format=custom --compress=6 --no-owner --no-privileges \
    --file="$plain_path"
  local plain_bytes minimum_dump_bytes plain_sha256
  plain_bytes="$(file_size "$plain_path")"
  minimum_dump_bytes="${CC_BACKUP_MIN_DUMP_BYTES:-1024}"
  [[ "$minimum_dump_bytes" =~ ^[0-9]+$ ]] || fail 'CC_BACKUP_MIN_DUMP_BYTES must be numeric'
  ((plain_bytes >= minimum_dump_bytes)) \
    || fail "dump is unexpectedly small: bytes=${plain_bytes} minimum=${minimum_dump_bytes}"

  current_step='pg_restore_list'
  "$pg_restore_bin" --list "$plain_path" >/dev/null
  current_step='pg_restore_full_read'
  "$pg_restore_bin" --file=/dev/null "$plain_path" >/dev/null
  plain_sha256="$(sha256_file "$plain_path")"

  current_step='age_encrypt'
  "$age_bin" -r "$CC_MEMORY_AGE_RECIPIENT" -o "$cipher_path" "$plain_path"
  local age_header
  IFS= read -r age_header < "$cipher_path"
  [[ "$age_header" == 'age-encryption.org/v1' ]] || fail 'ciphertext does not have an age v1 header'
  rm -f -- "$plain_path"

  local cipher_bytes cipher_sha256 year month object_key manifest_key
  cipher_bytes="$(file_size "$cipher_path")"
  cipher_sha256="$(sha256_file "$cipher_path")"
  year="${stamp:0:4}"
  month="${stamp:4:2}"
  object_key="backups/v1/${CC_BACKUP_TARGET}/${year}/${month}/${run_id}.dump.age"
  manifest_key="backups/v1/${CC_BACKUP_TARGET}/${year}/${month}/${run_id}.manifest.json"

  export RCLONE_CONFIG_CCMR2_TYPE='s3'
  export RCLONE_CONFIG_CCMR2_PROVIDER='Cloudflare'
  export RCLONE_CONFIG_CCMR2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  export RCLONE_CONFIG_CCMR2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_CCMR2_ENDPOINT="$AWS_ENDPOINT_URL"
  export RCLONE_CONFIG_CCMR2_REGION="$AWS_DEFAULT_REGION"
  export RCLONE_CONFIG_CCMR2_NO_CHECK_BUCKET='true'

  local remote_cipher remote_manifest remote_bytes remote_sha256
  remote_cipher="ccmr2:${CC_MEMORY_R2_BUCKET}/${object_key}"
  remote_manifest="ccmr2:${CC_MEMORY_R2_BUCKET}/${manifest_key}"
  current_step='upload_ciphertext'
  "$rclone_bin" copyto "$cipher_path" "$remote_cipher" --config /dev/null --no-traverse

  current_step='verify_ciphertext_readback'
  "$rclone_bin" cat "$remote_cipher" --config /dev/null > "$readback_path"
  remote_bytes="$(file_size "$readback_path")"
  remote_sha256="$(sha256_file "$readback_path")"
  [[ "$remote_bytes" == "$cipher_bytes" ]] || fail 'remote ciphertext size mismatch'
  [[ "$remote_sha256" == "$cipher_sha256" ]] || fail 'remote ciphertext sha256 mismatch'
  rm -f -- "$readback_path"

  local completed_at
  completed_at="$($date_bin -u +%Y-%m-%dT%H:%M:%SZ)"
  current_step='write_manifest'
  printf '%s\n' \
    '{' \
    '  "schema_version": 1,' \
    "  \"run_id\": \"${run_id}\"," \
    "  \"target\": \"${CC_BACKUP_TARGET}\"," \
    "  \"created_at\": \"${created_at}\"," \
    "  \"completed_at\": \"${completed_at}\"," \
    "  \"object_key\": \"${object_key}\"," \
    "  \"manifest_key\": \"${manifest_key}\"," \
    "  \"postgres_server_version_num\": ${postgres_version_num}," \
    '  "dump_format": "custom",' \
    "  \"plain\": { \"bytes\": ${plain_bytes}, \"sha256\": \"${plain_sha256}\" }," \
    "  \"cipher\": { \"bytes\": ${cipher_bytes}, \"sha256\": \"${cipher_sha256}\" }," \
    "  \"age_recipient\": \"${CC_MEMORY_AGE_RECIPIENT}\"," \
    "  \"remote_verification\": { \"bytes\": ${remote_bytes}, \"sha256\": \"${remote_sha256}\", \"method\": \"full-readback\" }" \
    '}' > "$manifest_path"

  current_step='upload_manifest'
  "$rclone_bin" copyto "$manifest_path" "$remote_manifest" --config /dev/null --no-traverse
  current_step='verify_manifest_readback'
  "$rclone_bin" cat "$remote_manifest" --config /dev/null > "$manifest_readback_path"
  [[ "$(sha256_file "$manifest_readback_path")" == "$(sha256_file "$manifest_path")" ]] \
    || fail 'remote manifest sha256 mismatch'

  current_step='completed'
  printf '[cc-memory-backup] backup completed: target=%s run=%s object=%s\n' \
    "$CC_BACKUP_TARGET" "$run_id" "$object_key"
}

main "$@"
