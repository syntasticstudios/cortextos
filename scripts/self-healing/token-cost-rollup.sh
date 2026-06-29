#!/usr/bin/env bash
# token-cost-rollup.sh — Thin wrapper around token-cost-rollup.py.
#
# Tails each enabled agent's Claude Code session transcripts, appends RAW
# token-usage rows to <ctxRoot>/logs/<agent>/token-usage.jsonl (idempotent via
# per-session byte-offset checkpoints), and re-derives the daily USD estimate
# into <ctxRoot>/orgs/<org>/analytics/cost.json from the versioned price-table.json.
#
# No src/ change — CI-freeze-independent (durable-cron convention: git-tracked
# top-level scripts/, $CTX_FRAMEWORK_ROOT-relative).
#
# Driven by the token-cost-rollup cron. Cron fire must be recorded by the caller:
#   cortextos bus update-cron-fire token-cost-rollup --interval 30

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$SCRIPT_DIR/token-cost-rollup.py"

if [ ! -f "$PY" ]; then
  echo "[token-cost-rollup] ERROR: $PY not found" >&2
  exit 1
fi

# cost.json is always re-derived cumulatively from the full retained transcript
# history (window-labelled + per-UTC-day buckets); no date argument is needed.
python3 "$PY" "$@" 2>&1 | tail -3
