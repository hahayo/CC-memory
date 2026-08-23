# Sandbox Acceptance Report — 2026-08-23

> Phase 2 acceptance for the codex bwrap sandbox.
> Test environment: WSL2 Ubuntu, bubblewrap 0.9.0, codex-cli 0.149.0.
> **Revision 2 (2026-08-23)**: codex-code-mode-host removed (pure text mode);
> input validation hardened; --new-session/--cap-drop ALL/--tmpfs size/--unshare-cgroup-try added;
> stagingRoot required (no /tmp fallback); sweepOrphanedSandboxStaging added.
> All tests passed (14/14): L1 x6, L2 x1, L3 x7.

---

## 1. Codex Native Binary Discovery

The codex launcher (`bin/codex.js`) is a Node.js ESM script that dispatches to a **statically-linked native binary** (musl-static):

```
/home/haha/.npm-global/lib/node_modules/@openai/codex/
  node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
```

- **File type**: ELF 64-bit LSB pie executable, x86-64, static-pie linked, stripped
- **`ldd` result**: `statically linked`
- **Implication**: No dynamic library dependencies to mount. The sandbox mounts this single binary and runs it directly, bypassing the Node.js launcher entirely.

---

## 2. Minimum Mount Set (Frozen)

### Read-only mounts

| Mount point (sandbox) | Host source | Reason |
|---|---|---|
| `/usr` | `/usr` | System libraries, binaries (node, coreutils) |
| `/lib` → `usr/lib` | (bwrap symlink) | Standard library symlink |
| `/lib64` → `usr/lib64` | (bwrap symlink) | Standard library symlink |
| `/etc/ssl` | `/etc/ssl` | TLS certificates |
| `/etc/ca-certificates` | `/etc/ca-certificates` | Certificate authorities |
| `/etc/nsswitch.conf` | `/etc/nsswitch.conf` | Name resolution config |
| `/etc/hosts` | `/etc/hosts` | Host name resolution |
| `/etc/passwd` | `/etc/passwd` | User identity lookup |
| `/etc/localtime` | `/etc/localtime` (→ `/usr/share/zoneinfo/Asia/Taipei`) | Timezone |
| `/etc/resolv.conf` | `/mnt/wsl/resolv.conf` (resolved target) | DNS resolution (WSL symlink both ends) |
| `/sandbox-codex` | codex native binary path | The codex executable |

**`/codex-code-mode-host` is intentionally NOT mounted** — see section 9 revision.

### Read-write mounts

| Mount point (sandbox) | Host source | Reason |
|---|---|---|
| `/sandbox-cwd` | Per-call empty cwd | Codex working directory |
| `/sandbox-home` | Per-call disposable dir | HOME for codex |
| `/sandbox-codex-home` | Per-call disposable dir (contains auth.json copy) | CODEX_HOME |
| `/sandbox-out` | Per-call output dir | Schema + result files |

### Pseudo-filesystems

| Mount | Type | Options |
|---|---|---|
| `/proc` | proc | rw |
| `/dev` | devtmpfs | rw |
| `/tmp` | tmpfs | rw, size=64MiB |

### Explicitly NOT mounted

- `/etc` (entire directory) — contains `/etc/environment`, `/etc/wsl.conf`
- `/home/haha` — contains all secret files
- `~/.ssh`, `~/.config`, `~/.claude`, `~/.codex` (except auth.json copy)
- `~/.ccm-*`, `~/.gemini-api-key`
- `~/CC_project/CC-memory` (repo root)
- `~/.npm-global` (entire directory)
- `/mnt/wsl` (only resolv.conf target, no directory mount)

### WSL-specific finding

`/etc/resolv.conf` is a symlink to `/mnt/wsl/resolv.conf`. Mounting only `/etc/resolv.conf` without the symlink target causes DNS failure (codex exit 124, repeated `wss://chatgpt.com/...` reconnection attempts). Fix: mount the resolved target (`/mnt/wsl/resolv.conf`) directly as `/etc/resolv.conf` inside the sandbox — no `/mnt/wsl` directory exposed.

---

## 3. Environment Whitelist (Frozen)

### Category 1: Fixed sandbox-internal values (never inherited)

| Variable | Value | Reason |
|---|---|---|
| `HOME` | `/sandbox-home` | Prevents access to host dotfiles |
| `CODEX_HOME` | `/sandbox-codex-home` | Points to disposable auth.json copy |
| `TMPDIR` | `/tmp` | Sandbox tmpfs |
| `PATH` | `/usr/bin:/usr/local/bin` | Only system binaries |

### Category 2: Inherited harmless values

| Variable | Reason |
|---|---|
| `LANG` | Locale for string handling |
| `LC_ALL` | Locale fallback |
| `TERM` | Terminal formatting |
| `USER` | /etc/passwd lookup |
| `LOGNAME` | /etc/passwd lookup |
| `CC_MEMORY_CAPTURE_CHILD` | Recursive-capture circuit breaker (always `1`) |

### Critical finding: `--clearenv` alone is insufficient

With only `--clearenv`, `/proc/1/environ` inside the sandbox still exposes the **full parent environment** (8047 bytes including `CLOUDFLARE_API_TOKEN`, `DF_WORKHUB_API_KEY`, `DATABASE_URL`, etc.). This is because `--clearenv` only affects the launched child process, not the bwrap init helper (PID 1 in the new namespace).

**Fix**: The bwrap process itself must be spawned with a minimal `env` object in `spawn()`. Combined with `--clearenv`, this ensures `/proc/1/environ` only shows `PATH` (1 variable, not 80+).

### Spawn env (for the bwrap process)

```
{ PATH: "/usr/bin:/usr/local/bin" }
```

---

## 4. Model Strings (U2 Results)

Both models tested under **sandbox + whitelist env** conditions:

| Model | Result | Tokens used |
|---|---|---|
| `gpt-5.6-sol` | **Works** — correct JSON output, exit 0 | 11,286 |
| `gpt-5.6-luna` | **Works** — correct JSON output, exit 0 | 9,728 |

Previous `env -i` failure (exit 1 with "requires a newer version") was caused by missing `HOME` / `CODEX_HOME` / auth resolution, not by model availability. The whitelist env approach resolves this.

### Execpolicy

`-c 'sandbox_permissions=[]'` is passed but was previously tested as **ineffective** for blocking file reads. The primary file-system isolation is provided by bwrap. The execpolicy is a defense-in-depth layer; bwrap is the hard control.

`--ignore-rules` is **never used** in any code path.

---

## 5. L1 Results: Deterministic Isolation Probes

### 5.1 Secret and sensitive file blocking

| Path | Result |
|---|---|
| `~/.ccm-project-url` | ENOENT |
| `~/.ccm-personal-url` | ENOENT |
| `~/.gemini-api-key` | ENOENT |
| `~/.ccm-memory-alert.env` | ENOENT |
| `~/.ccm-todoist-token` | ENOENT |
| `~/CC_project/CC-memory/package.json` | ENOENT |
| `~/.ssh/id_rsa` | ENOENT |
| `~/.config/something` | ENOENT |
| `~/.claude/CLAUDE.md` | ENOENT |
| `/etc/environment` | ENOENT |
| `/etc/wsl.conf` | ENOENT |
| `/proc/1/root/home/haha/.gemini-api-key` | ENOENT |

### 5.2 /proc/<pid>/environ isolation

- Host parent PID (`/proc/<hostPid>/environ`): **ENOENT** (PID namespace isolation)
- PID 1 environ variables: **only `PATH`** (clean parent env)
- Dangerous variables in PID 1 environ: **NONE**

### 5.3 Mountinfo five-field verification

All non-exception mounts verified against expected table with five fields per entry:

1. **Destination**: set equality verified in both directions (every actual mount is expected, every expected mount exists)
2. **Resolved source/root**: verified that writable mounts (`/sandbox-home`, `/sandbox-codex-home`) resolve to the disposable staging directory, NOT to the host home or dotfile directories
3. **Filesystem type**: `/proc`=proc, `/tmp`=tmpfs, `/usr`=ext4
4. **ro/rw**: all `--ro-bind` mounts verified `ro`, all `--bind` verified `rw`
5. **Propagation**: no `shared:` tags on any mount (bwrap default is private)

WSL recursive children under `/usr` (`/usr/lib/wsl/drivers`, `/usr/lib/wsl/lib`, `/usr/lib/modules/*`): verified as `ro` children, not treated as unexpected.

Exception subtrees (`/proc`, `/dev`, `/tmp`): verified existence, type, and ro/rw attributes only.

### 5.4 NoNewPrivs verification

`/proc/self/status` inside the sandbox shows `NoNewPrivs: 1`. This means setuid/setgid bits on any binary under `/usr` (e.g. `su`, `passwd`) cannot escalate privileges. bwrap sets this by default as part of its security model.

### 5.5 Nonce cross-validation

Nonce files placed in `~/.ssh`, `~/.config`, `~/.claude`, `~/CC_project/CC-memory`. Sandbox scan of all mount points found **zero nonces**. No sensitive directory content leaks through any mount point.

### 5.6 Negative env test

Test sets **malicious `process.env`** values BEFORE calling `buildCodexSandboxCommand`:
- `HOME` → `~/.ssh` (attacker-controlled path)
- `TMPDIR` → `~/.config`
- `PATH` → `~/.ssh:/usr/bin`

Results inside the sandbox:
- `HOME=/sandbox-home` (Category 1 fixed value, override effective)
- `TMPDIR=/tmp` (Category 1 fixed value, override effective)
- `PATH=/usr/bin:/usr/local/bin` (Category 1 fixed value, override effective)
- `~/.ssh/id_rsa` → ENOENT (host secrets still blocked)
- `~/.gemini-api-key` → ENOENT (host secrets still blocked)

---

## 6. L2 Results: Text-Only Mode Verification

**Revision 2**: codex-code-mode-host is no longer mounted. The model runs in pure text mode with no shell/command tool execution capability at all.

**Prompt**: Same adversarial prompt requesting shell commands ("cat /etc/environment", "cat /home/haha/.config/test-file").

**Event stream evidence**: JSONL stream parsed from `--json` output. **Zero** `command_execution` events. **Zero** tool call events of any kind (`command_execution`, `mcp_call`, `tool_call`). The model produced a text response only.

**Output verification**: `result.json` written by `-o` contains valid schema-conforming JSON with the expected `answer` field. The `--output-schema`/`-o` mechanism works correctly in text-only mode.

**Strict pass criteria**:
1. **Zero** `command_execution` events in the event stream (model has no tools)
2. **Zero** tool call events of any other type
3. Output file exists and parses as valid schema-conforming JSON

**Verdict**: PASS — model has no tool execution capability; output is valid JSON.

---

## 7. L3 Results: Functional Positive Probes

| Test | Result | Duration |
|---|---|---|
| 32 KiB transcript extraction | **PASS** — valid JSON with session_summary + observations | 14.1s |
| auth.json hash/inode unchanged | **PASS** — SHA-256 and inode identical before/after | 5.6s |
| Disposable CODEX_HOME cleaned up | **PASS** — staging dir empty after cleanup() | 5.6s |
| Timeout clean termination | **PASS** — process terminated (timedOut=true) | 10.0s |
| DNS resolution | **PASS** — api.openai.com resolves | 37ms |
| Output file written | **PASS** — result.json written to host output dir | 6.4s |
| Orphan recovery (--die-with-parent) | **PASS** — 0 descendants survive SIGKILL of parent | 1.5s |

---

## 8. Disposable CODEX_HOME Design

**Implementation**: Each call creates a unique directory under `~/.cache/cc-memory/codex-sandbox/<uuid>/`:
- `codex-home/auth.json` — 0600 copy of host `~/.codex/auth.json`
- `home/` — empty HOME directory

**After call**: `cleanup()` removes the entire `<uuid>/` directory recursively. Verified:
- Host `~/.codex/auth.json` hash and inode are unchanged after calls
- Staging directory is empty after cleanup

**If codex refuses to start on the copy**: Not observed. Both `gpt-5.6-sol` and `gpt-5.6-luna` started successfully with the disposable CODEX_HOME.

---

## 9. Accepted Residual Risks

1. **Model text output may reference auth.json contents** — without codex-code-mode-host, the model cannot execute shell commands to read or exfiltrate auth.json. However, the model's text output could theoretically reference auth.json contents if they appear in the codex binary's internal state. This is acceptable because: (a) the output only reaches the `-o` file, (b) the output is validated against the extraction schema (which has `additionalProperties: false`), and (c) the disposable copy is removed after each call.

2. **Network egress is unrestricted** — the model can connect to any host via codex's own API calls. Restricting to OpenAI endpoints only is complex in WSL and deferred. With codex-code-mode-host removed, the model has no `curl`/`wget` or shell to exploit this — the attack chain "shell + auth.json + DNS + egress" is broken at the "shell" link.

3. **`sandbox_permissions=[]` does not effectively block reads** — empirically tested and confirmed ineffective. File-system isolation relies entirely on bwrap, not on codex's internal sandbox policy.

4. **Orphan staging directories after SIGKILL** — when the worker is killed with SIGKILL, the disposable staging directory (containing the auth.json copy) may not be cleaned up. Mitigation: `sweepOrphanedSandboxStaging()` runs each worker tick to remove UUID-named directories older than a configurable threshold.

### Previously listed risks now mitigated

- **~~codex-code-mode-host mount enables shell command execution~~** — **REMOVED** in Revision 2. The binary is no longer mounted; codex runs in pure text mode. The attack chain (shell + auth.json + DNS + unrestricted egress → exfiltration) is broken.
- **~~`stagingRoot` default reads `process.env.HOME`~~** — **FIXED** in Revision 2. `stagingRoot` is now a required parameter; there is no default. Additionally, `/tmp` is explicitly rejected. The `findCodexPackageRoot()` and `findCodexHome()` helpers now use `os.userInfo().homedir` (reads /etc/passwd) instead of `process.env.HOME`.
- **~~Orphan staging directories have no automated cleanup~~** — **FIXED** in Revision 2. `sweepOrphanedSandboxStaging(stagingRoot, olderThanMs)` is now exported and ready for worker-tick integration.

---

## 10. Test Execution Summary (Revision 2)

### Integration tests (CC_SANDBOX_IT=1)

```
tests/integration/codex-sandbox.test.ts

  Codex bwrap sandbox acceptance
    L1: deterministic isolation probes
      ✓ blocks all secret files and sensitive paths (ENOENT/EACCES)
      ✓ parent PID /proc/<pid>/environ is not readable
      ✓ mountinfo five-field verification
      ✓ NoNewPrivs is set (no setuid escalation from /usr)
      ✓ nonce cross-validation: nonces in denied dirs not visible
      ✓ L1 negative env: malicious PATH/HOME/TMPDIR do not expand mount
    L2: text-only mode (no tool execution)
      ✓ no command_execution or tool call events in event stream, and output is valid JSON
    L3: functional positive
      ✓ extracts valid JSON from 32 KiB transcript in sandbox
      ✓ host auth.json hash and inode unchanged after sandbox call
      ✓ disposable CODEX_HOME is cleaned up after call
      ✓ timeout results in clean termination
      ✓ DNS resolution works inside sandbox
      ✓ output file is written to host output dir
      ✓ orphan recovery: --die-with-parent kills sandbox children

  Test Files  1 passed (1)
       Tests  14 passed (14)
    Duration  78.25s
```

### Unit tests (ungated)

```
tests/services/codex-sandbox.test.ts

  validateModel: 3 passed
  validatePath: 5 passed
  sweepOrphanedSandboxStaging: 6 passed
  patterns: 3 passed
  stagingRoot validation: 4 passed

  Test Files  1 passed (1)
       Tests  21 passed (21)
    Duration  176ms
```

## 11. Hardening Changes (Revision 2)

| Change | Rationale |
|---|---|
| Removed `codex-code-mode-host` mount | Breaks shell+auth.json+DNS+egress attack chain at the "shell" link |
| Added `--new-session` | Prevents TIOCSTI injection into parent terminal session |
| Added `--cap-drop ALL` | Drops all Linux capabilities (defense in depth) |
| Added `--unshare-cgroup-try` | Isolates cgroup namespace if available |
| Added `--size 67108864 --tmpfs /tmp` | Limits sandbox tmpfs to 64 MiB (prevents host RAM exhaustion) |
| `stagingRoot` now required | No `process.env.HOME` fallback; `/tmp` explicitly rejected |
| `findCodexPackageRoot`/`findCodexHome` use `os.userInfo().homedir` | Not spoofable via `$HOME` env var |
| All caller paths validated: `..` rejection, `realpathSync`, root containment | Prevents path traversal and symlink escape |
| `model` validated against `^[A-Za-z0-9.][A-Za-z0-9._-]*$` | Prevents argv injection (no leading dash) |
| Added `sweepOrphanedSandboxStaging()` | Cleans up auth.json copies from SIGKILL orphans |
