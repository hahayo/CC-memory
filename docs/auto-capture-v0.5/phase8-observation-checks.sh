#!/usr/bin/env bash
# Phase 8 觀察窗唯讀檢查（第 1／2／3／5 項）。整個連線強制 default_transaction_read_only=on，任何寫入都會被 PG 拒絕。
# 用法：bash docs/auto-capture-v0.5/phase8-observation-checks.sh
set -euo pipefail
URL="$(<"$HOME/.ccm-project-url")"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000'
psql "$URL" -X -v ON_ERROR_STOP=1 -f "$(dirname "$0")/phase8-observation-checks.sql"
