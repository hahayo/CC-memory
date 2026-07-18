#!/usr/bin/env bash
# Best-effort handoff from lifecycle hooks to the systemd oneshot supervisor.
# `systemctl --no-block` queues the service and returns without waiting for the worker.

if [[ -n "${CC_MEMORY_CAPTURE_CHILD:-}" ]]; then
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  exit 0
fi

systemctl --user start --no-block cc-memory-auto-capture.service >/dev/null 2>&1 || true
exit 0
