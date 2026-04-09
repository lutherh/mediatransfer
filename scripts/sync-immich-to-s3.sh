#!/usr/bin/env bash
# Sync existing local Immich library to S3 before enabling the rclone mount.
#
# Uploads library/ and upload/ from local data/immich/ to s3://bucket/immich/
# so that Immich's DB references still resolve after UPLOAD_LOCATION points to S3.
#
# Usage:
#   ./scripts/sync-immich-to-s3.sh              # dry run (default)
#   ./scripts/sync-immich-to-s3.sh --execute    # actually sync
#   ./scripts/sync-immich-to-s3.sh --execute --verify  # sync + verify checksums
#
# S3 credentials are read from .env (same as mount scripts).
# No rclone remote or rclone.conf is needed.
# Immich should be STOPPED during sync to avoid writes to local path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

EXECUTE=false
VERIFY=false
for arg in "$@"; do
  case "$arg" in
    --execute|-e) EXECUTE=true ;;
    --verify|-v)  VERIFY=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# -- Helper: read a key from a .env file --
read_env_val() {
  local file="$1" key="$2" default="${3:-}"
  local val
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//")
  echo "${val:-$default}"
}

# -- Load config --
MAIN_ENV="$ROOT_DIR/.env"
IMMICH_ENV="$ROOT_DIR/.env.immich"

if [ ! -f "$MAIN_ENV" ]; then
  echo "ERROR: .env not found at $MAIN_ENV" >&2; exit 1
fi
if [ ! -f "$IMMICH_ENV" ]; then
  echo "ERROR: .env.immich not found at $IMMICH_ENV -- copy from .env.immich.example first." >&2; exit 1
fi

ACCESS_KEY=$(read_env_val "$MAIN_ENV" SCW_ACCESS_KEY)
SECRET_KEY=$(read_env_val "$MAIN_ENV" SCW_SECRET_KEY)
REGION=$(read_env_val "$MAIN_ENV" SCW_REGION "fr-par")
STORAGE_CLASS=$(read_env_val "$MAIN_ENV" SCW_STORAGE_CLASS)

if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
  echo "ERROR: SCW_ACCESS_KEY and SCW_SECRET_KEY must be set in .env" >&2; exit 1
fi

if [[ "$REGION" =~ ^https?:// ]]; then
  ENDPOINT="$REGION"
  SIGNING_REGION=$(echo "$REGION" | sed -n 's|.*s3\.\([a-z0-9-]*\)\.scw\.cloud.*|\1|p')
  if [ -z "$SIGNING_REGION" ]; then
    echo "ERROR: Cannot derive signing region from endpoint URL: $REGION" >&2; exit 1
  fi
else
  ENDPOINT="https://s3.${REGION}.scw.cloud"
  SIGNING_REGION="$REGION"
fi

BUCKET=$(read_env_val "$IMMICH_ENV" RCLONE_BUCKET "$(read_env_val "$MAIN_ENV" SCW_BUCKET)")
PREFIX=$(read_env_val "$IMMICH_ENV" RCLONE_PREFIX "immich")
LOCAL_IMMICH="$ROOT_DIR/data/immich"

DESTINATION=":s3:${BUCKET}/${PREFIX}"

S3_FLAGS=(
  --s3-provider Scaleway
  --s3-access-key-id "$ACCESS_KEY"
  --s3-secret-access-key "$SECRET_KEY"
  --s3-endpoint "$ENDPOINT"
  --s3-region "$SIGNING_REGION"
)
if [ -n "$STORAGE_CLASS" ]; then
  S3_FLAGS+=(--s3-storage-class "$STORAGE_CLASS")
fi

# -- Pre-flight --
echo "======================================================="
echo "  Immich Local -> S3 Migration"
echo "======================================================="
echo ""
if $EXECUTE; then
  echo "  Source:       $LOCAL_IMMICH"
  echo "  Destination:  $DESTINATION"
  echo "  Mode:         EXECUTE"
else
  echo "  Source:       $LOCAL_IMMICH"
  echo "  Destination:  $DESTINATION"
  echo "  Mode:         DRY RUN"
fi
echo ""

if [ ! -d "$LOCAL_IMMICH" ]; then
  echo "ERROR: Local Immich directory not found: $LOCAL_IMMICH" >&2; exit 1
fi

DIRS_TO_SYNC=(library upload)
SKIPPED_DIRS=(thumbs encoded-video profile backups)

echo "Directories to sync to S3:"
for d in "${DIRS_TO_SYNC[@]}"; do
  dir_path="$LOCAL_IMMICH/$d"
  if [ -d "$dir_path" ]; then
    count=$(find "$dir_path" -type f | wc -l)
    size=$(du -sm "$dir_path" 2>/dev/null | cut -f1)
    echo "  + $d/  ($count files, ${size:-0} MB)"
  else
    echo "  - $d/  (not found -- skipping)"
  fi
done
echo ""
echo "Directories staying local (NOT synced):"
for d in "${SKIPPED_DIRS[@]}"; do
  echo "  - $d/"
done
echo ""

# -- Check Immich is stopped --
if docker ps --filter "name=immich_server" --format "{{.Status}}" 2>/dev/null | grep -q .; then
  echo "WARNING: Immich server is running. Stop it first to avoid inconsistencies:"
  echo "  docker compose -f docker-compose.immich.yml down"
  echo ""
  if $EXECUTE; then
    read -rp "Continue anyway? (y/N) " answer
    if [ "$answer" != "y" ]; then
      echo "Aborted."; exit 1
    fi
  fi
fi

# -- Sync each directory --
total_errors=0

for d in "${DIRS_TO_SYNC[@]}"; do
  source_dir="$LOCAL_IMMICH/$d"
  if [ ! -d "$source_dir" ]; then
    echo "[$d] Skipping -- directory does not exist."
    continue
  fi

  dest="$DESTINATION/$d"
  echo ""
  echo "[$d] Syncing $source_dir -> $dest"

  rclone_args=(
    sync "$source_dir" "$dest"
    "${S3_FLAGS[@]}"
    --progress
    --transfers 8
    --checkers 16
    --s3-chunk-size 16M
    --s3-upload-concurrency 4
    --fast-list
    --log-level INFO
    --stats 10s
    --stats-one-line
  )

  if ! $EXECUTE; then
    rclone_args+=(--dry-run)
    echo "[$d] DRY RUN -- no files will be copied."
  fi

  if rclone "${rclone_args[@]}"; then
    echo "[$d] Sync completed."
  else
    echo "[$d] rclone exited with error." >&2
    total_errors=$((total_errors + 1))
  fi
done

# -- Verification --
if $VERIFY && $EXECUTE; then
  echo ""
  echo "======================================================="
  echo "  Verification: comparing checksums"
  echo "======================================================="

  for d in "${DIRS_TO_SYNC[@]}"; do
    source_dir="$LOCAL_IMMICH/$d"
    [ ! -d "$source_dir" ] && continue

    dest="$DESTINATION/$d"
    echo ""
    echo "[$d] Checking $source_dir <-> $dest"

    if rclone check "$source_dir" "$dest" \
        "${S3_FLAGS[@]}" \
        --one-way --fast-list --log-level INFO; then
      echo "[$d] Verification PASSED."
    else
      echo "[$d] Verification FAILED -- some files differ." >&2
      total_errors=$((total_errors + 1))
    fi
  done
fi

# -- Summary --
echo ""
echo "======================================================="
if [ "$total_errors" -gt 0 ]; then
  echo "  COMPLETED with $total_errors error(s). Review the log above."
elif ! $EXECUTE; then
  echo "  DRY RUN complete -- no changes made."
  echo "  Run with --execute to sync, or --execute --verify to sync + verify."
else
  echo "  SYNC COMPLETE -- all files uploaded to S3."
  echo ""
  echo "  Next steps:"
  echo "    1. Run the verify script:  npx tsx scripts/verify-s3-immich-compat.ts"
  echo "    2. Start the S3 mount:     ./scripts/mount-s3.sh"
  echo "    3. Start Immich:           docker compose -f docker-compose.immich.yml up -d"
  echo "    4. Verify Immich works (browse photos, check for missing thumbnails)"
  echo "    5. Once confirmed, you can delete local originals:"
  echo "       rm -rf data/immich/library data/immich/upload"
fi
echo "======================================================="

exit "$total_errors"
