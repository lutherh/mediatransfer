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
#   ./scripts/sync-immich-to-s3.sh --cleanup    # delete local files already verified in S3
#
# S3 credentials are read from .env (same as mount scripts).
# No rclone remote or rclone.conf is needed.
# Immich should be STOPPED during sync to avoid writes to local path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

EXECUTE=false
VERIFY=false
CLEANUP=false
for arg in "$@"; do
  case "$arg" in
    --execute|-e) EXECUTE=true ;;
    --verify|-v)  VERIFY=true ;;
    --cleanup|-c) CLEANUP=true ;;
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
elif ! $EXECUTE && ! $CLEANUP; then
  echo "  DRY RUN complete -- no changes made."
  echo "  Run with --execute to sync, or --execute --verify to sync + verify."
else
  echo "  SYNC COMPLETE -- all files uploaded to S3."
fi
echo "======================================================="

# -- Cleanup: delete local files verified in S3 --
if $CLEANUP; then
  echo ""
  echo "======================================================="
  echo "  Cleanup: deleting local files verified in S3"
  echo "======================================================="
  echo ""

  cleanup_deleted=0
  cleanup_skipped=0
  cleanup_errors=0

  for d in "${DIRS_TO_SYNC[@]}"; do
    source_dir="$LOCAL_IMMICH/$d"
    [ ! -d "$source_dir" ] && continue

    dest="$DESTINATION/$d"
    echo "[$d] Verifying before cleanup..."

    # Run rclone check first — abort cleanup for this dir if ANY file fails
    if ! rclone check "$source_dir" "$dest" \
        "${S3_FLAGS[@]}" \
        --one-way --fast-list --log-level INFO 2>&1; then
      echo "[$d] Verification FAILED — skipping cleanup for this directory." >&2
      cleanup_errors=$((cleanup_errors + 1))
      continue
    fi

    echo "[$d] Verification passed. Building S3 manifest..."

    # Build a manifest of all S3 files in one call (much faster than per-file lsl)
    s3_manifest=$(mktemp)
    if ! rclone lsl "$dest" "${S3_FLAGS[@]}" --fast-list > "$s3_manifest" 2>/dev/null; then
      echo "[$d] ERROR: Failed to list S3 contents — skipping cleanup for this directory." >&2
      rm -f "$s3_manifest"
      cleanup_errors=$((cleanup_errors + 1))
      continue
    fi

    echo "[$d] Deleting local files verified in S3..."

    # Delete files one by one, checking each against the S3 manifest
    while IFS= read -r -d '' local_file; do
      rel_path="${local_file#"$source_dir"/}"
      local_size=$(stat -c '%s' "$local_file" 2>/dev/null || stat -f '%z' "$local_file" 2>/dev/null || true)

      if [ -z "$local_size" ]; then
        echo "  SKIP: $rel_path — cannot read local file size" >&2
        cleanup_skipped=$((cleanup_skipped + 1))
        continue
      fi

      # Look up file in the S3 manifest (rclone lsl format: "  SIZE DATE TIME PATH")
      # Use awk for exact path matching (handles spaces, dots, special chars)
      remote_size=$(awk -v path="$rel_path" '{
        fname=""; for(i=4;i<=NF;i++) fname=(fname?fname" ":"")$i
        if(fname==path){print $1; exit}
      }' "$s3_manifest" || true)

      if [ -z "$remote_size" ]; then
        echo "  SKIP: $rel_path — not found in S3" >&2
        cleanup_skipped=$((cleanup_skipped + 1))
        continue
      fi

      if [ "$local_size" != "$remote_size" ]; then
        echo "  SKIP: $rel_path — size mismatch (local=${local_size}, S3=${remote_size})" >&2
        cleanup_skipped=$((cleanup_skipped + 1))
        continue
      fi

      rm -f "$local_file"
      cleanup_deleted=$((cleanup_deleted + 1))
    done < <(find "$source_dir" -type f -print0)

    rm -f "$s3_manifest"

    # Remove empty directories left behind
    find "$source_dir" -type d -empty -delete 2>/dev/null || true

    echo "[$d] Cleanup done."
  done

  echo ""
  echo "======================================================="
  echo "  Cleanup summary:"
  echo "    Deleted:  $cleanup_deleted files"
  echo "    Skipped:  $cleanup_skipped files (not in S3 or size mismatch)"
  echo "    Errors:   $cleanup_errors directories skipped entirely"

  for d in "${DIRS_TO_SYNC[@]}"; do
    dir_path="$LOCAL_IMMICH/$d"
    if [ -d "$dir_path" ]; then
      remaining=$(du -sm "$dir_path" 2>/dev/null | cut -f1)
      echo "    Remaining in $d/: ${remaining:-0} MB"
    fi
  done
  echo "======================================================="
fi

exit "$total_errors"
