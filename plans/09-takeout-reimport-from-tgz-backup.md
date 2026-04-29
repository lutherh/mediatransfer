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

## 0a. Pre-reimport bug fixes landed 2026-04-29

The following bugs in the takeout pipeline were found by parallel agent
review and fixed before this plan was first executed. All four ship with a
shared regression test at
[src/regression/takeout-pipeline-bugs.test.ts](../src/regression/takeout-pipeline-bugs.test.ts).

| # | Bug | Fix |
|---|-----|-----|
| B1 | `objectExists()` used `list({maxResults: 20})` \u2014 false-negative on dense prefixes (\u226520 sibling keys lex-below the target) | `ScalewayProvider.head()` exact-key `HeadObject` probe; `list()` widened to `maxResults: 1000` as fallback. See [src/providers/scaleway.ts](../src/providers/scaleway.ts), [src/takeout/uploader.ts](../src/takeout/uploader.ts). |
| B2 | `persistManifestJsonl` was a non-atomic `fs.writeFile` \u2014 a crash mid-write would leave a truncated manifest. The `StateCheckpointManager` flush also wiped the dirty flag *after* the in-flight write, silently dropping markDirty calls that arrived during persist. | Shared [src/utils/fs-atomic.ts](../src/utils/fs-atomic.ts) helper with unique tmp suffixes; `enqueueFlush` now snapshots-and-clears `dirty` synchronously so concurrent markDirty calls correctly trigger a follow-up write. |
| B3 | Sanitiser did not NFC-normalise \u2014 macOS NFD filenames (`e + combining acute`) and Linux NFC (`\u00e9`) produced different keys for the same logical file, leading to silent duplicates. | `sanitizeRelativePath` now `.normalize('NFC')` before per-segment processing. |
| B4 | Sanitiser allowed `.` and `..` segments and empty segments through \u2014 latent path-traversal class. | Reject `.`, `..`, and empty segments; replace with `_`. Runner also logs a warning when distinct relative paths collide on the same destination key. |

**Backwards-compatibility note:** the per-character ASCII allow-list
`[^a-zA-Z0-9._-] \u2192 _` was deliberately preserved. Widening to
`\\p{L}\\p{N}` would have produced different keys for non-ASCII filenames
and broken dedup against the ~46k objects already in S3 under
ASCII-mangled names. The existing test asserts
`'My File (1).jpg' \u2192 'My_File__1_.jpg'` (double underscore) to pin this
shape.

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

# (d) Snapshot state files (idempotency safety net) — snapshot ALL pipeline
#     state, not just state.json. archive-state.json + manifest.jsonl are
#     equally critical for resume.
TS=$(date +%s)
cp data/takeout/state.json                        data/takeout/state.json.pre-reimport-${TS}.bak
cp data/takeout/auto-upload.json                  data/takeout/auto-upload.json.pre-reimport-${TS}.bak 2>/dev/null || true
cp data/takeout/work/archive-state.json           data/takeout/work/archive-state.json.pre-reimport-${TS}.bak 2>/dev/null || true
cp data/takeout/work/manifest.jsonl               data/takeout/work/manifest.jsonl.pre-reimport-${TS}.bak 2>/dev/null || true
cp data/takeout/google-api-state.json             data/takeout/google-api-state.json.pre-reimport-${TS}.bak 2>/dev/null || true

# (e) Bucket versioning precheck — re-uploading over existing keys with
#     versioning OFF will overwrite irrecoverably. Confirm state matches
#     your expectation before proceeding.
AWS_ACCESS_KEY_ID=$(grep -E '^SCW_ACCESS_KEY=' .env | cut -d= -f2-) \
AWS_SECRET_ACCESS_KEY=$(grep -E '^SCW_SECRET_KEY=' .env | cut -d= -f2-) \
  aws --endpoint-url "$(grep -E '^SCW_ENDPOINT=' .env | cut -d= -f2-)" \
      s3api get-bucket-versioning --bucket "$(grep -E '^S3_BUCKET=' .env | cut -d= -f2-)"
# Expected: {"Status": "Enabled"} or empty (= unversioned). The dedup logic
# below means we should never *overwrite* an existing key in the happy path,
# but record the result for the run log.

# (f) Make sure tsx + deps are installed
npm ci

# (g) Lint + tests still pass on this branch (per LLM_INSTRUCTIONS.md)
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

### 2a. External HDD source (slow disk, limited local space)

When `INPUT_DIR` lives on a slow external HDD (e.g.
`/Volumes/Data/archive-already-uploaded`) and there is **not** enough local
space to extract every archive at once, you must rely on the
*incremental* runner — never the one-shot scan. The incremental flow only
keeps **one extracted archive on disk at a time** and deletes it after a
clean upload (see
[src/takeout/incremental.ts](../src/takeout/incremental.ts)).

**Hard rules for this layout:**

1. `TAKEOUT_WORK_DIR` MUST be on the local SSD, never on the HDD. Random
   fs reads during manifest build + multipart upload destroy HDD throughput
   (and shorten its life). The `.tgz` files on the HDD are read **once,
   sequentially** during extract — that is the HDD's best case.
2. Free space on the SSD must exceed the largest individual `.tgz`
   uncompressed (typically ~10–50 GB for a Takeout slice). Verify before
   starting:
   ```bash
   df -h "$(pwd)/data/takeout/work"
   # Largest archive uncompressed estimate (sum of compressed × ~1.05 for media):
   ls -lhS "$INPUT_DIR" | head -5
   ```
   Recommend ≥ 60 GB free.
3. **Do NOT pass `--delete-archive` or `--move-archive`.** The HDD is your
   only backup copy — the runner default leaves the source `.tgz` files
   untouched.
4. If the Mac thermal-throttles during HEIC conversion or the HDD bus
   saturates, drop concurrency: `--concurrency 2`. Default `4` is fine on
   most machines.

**Recommended invocation:**
```bash
INPUT_DIR=/Volumes/Data/archive-already-uploaded

npx tsx scripts/takeout-process.ts \
  --input-dir "$INPUT_DIR" \
  --work-dir "$(pwd)/data/takeout/work" \
  --concurrency 4 \
  2>&1 | tee data/logs/takeout-reimport-$(date +%Y%m%d-%H%M).log
```

Per-archive cycle (verified in
[src/takeout/incremental.ts](../src/takeout/incremental.ts) lines 230–342):

1. Extract one `.tgz` from the HDD into `${workDir}/temp-extract` (SSD).
2. Build manifest, persist archive metadata under
   `${workDir}/metadata/<archive>.json`.
3. Upload via Scaleway SDK at `UPLOAD_CONCURRENCY` parallelism. Each entry
   passes through the B1-fixed dedup probe
   (`state.json` → `provider.head()` → list fallback) before any bytes
   leave the SSD.
4. On `failed === 0`, `cleanupDir(extractDir)` wipes the SSD scratch.
   On any failure the extract is preserved for inspection and the archive
   is marked `failed` in `archive-state.json`. Re-running resumes from
   `pending` archives only.

**Network sanity check before starting** (HDD throughput is rarely the
bottleneck — Scaleway egress is):
```bash
curl -sS -o /dev/null -w 'TTFB %{time_starttransfer}s  total %{time_total}s  speed %{speed_download} B/s\n' \
  "https://s3.${SCW_REGION:-nl-ams}.scw.cloud"
```

**Multipart hygiene (HDD runs are long → more chance of Ctrl-C):**
```bash
# Before the run — establish baseline
AWS_ACCESS_KEY_ID=$(grep -E '^SCW_ACCESS_KEY=' .env | cut -d= -f2-) \
AWS_SECRET_ACCESS_KEY=$(grep -E '^SCW_SECRET_KEY=' .env | cut -d= -f2-) \
  aws --endpoint-url "$(grep -E '^SCW_ENDPOINT=' .env | cut -d= -f2-)" \
      s3api list-multipart-uploads --bucket "$(grep -E '^S3_BUCKET=' .env | cut -d= -f2-)" \
      > /tmp/mpu-before.json

# After the run — abort anything older than the run start, since the
# uploader has no SIGINT handler and orphans cost storage.
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
   Forces every file to be re-checked against S3. The current uploader
   (post-2026-04 fix) prefers an exact-key `HeadObject` probe via
   `ScalewayProvider.head()` and falls back to a bulk `ListObjectsV2`
   prefix preload, then per-key `head()`. Cost ≈ ~46k HEADs (~2-5 minutes
   against Scaleway, mostly hidden by the prefix preload coalescing
   sibling lookups). Use only if the catalog is suspected corrupt.
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
  - else exact-key `HeadObject(key)` returns 200 (preferred) or the bulk
    prefix preload contains the key → skip with reason
    `already_exists_in_destination`.
- **Concurrency:** controlled by `UPLOAD_CONCURRENCY` (default `4` in
  [.env](../.env), see [src/takeout/uploader.ts](../src/takeout/uploader.ts)).
  Set to `1` if you need strict serialisation. Resume-safe
  ([takeout-resume.ts](../scripts/takeout-resume.ts)).
- **Do NOT pass `--move-archives` or `--delete-archives`.** This is a
  re-import from a backup; the source archives are the recovery copy.
  Moving/deleting them risks losing the only good copy if the run aborts
  mid-stream and we need to retry from scratch.
- **No SIGINT handler.** Ctrl-C during a multipart upload may leave
  orphaned upload IDs in the bucket. Prefer letting the run finish; if you
  must abort, follow up with:
  ```bash
  aws --endpoint-url "$SCW_ENDPOINT" s3api list-multipart-uploads --bucket "$S3_BUCKET"
  ```
  and abort any uploads older than the run start time.

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
