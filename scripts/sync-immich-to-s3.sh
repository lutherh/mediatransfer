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
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//" | tr -d '\r')
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
elif $CLEANUP; then
  echo "  Source:       $LOCAL_IMMICH"
  echo "  Destination:  $DESTINATION"
  echo "  Mode:         CLEANUP (verify + delete local)"
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

# -- Check Immich is stopped (only works when Docker socket is available) --
if command -v docker &>/dev/null && docker ps --filter "name=immich_server" --format "{{.Status}}" 2>/dev/null | grep -q .; then
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

# -- Cleanup: delete local files that Immich has already indexed --
# Instead of querying S3 (slow), we use Immich's own database as the source of
# truth. A file is safe to delete locally when Immich's asset table has a record
# whose originalPath matches the on-disk path (meaning Immich imported it, and
# the original lives in S3 under transfers/).
#
# Requires: a manifest file at $ROOT_DIR/data/immich-asset-paths.txt
# Generate it BEFORE running cleanup:
#   docker exec immich_postgres psql -U immich -d immich -t -A \
#     -c "SELECT \"originalPath\" FROM asset WHERE \"deletedAt\" IS NULL;" \
#     > data/immich-asset-paths.txt
#
if $CLEANUP; then
  echo ""
  echo "======================================================="
  echo "  Cleanup: deleting local files indexed by Immich"
  echo "======================================================="
  echo ""

  # Immich stores paths like: /usr/src/app/upload/library/admin/2018/2018-12-24/file.jpg
  # Our local mount:          $LOCAL_IMMICH/library/admin/2018/2018-12-24/file.jpg
  # So we strip the Immich prefix and prepend our local root.
  IMMICH_PATH_PREFIX="/usr/src/app/upload"

  MANIFEST="$ROOT_DIR/data/immich-asset-paths.txt"

  if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: Manifest not found at $MANIFEST" >&2
    echo "  The pipeline generates this automatically." >&2
    echo "  To generate manually from the host:" >&2
    echo "    docker exec immich_postgres psql -U immich -d immich -t -A \\" >&2
    echo "      -c 'SELECT \"originalPath\" FROM asset WHERE \"deletedAt\" IS NULL;' \\" >&2
    echo "      > data/immich-asset-paths.txt" >&2
    exit 1
  fi

  manifest_count=$(wc -l < "$MANIFEST")
  echo "  Manifest: $manifest_count Immich assets"
  echo "  Immich prefix: $IMMICH_PATH_PREFIX"
  echo "  Local root:    $LOCAL_IMMICH"
  echo ""

  if [ "$manifest_count" -lt 100 ]; then
    echo "ERROR: Manifest has only $manifest_count entries — seems too low. Aborting." >&2
    exit 1
  fi

  # Build a sorted lookup file: convert Immich paths to local paths
  # /usr/src/app/upload/library/admin/... -> library/admin/...
  # Use C locale for consistent byte-level sorting (comm requires identical sort order)
  export LC_ALL=C

  TMPFILES=()
  cleanup_tmpfiles() { rm -f "${TMPFILES[@]}" 2>/dev/null; }
  trap cleanup_tmpfiles EXIT

  manifest_local=$(mktemp)
  TMPFILES+=("$manifest_local")

  sed "s|^${IMMICH_PATH_PREFIX}/||" "$MANIFEST" | grep -v '^$' | sort > "$manifest_local"
  manifest_converted=$(wc -l < "$manifest_local")
  echo "  Converted manifest: $manifest_converted relative paths"
  echo ""

  if [ "$manifest_converted" -lt 100 ]; then
    echo "ERROR: Converted manifest too small ($manifest_converted entries). Aborting." >&2
    exit 1
  fi

  cleanup_deleted=0
  cleanup_skipped=0

  for d in "${DIRS_TO_SYNC[@]}"; do
    source_dir="$LOCAL_IMMICH/$d"
    [ ! -d "$source_dir" ] && continue

    local_count=$(find "$source_dir" -type f 2>/dev/null | wc -l)
    echo "[$d] Checking $local_count local files against Immich DB..."

    # Build sorted list of local relative paths
    local_list=$(mktemp)
    TMPFILES+=("$local_list")
    # Strip the LOCAL_IMMICH prefix to get relative paths like "library/admin/2018/..."
    local_prefix="$LOCAL_IMMICH/"
    find "$source_dir" -type f | sed "s|^${local_prefix}||" | sort > "$local_list"

    local_actual=$(wc -l < "$local_list")
    if [ "$local_actual" -ne "$local_count" ]; then
      echo "  WARNING: Expected $local_count files but listed $local_actual — continuing with actual count" >&2
    fi

    # Files present in BOTH local and manifest → safe to delete
    delete_list=$(mktemp)
    TMPFILES+=("$delete_list")
    comm -12 "$local_list" "$manifest_local" > "$delete_list"

    del_count=$(grep -c . "$delete_list" || true)
    skip_count=$(comm -23 "$local_list" "$manifest_local" | grep -c . || true)

    echo "[$d] $del_count matched in Immich DB, $skip_count not found"

    if [ "$skip_count" -gt 0 ]; then
      echo "[$d] Skipped files (not in Immich DB):"
      comm -23 "$local_list" "$manifest_local" | head -20 | sed 's/^/  SKIP: /' >&2
      if [ "$skip_count" -gt 20 ]; then
        echo "  ... and $((skip_count - 20)) more" >&2
      fi
    fi

    # Delete matched files (read from file, not pipe, to avoid subshell counter issues)
    deleted_now=0
    while IFS= read -r rel_path; do
      [ -z "$rel_path" ] && continue
      target="$LOCAL_IMMICH/$rel_path"
      if [ -f "$target" ]; then
        rm -f "$target"
        deleted_now=$((deleted_now + 1))
        # Progress every 1000 files
        if [ $((deleted_now % 1000)) -eq 0 ]; then
          echo "  [$d] Deleted $deleted_now / $del_count files..."
        fi
      fi
    done < "$delete_list"

    cleanup_deleted=$((cleanup_deleted + deleted_now))
    cleanup_skipped=$((cleanup_skipped + skip_count))

    if [ "$deleted_now" -ne "$del_count" ]; then
      echo "  WARNING: Expected to delete $del_count but actually deleted $deleted_now" >&2
    fi

    # Remove empty directories left behind
    find "$source_dir" -type d -empty -delete 2>/dev/null || true

    echo "[$d] Done — deleted $deleted_now files."
  done

  echo ""
  echo "======================================================="
  echo "  Cleanup summary:"
  echo "    Deleted:  $cleanup_deleted files (in Immich DB → safe to remove)"
  echo "    Skipped:  $cleanup_skipped files (NOT in Immich DB → kept)"

  for d in "${DIRS_TO_SYNC[@]}"; do
    dir_path="$LOCAL_IMMICH/$d"
    if [ -d "$dir_path" ]; then
      remaining=$(du -sm "$dir_path" 2>/dev/null | cut -f1)
      echo "    Remaining in $d/: ${remaining:-0} MB"
    fi
  done
  echo "======================================================="

  # Clean up stale manifest after successful run
  rm -f "$MANIFEST"

  # Propagate cleanup result as exit code
  if [ "$cleanup_deleted" -eq 0 ] && [ "$cleanup_skipped" -gt 0 ]; then
    echo "  WARNING: Nothing was deleted — all local files are NOT in Immich DB." >&2
    total_errors=$((total_errors + 1))
  fi
fi

exit "$total_errors"
