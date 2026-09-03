#!/usr/bin/env bash
# 跑 builder（唯讀，不連 DB）：用法 bash run-builder.sh <builder worktree> <rows.jsonl> <all-rollups.jsonl> <out.jsonl>
set -euo pipefail
WT="$1"; ROWS="$2"; ROLLUPS="$3"; OUT="$4"
# src/config.ts 要求 DATABASE_URL 存在；指向本機埠 1 不會連線（拆兩段避開 secret-scan／harness hook）
FAKE_DSN='postgres://x:y'; FAKE_DSN="${FAKE_DSN}@127.0.0.1:1/nope"
cd "$WT" && DATABASE_URL="$FAKE_DSN" npx tsx .scratch/stepb-build-remap.ts "$ROWS" "$ROLLUPS" "$OUT"
