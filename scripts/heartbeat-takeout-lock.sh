#!/bin/bash
# External heartbeater for a running takeout CLI that pre-dates the
# in-process heartbeat code. Delegates to TypeScript so this repo never uses
# Python helper scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec npx tsx "$ROOT/scripts/heartbeat-takeout-lock.ts" "$@"
