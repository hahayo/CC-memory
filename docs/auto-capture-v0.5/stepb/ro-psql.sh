#!/usr/bin/env bash
# 唯讀 psql 殼（同 docs/auto-capture-v0.5/phase8-observation-checks.sh）：整條連線 default_transaction_read_only=on。
# 用法：bash ro-psql.sh <sql 檔> [psql 額外參數…]
set -euo pipefail
SQL_FILE="$1"; shift
URL="$(<"$HOME/.ccm-project-url")"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000'
psql "$URL" -X -v ON_ERROR_STOP=1 "$@" -f "$SQL_FILE"
