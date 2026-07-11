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
  [[ -d "$directory" && ! -L "$directory" ]] || return 1

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
  DECISION_SKILLS_TIMESTAMP="${DECISION_SKILLS_TIMESTAMP:-$TIMESTAMP}" \
    bash "$INSTALLER" "$@" \
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

PATH_SAFETY_FAILURES=0

record_path_safety_failure() {
  echo "PATH SAFETY FAIL: $*" >&2
  PATH_SAFETY_FAILURES=$((PATH_SAFETY_FAILURES + 1))
}

run_path_safety_case() {
  local pair=$1
  local relation=$2
  local case_name="$pair-$relation"
  local case_root="$TMP_ROOT/path-safety/$case_name"
  local state_root="$case_root/state"
  local fixture_repo="$state_root/repo"
  local fixture_installer="$fixture_repo/scripts/install-decision-skills.sh"
  local spy_bin="$case_root/spy-bin"
  local mutation_log="$case_root/mutations.log"
  local stdout_file="$case_root/stdout.log"
  local stderr_file="$case_root/stderr.log"
  local claude_root="$state_root/targets/claude"
  local codex_root="$state_root/targets/codex"
  local port_root="$state_root/targets/port"
  local backup_root="$state_root/backups"
  local before_hash after_hash status

  mkdir -p "$fixture_repo/scripts" "$state_root/targets" "$spy_bin"
  cp -a "$CANONICAL_ROOT" "$fixture_repo/skills"
  cp -a "$INSTALLER" "$fixture_installer"
  ln -s "$fixture_repo" "$state_root/repo-alias"
  ln -s "$state_root/targets" "$state_root/targets-alias"

  case "$pair:$relation" in
    source-target:same)
      claude_root="$state_root/repo-alias/skills/."
      ;;
    source-target:ancestor)
      claude_root="$state_root/repo-alias/skills/nested/../nested"
      ;;
    source-target:descendant)
      claude_root="$state_root/repo-alias"
      ;;
    target-target:same)
      claude_root="$state_root/targets/shared"
      codex_root="$state_root/targets-alias/shared/."
      ;;
    target-target:ancestor)
      claude_root="$state_root/targets/shared"
      codex_root="$state_root/targets-alias/shared/nested"
      ;;
    target-target:descendant)
      claude_root="$state_root/targets/shared/nested"
      codex_root="$state_root/targets-alias/shared"
      ;;
    backup-source:same)
      backup_root="$state_root/repo-alias/skills/."
      ;;
    backup-source:ancestor)
      backup_root="$state_root/repo-alias"
      ;;
    backup-source:descendant)
      backup_root="$state_root/repo-alias/skills/backups"
      ;;
    backup-target:same)
      claude_root="$state_root/targets/shared"
      backup_root="$state_root/targets-alias/shared/."
      ;;
    backup-target:ancestor)
      claude_root="$state_root/targets-alias/shared"
      backup_root="$state_root/targets"
      ;;
    backup-target:descendant)
      claude_root="$state_root/targets/shared"
      backup_root="$state_root/targets-alias/shared/backups"
      ;;
    *)
      fail "unknown path safety case: $case_name"
      ;;
  esac

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\\n" "mkdir $*" >> "${PATH_SAFETY_MUTATION_LOG:?}"' \
    'exit 97' \
    > "$spy_bin/mkdir"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\\n" "mv $*" >> "${PATH_SAFETY_MUTATION_LOG:?}"' \
    'exit 98' \
    > "$spy_bin/mv"
  chmod +x "$spy_bin/mkdir" "$spy_bin/mv"

  before_hash="$(tree_hash "$state_root")"
  if PATH="$spy_bin:$PATH" \
    PATH_SAFETY_MUTATION_LOG="$mutation_log" \
    DECISION_SKILLS_TIMESTAMP="$TIMESTAMP" \
    bash "$fixture_installer" --install \
      --claude-root "$claude_root" \
      --codex-root "$codex_root" \
      --port-root "$port_root" \
      --backup-root "$backup_root" \
      >"$stdout_file" 2>"$stderr_file"; then
    status=0
  else
    status=$?
  fi
  after_hash="$(tree_hash "$state_root")"

  [[ "$status" -eq 2 ]] \
    || record_path_safety_failure "$case_name exited $status instead of 2"
  grep -Fq 'unsafe path overlap:' "$stderr_file" \
    || record_path_safety_failure "$case_name did not report unsafe overlap"
  [[ ! -s "$mutation_log" ]] \
    || record_path_safety_failure \
      "$case_name attempted mutation before rejection: $(<"$mutation_log")"
  [[ "$after_hash" == "$before_hash" ]] \
    || record_path_safety_failure "$case_name changed protected state"
}

[[ -f "$INSTALLER" ]] || fail "installer missing: $INSTALLER"

for pair in source-target target-target backup-source backup-target; do
  for relation in same ancestor descendant; do
    run_path_safety_case "$pair" "$relation"
  done
done

((PATH_SAFETY_FAILURES == 0)) \
  || fail "$PATH_SAFETY_FAILURES path safety assertion(s) failed"

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

mv "$PORT_ROOT/save-decision" "$TMP_ROOT/linked-save-decision"
ln -s "$TMP_ROOT/linked-save-decision" "$PORT_ROOT/save-decision"
if installer --check >/dev/null 2>&1; then
  fail 'check unexpectedly accepted a symlinked destination root'
fi

installer --install >/dev/null
[[ -L "$BACKUP_ROOT/$TIMESTAMP/port/save-decision" ]] \
  || fail 'symlinked destination root was not preserved in backup'
assert_same_tree "$CANONICAL_ROOT/save-decision" "$PORT_ROOT/save-decision"

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

ROLLBACK_TIMESTAMP='20260711T000001Z'
FAILING_BIN="$TMP_ROOT/failing-bin"
FAILED_COPY="$BACKUP_ROOT/$ROLLBACK_TIMESTAMP/.failed/claude/setup-decision-wiki"
mkdir -p "$FAILING_BIN" "$FAILED_COPY" "$FAILED_COPY.1"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'destination="${@: -1}"' \
  'mkdir -p "$destination"' \
  'printf "%s\\n" partial > "$destination/partial.txt"' \
  'exit 42' \
  > "$FAILING_BIN/cp"
chmod +x "$FAILING_BIN/cp"

printf '%s\n' 'rollback drift' >> "$CLAUDE_ROOT/setup-decision-wiki/SKILL.md"
if PATH="$FAILING_BIN:$PATH" DECISION_SKILLS_TIMESTAMP="$ROLLBACK_TIMESTAMP" \
  installer --install >/dev/null 2>&1; then
  fail 'install unexpectedly passed with a failing copy command'
fi

grep -q 'rollback drift' "$CLAUDE_ROOT/setup-decision-wiki/SKILL.md" \
  || fail 'rollback did not restore the previous drifted skill'
[[ -f "$FAILED_COPY.2/partial.txt" ]] \
  || fail 'rollback did not choose the first free deterministic quarantine path'

DECISION_SKILLS_TIMESTAMP="$ROLLBACK_TIMESTAMP" installer --install >/dev/null
installer --check >/dev/null

echo 'install-decision-skills: PASS'
