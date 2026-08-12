import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const BACKUP_SCRIPT = join(REPO_ROOT, 'ops', 'backup', 'cc-memory-backup.sh');

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

describe('encrypted R2 backup runtime', () => {
  let root: string;
  let binDir: string;
  let tmpfsDir: string;
  let remoteDir: string;
  let commandLog: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-memory-backup-runtime-'));
    binDir = join(root, 'bin');
    tmpfsDir = join(root, 'tmpfs');
    remoteDir = join(root, 'remote');
    commandLog = join(root, 'commands.log');
    mkdirSync(binDir);
    mkdirSync(tmpfsDir);
    mkdirSync(remoteDir);

    writeExecutable(join(binDir, 'fake-findmnt'), `#!/usr/bin/env bash
set -euo pipefail
printf 'findmnt %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' "${'${FAKE_FS_TYPE:-tmpfs}'}"
`);
    writeExecutable(join(binDir, 'fake-df'), `#!/usr/bin/env bash
set -euo pipefail
printf 'df %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'
printf '%s\\n' 'tmpfs 4194304 0 4194304 0% /tmpfs'
`);
    writeExecutable(join(binDir, 'fake-psql'), `#!/usr/bin/env bash
set -euo pipefail
printf 'psql %s\\n' "$*" >> "$COMMAND_LOG"
printf '1048576\\t180004\\n'
`);
    writeExecutable(join(binDir, 'fake-pg-dump'), `#!/usr/bin/env bash
set -euo pipefail
printf 'pg_dump %s\\n' "$*" >> "$COMMAND_LOG"
output=''
for arg in "$@"; do
  case "$arg" in --file=*) output="${'${arg#--file=}'}" ;; esac
done
test -n "$output"
dd if=/dev/zero of="$output" bs=2048 count=1 status=none
`);
    writeExecutable(join(binDir, 'fake-pg-restore'), `#!/usr/bin/env bash
set -euo pipefail
printf 'pg_restore %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "${'${FAIL_PG_RESTORE:-0}'}" == 1 && "$*" == *'--file=/dev/null'* ]]; then exit 9; fi
`);
    writeExecutable(join(binDir, 'fake-age'), `#!/usr/bin/env bash
set -euo pipefail
printf 'age %s\\n' "$*" >> "$COMMAND_LOG"
output=''
input=''
while (($#)); do
  case "$1" in
    -r) shift 2 ;;
    -o) output="$2"; shift 2 ;;
    *) input="$1"; shift ;;
  esac
done
test -n "$output" && test -n "$input"
printf 'age-encryption.org/v1\\n' > "$output"
cat "$input" >> "$output"
`);
    writeExecutable(join(binDir, 'fake-rclone'), `#!/usr/bin/env bash
set -euo pipefail
printf 'rclone %s\\n' "$*" >> "$COMMAND_LOG"
command="$1"
shift
case "$command" in
  copyto)
    source="$1"
    destination="$2"
    relative="${'${destination#ccmr2:}'}"
    target="$FAKE_REMOTE_DIR/$relative"
    mkdir -p "$(dirname "$target")"
    cp "$source" "$target"
    ;;
  cat)
    source="$1"
    relative="${'${source#ccmr2:}'}"
    if [[ "${'${RCLONE_TAMPER_READBACK:-0}'}" == 1 && "$source" == *.dump.age ]]; then
      printf 'tampered'
    else
      cat "$FAKE_REMOTE_DIR/$relative"
    fi
    ;;
  *)
    printf 'unexpected rclone command: %s\\n' "$command" >&2
    exit 64
    ;;
esac
`);
    writeExecutable(join(binDir, 'fake-curl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'curl alert\\n' >> "$COMMAND_LOG"
cat >/dev/null
printf '{"ok":true}\\n'
`);
    writeExecutable(join(binDir, 'fake-date'), `#!/usr/bin/env bash
set -euo pipefail
case "${'${*: -1}'}" in
  +%Y%m%dT%H%M%SZ) printf '20260812T150000Z\\n' ;;
  +%Y-%m-%dT%H:%M:%SZ) printf '2026-08-12T15:00:00Z\\n' ;;
  *) exit 64 ;;
esac
`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      COMMAND_LOG: commandLog,
      FAKE_REMOTE_DIR: remoteDir,
      CC_BACKUP_TARGET: 'project',
      CC_BACKUP_TMP_DIR: tmpfsDir,
      CC_BACKUP_RUN_SUFFIX: 'abcdef0123456789',
      CC_MEMORY_AGE_RECIPIENT:
        'age1t84j9vcpj2es3tnhrqmye945kjj9swqfaqyhdt5ulslnrcly0vrqhetl7f',
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com',
      AWS_DEFAULT_REGION: 'auto',
      CC_MEMORY_R2_BUCKET: 'cc-memory-backups',
      CC_MEMORY_ALERT_BOT_TOKEN: 'test-telegram-token',
      CC_MEMORY_ALERT_CHAT_ID: '12345',
      CC_MEMORY_REQUIRE_ALERTS: '1',
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGDATABASE: 'cc_memory',
      PGUSER: 'cc_memory_backup',
      PGPASSWORD: 'test-db-password',
      FINDMNT_BIN: join(binDir, 'fake-findmnt'),
      DF_BIN: join(binDir, 'fake-df'),
      PSQL_BIN: join(binDir, 'fake-psql'),
      PG_DUMP_BIN: join(binDir, 'fake-pg-dump'),
      PG_RESTORE_BIN: join(binDir, 'fake-pg-restore'),
      AGE_BIN: join(binDir, 'fake-age'),
      RCLONE_BIN: join(binDir, 'fake-rclone'),
      CURL_BIN: join(binDir, 'fake-curl'),
      DATE_BIN: join(binDir, 'fake-date'),
      ...overrides,
    };
  }

  function run(overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [BACKUP_SCRIPT, 'run'], {
      env: env(overrides),
      encoding: 'utf8',
    });
  }

  it('uploads a fresh encrypted dump, verifies full readback, and commits manifest last', () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('backup completed');
    const log = readFileSync(commandLog, 'utf8');
    const dumpAt = log.indexOf('pg_dump ');
    const listAt = log.indexOf('pg_restore --list');
    const fullReadAt = log.indexOf('pg_restore --file=/dev/null');
    const ageAt = log.indexOf('age ');
    const cipherUploadAt = log.indexOf('rclone copyto', ageAt);
    const readbackAt = log.indexOf('rclone cat', cipherUploadAt);
    const manifestUploadAt = log.lastIndexOf('rclone copyto');
    expect(dumpAt).toBeGreaterThanOrEqual(0);
    expect(listAt).toBeGreaterThan(dumpAt);
    expect(fullReadAt).toBeGreaterThan(listAt);
    expect(ageAt).toBeGreaterThan(fullReadAt);
    expect(cipherUploadAt).toBeGreaterThan(ageAt);
    expect(readbackAt).toBeGreaterThan(cipherUploadAt);
    expect(manifestUploadAt).toBeGreaterThan(readbackAt);

    const files = readdirSync(remoteDir, { recursive: true, withFileTypes: false })
      .map(String)
      .filter((name) => !name.endsWith('/'));
    const agePath = files.find((name) => name.endsWith('.dump.age'));
    const manifestPath = files.find((name) => name.endsWith('.manifest.json'));
    expect(agePath).toBeDefined();
    expect(manifestPath).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(remoteDir, manifestPath!), 'utf8')) as {
      schema_version: number;
      target: string;
      object_key: string;
      cipher: { bytes: number; sha256: string };
      remote_verification: { bytes: number; sha256: string };
    };
    expect(manifest).toMatchObject({
      schema_version: 1,
      target: 'project',
      object_key: expect.stringMatching(
        /^backups\/v1\/project\/2026\/08\/20260812T150000Z-abcdef0123456789\.dump\.age$/,
      ),
    });
    expect(manifest.remote_verification).toMatchObject(manifest.cipher);
    expect(readdirSync(tmpfsDir)).toEqual(['.cc-memory-backup.lock']);
  });

  it('fails before upload when full pg_restore validation fails and alerts', () => {
    const result = run({ FAIL_PG_RESTORE: '1' });

    expect(result.status).not.toBe(0);
    const log = readFileSync(commandLog, 'utf8');
    expect(log).toContain('pg_restore --file=/dev/null');
    expect(log).not.toContain('rclone ');
    expect(log).toContain('curl alert');
    expect(readdirSync(remoteDir)).toEqual([]);
    expect(readdirSync(tmpfsDir)).toEqual(['.cc-memory-backup.lock']);
  });

  it('does not upload the commit manifest when remote ciphertext readback is corrupt', () => {
    const result = run({ RCLONE_TAMPER_READBACK: '1' });

    expect(result.status).not.toBe(0);
    const remoteFiles = readdirSync(remoteDir, { recursive: true, withFileTypes: false })
      .map(String);
    expect(remoteFiles.some((name) => name.endsWith('.dump.age'))).toBe(true);
    expect(remoteFiles.some((name) => name.endsWith('.manifest.json'))).toBe(false);
    expect(readFileSync(commandLog, 'utf8')).toContain('curl alert');
  });

  it('rejects an unknown target before touching PostgreSQL', () => {
    const result = run({ CC_BACKUP_TARGET: '../personal' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CC_BACKUP_TARGET');
    expect(existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '').not.toContain(
      'pg_dump ',
    );
  });

  it('rejects a non-tmpfs work directory before creating a dump', () => {
    const result = run({ FAKE_FS_TYPE: 'ext4' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tmpfs');
    expect(readFileSync(commandLog, 'utf8')).not.toContain('pg_dump ');
  });

  it('removes orphaned run directories only after taking the exclusive backup lock', () => {
    const orphan = join(tmpfsDir, 'cc-memory-project-orphaned-run');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'plaintext.dump'), 'orphaned plaintext', 'utf8');

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(tmpfsDir)).toEqual(['.cc-memory-backup.lock']);
  });

  it('rejects an overlapping run before sweeping or touching PostgreSQL', async () => {
    const lockPath = join(tmpfsDir, '.cc-memory-backup.lock');
    const orphan = join(tmpfsDir, 'cc-memory-project-active-run');
    mkdirSync(orphan);
    const holder = spawn('flock', ['-n', lockPath, 'sleep', '10'], {
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const result = run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('already running');
      expect(existsSync(orphan)).toBe(true);
      expect(existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '').not.toContain(
        'pg_dump ',
      );
    } finally {
      holder.kill('SIGTERM');
    }
  });
});
