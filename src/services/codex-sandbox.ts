// src/services/codex-sandbox.ts
//
// Phase 2: bubblewrap sandbox for codex exec subprocess.
//
// Design: OS-level file-system isolation via bwrap (bubblewrap) +
// deny-all execpolicy via `-c sandbox_permissions=[]`. The sandbox
// prevents codex (and any model-generated shell commands) from reading
// host secrets (DATABASE_URL, GEMINI_API_KEY, Telegram tokens, etc.)
// while still allowing it to function (connect to OpenAI API, read TLS
// certs, resolve DNS).
//
// Security invariants:
//   1. No host secret files are readable inside the sandbox.
//   2. /proc/1/environ does not leak the parent environment.
//   3. auth.json is a disposable copy; host original is never modified.
//   4. --ignore-rules is NEVER used.
//
// Key discovery from empirical testing:
//   - codex native binary is musl-static — no ldd deps needed.
//   - --clearenv alone is insufficient: /proc/1/environ leaks the bwrap
//     parent's env. Fix: spawn bwrap itself with a minimal env object.
//   - /lib, /lib64 are symlinks to usr/lib, usr/lib64 on this system.
//   - /etc/resolv.conf is a symlink to /mnt/wsl/resolv.conf (WSL).
//   - Both gpt-5.6-sol and gpt-5.6-luna work inside the sandbox.

import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
 * Host path suffix for the codex-code-mode-host binary.
 * Required for codex to execute shell/command tool calls. Without it,
 * codex falls back to text-only mode with no tool execution capability.
 * Mounted read-only at the fixed path /codex-code-mode-host that codex
 * probes internally.
 */
const CODEX_CODE_MODE_HOST_SUBPATH =
  'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host';

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
 *   CC_MEMORY_CAPTURE_CHILD — recursive-capture circuit breaker.
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
   * Defaults to ~/.cache/cc-memory/codex-sandbox/.
   */
  stagingRoot?: string;
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
 * @throws if bwrap or the codex native binary is not found.
 */
export function buildCodexSandboxCommand(opts: CodexSandboxOptions): CodexSandboxCommand {
  // -----------------------------------------------------------------------
  // Validate prerequisites
  // -----------------------------------------------------------------------
  const bwrapPath = '/usr/bin/bwrap';
  assertReadable(bwrapPath, 'bwrap binary');

  const codexNativeBinary = join(opts.codexPackageRoot, CODEX_NATIVE_BINARY_SUBPATH);
  assertReadable(codexNativeBinary, 'codex native binary');

  const hostAuthJson = join(opts.hostCodexHome, 'auth.json');
  assertReadable(hostAuthJson, 'codex auth.json');

  // -----------------------------------------------------------------------
  // Create disposable CODEX_HOME with auth.json copy
  // -----------------------------------------------------------------------
  const stagingRoot = opts.stagingRoot ?? join(
    process.env.HOME ?? '/tmp',
    '.cache', 'cc-memory', 'codex-sandbox',
  );
  const callId = randomUUID();
  const disposableDir = join(stagingRoot, callId);
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
    '--die-with-parent',

    // Clean environment (prevents /proc/1/environ from leaking parent env
    // when combined with a minimal spawn env)
    '--clearenv',

    // Pseudo-filesystems
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',

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

    // Codex code-mode-host (required for shell/command tool execution;
    // without it codex falls back to text-only with no tools)
    ...mountCodeModeHost(opts.codexPackageRoot),

    // Writable areas (all on host tmpdir, disposable)
    '--bind', opts.hostCwd, SANDBOX_CWD,
    '--bind', disposableHomeDir, SANDBOX_HOME,
    '--bind', disposableCodexHome, SANDBOX_CODEX_HOME,
    '--bind', opts.hostOutputDir, SANDBOX_OUT,
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
      // Best-effort; the staging root is under ~/.cache and will be cleaned
      // eventually by the OS or a manual sweep.
    }
  };

  return {
    command: bwrapPath,
    args: bwrapArgs,
    env: spawnEnv,
    cleanup,
    schemaFile: join(opts.hostOutputDir, 'schema.json'),
    outputFile: join(opts.hostOutputDir, 'result.json'),
  };
}

// ---------------------------------------------------------------------------
// Host path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Find the @openai/codex package root by walking from a known global
 * npm modules location. Returns null if not found.
 */
export function findCodexPackageRoot(): string | null {
  // Try common global npm paths
  const candidates = [
    join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@openai', 'codex'),
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
 * Respects CODEX_HOME env var, falls back to ~/.codex.
 */
export function findCodexHome(): string {
  return process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
}

/**
 * Resolve the bwrap arguments for /etc/resolv.conf.
 * On WSL, /etc/resolv.conf is a symlink to /mnt/wsl/resolv.conf.
 * We mount the target directly so no /mnt/wsl directory is exposed.
 */
/**
 * Mount the codex-code-mode-host binary if it exists.
 * codex probes for this binary at /codex-code-mode-host by default.
 * Without it, shell/command tools are unavailable.
 */
function mountCodeModeHost(codexPackageRoot: string): string[] {
  const hostPath = join(codexPackageRoot, CODEX_CODE_MODE_HOST_SUBPATH);
  try {
    accessSync(hostPath, constants.R_OK | constants.X_OK);
    return ['--ro-bind', hostPath, '/codex-code-mode-host'];
  } catch {
    // Binary not found; codex will run in text-only mode
    return [];
  }
}

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
  CODEX_CODE_MODE_HOST_SUBPATH,
  SANDBOX_HOME,
  SANDBOX_CODEX_HOME,
  SANDBOX_CWD,
  SANDBOX_OUT,
  SANDBOX_CODEX_BIN,
  resolveResolvConf,
  mountCodeModeHost,
};
