# M2b Hermes Cron Draft

Draft only. Do not register until the user reviews this file and the project DB health gate passes.

## Job

- Name: `cc-memory-auto-capture`
- Schedule: `*/5 * * * *`
- Mode: `--no-agent`
- Script: `cc-memory-auto-capture.sh`
- Entry: `npx tsx scripts/run-auto-capture.ts`

## Draft Script

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /home/haha/CC_project/CC-memory

# Project DB only. Keep personal DB out of this worker.
export DATABASE_URL="$(cat ~/.ccm-prod-url)"
export CC_MEMORY_SPOOL_DIR="${CC_MEMORY_SPOOL_DIR:-$HOME/.cache/cc-memory/spool}"
export CC_CAPTURE_LLM="${CC_CAPTURE_LLM:-gemini-flash}"

if [[ -f "$HOME/.gemini-api-key" ]]; then
  export GEMINI_API_KEY="$(cat "$HOME/.gemini-api-key")"
fi

exec npx tsx scripts/run-auto-capture.ts
```

## Draft Command

Check the current Hermes CLI help before running this; command syntax may differ by installed Hermes version.

```bash
hermes cron create \
  --name cc-memory-auto-capture \
  --schedule '*/5 * * * *' \
  --script cc-memory-auto-capture.sh \
  --no-agent
```

## Operational Notes

- The worker exits `0` and does not advance HWM when DB health check fails.
- `GEMINI_API_KEY` absence disables capture without touching spool HWM.
- Malformed LLM output writes `CC_MEMORY_SPOOL_DIR/.dead/<hash>.json`.
- Register only after migrations 0011-0013 are verified on the project DB.
