#!/usr/bin/env bash
# Immich BullMQ queue watchdog.
#
# Detects the failure mode observed on 2026-05-02:
#
#   Queue stalled — `wait > THRESHOLD` while `active == 0` and the
#   queue isn't paused, persisting across two consecutive samples
#   (default 5 min apart). Catches the case where Immich is `(healthy)`
#   per /api/server/ping but a BullMQ worker isn't pulling jobs (e.g.
#   bzpopmin marker desync after a Redis hiccup, or worker thread
#   half-registered after `docker restart`).
#
# Sources of truth:
#   * `GET /api/jobs` on http://127.0.0.1:2283 — Immich's own admin
#     endpoint, returns one entry per queue Immich knows about. This
#     auto-tracks queue renames/additions across Immich upgrades — no
#     hardcoded list to rot.
#   * `redis-cli CLIENT LIST | grep name=immich_bull:<base64>` —
#     informational; reports which BullMQ consumers are currently
#     connected. Note: BullMQ consumers connect *lazily* (on first job
#     pull) and disconnect when idle, so a `workers=0` snapshot is NOT
#     a fault by itself — it only matters if there's also a backlog,
#     which the stall rule already covers.
#
# Recovery (--auto-restart):
#   `docker stop immich_server && docker start immich_server`.
#   A plain `docker restart` was insufficient on 2026-05-02 — workers
#   came back half-registered. stop+start fully resets the worker
#   threads. Throttled by a 30-min cooldown stored in the state file.
#
#   We do NOT touch rclone here: the watchdog only restarts the Immich
#   API container, which is orthogonal to the rclone mount. The
#   AGENTS.md rule about flushing the vfs cache applies to killing
#   rclone/unmounting, neither of which we do. (Earlier versions of
#   this script tried `rclone rc vfs/sync` — that method does not
#   exist on rclone 1.x; only vfs/forget|list|queue|refresh|stats are
#   available.)
#
# Exit codes:
#   0   healthy, OR only advisory missing-workers signal (lazy connect)
#   2   one or more queues stalled (confirmed across two samples)
#   3   immich_server / immich_redis / S3 mount unreachable
#  64   bad CLI usage
#
# Usage:
#   scripts/immich-queue-watchdog.sh              # check + log
#   scripts/immich-queue-watchdog.sh --json       # machine-readable
#   scripts/immich-queue-watchdog.sh --auto-restart
#   scripts/immich-queue-watchdog.sh --dry-run --auto-restart  # plan only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/data/logs"
STATE_FILE="$LOG_DIR/immich-watchdog.state"
LOG_FILE="$LOG_DIR/immich-watchdog.log"
RC_SOCK="$ROOT_DIR/data/rclone-rc.sock"
mkdir -p "$LOG_DIR"

REDIS_CTR="${IMMICH_REDIS_CTR:-immich_redis}"
SERVER_CTR="${IMMICH_SERVER_CTR:-immich_server}"
API_BASE="${IMMICH_API_BASE:-http://127.0.0.1:2283}"

# API key for /api/jobs. Created in the Immich UI (Account Settings ->
# API Keys). Stored in .env.immich as IMMICH_WATCHDOG_API_KEY=<key>.
# Read here so the value never appears in process tables.
API_KEY="${IMMICH_WATCHDOG_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f "$ROOT_DIR/.env.immich" ]; then
  API_KEY=$(grep -E '^\s*IMMICH_WATCHDOG_API_KEY\s*=' "$ROOT_DIR/.env.immich" 2>/dev/null \
    | head -1 | sed 's/^[^=]*=\s*//' | sed "s/^[\"']//;s/[\"']\s*$//" | tr -d '\r')
fi

# Stall detector: per-queue (wait > WAIT_THRESHOLD && active == 0)
# observed in two consecutive samples is an alert.
WAIT_THRESHOLD="${IMMICH_WAIT_THRESHOLD:-1000}"

# Cooldown between auto-restart attempts (seconds). Prevents a flap
# from rotating the container forever.
RESTART_COOLDOWN="${IMMICH_RESTART_COOLDOWN:-1800}"

AUTO_RESTART=0
JSON=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --auto-restart) AUTO_RESTART=1 ;;
    --json)         JSON=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    -h|--help)      sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '%s %s\n' "$(ts)" "$*" | tee -a "$LOG_FILE" >&2; }

# Portable base64 (BSD on macOS, GNU on Linux). BullMQ uses standard
# alphabet with padding, no newline.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# --- Pre-flight ---
# If the rclone S3 mount has gone stale (NFS attribute timeout, network
# blip, rclone crash-loop), Immich workers will see ENOENT on every
# /usr/src/app/upload/library/* read — they LOOK stuck even though the
# fault is one layer down. Bouncing immich_server in that state burns
# the 30-min cooldown without fixing anything; the s3mount LaunchAgent
# is what actually heals the mount. Detect this and exit 3 (unreachable)
# instead of triggering --auto-restart. (architect Risk #3, devops Risk #2)
MOUNT_POINT="$ROOT_DIR/data/immich-s3"
if mount | grep -Fq " $MOUNT_POINT "; then
  # Bounded liveness probe via rclone's rc Unix socket. We cannot use the
  # filesystem (e.g. `ls $MOUNT_POINT/library`) because launchd-spawned
  # processes hit macOS TCC and get EPERM on the NFS mount even though
  # the caller owns it. `rc/noop` against the user-owned 0600 Unix socket
  # is unaffected by TCC and proves that rclone is alive (which is the
  # only thing we actually need to know — if rclone is up, the NFS
  # endpoint is up). See start-all.sh probe_mount_live() for the same
  # rationale.
  if [ ! -S "$RC_SOCK" ] \
     || ! rclone rc rc/noop --unix-socket "$RC_SOCK" --timeout 5s >/dev/null 2>&1; then
    log "FATAL: rclone rc unreachable at $RC_SOCK — mount $MOUNT_POINT may be stale (rclone crash-loop / not yet provisioned). Fix s3mount, not Immich."
    exit 3
  fi
else
  log "FATAL: $MOUNT_POINT not mounted — fix s3mount, not Immich"
  exit 3
fi

if ! docker inspect -f '{{.State.Running}}' "$REDIS_CTR" 2>/dev/null | grep -q true; then
  log "FATAL: $REDIS_CTR not running"
  exit 3
fi

if [ -z "$API_KEY" ]; then
  log "FATAL: IMMICH_WATCHDOG_API_KEY not set (export it or add to .env.immich)"
  exit 3
fi
JOBS_JSON="$(curl -fsS -m 10 -H "x-api-key: $API_KEY" "$API_BASE/api/jobs" 2>/dev/null || true)"
if [ -z "$JOBS_JSON" ]; then
  log "FATAL: $API_BASE/api/jobs unreachable or auth rejected"
  exit 3
fi
# Validate JSON shape before consuming — a 200 with a Nest error page would
# otherwise break jq under `set -e` and exit 1, which --auto-restart treats as
# "missing workers" and would unjustifiably bounce immich_server. (audit W3)
if ! printf '%s' "$JOBS_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
  log "FATAL: $API_BASE/api/jobs returned non-JSON or non-object body"
  exit 3
fi

# Single CLIENT LIST snapshot for all worker probes.
CLIENT_LIST="$(docker exec -i "$REDIS_CTR" redis-cli CLIENT LIST 2>/dev/null || true)"
if [ -z "$CLIENT_LIST" ]; then
  log "FATAL: redis CLIENT LIST returned empty"
  exit 3
fi

# Queue list comes from /api/jobs — Immich's source of truth. Avoids the
# 18-name hardcoded list that would silently rot across upgrades.
# (bash 3.2 on macOS has no `mapfile`; use a portable read loop.)
QUEUES=()
while IFS= read -r line; do QUEUES+=("$line"); done < <(printf '%s' "$JOBS_JSON" | jq -r 'keys[]')
if [ "${#QUEUES[@]}" -eq 0 ]; then
  log "FATAL: /api/jobs returned no queues"
  exit 3
fi

# --- Sample each queue ---
declare -a missing_workers stalled rows
for q in "${QUEUES[@]}"; do
  name_tag="immich_bull:$(b64 "$q")"
  workers=$(printf '%s\n' "$CLIENT_LIST" \
    | awk -v n="name=$name_tag" '{for(i=1;i<=NF;i++) if($i==n){c++}} END{print c+0}')
  wait_n=$(printf '%s' "$JOBS_JSON" | jq -r --arg q "$q" '.[$q].jobCounts.waiting // 0')
  active_n=$(printf '%s' "$JOBS_JSON" | jq -r --arg q "$q" '.[$q].jobCounts.active // 0')
  paused=$(printf '%s' "$JOBS_JSON" | jq -r --arg q "$q" '.[$q].queueStatus.isPaused // false')
  rows+=("$q workers=$workers wait=$wait_n active=$active_n paused=$paused")

  # Worker-missing rule: zero connected consumers for a queue Immich
  # itself thinks exists is the unambiguous bug.
  if [ "$workers" -eq 0 ]; then
    missing_workers+=("$q")
  fi
  # Stall rule: backlog with no active processing. Skip paused queues —
  # those are intentional.
  if [ "$paused" = "false" ] && [ "$wait_n" -gt "$WAIT_THRESHOLD" ] && [ "$active_n" -eq 0 ]; then
    stalled+=("$q:$wait_n")
  fi
done

# --- Compare to previous sample, persist new one ---
prev_stalled=""
prev_restart_ts=0
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE" 2>/dev/null || true
  prev_stalled="${PREV_STALLED:-}"
  prev_restart_ts="${PREV_RESTART_TS:-0}"
fi

confirmed_stall=()
for cur in "${stalled[@]:-}"; do
  cur_q="${cur%%:*}"
  if printf '%s' "$prev_stalled" | tr ' ' '\n' | grep -qE "^${cur_q}:"; then
    confirmed_stall+=("$cur")
  fi
done

{
  echo "PREV_STALLED=\"${stalled[*]:-}\""
  echo "PREV_RESTART_TS=${prev_restart_ts}"
} > "$STATE_FILE"

# --- Report ---
# Helper: serialize a bash array to a JSON array, emitting [] (not [""]) when
# empty. Naive `printf '%s\n' "${arr[@]:-}"` produces a stray empty line for
# zero-element arrays, which jq turns into [""]. (audit W1)
json_array() {
  if [ "$#" -eq 0 ]; then
    echo '[]'
  else
    printf '%s\n' "$@" | jq -R . | jq -sc .
  fi
}

if [ "$JSON" = 1 ]; then
  # NB: `"${arr[@]:-}"` expands to ONE empty string for a zero-element
  # array under `set -u`, so use `${arr[@]+"${arr[@]}"}` to expand to
  # zero args when empty. Otherwise json_array() sees `$# == 1` and
  # produces `[""]` instead of `[]`. (debug review #1)
  printf '%s' "$JOBS_JSON" | jq \
    --argjson missing "$(json_array ${missing_workers[@]+"${missing_workers[@]}"})" \
    --argjson stalled "$(json_array ${confirmed_stall[@]+"${confirmed_stall[@]}"})" \
    --arg ts "$(ts)" \
    '{ts: $ts, missing_workers: $missing, confirmed_stall: $stalled, queues: .}'
else
  printf '%s\n' "${rows[@]}" | tee -a "$LOG_FILE"
fi

status=0
if [ "${#missing_workers[@]}" -gt 0 ]; then
  # Advisory only — BullMQ consumers connect lazily, so a queue with
  # zero connected workers AND zero waiting jobs is normal idle state.
  # The stall rule below is what actually catches stuck queues.
  log "INFO missing-worker snapshot (${#missing_workers[@]}/${#QUEUES[@]}, advisory — may be lazy idle): ${missing_workers[*]}"
fi
if [ "${#confirmed_stall[@]}" -gt 0 ]; then
  log "ALERT stalled queues (2 consecutive samples): ${confirmed_stall[*]}"
  status=2
fi

# --- Auto-recovery (only on confirmed stall) ---
if [ "$AUTO_RESTART" = 1 ] && [ "$status" -eq 2 ]; then
  now=$(date +%s)
  age=$(( now - prev_restart_ts ))
  if [ "$age" -lt "$RESTART_COOLDOWN" ]; then
    log "auto-restart suppressed: last restart ${age}s ago (cooldown ${RESTART_COOLDOWN}s)"
    exit "$status"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    log "DRY-RUN would: docker stop $SERVER_CTR; docker start $SERVER_CTR"
    exit "$status"
  fi

  log "auto-restart begin (trigger: confirmed stall)"
  log "docker stop $SERVER_CTR (a plain 'restart' is NOT sufficient — see header note)"
  docker stop "$SERVER_CTR" 2>&1 | tee -a "$LOG_FILE"
  docker start "$SERVER_CTR" 2>&1 | tee -a "$LOG_FILE"

  # Persist restart timestamp.
  {
    echo "PREV_STALLED=\"${stalled[*]:-}\""
    echo "PREV_RESTART_TS=${now}"
  } > "$STATE_FILE"
  log "auto-restart done — next watchdog tick will re-verify"
fi

exit "$status"
