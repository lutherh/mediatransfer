# Plan 09 — Re-import Google Takeout from `.tgz` backup to restore missing S3 originals

> **Scope:** Old server holds a complete set of Google Takeout `.tgz` archives.
> The current Scaleway bucket `photosync/immich/...` is missing some originals
> referenced by the Immich DB (notably ~298 rows under `library/...` and any
> further gaps that emerge). Re-feed the archives through the existing
> MediaTransfer pipeline so missing files are uploaded to the canonical S3
> layout, with **zero duplication** for files already present.
>
> **Out of scope (do these separately):**
> - Regenerating Immich thumbnails / encoded-video derived files
>   (handled by Immich's `thumbnailGeneration` + `videoConversion` jobs after
>   `asset_file` cleanup — see the chat thread that produced this plan).
> - Healing the `library/...` rows whose originals never made it to S3
>   (requires [data/logs/recovery-2026-04/offline-flag-update.sql](../data/logs/recovery-2026-04/offline-flag-update.sql)
>   plus +1 row `4a61fb6e-…/IMG_8350.mov` discovered by the audit).

---

## 0. Hard rules (do not violate)

1. **Read-only mindset for `state.json`.** Never delete it without taking a `.bak` snapshot first (per AGENTS.md "things that bite").
2. **No new code unless a real gap is found.** Existing scripts cover the full pipeline. If something seems missing, search before writing.
3. **No `git commit`/`push`.** The developer handles VCS.
4. **No Python.** TypeScript via `tsx` for everything.
5. **Run on the host that already has the rclone mount alive at `data/immich-s3`.** The bound NFS mount is the single source of truth for Immich; the takeout pipeline writes via the Scaleway SDK directly (not through the mount), but other steps (verify, audit) need it.

---

## 1. Preconditions checklist

Before kicking off the upload, verify all of these. **Do not skip — each guards
against a known failure mode.**

```bash
# (a) Repo is on the canonical layout
grep -E '^SCW_PREFIX=' .env            # must be: SCW_PREFIX=immich
grep -E '^S3_BUCKET=' .env             # must be: S3_BUCKET=photosync (or your bucket)

# (b) Mount is healthy (bounded probe — never `cd` into it)
timeout 5 stat data/immich-s3 >/dev/null && echo OK || echo "MOUNT BAD"
rclone rc --unix-socket data/rclone-rc.sock vfs/stats | jq '.uploadsInProgress, .uploadsQueued, .erroredFiles'
# All three must be 0. If not, flush before doing anything:
#   rclone rc --unix-socket data/rclone-rc.sock vfs/sync

# (c) Immich is up and reachable (we'll need its API later for cleanup)
curl -sS --max-time 5 http://localhost:2283/api/server-info/ping
# expect {"res":"pong"}

# (d) Snapshot state files (idempotency safety net)
cp data/takeout/state.json   data/takeout/state.json.pre-reimport-$(date +%s).bak
cp data/takeout/auto-upload.json data/takeout/auto-upload.json.pre-reimport-$(date +%s).bak 2>/dev/null || true

# (e) Make sure tsx + deps are installed
npm ci

# (f) Lint + tests still pass on this branch (per LLM_INSTRUCTIONS.md)
npm run lint
npx vitest run
```

If any check fails, **stop** and surface the failure to the user.

---

## 2. Stage the backup archives

The old server's archives must be reachable as a single input directory of
`.tgz` files. Two options:

**Option A — local copy (recommended if disk space allows):**
```bash
# pick a stable location outside data/ to avoid the takeout pipeline
# accidentally treating its own input as work output
mkdir -p ./backup-tgz
rsync -av --info=progress2 user@old-host:/path/to/takeout-archives/ ./backup-tgz/
INPUT_DIR="$(pwd)/backup-tgz"
```

**Option B — mount over SSHFS / external volume:**
```bash
INPUT_DIR=/Volumes/old-backup/takeout-archives   # whatever the path is
```

Sanity-check the input:
```bash
find "$INPUT_DIR" -maxdepth 1 -name 'takeout-*.tgz' | wc -l   # >0
du -sh "$INPUT_DIR"
```

---

## 3. Decide on `state.json` strategy

Three modes, in order of preference:

1. **Keep current `state.json` (default, fastest).**
   The catalog records every key already uploaded. Re-running with the same
   archives + same paths will hit `already_uploaded_in_state` for the bulk and
   only upload genuinely missing keys. Use this unless you have reason to
   distrust the catalog.

2. **Merge old + current state.** Only relevant if the old server has a
   `state.json` with entries the current one lacks. Generally not needed —
   S3 existence is checked anyway as a fallback.

3. **Discard `state.json` (slowest, fully correct).**
   Forces every file to be re-checked against S3 via `HeadObject`. Use only
   if the catalog is suspected corrupt. With ~46k existing keys this adds
   ~46k HEADs (~2-5 minutes against Scaleway).
   ```bash
   mv data/takeout/state.json data/takeout/state.json.discarded-$(date +%s).bak
   ```

**Default: mode 1.** Document the chosen mode in your run log.

---

## 4. Dry-run / sizing pass

Before committing IO, see what the pipeline thinks the gap is.

```bash
# Scan + plan, do not upload yet
npx tsx scripts/takeout-scan.ts --input-dir "$INPUT_DIR" --plan-only 2>&1 | tee /tmp/takeout-plan.log
```

If `--plan-only` is not yet a flag on `takeout-scan.ts`, the equivalent is:
```bash
npx tsx scripts/takeout-scan.ts --input-dir "$INPUT_DIR"     # builds work/normalized/
# then count what would actually upload:
npx tsx scripts/takeout-verify.ts --report-pending             # if available
# fallback: read work/manifest.json and grep for status != 'uploaded'
```

Expected outcome: a small fraction of files (the genuine S3 gaps + anything
new) will be marked pending. Anything close to 100% pending means
`state.json` was wiped or paths drifted — investigate before continuing.

Record the pending count for post-run verification.

---

## 5. Upload

```bash
npx tsx scripts/takeout-upload.ts 2>&1 | tee data/logs/takeout-reimport-$(date +%Y%m%d-%H%M).log
```

Behavioural guarantees from the code (verified 2026-04-29):

- Destination key built in [src/takeout/manifest.ts](../src/takeout/manifest.ts)
  as `s3transfers/YYYY/MM/DD/<sanitized_relative_path>`.
- Final S3 key prefixed with `SCW_PREFIX` in
  [src/providers/scaleway.ts](../src/providers/scaleway.ts) →
  `immich/s3transfers/...`.
- Resulting bucket layout: `photosync/immich/s3transfers/YYYY/MM/DD/...` —
  the canonical Immich-compatible path Immich already reads via the rclone
  mount at `/usr/src/app/upload/s3transfers/...`.
- Skip rules:
  - `state.json[key].status === 'uploaded'` → skip with reason
    `already_uploaded_in_state`.
  - else `HeadObject(key)` succeeds → skip with reason
    `already_exists_in_destination`.
- Single-threaded by design. Resume-safe ([takeout-resume.ts](../scripts/takeout-resume.ts)).

If the run is interrupted:
```bash
npx tsx scripts/takeout-resume.ts
```

---

## 6. Verify

Two complementary checks. Run **both**.

```bash
# (a) Manifest ↔ S3: every state-marked-uploaded key must exist on S3
#     with matching size.
npx tsx scripts/takeout-verify-s3.ts 2>&1 | tee /tmp/takeout-verify-s3.log

# (b) Manifest ↔ DB: every Immich asset whose originalPath points under
#     /usr/src/app/upload/s3transfers/... must resolve to a real file
#     through the mount.
docker exec immich_postgres psql -U immich -d immich -tAc "
  SELECT \"originalPath\" FROM asset
  WHERE \"deletedAt\" IS NULL
    AND \"originalPath\" LIKE '/usr/src/app/upload/s3transfers/%'
  ORDER BY random() LIMIT 200
" | docker exec -i immich_server bash -lc '
  miss=0 ok=0
  while read p; do [ -f "$p" ] && ok=$((ok+1)) || miss=$((miss+1)); done
  echo "ok=$ok miss=$miss"
'
```

**Pass criteria:**
- `takeout-verify-s3` reports 0 missing, 0 size-mismatched.
- DB sample reports `miss=0`.

If either fails, stop and read [data/logs/recovery-2026-04/recovery-report.md](../data/logs/recovery-2026-04/recovery-report.md)
for the SHA1-based recovery procedure already used for `library/...` rows.

---

## 7. Reset Immich's `isOffline` flag for healed assets (if any)

Any rows previously flagged offline because their original was missing must be
un-flagged so Immich serves them again. This must run **after** verify passes.

```bash
# Identify candidates (assets whose originalPath now resolves)
docker exec immich_postgres psql -U immich -d immich -c "
SELECT id, \"originalPath\"
FROM asset
WHERE \"isOffline\" = true
  AND \"originalPath\" LIKE '/usr/src/app/upload/s3transfers/%'
LIMIT 20;
"

# After confirming the file actually exists on the mount for those paths,
# clear the flag in bulk. Save the SQL to data/logs/ first for audit.
docker exec -i immich_postgres psql -U immich -d immich <<'SQL'
UPDATE asset SET "isOffline" = false
WHERE "isOffline" = true
  AND "originalPath" LIKE '/usr/src/app/upload/s3transfers/%';
SQL
```

(Do **not** touch `library/...` offline rows from this plan — they're owned by
[offline-flag-update.sql](../data/logs/recovery-2026-04/offline-flag-update.sql).)

---

## 8. Trigger Immich to backfill derived files for the healed assets

Re-uploading originals does **not** create thumbnails or encoded-videos
automatically. Kick the queues:

```bash
KEY=$(grep -E '^IMMICH_ADMIN_API_KEY=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
for q in thumbnailGeneration metadataExtraction videoConversion; do
  curl -sS -X PUT \
    -H "x-api-key: $KEY" -H 'Content-Type: application/json' \
    -d '{"command":"start","force":false}' \
    "http://localhost:2283/api/jobs/$q"
  echo
done
```

Watch progress:
```bash
watch -n5 '
docker exec immich_redis redis-cli LLEN immich_bull:thumbnailGeneration:wait
docker exec immich_redis redis-cli LLEN immich_bull:thumbnailGeneration:active
docker exec immich_redis redis-cli ZCARD immich_bull:thumbnailGeneration:failed
'
```

`force:false` is mandatory — `force:true` would re-download every original
from Scaleway (egress + time).

---

## 9. Manual verification gate (per LLM_INSTRUCTIONS.md)

Stop here and have the user confirm in the Immich UI / mobile app:

- [ ] No `ENOENT` errors in `docker logs immich_server` for newly-restored
      paths.
- [ ] Mobile timeline scrolls without `PlatformException(Failed to decode
      image…)` for the previously-broken assets.
- [ ] `takeout-verify-s3.ts` exit code is 0 in the final run.
- [ ] No new entries in `data/logs/s3mount.err.log` correlated with the run.

Only after the user signs off, mark the plan complete in `PLAN.md`.

---

## 10. Cleanup

```bash
# Remove the temporary backup-tgz/ if you copied locally
# (do NOT delete the source on the old server — that's the only golden copy)
rm -rf ./backup-tgz   # only if step 9 passed AND user confirms

# Old state.json snapshots can be pruned after the user is confident
ls -la data/takeout/state.json.pre-reimport-*.bak
```

`takeout-cleanup.ts` will refuse to delete `work/normalized/` if any manifest
entry is `failed` — trust it.

---

## Quick reference card

```bash
# One-liner happy path (assumes preconditions all green, state.json kept):
INPUT_DIR=/path/to/tgz-backups
cp data/takeout/state.json data/takeout/state.json.pre-reimport-$(date +%s).bak
npx tsx scripts/takeout-scan.ts   --input-dir "$INPUT_DIR"
npx tsx scripts/takeout-upload.ts | tee data/logs/takeout-reimport-$(date +%Y%m%d-%H%M).log
npx tsx scripts/takeout-verify-s3.ts
```

## Verified facts (audit 2026-04-29)

- Bucket layout `photosync/immich/{library,upload,s3transfers,_thumbs}` confirmed live via rclone.
- `SCW_PREFIX=immich` in `.env`, no path drift.
- `asset.checksum` populated → SHA1-based dedup is wired in Immich; byte-identical re-uploads are skipped at the API layer too.
- Pipeline writes to `s3transfers/`, **not** `library/` or `upload/`. Immich reads all three through the same NFS bind, so any DB row whose `originalPath` is under `/usr/src/app/upload/s3transfers/...` will be healed by this plan.
- Pipeline is **single-writer**, **idempotent**, and **resume-safe**.
