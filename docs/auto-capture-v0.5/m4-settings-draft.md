# M4 SessionStart Injection Settings Draft

This is a draft only. **Not applied.** Do not paste it into `~/.claude/settings.json` until M4 is accepted and you deliberately want Recent Activity injection enabled for the current Claude Code profile. Injection stays **off by default** (`CC_MEMORY_INJECT_RECENT` unset).

## What This Adds

A `SessionStart` hook that, when explicitly enabled, injects a compact **Recent Activity index** (recent rollup memories for the current project) into the new session's context. The injected text carries the pollution marker `source=cc-memory-inject`, so the capture worker excludes it from later extraction (no feedback loop).

Design constraints (see `docs/auto-capture-v0.5/plan.md` §Injection Pollution Defense):

- Off by default; both the bash wrapper and the Node script re-check the flag (defense in depth).
- Injects only a light index — id / updated_at / observation count / discovery_tokens / summary excerpt. **No** observation narrative full text.
- Every failure path (flag off, malformed payload, DB unreachable, builder throw) prints nothing and exits `0`, so a broken injector can never block session start.

## Settings Snippet

Add the following hook to `~/.claude/settings.json`, adjusting the absolute path if this repo moves:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/haha/CC_project/CC-memory/hooks/session-start-inject.sh"
          }
        ]
      }
    ]
  }
}
```

## Enable Conditions

- Use only after the M4 gate passes and migrations 0011-0013 are verified on the project DB.
- Injection is disabled unless `CC_MEMORY_INJECT_RECENT=on`. Enable it (e.g. in your shell profile or a project `.env` consumed before Claude Code launches):

```bash
export CC_MEMORY_INJECT_RECENT=on
```

- The wrapper runs `npx tsx scripts/run-session-start-inject.ts` from the repo root; the `claude` CLI must run in an environment where the project DB is reachable. DSN resolution reuses `config.databaseUrl` (same as `scripts/run-auto-capture.ts`); for the project DB via SSH tunnel see `docs/auto-capture-v0.5/m2b-cron-draft.md`.

## Environment Variables

| Variable | Default | Effect |
| --- | --- | --- |
| `CC_MEMORY_INJECT_RECENT` | unset (off) | `on` (case-insensitive, surrounding whitespace trimmed) enables injection. Any other value / unset → bash layer exits `0` without spawning Node. |
| `CC_MEMORY_INJECT_TOKEN_BUDGET` | `1200` | Token budget for the injected index. Over budget the builder first drops observation ids, then shrinks summary excerpts, then drops the oldest rows (see `src/services/recent-activity.ts`). |
| `CC_MEMORY_CAPTURE_CHILD` | unset | Set to `1` inside the capture worker's extraction subprocess; the wrapper treats it as a recursion breaker and exits `0` before the flag check. |

## Risks & Rollback

- **Context pollution loop** — mitigated by the `source=cc-memory-inject` marker + capture worker line-level exclusion. If you see injected indexes reappearing as captured observations, confirm the worker filter is present (`INJECTION_MARKER` in `src/services/capture-worker.ts`).
- **Session start latency** — the injector uses a 2s DB connect timeout and fails open (empty stdout). If session start feels slow, unset `CC_MEMORY_INJECT_RECENT` to disable.
- **Privacy** — `buildRecentActivity` refuses the reserved `__personal__` namespace; a project whose sanitized cwd basename resolves to `__personal__` yields empty output.

**Rollback:** remove the `SessionStart` entry above from `~/.claude/settings.json`, or simply `unset CC_MEMORY_INJECT_RECENT` to disable injection while leaving the hook wired.
