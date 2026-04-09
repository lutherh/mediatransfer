#!/usr/bin/env bash
# Mount Scaleway S3 bucket for Immich originals storage.
# Requires: rclone, fuse3 (Linux) or macFUSE (macOS)
#
# Usage:
#   ./scripts/mount-s3.sh              # mount (foreground — Ctrl+C to stop)
#   ./scripts/mount-s3.sh --background # mount as daemon
#   ./scripts/mount-s3.sh --unmount    # unmount
#
# Config is read from .env.immich (RCLONE_REMOTE, RCLONE_BUCKET, RCLONE_PREFIX, UPLOAD_LOCATION)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env.immich"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env.immich not found at $ENV_FILE" >&2
  exit 1
fi

# Parse .env.immich
load_env() {
  local key val
  while IFS='=' read -r key val; do
    key=$(echo "$key" | xargs)
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    val=$(echo "$val" | sed "s/^[\"']//;s/[\"']$//")
    case "$key" in
      RCLONE_REMOTE)     RCLONE_REMOTE="$val" ;;
      RCLONE_BUCKET)     RCLONE_BUCKET="$val" ;;
      RCLONE_PREFIX)     RCLONE_PREFIX="$val" ;;
      UPLOAD_LOCATION)   UPLOAD_LOCATION="$val" ;;
    esac
  done < "$ENV_FILE"
}

load_env

REMOTE="${RCLONE_REMOTE:-scaleway}"
BUCKET="${RCLONE_BUCKET:-photosync}"
PREFIX="${RCLONE_PREFIX:-immich}"
MOUNT_POINT="${UPLOAD_LOCATION:-./data/immich-s3}"

# Resolve relative paths from repo root
if [[ "$MOUNT_POINT" != /* ]]; then
  MOUNT_POINT="$ROOT_DIR/$MOUNT_POINT"
fi

SOURCE="${REMOTE}:${BUCKET}/${PREFIX}"

# Pre-flight
if ! command -v rclone &>/dev/null; then
  echo "ERROR: rclone is not installed. Install with: sudo apt install rclone  (or brew install rclone)" >&2
  exit 1
fi

if ! grep -q fuse /proc/filesystems 2>/dev/null && [ "$(uname)" != "Darwin" ]; then
  echo "WARNING: FUSE not found. Install with: sudo apt install fuse3" >&2
fi

# Unmount
if [[ "${1:-}" == "--unmount" || "${1:-}" == "-u" ]]; then
  echo "Unmounting $MOUNT_POINT ..."
  fusermount -uz "$MOUNT_POINT" 2>/dev/null || umount "$MOUNT_POINT" 2>/dev/null || true
  echo "Done."
  exit 0
fi

# Ensure mount directory
mkdir -p "$MOUNT_POINT"

echo "Mounting $SOURCE -> $MOUNT_POINT"
echo "  Remote:  $REMOTE"
echo "  Bucket:  $BUCKET"
echo "  Prefix:  $PREFIX"
echo ""

RCLONE_ARGS=(
  mount "$SOURCE" "$MOUNT_POINT"
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
  --allow-other
  --log-level NOTICE
)

if [[ "${1:-}" == "--background" || "${1:-}" == "-b" ]]; then
  RCLONE_ARGS+=(--daemon)
  rclone "${RCLONE_ARGS[@]}"
  echo "Mount running in background. Unmount with: $0 --unmount"
else
  echo "Mount running in foreground. Press Ctrl+C to stop."
  echo ""
  rclone "${RCLONE_ARGS[@]}"
fi
