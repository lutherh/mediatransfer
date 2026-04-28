#!/usr/bin/env bash
# Backdate every Immich asset whose originalPath contains an `unknown-date`
# segment so they sort to the bottom of the timeline instead of polluting
# the "recent" view.
#
# Re-run this any time MediaTransfer imports more undated items.
#
# Usage:
#   ./scripts/immich-sink-unknown-date.sh
set -euo pipefail

CONTAINER=${IMMICH_DB_CONTAINER:-immich_postgres}
DB_USER=${IMMICH_DB_USER:-immich}
DB_NAME=${IMMICH_DB_NAME:-immich}
EPOCH='1970-01-01 00:00:00+00'

read -r -d '' SQL <<SQL || true
BEGIN;
UPDATE asset
   SET "fileCreatedAt" = '${EPOCH}',
       "localDateTime" = '${EPOCH}'
 WHERE ("originalPath" LIKE '%/unknown-date/%'
        OR "originalPath" LIKE '%/unknown-date')
   AND "fileCreatedAt" <> '${EPOCH}';
SELECT count(*) AS sunk
  FROM asset
 WHERE "fileCreatedAt" = '${EPOCH}';
COMMIT;
SQL

docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<<"$SQL"
