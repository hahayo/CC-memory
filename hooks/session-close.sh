#!/usr/bin/env bash
# Local-only, best-effort. Shared by Claude Code and Codex command wrappers.
[[ -n "${CC_MEMORY_CAPTURE_CHILD:-}" ]] && exit 0
export LC_ALL=C.UTF-8
source "${BASH_SOURCE[0]%/*}/capture-common.sh" 2>/dev/null || exit 0
umask 077
payload="$(cat 2>/dev/null)"
mapfile -d '' -t fields < <(printf '%s' "$payload" | node -e '
const fs = require("node:fs");
try {
  const p = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const k of ["session_id", "transcript_path", "cwd"]) {
    if (typeof p[k] !== "string" || !p[k] || p[k].includes("\0")) process.exit(0);
  }
  process.stdout.write([p.session_id,p.transcript_path,p.cwd].join("\0")+"\0");
} catch {}
' 2>/dev/null)
[[ ${#fields[@]} == 3 ]] || exit 0
resolve_project_id "${fields[2]}"
project_id="$REPLY"
[[ "$project_id" == '__personal__' || "$project_id" == 'unknown' ]] && exit 0
sanitize_segment "$project_id"
project_dir="$REPLY"
sanitize_segment "${fields[0]}"
session_file="$REPLY"
[[ -n "${CC_MEMORY_SPOOL_DIR:-${HOME:-}}" ]] || exit 0
spool_root="${CC_MEMORY_SPOOL_DIR:-${HOME}/.cache/cc-memory/spool}"
node - "$spool_root" "$project_dir" "$session_file" "$project_id" "${fields[0]}" "${fields[1]}" <<'NODE' 2>/dev/null
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const [root, folder, name, projectId, sessionId, transcript] = process.argv.slice(2);
  const dir = path.join(root, folder);
  const spool = path.join(dir, name + '.jsonl');
  for (const p of [root, dir, spool, spool+'.close', spool+'.finalize.json']) {
    try { if (fs.lstatSync(p).isSymbolicLink()) process.exit(0); } catch {}
  }
  const size = fs.statSync(transcript).size;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(spool, JSON.stringify({project_id: projectId, session_id: sessionId,
    transcript_path: transcript, hwm_offset: size})+'\n', { mode: 0o600 });
  const marker = spool+'.finalize.json';
  const temporary = marker+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary, JSON.stringify({projectId,sessionId}), { mode: 0o600 });
  fs.renameSync(temporary, marker);
  fs.writeFileSync(spool+'.close', '', { mode: 0o600 });
} catch {}
NODE
exit 0
