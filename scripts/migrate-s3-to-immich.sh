#!/usr/bin/env bash
# Migrate photos from Scaleway S3 (transfers/) into Immich.
# Downloads in year-based batches, uploads via immich-go, then cleans up.
#
# Requires: rclone, immich-go
# Does NOT keep permanent local copies -- each batch is deleted after upload.
# Resume-safe: re-running skips years already completed.
#
# Usage:
#   ./scripts/migrate-s3-to-immich.sh
#   IMMICH_API_KEY=xxx ./scripts/migrate-s3-to-immich.sh
#   ./scripts/migrate-s3-to-immich.sh --immich-url http://localhost:2283

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# -- Defaults (overridable via env or flags) --
IMMICH_URL="${IMMICH_URL:-http://localhost:2283}"
API_KEY="${IMMICH_API_KEY:-}"
TEMP_DIR="${TMPDIR:-/tmp}/immich-migration"
IMMICH_GO="${IMMICH_GO:-immich-go}"
DONE_FILE="$SCRIPT_DIR/migration-done-years.txt"

# -- Helper: read a key from a .env file --
read_env_val() {
  local file="$1" key="$2" default="${3:-}"
  local val
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//" | tr -d '\r')
  echo "${val:-$default}"
}

# -- Parse flags --
for arg in "$@"; do
  case "$arg" in
    --immich-url=*) IMMICH_URL="${arg#*=}" ;;
    --api-key=*)    API_KEY="${arg#*=}" ;;
    --temp-dir=*)   TEMP_DIR="${arg#*=}" ;;
    --help|-h)
      echo "Usage: $0 [--immich-url=URL] [--api-key=KEY] [--temp-dir=DIR]"
      echo "  Env vars: IMMICH_URL, IMMICH_API_KEY, TEMP_DIR, IMMICH_GO"
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# -- Load S3 config from .env --
MAIN_ENV="$ROOT_DIR/.env"
if [ ! -f "$MAIN_ENV" ]; then
  echo "ERROR: .env not found at $MAIN_ENV" >&2; exit 1
fi

ACCESS_KEY=$(read_env_val "$MAIN_ENV" SCW_ACCESS_KEY)
SECRET_KEY=$(read_env_val "$MAIN_ENV" SCW_SECRET_KEY)
REGION=$(read_env_val "$MAIN_ENV" SCW_REGION "fr-par")
BUCKET=$(read_env_val "$MAIN_ENV" SCW_BUCKET)

if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
  echo "ERROR: SCW_ACCESS_KEY and SCW_SECRET_KEY must be set in .env" >&2; exit 1
fi
if [ -z "$BUCKET" ]; then
  echo "ERROR: SCW_BUCKET must be set in .env" >&2; exit 1
fi
if [ -z "$API_KEY" ]; then
  API_KEY=$(read_env_val "$MAIN_ENV" IMMICH_API_KEY)
fi
if [ -z "$API_KEY" ]; then
  echo "ERROR: IMMICH_API_KEY not set. Add it to .env or pass --api-key=KEY" >&2; exit 1
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

S3_SOURCE=":s3:${BUCKET}/transfers"
S3_FLAGS=(
  --s3-provider Scaleway
  --s3-access-key-id "$ACCESS_KEY"
  --s3-secret-access-key "$SECRET_KEY"
  --s3-endpoint "$ENDPOINT"
  --s3-region "$SIGNING_REGION"
)

# -- Pre-flight --
if ! command -v rclone &>/dev/null; then
  echo "ERROR: rclone not found. Install with: sudo apt install rclone" >&2; exit 1
fi
if ! command -v "$IMMICH_GO" &>/dev/null; then
  echo "ERROR: immich-go not found. Install from: https://github.com/simulot/immich-go" >&2; exit 1
fi

mkdir -p "$TEMP_DIR"

# Load already-completed years
completed_years=()
if [ -f "$DONE_FILE" ]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && completed_years+=("$line")
  done < "$DONE_FILE"
fi

echo "=== Immich S3 Migration ==="
echo "Source:    $S3_SOURCE"
echo "Immich:    $IMMICH_URL"
echo "Temp dir:  $TEMP_DIR"
echo ""

# List year folders from S3
echo "Listing year folders from S3..."
year_dirs=()
while IFS= read -r line; do
  dir=$(echo "$line" | awk '{print $NF}')
  [[ -n "$dir" ]] && year_dirs+=("$dir")
done < <(rclone lsd "$S3_SOURCE" "${S3_FLAGS[@]}" 2>/dev/null || true)

if [ ${#year_dirs[@]} -eq 0 ]; then
  echo "No year folders found under $S3_SOURCE"
  exit 0
fi

echo "Found years: ${year_dirs[*]}"
echo ""

is_completed() {
  local year="$1"
  for c in "${completed_years[@]}"; do
    [[ "$c" == "$year" ]] && return 0
  done
  return 1
}

for year in "${year_dirs[@]}"; do
  if is_completed "$year"; then
    echo "[$year] Already completed, skipping."
    continue
  fi

  year_temp="$TEMP_DIR/$year"

  echo "[$year] Downloading from S3..."
  if ! rclone copy "$S3_SOURCE/$year" "$year_temp" "${S3_FLAGS[@]}" --progress --transfers 8; then
    echo "[$year] ERROR: rclone download failed. Skipping." >&2
    continue
  fi

  file_count=$(find "$year_temp" -type f 2>/dev/null | wc -l)
  echo "[$year] Downloaded $file_count files. Uploading to Immich..."

  if [ "$file_count" -eq 0 ]; then
    echo "[$year] No files found, marking complete."
    echo "$year" >> "$DONE_FILE"
    continue
  fi

  # Upload to Immich with album creation based on folder names
  if "$IMMICH_GO" upload from-folder \
    --server "$IMMICH_URL" \
    --api-key "$API_KEY" \
    --folder-as-album FOLDER \
    --recursive \
    --no-ui \
    --on-errors continue \
    "$year_temp"; then

    echo "[$year] Upload complete. Cleaning up temp files..."
    rm -rf "$year_temp"
    echo "$year" >> "$DONE_FILE"
  else
    echo "[$year] WARNING: immich-go failed (exit $?). Temp files kept at: $year_temp" >&2
    echo "[$year] Re-run this script to retry." >&2
  fi
  echo "[$year] Done!"
  echo ""
done

echo ""
echo "=== Migration complete! ==="
echo "All years processed. You can delete the 'transfers/' prefix from S3 when ready."
