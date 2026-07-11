#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install-decision-skills.sh"
CANONICAL_ROOT="$REPO_ROOT/skills"
TMP_ROOT="$(mktemp -d)"
CLAUDE_ROOT="$TMP_ROOT/claude-skills"
CODEX_ROOT="$TMP_ROOT/codex-skills"
PORT_ROOT="$TMP_ROOT/port-skills"
BACKUP_ROOT="$TMP_ROOT/backups"
TIMESTAMP="20260711T000000Z"
SKILLS=(setup-decision-wiki save-decision)

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

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
        return 1
      fi
    done < <(find . -mindepth 1 -print0 | LC_ALL=C sort -z)
  ) | sha256sum | cut -d ' ' -f 1
}

installer() {
  DECISION_SKILLS_TIMESTAMP="$TIMESTAMP" bash "$INSTALLER" "$@" \
    --claude-root "$CLAUDE_ROOT" \
    --codex-root "$CODEX_ROOT" \
    --port-root "$PORT_ROOT" \
    --backup-root "$BACKUP_ROOT"
}

assert_same_tree() {
  local expected=$1
  local actual=$2
  [[ "$(tree_hash "$expected")" == "$(tree_hash "$actual")" ]] \
    || fail "tree hash mismatch: $actual"
}

[[ -f "$INSTALLER" ]] || fail "installer missing: $INSTALLER"

if installer --check >/dev/null 2>&1; then
  fail "check unexpectedly passed with missing destinations"
fi

mkdir -p "$CLAUDE_ROOT/keep-me"
printf '%s\n' 'preserve me' > "$CLAUDE_ROOT/keep-me/value.txt"

installer --install >/dev/null

for skill in "${SKILLS[@]}"; do
  for target in "$CLAUDE_ROOT" "$CODEX_ROOT" "$PORT_ROOT"; do
    [[ -f "$target/$skill/SKILL.md" ]] || fail "missing installed $target/$skill"
    assert_same_tree "$CANONICAL_ROOT/$skill" "$target/$skill"
  done
done

[[ "$(<"$CLAUDE_ROOT/keep-me/value.txt")" == 'preserve me' ]] \
  || fail 'unrelated skill changed during install'

installer --check >/dev/null

ln -s SKILL.md "$CODEX_ROOT/setup-decision-wiki/untracked-link"
if installer --check >/dev/null 2>&1; then
  fail 'check unexpectedly ignored a destination-only symlink'
fi

installer --install >/dev/null
[[ -L "$BACKUP_ROOT/$TIMESTAMP/codex/setup-decision-wiki/untracked-link" ]] \
  || fail 'destination-only symlink was not preserved in backup'
assert_same_tree \
  "$CANONICAL_ROOT/setup-decision-wiki" \
  "$CODEX_ROOT/setup-decision-wiki"

printf '%s\n' 'manual drift' >> "$CODEX_ROOT/save-decision/SKILL.md"
if installer --check >/dev/null 2>&1; then
  fail 'check unexpectedly passed after destination drift'
fi

installer --install >/dev/null

BACKED_UP_SKILL="$BACKUP_ROOT/$TIMESTAMP/codex/save-decision"
[[ -f "$BACKED_UP_SKILL/SKILL.md" ]] || fail 'drifted skill was not backed up'
grep -q 'manual drift' "$BACKED_UP_SKILL/SKILL.md" \
  || fail 'backup does not contain the drifted copy'

for skill in "${SKILLS[@]}"; do
  for target in "$CLAUDE_ROOT" "$CODEX_ROOT" "$PORT_ROOT"; do
    assert_same_tree "$CANONICAL_ROOT/$skill" "$target/$skill"
  done
done

[[ "$(<"$CLAUDE_ROOT/keep-me/value.txt")" == 'preserve me' ]] \
  || fail 'unrelated skill changed during reinstall'

installer --check >/dev/null

echo 'install-decision-skills: PASS'
