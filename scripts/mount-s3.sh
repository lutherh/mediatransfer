#!/usr/bin/env bash
# Mount Scaleway S3 bucket for Immich originals storage.
# Requires: rclone, fuse3 (Linux) or macFUSE (macOS)
#
# Usage:
#   ./scripts/mount-s3.sh              # mount (foreground — Ctrl+C to stop)
#   ./scripts/mount-s3.sh --background # mount as daemon
#   ./scripts/mount-s3.sh --unmount    # unmount
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
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//")
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

# Resolve endpoint from region (region code or full URL)
if [[ "$REGION" =~ ^https?:// ]]; then
  ENDPOINT="$REGION"
else
  ENDPOINT="https://s3.${REGION}.scw.cloud"
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
echo "  Endpoint: $ENDPOINT"
echo "  Bucket:   $BUCKET"
echo "  Prefix:   $PREFIX"
echo ""

RCLONE_ARGS=(
  mount "$SOURCE" "$MOUNT_POINT"
  --s3-provider Scaleway
  --s3-access-key-id "$ACCESS_KEY"
  --s3-secret-access-key "$SECRET_KEY"
  --s3-endpoint "$ENDPOINT"
  --s3-region nl-ams
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
