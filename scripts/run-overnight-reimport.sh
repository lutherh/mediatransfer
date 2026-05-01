#!/usr/bin/env bash
# Overnight launcher for takeout reimport from /Volumes/Data backup.
# Used 2026-04-30 — safe to delete after the run completes.
set -uo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a

LOG="data/takeout/work/overnight-$(date +%Y%m%d-%H%M%S).log"
echo "Logging to $LOG"
echo "$$" > data/takeout/work/overnight.pid

exec npx tsx scripts/takeout-process.ts \
  --input-dir /Volumes/Data/archive-already-uploaded \
  --work-dir  "$(pwd)/data/takeout/work" \
  --concurrency 4 \
  >> "$LOG" 2>&1
