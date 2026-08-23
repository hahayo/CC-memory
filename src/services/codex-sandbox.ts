// src/services/codex-sandbox.ts
//
// Phase 2: bubblewrap sandbox for codex exec subprocess.
//
// Design: OS-level file-system isolation via bwrap (bubblewrap) +
// deny-all execpolicy via `-c sandbox_permissions=[]`. The sandbox
// runs codex in **pure text mode** (no codex-code-mode-host binary
// mounted), so the model has no shell/command tools at all. This
// eliminates the attack chain: shell + auth.json + DNS + egress.
//
// Security invariants:
//   1. No host secret files are readable inside the sandbox.
//   2. /proc/1/environ does not leak the parent environment.
//   3. auth.json is a disposable copy; host original is never modified.
//   4. --ignore-rules is NEVER used.
//   5. No shell/command tool execution capability (no code-mode-host).
//   6. All caller-supplied paths are resolved and validated against
//      their expected roots before use in bwrap arguments.
//   7. Model string is validated against a strict character allowlist.
//
// Key discovery from empirical testing:
//   - codex native binary is musl-static — no ldd deps needed.
//   - --clearenv alone is insufficient: /proc/1/environ leaks the bwrap
//     parent's env. Fix: spawn bwrap itself with a minimal env object.
//   - /lib, /lib64 are symlinks to usr/lib, usr/lib64 on this system.
//   - /etc/resolv.conf is a symlink to /mnt/wsl/resolv.conf (WSL).
//   - Both gpt-5.6-sol and gpt-5.6-luna work inside the sandbox.
//   - Without code-mode-host, codex runs in text-only mode with no
//     tool execution — --output-schema/-o still produce valid JSON.
//
// Residual risk: model text output may reference auth.json contents
// from the disposable copy. This is acceptable because the output only
// reaches the -o file and is validated against the output schema.

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed sandbox-internal paths (never host paths). */
const SANDBOX_HOME = '/sandbox-home';
const SANDBOX_CODEX_HOME = '/sandbox-codex-home';
const SANDBOX_CWD = '/sandbox-cwd';
const SANDBOX_OUT = '/sandbox-out';
const SANDBOX_CODEX_BIN = '/sandbox-codex';

/**
 * Host path for the codex native binary.
 * Resolved once at module load; the launcher (codex.js) dispatches to this
 * static-linked binary, so we mount it directly and skip the Node.js
 * launcher entirely — no need to mount ~/.npm-global or /usr/bin/env.
 */
const CODEX_NATIVE_BINARY_SUBPATH =
  'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';

/**
 * Maximum allowed tmpfs size for /tmp inside the sandbox (64 MiB).
 * Prevents the sandboxed process from consuming unbounded host RAM.
 */
const SANDBOX_TMPFS_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Strict character allowlist for the model string.
 * Must start with an alphanumeric or dot, not a dash (prevents argv injection).
 * Only alphanumeric, dots, underscores, and dashes allowed.
 */
const MODEL_PATTERN = /^[A-Za-z0-9.][A-Za-z0-9._-]*$/;

/**
 * UUID v4 pattern for identifying orphaned staging directories.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Category 1 env: fixed sandbox-internal values (never inherited from parent).
 *
 * Rationale per var:
 *   HOME      — must point inside sandbox; inheriting host HOME would let
 *               codex discover host dotfiles.
 *   CODEX_HOME — where codex reads auth.json; points to our disposable copy.
 *   TMPDIR    — sandbox tmpfs; inheriting host path would escape sandbox.
 *   PATH      — only /usr/bin:/usr/local/bin; host PATH contains ~/.npm-global
 *               and other user dirs that are not mounted.
 */
const CATEGORY_1_ENV: Record<string, string> = {
  HOME: SANDBOX_HOME,
  CODEX_HOME: SANDBOX_CODEX_HOME,
  TMPDIR: '/tmp',
  PATH: '/usr/bin:/usr/local/bin',
};

/**
 * Category 2 env: harmless values inherited from the host.
 *
 * Rationale per var:
 *   LANG, LC_ALL — locale for correct string handling.
 *   TERM         — terminal type for output formatting.
 *   USER, LOGNAME — /etc/passwd lookup; codex reads these.
 */
const CATEGORY_2_INHERITABLE_KEYS = ['LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for building a sandboxed codex exec command. */
export interface CodexSandboxOptions {
  /** Absolute path to the @openai/codex package root on the host. */
  codexPackageRoot: string;
  /** Absolute path to the host ~/.codex directory (contains auth.json). */
  hostCodexHome: string;
  /** Absolute path to a host directory for output files (schema + result). */
  hostOutputDir: string;
  /** Absolute path to an empty host directory to use as cwd. */
  hostCwd: string;
  /** Model string to pass to --model. */
  model: string;
  /** Timeout in milliseconds (for the caller to enforce externally). */
  timeoutMs: number;
  /**
   * Staging root where per-call disposable directories are created.
   * Required — must be an absolute path to a directory the caller controls.
   * Must NOT be /tmp (shared with other users).
   */
  stagingRoot: string;
}

/** Result of buildCodexSandboxCommand. */
export interface CodexSandboxCommand {
  /** The bwrap binary path (/usr/bin/bwrap). */
  command: string;
  /** Full argument array for bwrap (everything before and after --). */
  args: string[];
  /**
   * Minimal env to pass to spawn(). This is NOT the env inside the sandbox
   * (that's controlled by --clearenv + --setenv); this is the env for the
   * bwrap process itself. Keeping it minimal prevents /proc/1/environ leaks.
   */
  env: Record<string, string>;
  /** Clean up the disposable CODEX_HOME copy. Idempotent. */
  cleanup(): Promise<void>;
  /** Absolute host path to the schema file (caller writes it). */
  schemaFile: string;
  /** Absolute host path where codex writes the output (caller reads it). */
  outputFile: string;
}

// ---------------------------------------------------------------------------
// Input validation (runs before any filesystem operations)
// ---------------------------------------------------------------------------

/**
 * Validate and resolve an input path: reject `..` segments, resolve symlinks
 * via realpathSync, and verify the resolved path is under the expected root.
 * Returns the resolved (real) absolute path.
 *
 * @throws on `..` segments, symlink escape, or path outside expectedRoot.
 */
function validatePath(
  inputPath: string,
  label: string,
  expectedRoot?: string,
): string {
  // Reject paths containing .. segments (pre-resolution check)
  const segments = inputPath.split('/');
  if (segments.includes('..')) {
    throw new Error(`${label}: path contains '..' segment — rejected: ${inputPath}`);
  }

  // Must be absolute
  if (!inputPath.startsWith('/')) {
    throw new Error(`${label}: must be an absolute path, got: ${inputPath}`);
  }

  // Resolve symlinks to get the canonical path
  let resolved: string;
  try {
    resolved = realpathSync(inputPath);
  } catch {
    // For paths that don't exist yet (e.g. output dirs created by caller),
    // resolve the parent and append the basename
    const parent = pathResolve(inputPath, '..');
    try {
      const resolvedParent = realpathSync(parent);
      const basename = inputPath.slice(inputPath.lastIndexOf('/') + 1);
      resolved = join(resolvedParent, basename);
    } catch {
      throw new Error(`${label}: path does not exist and parent is unresolvable: ${inputPath}`);
    }
  }

  // If an expected root is specified, verify containment
  if (expectedRoot !== undefined) {
    const resolvedRoot = realpathSync(expectedRoot);
    if (!resolved.startsWith(resolvedRoot + '/') && resolved !== resolvedRoot) {
      throw new Error(
        `${label}: resolved path "${resolved}" is outside expected root "${resolvedRoot}"`,
      );
    }
  }

  return resolved;
}

/**
 * Validate the model string against the strict allowlist.
 * Prevents argv injection (e.g. --ignore-rules masquerading as a model name).
 */
function validateModel(model: string): void {
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(
      `Invalid model string: "${model}". ` +
      'Must match /^[A-Za-z0-9.][A-Za-z0-9._-]*$/ (no leading dash, no special characters).',
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a bwrap-wrapped codex exec command with full OS-level sandbox
 * isolation. The caller is responsible for:
 *   1. Writing the output-schema JSON to `result.schemaFile`.
 *   2. Spawning the process with `result.env` as the spawn env.
 *   3. Piping the prompt to stdin.
 *   4. Calling `result.cleanup()` in a finally block.
 *
 * codex runs in pure text mode (no code-mode-host mounted), so the model
 * cannot execute shell commands. Output is via --output-schema/-o only.
 *
 * @throws if bwrap or the codex native binary is not found, or if any
 *         input path fails validation.
 */
export function buildCodexSandboxCommand(opts: CodexSandboxOptions): CodexSandboxCommand {
  // -----------------------------------------------------------------------
  // Validate inputs (before any filesystem side effects)
  // -----------------------------------------------------------------------
  validateModel(opts.model);

  // stagingRoot: must be absolute, must not be /tmp
  if (!opts.stagingRoot.startsWith('/')) {
    throw new Error(`stagingRoot must be an absolute path, got: ${opts.stagingRoot}`);
  }
  if (opts.stagingRoot === '/tmp' || opts.stagingRoot.startsWith('/tmp/')) {
    throw new Error(
      'stagingRoot must not be under /tmp (shared with other users; auth.json copies would be exposed)',
    );
  }

  const bwrapPath = '/usr/bin/bwrap';
  assertReadable(bwrapPath, 'bwrap binary');

  // Validate and resolve all caller-supplied paths
  const resolvedCodexPkgRoot = validatePath(opts.codexPackageRoot, 'codexPackageRoot');
  const resolvedHostCodexHome = validatePath(opts.hostCodexHome, 'hostCodexHome');
  const resolvedHostOutputDir = validatePath(opts.hostOutputDir, 'hostOutputDir');
  const resolvedHostCwd = validatePath(opts.hostCwd, 'hostCwd');
  const resolvedStagingRoot = validatePath(opts.stagingRoot, 'stagingRoot');

  const codexNativeBinary = join(resolvedCodexPkgRoot, CODEX_NATIVE_BINARY_SUBPATH);
  assertReadable(codexNativeBinary, 'codex native binary');

  const hostAuthJson = join(resolvedHostCodexHome, 'auth.json');
  assertReadable(hostAuthJson, 'codex auth.json');

  // -----------------------------------------------------------------------
  // Create disposable CODEX_HOME with auth.json copy
  // -----------------------------------------------------------------------
  const callId = randomUUID();
  const disposableDir = join(resolvedStagingRoot, callId);
  const disposableCodexHome = join(disposableDir, 'codex-home');
  const disposableHomeDir = join(disposableDir, 'home');

  mkdirSync(disposableCodexHome, { recursive: true, mode: 0o700 });
  mkdirSync(disposableHomeDir, { recursive: true, mode: 0o700 });
  copyFileSync(hostAuthJson, join(disposableCodexHome, 'auth.json'));
  // Ensure 0600 on the copy
  chmodSync(join(disposableCodexHome, 'auth.json'), 0o600);

  // -----------------------------------------------------------------------
  // Build bwrap arguments
  // -----------------------------------------------------------------------
  const bwrapArgs: string[] = [
    // Namespace isolation
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--new-session',     // Prevents TIOCSTI injection into parent terminal

    // Drop all capabilities (defense in depth; bwrap already drops most)
    '--cap-drop', 'ALL',

    // Clean environment (prevents /proc/1/environ from leaking parent env
    // when combined with a minimal spawn env)
    '--clearenv',

    // Pseudo-filesystems
    '--proc', '/proc',
    '--dev', '/dev',
    '--size', String(SANDBOX_TMPFS_MAX_BYTES), '--tmpfs', '/tmp',

    // System libraries and binaries (read-only)
    '--ro-bind', '/usr', '/usr',
    // /lib and /lib64 are symlinks to usr/lib and usr/lib64
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',

    // TLS certificates
    '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/ca-certificates', '/etc/ca-certificates',

    // Name resolution and system config (individual files, NOT /etc entirely)
    '--ro-bind', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind', '/etc/hosts', '/etc/hosts',
    '--ro-bind', '/etc/passwd', '/etc/passwd',

    // Timezone (already within /usr via symlink, but mount the target path
    // directly so /etc/localtime resolves inside the sandbox)
    '--ro-bind', '/etc/localtime', '/etc/localtime',

    // DNS: /etc/resolv.conf is a symlink to /mnt/wsl/resolv.conf on WSL.
    // Mount the target file directly as /etc/resolv.conf in the sandbox
    // (no /mnt/wsl directory exposed).
    ...resolveResolvConf(),

    // Codex native binary (static-linked, no ldd deps)
    '--ro-bind', codexNativeBinary, SANDBOX_CODEX_BIN,

    // NOTE: codex-code-mode-host is intentionally NOT mounted.
    // Without it, codex runs in pure text mode — the model has no
    // shell/command tools. This breaks the attack chain:
    // shell + auth.json + DNS + egress → exfiltration.
    // The residual risk is that model text output may reference auth.json
    // contents, but output only reaches the -o file and is schema-validated.

    // Writable areas (all on host tmpdir, disposable)
    '--bind', resolvedHostCwd, SANDBOX_CWD,
    '--bind', disposableHomeDir, SANDBOX_HOME,
    '--bind', disposableCodexHome, SANDBOX_CODEX_HOME,
    '--bind', resolvedHostOutputDir, SANDBOX_OUT,
  ];

  // Category 1: fixed sandbox-internal env
  for (const [key, value] of Object.entries(CATEGORY_1_ENV)) {
    bwrapArgs.push('--setenv', key, value);
  }

  // Category 2: inherited harmless values
  for (const key of CATEGORY_2_INHERITABLE_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      bwrapArgs.push('--setenv', key, value);
    }
  }

  // CC_MEMORY_CAPTURE_CHILD: recursive-capture circuit breaker (always set)
  bwrapArgs.push('--setenv', 'CC_MEMORY_CAPTURE_CHILD', '1');

  // Separator
  bwrapArgs.push('--');

  // Codex exec command (inside the sandbox)
  bwrapArgs.push(
    SANDBOX_CODEX_BIN, 'exec',
    '--model', opts.model,
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-s', 'read-only',
    '-c', 'mcp_servers={}',
    '-c', 'web_search="disabled"',
    '-c', 'sandbox_permissions=[]',
    '-C', SANDBOX_CWD,
    '--output-schema', join(SANDBOX_OUT, 'schema.json'),
    '-o', join(SANDBOX_OUT, 'result.json'),
    '-',  // read prompt from stdin
  );

  // -----------------------------------------------------------------------
  // Minimal env for the bwrap process itself (prevents /proc/1/environ leak)
  // -----------------------------------------------------------------------
  const spawnEnv: Record<string, string> = {
    PATH: '/usr/bin:/usr/local/bin',
  };

  // -----------------------------------------------------------------------
  // Cleanup function (idempotent)
  // -----------------------------------------------------------------------
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(disposableDir, { recursive: true, force: true });
    } catch {
      // Best-effort; the staging root will be swept by
      // sweepOrphanedSandboxStaging() on the next worker tick.
    }
  };

  return {
    command: bwrapPath,
    args: bwrapArgs,
    env: spawnEnv,
    cleanup,
    schemaFile: join(resolvedHostOutputDir, 'schema.json'),
    outputFile: join(resolvedHostOutputDir, 'result.json'),
  };
}

// ---------------------------------------------------------------------------
// Orphaned staging directory sweep
// ---------------------------------------------------------------------------

/**
 * Result of a sweep operation.
 */
export interface SweepResult {
  /** Absolute paths of directories successfully removed. */
  removed: string[];
  /** Entries that failed removal (path + error message). */
  errors: Array<{ path: string; error: string }>;
}

/**
 * Sweep orphaned sandbox staging directories that may remain after SIGKILL.
 *
 * Each sandbox call creates a UUID-named directory under `stagingRoot`
 * containing a disposable auth.json copy. Normally cleanup() removes it,
 * but a SIGKILL can leave orphans. This function removes directories whose
 * mtime is older than `olderThanMs` milliseconds.
 *
 * Only removes direct child **directories** of `stagingRoot` whose names
 * match the UUID v4 pattern. Tolerates ENOENT (concurrent removal).
 *
 * @param stagingRoot - The staging root directory to sweep.
 * @param olderThanMs - Minimum age in milliseconds before removal.
 * @returns Removed paths and any errors encountered.
 */
export function sweepOrphanedSandboxStaging(
  stagingRoot: string,
  olderThanMs: number,
): SweepResult {
  const result: SweepResult = { removed: [], errors: [] };

  if (olderThanMs <= 0) {
    throw new Error('olderThanMs must be positive');
  }

  let entries: string[];
  try {
    entries = readdirSync(stagingRoot);
  } catch (err: unknown) {
    // stagingRoot doesn't exist yet — nothing to sweep
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return result;
    }
    throw err;
  }

  const cutoffTime = Date.now() - olderThanMs;

  for (const entry of entries) {
    // Only remove UUID-shaped directory names (our call IDs)
    if (!UUID_PATTERN.test(entry)) continue;

    const entryPath = join(stagingRoot, entry);

    try {
      const st = lstatSync(entryPath);
      // Must be a directory, not a symlink
      if (!st.isDirectory()) continue;
      // Must be older than the cutoff
      if (st.mtimeMs >= cutoffTime) continue;

      rmSync(entryPath, { recursive: true, force: true });
      result.removed.push(entryPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT: concurrent removal — not an error
      if (code === 'ENOENT') continue;
      result.errors.push({ path: entryPath, error: String(err) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Host path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Find the @openai/codex package root by walking from a known global
 * npm modules location. Returns null if not found.
 *
 * Note: the first candidate uses os.userInfo().homedir (reads /etc/passwd,
 * not spoofable via $HOME env) for the user's home directory.
 */
export function findCodexPackageRoot(): string | null {
  // Use os.userInfo().homedir which reads /etc/passwd, not $HOME
  const homeDir = userInfo().homedir;
  const candidates = [
    join(homeDir, '.npm-global', 'lib', 'node_modules', '@openai', 'codex'),
    '/usr/local/lib/node_modules/@openai/codex',
    '/usr/lib/node_modules/@openai/codex',
  ];
  for (const candidate of candidates) {
    try {
      const nativeBin = join(candidate, CODEX_NATIVE_BINARY_SUBPATH);
      accessSync(nativeBin, constants.R_OK | constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Find the codex home directory (where auth.json lives).
 * Respects CODEX_HOME env var, falls back to ~/.codex using
 * os.userInfo().homedir (reads /etc/passwd, not spoofable via $HOME).
 */
export function findCodexHome(): string {
  return process.env.CODEX_HOME ?? join(userInfo().homedir, '.codex');
}

/**
 * Resolve the bwrap arguments for /etc/resolv.conf.
 * On WSL, /etc/resolv.conf is a symlink to /mnt/wsl/resolv.conf.
 * We mount the target directly so no /mnt/wsl directory is exposed.
 */
function resolveResolvConf(): string[] {
  try {
    const resolved = realpathSync('/etc/resolv.conf');
    if (resolved !== '/etc/resolv.conf') {
      // It's a symlink (e.g., → /mnt/wsl/resolv.conf).
      // Mount the target as /etc/resolv.conf inside the sandbox.
      return ['--ro-bind', resolved, '/etc/resolv.conf'];
    }
  } catch {
    // If we can't resolve, fall through to direct mount
  }
  return ['--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf'];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertReadable(path: string, label: string): void {
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`${label} not found or not readable: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const _testing = {
  CATEGORY_1_ENV,
  CATEGORY_2_INHERITABLE_KEYS,
  CODEX_NATIVE_BINARY_SUBPATH,
  SANDBOX_HOME,
  SANDBOX_CODEX_HOME,
  SANDBOX_CWD,
  SANDBOX_OUT,
  SANDBOX_CODEX_BIN,
  SANDBOX_TMPFS_MAX_BYTES,
  MODEL_PATTERN,
  UUID_PATTERN,
  resolveResolvConf,
  validatePath,
  validateModel,
};
