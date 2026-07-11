#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT="$REPO_ROOT/skills"
PROJECTS_ROOT="$(cd "$REPO_ROOT/.." && pwd)"

SKILLS=(setup-decision-wiki save-decision)
MODE=check
MODE_WAS_SET=false
CLAUDE_ROOT="${DECISION_SKILLS_CLAUDE_ROOT:-$HOME/.claude/skills}"
CODEX_ROOT="${DECISION_SKILLS_CODEX_ROOT:-${CODEX_HOME:-$HOME/.codex}/skills}"
PORT_ROOT="${DECISION_SKILLS_PORT_ROOT:-$PROJECTS_ROOT/doc/claude-codex-port/skills}"
BACKUP_ROOT="${DECISION_SKILLS_BACKUP_ROOT:-$HOME/backups/decision-skills}"
TIMESTAMP="${DECISION_SKILLS_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"

usage() {
  cat <<'EOF'
Usage: install-decision-skills.sh [--check|--install] [options]

Modes:
  --check                 Compare canonical and installed tree hashes (default).
  --install               Back up drifted copies, then install canonical skills.

Options:
  --claude-root DIR       Claude Code skills root (default: ~/.claude/skills).
  --codex-root DIR        Codex skills root (default: $CODEX_HOME/skills or ~/.codex/skills).
  --port-root DIR         Compatibility mirror skills root.
  --backup-root DIR       Backup root (default: ~/backups/decision-skills).
  -h, --help              Show this help.
EOF
}

die() {
  echo "error: $*" >&2
  exit 2
}

set_mode() {
  local requested=$1
  if [[ "$MODE_WAS_SET" == true && "$MODE" != "$requested" ]]; then
    die 'choose only one of --check or --install'
  fi
  MODE=$requested
  MODE_WAS_SET=true
}

require_value() {
  local option=$1
  local value=${2-}
  [[ -n "$value" ]] || die "$option requires a directory"
}

while (($# > 0)); do
  case "$1" in
    --check)
      set_mode check
      shift
      ;;
    --install)
      set_mode install
      shift
      ;;
    --claude-root)
      require_value "$1" "${2-}"
      CLAUDE_ROOT=$2
      shift 2
      ;;
    --codex-root)
      require_value "$1" "${2-}"
      CODEX_ROOT=$2
      shift 2
      ;;
    --port-root)
      require_value "$1" "${2-}"
      PORT_ROOT=$2
      shift 2
      ;;
    --backup-root)
      require_value "$1" "${2-}"
      BACKUP_ROOT=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

for command_name in find sort sha256sum cut cp mv mkdir date readlink stat; do
  command -v "$command_name" >/dev/null || die "required command not found: $command_name"
done

tree_hash() {
  local directory=$1
  local entry relative_path mode
  [[ -d "$directory" ]] || return 1

  (
    cd "$directory"
    while IFS= read -r -d '' entry; do
      relative_path=${entry#./}
      if [[ -L "$entry" ]]; then
        printf 'symlink\0%s\0%s\0' "$relative_path" "$(readlink "$entry")"
      elif [[ -d "$entry" ]]; then
        mode=$(stat -c '%a' "$entry")
        printf 'directory\0%s\0%s\0' "$relative_path" "$mode"
      elif [[ -f "$entry" ]]; then
        mode=$(stat -c '%a' "$entry")
        printf 'file\0%s\0%s\0' "$relative_path" "$mode"
        sha256sum "$entry" | cut -d ' ' -f 1
      else
        echo "unsupported skill entry: $entry" >&2
        return 1
      fi
    done < <(find . -mindepth 1 -print0 | LC_ALL=C sort -z)
  ) | sha256sum | cut -d ' ' -f 1
}

destination_exists() {
  [[ -e "$1" || -L "$1" ]]
}

declare -A SOURCE_HASHES=()
for skill in "${SKILLS[@]}"; do
  source_directory="$SOURCE_ROOT/$skill"
  [[ -f "$source_directory/SKILL.md" ]] \
    || die "canonical skill is missing SKILL.md: $source_directory"
  SOURCE_HASHES[$skill]="$(tree_hash "$source_directory")" \
    || die "cannot hash canonical skill: $source_directory"
done

TARGET_LABELS=(claude codex port)
TARGET_ROOTS=("$CLAUDE_ROOT" "$CODEX_ROOT" "$PORT_ROOT")

check_installation() {
  local failures=0
  local index label root skill destination destination_hash source_hash

  for index in "${!TARGET_ROOTS[@]}"; do
    label=${TARGET_LABELS[$index]}
    root=${TARGET_ROOTS[$index]}
    for skill in "${SKILLS[@]}"; do
      destination="$root/$skill"
      source_hash=${SOURCE_HASHES[$skill]}
      if ! destination_exists "$destination"; then
        echo "missing: $label/$skill ($destination)" >&2
        failures=1
        continue
      fi
      if [[ ! -d "$destination" ]]; then
        echo "drift: $label/$skill is not a directory ($destination)" >&2
        failures=1
        continue
      fi
      if ! destination_hash="$(tree_hash "$destination")"; then
        echo "drift: cannot hash $label/$skill ($destination)" >&2
        failures=1
        continue
      fi
      if [[ "$destination_hash" != "$source_hash" ]]; then
        echo "drift: $label/$skill source=$source_hash destination=$destination_hash" >&2
        failures=1
        continue
      fi
      echo "ok: $label/$skill $source_hash"
    done
  done

  ((failures == 0))
}

if [[ "$MODE" == check ]]; then
  check_installation
  exit $?
fi

[[ "$TIMESTAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
  || die 'DECISION_SKILLS_TIMESTAMP must use YYYYMMDDTHHMMSSZ'

for root in "${TARGET_ROOTS[@]}"; do
  mkdir -p "$root"
done

CHANGE_LABELS=()
CHANGE_SKILLS=()
CHANGE_SOURCES=()
CHANGE_DESTINATIONS=()
CHANGE_BACKUPS=()

for index in "${!TARGET_ROOTS[@]}"; do
  label=${TARGET_LABELS[$index]}
  root=${TARGET_ROOTS[$index]}
  for skill in "${SKILLS[@]}"; do
    source_directory="$SOURCE_ROOT/$skill"
    destination="$root/$skill"
    backup=''

    if [[ -d "$destination" ]] \
      && [[ "$(tree_hash "$destination")" == "${SOURCE_HASHES[$skill]}" ]]; then
      echo "unchanged: $label/$skill"
      continue
    fi

    if destination_exists "$destination"; then
      backup="$BACKUP_ROOT/$TIMESTAMP/$label/$skill"
      destination_exists "$backup" \
        && die "backup already exists; choose a new timestamp: $backup"
    fi

    CHANGE_LABELS+=("$label")
    CHANGE_SKILLS+=("$skill")
    CHANGE_SOURCES+=("$source_directory")
    CHANGE_DESTINATIONS+=("$destination")
    CHANGE_BACKUPS+=("$backup")
  done
done

APPLIED_DESTINATIONS=()
APPLIED_BACKUPS=()
APPLIED_LABELS=()
APPLIED_SKILLS=()

rollback() {
  local status=${1:-1}
  local index destination backup failed_copy

  trap - ERR INT TERM
  set +e
  for ((index=${#APPLIED_DESTINATIONS[@]} - 1; index >= 0; index--)); do
    destination=${APPLIED_DESTINATIONS[$index]}
    backup=${APPLIED_BACKUPS[$index]}
    if destination_exists "$destination"; then
      failed_copy="$BACKUP_ROOT/$TIMESTAMP/.failed/${APPLIED_LABELS[$index]}/${APPLIED_SKILLS[$index]}"
      mkdir -p "$(dirname "$failed_copy")"
      if destination_exists "$failed_copy"; then
        failed_copy="$failed_copy.$RANDOM"
      fi
      mv "$destination" "$failed_copy"
    fi
    if [[ -n "$backup" ]] && destination_exists "$backup"; then
      mkdir -p "$(dirname "$destination")"
      mv "$backup" "$destination"
    fi
  done
  echo 'install failed; restored previous skill directories' >&2
  exit "$status"
}

trap 'rollback $?' ERR
trap 'rollback 130' INT TERM

for index in "${!CHANGE_DESTINATIONS[@]}"; do
  label=${CHANGE_LABELS[$index]}
  skill=${CHANGE_SKILLS[$index]}
  source_directory=${CHANGE_SOURCES[$index]}
  destination=${CHANGE_DESTINATIONS[$index]}
  backup=${CHANGE_BACKUPS[$index]}

  if [[ -n "$backup" ]]; then
    mkdir -p "$(dirname "$backup")"
    mv "$destination" "$backup"
    echo "backed up: $label/$skill -> $backup"
  fi

  APPLIED_DESTINATIONS+=("$destination")
  APPLIED_BACKUPS+=("$backup")
  APPLIED_LABELS+=("$label")
  APPLIED_SKILLS+=("$skill")

  cp -a "$source_directory" "$destination"
  installed_hash="$(tree_hash "$destination")"
  if [[ "$installed_hash" != "${SOURCE_HASHES[$skill]}" ]]; then
    echo "install hash mismatch: $label/$skill" >&2
    false
  fi
  echo "installed: $label/$skill $installed_hash"
done

check_installation
trap - ERR INT TERM
echo 'decision skills install complete'
