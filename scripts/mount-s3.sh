#!/usr/bin/env bash
# Mount Scaleway S3 bucket for Immich originals storage.
# Requires:
#   - Linux: rclone + fuse3   (apt install rclone fuse3)
#   - macOS: rclone only      (brew install rclone) — uses `rclone nfsmount`,
#                              NO macFUSE / NO kernel extension / NO reboot.
#
# Usage:
#   ./scripts/mount-s3.sh              # mount (foreground — Ctrl+C to stop)
#   ./scripts/mount-s3.sh --background # mount as daemon (writes a PID file)
#   ./scripts/mount-s3.sh --unmount    # unmount AND stop the daemon
#
# S3 credentials are read from .env (single source of truth):
#   SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_REGION
#
# Mount config is read from .env.immich:
#   RCLONE_BUCKET, RCLONE_PREFIX, UPLOAD_LOCATION
#
# No rclone remote or rclone.conf is needed — credentials are passed inline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Helper: read a key from a .env file ──
read_env_val() {
  local file="$1" key="$2" default="${3:-}"
  local val
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//" | tr -d '\r')
  echo "${val:-$default}"
}

# ── Load config ──
MAIN_ENV="$ROOT_DIR/.env"
IMMICH_ENV="$ROOT_DIR/.env.immich"

if [ ! -f "$MAIN_ENV" ]; then
  echo "ERROR: .env not found at $MAIN_ENV" >&2
  exit 1
fi
if [ ! -f "$IMMICH_ENV" ]; then
  echo "ERROR: .env.immich not found at $IMMICH_ENV — copy from .env.immich.example first." >&2
  exit 1
fi

# S3 credentials from .env
ACCESS_KEY=$(read_env_val "$MAIN_ENV" SCW_ACCESS_KEY)
SECRET_KEY=$(read_env_val "$MAIN_ENV" SCW_SECRET_KEY)
REGION=$(read_env_val "$MAIN_ENV" SCW_REGION "fr-par")
STORAGE_CLASS=$(read_env_val "$MAIN_ENV" SCW_STORAGE_CLASS)

if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
  echo "ERROR: SCW_ACCESS_KEY and SCW_SECRET_KEY must be set in .env" >&2
  exit 1
fi

# Resolve endpoint and signing region from SCW_REGION (accepts code or full URL)
if [[ "$REGION" =~ ^https?:// ]]; then
  ENDPOINT="$REGION"
  SIGNING_REGION=$(echo "$REGION" | sed -n 's|.*s3\.\([a-z0-9-]*\)\.scw\.cloud.*|\1|p')
  if [ -z "$SIGNING_REGION" ]; then
    echo "ERROR: Cannot derive signing region from endpoint URL: $REGION" >&2
    exit 1
  fi
else
  ENDPOINT="https://s3.${REGION}.scw.cloud"
  SIGNING_REGION="$REGION"
fi

# Mount config from .env.immich (falls back to .env for bucket)
BUCKET=$(read_env_val "$IMMICH_ENV" RCLONE_BUCKET "$(read_env_val "$MAIN_ENV" SCW_BUCKET)")
PREFIX=$(read_env_val "$IMMICH_ENV" RCLONE_PREFIX "immich")
MOUNT_POINT=$(read_env_val "$IMMICH_ENV" UPLOAD_LOCATION "./data/immich-s3")

if [ -z "$BUCKET" ]; then
  echo "ERROR: No bucket configured. Set RCLONE_BUCKET in .env.immich or SCW_BUCKET in .env" >&2
  exit 1
fi

# Resolve relative paths from repo root
if [[ "$MOUNT_POINT" != /* ]]; then
  MOUNT_POINT="$ROOT_DIR/$MOUNT_POINT"
fi

SOURCE=":s3:${BUCKET}/${PREFIX}"

# Pre-flight
if ! command -v rclone &>/dev/null; then
  echo "ERROR: rclone is not installed. Install with: sudo apt install rclone  (or brew install rclone)" >&2
  exit 1
fi

if ! grep -q fuse /proc/filesystems 2>/dev/null && [ "$(uname)" != "Darwin" ]; then
  echo "WARNING: FUSE not found. Install with: sudo apt install fuse3" >&2
fi

# PID file lives next to the mount point so multiple repos / mount points
# don't fight over a single global file.
PID_FILE="${MOUNT_POINT%/}.rclone.pid"

# Unmount
if [[ "${1:-}" == "--unmount" || "${1:-}" == "-u" ]]; then
  echo "Unmounting $MOUNT_POINT ..."
  if [ "$(uname)" = "Darwin" ]; then
    diskutil unmount force "$MOUNT_POINT" 2>/dev/null || umount -f "$MOUNT_POINT" 2>/dev/null || true
  else
    fusermount -uz "$MOUNT_POINT" 2>/dev/null || umount "$MOUNT_POINT" 2>/dev/null || true
  fi
  # Stop the rclone daemon — without this it survives the unmount and leaks
  # an orphan NFS server on a random localhost port (architect review #2).
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      sleep 1
      kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # Belt-and-braces: kill any rclone process still bound to this exact mount
  # point (covers daemons started before this PID-file change shipped).
  pkill -f "rclone .*${MOUNT_SUBCMD:-(mount|nfsmount)}.* ${MOUNT_POINT}" 2>/dev/null || true
  echo "Done."
  exit 0
fi

# Ensure mount directory
mkdir -p "$MOUNT_POINT"

echo "Mounting $SOURCE -> $MOUNT_POINT"
echo "  Endpoint: $ENDPOINT"
echo "  Bucket:   $BUCKET"
echo "  Prefix:   $PREFIX"
echo ""

# On macOS, Homebrew's rclone bottle does NOT include macFUSE bindings, so the
# `mount` subcommand fails immediately. Use `nfsmount` instead — it serves NFS
# on a local port and uses the system's built-in NFS client (no kernel ext,
# no reboot, no macFUSE). On Linux we keep the original FUSE-based `mount`.
if [ "$(uname)" = "Darwin" ]; then
  MOUNT_SUBCMD="nfsmount"
  EXTRA_MOUNT_FLAGS=()
else
  MOUNT_SUBCMD="mount"
  EXTRA_MOUNT_FLAGS=(--allow-other)
fi

RCLONE_ARGS=(
  "$MOUNT_SUBCMD" "$SOURCE" "$MOUNT_POINT"
  --s3-provider Scaleway
  --s3-access-key-id "$ACCESS_KEY"
  --s3-secret-access-key "$SECRET_KEY"
  --s3-endpoint "$ENDPOINT"
  --s3-region "$SIGNING_REGION"
  ${STORAGE_CLASS:+--s3-storage-class "$STORAGE_CLASS"}
  --vfs-cache-mode writes
  --vfs-write-back 5s
  --vfs-cache-max-age 1h
  --vfs-cache-max-size 2G
  --vfs-read-chunk-size 16M
  --vfs-read-chunk-size-limit 64M
  --dir-cache-time 30s
  --poll-interval 0
  --transfers 8
  --s3-chunk-size 16M
  ${EXTRA_MOUNT_FLAGS[@]+"${EXTRA_MOUNT_FLAGS[@]}"}
  --log-level NOTICE
)

if [[ "${1:-}" == "--background" || "${1:-}" == "-b" ]]; then
  RCLONE_ARGS+=(--daemon --rc --rc-addr=localhost:0)
  rclone "${RCLONE_ARGS[@]}"
  # Capture the PID of the daemon rclone forks. `rclone --daemon` double-forks,
  # so we record the most recent rclone PID owning this mount point.
  sleep 1
  RCLONE_PID=$(pgrep -f "rclone .*${MOUNT_SUBCMD}.* ${MOUNT_POINT}" | tail -1 || true)
  if [ -n "${RCLONE_PID:-}" ]; then
    echo "$RCLONE_PID" > "$PID_FILE"
  fi
  echo "Mount running in background (pid ${RCLONE_PID:-?}, pidfile $PID_FILE)."
  echo "Unmount with: $0 --unmount"
else
  echo "Mount running in foreground. Press Ctrl+C to stop."
  echo ""
  rclone "${RCLONE_ARGS[@]}"
fi
