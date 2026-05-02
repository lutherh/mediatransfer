# Plan 10 — Immich thumbnail/preview recovery runbook

> **Scope:** ~85,000 thumbnail+preview files referenced by `asset_file` rows are
> **missing** from the local-disk thumbs directory (`data/immich/thumbs`). Immich
> server logs flood with `ENOENT` on every grid render and the timeline shows
> "Error loading image" tiles for the vast majority of assets. This plan
> orchestrates a controlled regeneration via Immich's job queue.
>
> **Decision (per parallel agent review, 2026-05-02):** do **NOT** retune rclone
> (option A from the diagnosis chat). The bottleneck is the Immich worker, not
> rclone reads, and the rclone setup is going away when the planned **local-NAS
> migration** lands. This runbook is structured so every phase except *Phase 0*
> survives the NAS migration verbatim.
>
> **Out of scope:**
> - Switching `--vfs-cache-mode` to `full` (rejected: marginal speedup, real
>   data-loss footgun, throwaway when NAS lands).
> - Migrating storage to NAS (separate plan, future).
> - Healing the 1,155 assets whose original files never made it to S3 (already
>   covered by [plans/09-takeout-reimport-from-tgz-backup.md](09-takeout-reimport-from-tgz-backup.md)).
> - Fixing `immich_machine_learning` health (orthogonal — does NOT affect
>   thumbnails).

---

## 0. Hard rules (do not violate)

1. **Never `git commit`/`push`** — developer handles VCS.
2. **Never unmount or restart rclone without `vfs/sync` first** — see
   [memories/repo/rclone-vfs-cache-incident-2026-04.md](rclone-vfs-cache-incident-2026-04). The
   launchagent already enforces this; manual interventions must too.
3. **Do NOT click "Run" on `storage-template-migration`** in the Bull-Board UI.
   The single waiting job is harmless; draining it during the backfill would
   rewrite ~42k S3 keys via writeback rclone — exactly the wrong workload right
   now.
4. **Backfill writes only land on local disk** (`data/immich/thumbs`,
   `data/immich/encoded-video`). No Scaleway egress for thumbs themselves.
5. **Do NOT delete `asset_file` rows blindly** to "force" regeneration. Use the
   admin "All" job instead — see Phase 1 branch decision.

---

## 1. Pre-flight facts (snapshot 2026-05-02)

| Metric | Value |
|---|---|
| Active assets in DB | 42,645 |
| Active videos | 6,705 |
| Assets with NO `asset_file` thumbnail row | **1,155** |
| Assets with NO `asset_file` preview row | **1,155** |
| `asset_file` rows total (active assets) | 86,887 |
| Files actually on `data/immich/thumbs` | 171 (~25 MB) |
| **Files missing on disk** (rows exist but file gone) | **~85,000+** |
| `data/immich/thumbs` filesystem | local SSD on `/dev/disk1s1`, 402 GiB free |
| rclone mount | NFS, `--vfs-cache-mode writes`, healthy |
| Sample read latency `head -c 4 KB` from S3 | ~9 s cold (one round-trip) |
| Sample thumb size | ~16–32 KB `_thumbnail.webp`; preview ~50–500 KB |
| Disk needed for full regen (87k files × ~80 KB avg) | ~7 GB (well under 402 GiB free) |
| Stale `storage-template-migration` waiting job | 1 (id `068033fd-…`), source=upload, NOT to be drained now |
| Immich version | as deployed in [docker-compose.immich.yml](../docker-compose.immich.yml) |

---

## 2. Branch decision: which Immich job to trigger

Immich's **"Missing"** job for `Thumbnail Generation` regenerates only when an
`asset_file` row is absent for the asset. In our case, **most assets already
have `asset_file` rows pointing to nonexistent files** — so "Missing" will only
help the 1,155 truly orphaned assets, leaving ~41k still broken.

The **"All"** variant force-regenerates for every asset and overwrites stale
rows. This is what we need.

> **Branch chosen: "All" for both Thumbnail Generation and (optionally)
> Video Conversion.** "Missing" alone is insufficient.

Risk of "All": writes ~87k local files and re-reads ~42k originals from S3 via
rclone. Estimated duration **4–10 hours** wall-clock, dominated by Immich worker
concurrency, not rclone. Egress ~210 GB (free under Scaleway's 75 GB/month tier
+ ~€0.01/GB beyond ≈ €1.35 worst-case).

---

## 3. Phases

### Phase 0 — Pre-flight (rclone era; deleted post-NAS)

- [ ] **0.1** Confirm rclone mount is healthy and not stuck:
  ```bash
  mount | grep immich-s3
  ls data/immich-s3/library | head    # must return within 2s
  ```
- [ ] **0.2** Flush any pending writeback to S3 (no-op for `writes` mode reads,
  but harmless and required hygiene before any heavy mount usage):
  ```bash
  rclone rc --unix-socket data/rclone-rc.sock vfs/sync
  rclone rc --unix-socket data/rclone-rc.sock core/stats | head
  ```
- [ ] **0.3** Take a baseline snapshot of `vfs/stats` and `core/stats` to a
  log file in `data/logs/thumb-recovery-2026-05-02/` for after-action review:
  ```bash
  mkdir -p data/logs/thumb-recovery-2026-05-02
  rclone rc --unix-socket data/rclone-rc.sock vfs/stats   > data/logs/thumb-recovery-2026-05-02/vfs-stats.before.json
  rclone rc --unix-socket data/rclone-rc.sock core/stats  > data/logs/thumb-recovery-2026-05-02/core-stats.before.json
  ```
- [ ] **0.4** Disable Mac sleep/idle for the duration:
  ```bash
  caffeinate -dimsu &
  echo $! > /tmp/caffeinate.pid
  ```
- [ ] **0.5** Free-disk gate: confirm ≥ 50 GiB free on the host (we have 402
  GiB).
  ```bash
  df -h /Users/4to | awk 'NR==2 {print $4}'
  ```

### Phase 1 — Concurrency tuning (storage-agnostic)

Immich job concurrency is **not env-driven** in current Immich; it lives in the
admin Settings (or via a config file). Defaults are conservative.

- [ ] **1.1** In the Immich web UI: **Administration → Settings → Job Settings**.
  Record current values to `data/logs/thumb-recovery-2026-05-02/job-settings.before.txt`.
- [ ] **1.2** Bump for the duration of the backfill:
  | Queue | Default | Backfill setting | Rationale |
  |---|---|---|---|
  | Thumbnail Generation | 3 | **5** | HEIC decode (`heic-convert`) is single-threaded JS; 5 parallel keeps 5 P-cores hot without starving the UI |
  | Metadata Extraction | 5 | **5** | already adequate |
  | Video Conversion | 1 | **1** | leave as-is; ffmpeg saturates cores per-job |
  | Background Task | 5 | **5** | leave |
  | Smart Search / Face Detection | 2 / 2 | **2 / 2** | bottlenecked on ML container (currently unhealthy); don't queue more |
- [ ] **1.3** Save settings. (No restart required — Immich picks up live.)

### Phase 2 — Trigger the regeneration (storage-agnostic)

- [ ] **2.1** **Smoke test first**: in **Administration → Jobs**, click
  "Thumbnail Generation" → **Missing**. This processes the 1,155 truly-orphaned
  assets quickly (no overwrites). Watch the queue drain to zero in the admin
  UI's Jobs panel before continuing. Confirms the pipeline is healthy.
- [ ] **2.2** **Bulk regen**: same panel, "Thumbnail Generation" → **All**.
  Note start time in
  `data/logs/thumb-recovery-2026-05-02/run-log.md`.
- [ ] **2.3** Optional (defer until 2.2 is complete): "Video Conversion" →
  **Missing**. The 6,705 active videos may need encoded-video files
  regenerated. Run only if video tiles still show errors after thumb regen.

### Phase 3 — Monitoring (run all four in separate terminals)

- [ ] **3.1** Server error stream:
  ```bash
  docker logs -f immich_server 2>&1 \
    | grep --line-buffered -iE 'enoent|error|failed|thumbnail|preview' \
    | tee -a data/logs/thumb-recovery-2026-05-02/immich-server.log
  ```
- [ ] **3.2** rclone activity (every 60 s):
  ```bash
  while true; do
    date -u +%FT%TZ
    rclone rc --unix-socket data/rclone-rc.sock core/stats \
      | jq '{transfers, errors, lastError, speed, elapsedTime}'
    sleep 60
  done | tee -a data/logs/thumb-recovery-2026-05-02/rclone-stats.log
  ```
- [ ] **3.3** Queue depth (every 30 s):
  ```bash
  while true; do
    date -u +%FT%TZ
    for q in thumbnailGeneration metadataExtraction videoConversion; do
      W=$(docker exec immich_redis redis-cli LLEN "immich_bull:$q:wait")
      A=$(docker exec immich_redis redis-cli LLEN "immich_bull:$q:active")
      F=$(docker exec immich_redis redis-cli ZCARD "immich_bull:$q:failed")
      printf "%-25s wait=%-6s active=%-3s failed=%s\n" "$q" "$W" "$A" "$F"
    done
    echo "---"
    sleep 30
  done | tee -a data/logs/thumb-recovery-2026-05-02/queue-depth.log
  ```
- [ ] **3.4** Disk usage on thumbs dir (every 5 min):
  ```bash
  while true; do
    date -u +%FT%TZ
    du -sh data/immich/thumbs data/immich/encoded-video 2>/dev/null
    df -h /Users/4to | tail -1
    sleep 300
  done | tee -a data/logs/thumb-recovery-2026-05-02/disk.log
  ```

**Healthy progress signals:**
- `thumbnailGeneration:wait` decreases monotonically.
- `du -sh data/immich/thumbs` grows steadily.
- rclone `errors` stays ≤ 5 over the full run; `lastError` clears between samples.
- Server log ENOENT rate **drops** (those errors are user-triggered grid
  renders for not-yet-regenerated assets — they should taper as the backfill
  progresses).

### Phase 4 — Bail-outs (storage-agnostic core; rclone-specific notes)

| Symptom | Action |
|---|---|
| rclone error rate >1/sec sustained 5 min | **Pause** Immich Thumbnail job from admin UI. Check `core/stats` `lastError`. Resume after error rate falls. |
| Scaleway 5xx in rclone log | Pause job. Wait 10 min. Resume. (Throttling is transient.) |
| `ls data/immich-s3/library` hangs >10 s | Mount stale. **Pause** Immich job FIRST. Then `rclone rc --unix-socket data/rclone-rc.sock vfs/sync`. Then `scripts/mount-s3.sh --unmount && scripts/mount-s3.sh`. NEVER skip the `vfs/sync`. |
| Disk fills on `data/immich/thumbs` | Pause job. Investigate (current projection is ~7 GiB total — should not fill). |
| Mac sleeps anyway | `pgrep -lf caffeinate`. Re-issue `caffeinate -dimsu &`. |
| Immich `thumbnailGeneration:failed` ZCARD grows | Sample failed jobs: `docker exec immich_redis redis-cli ZRANGE "immich_bull:thumbnailGeneration:failed" 0 5 WITHSCORES`. Inspect one job's `data` and `failedReason` via `HGETALL "immich_bull:thumbnailGeneration:<jobId>"`. Common cause: corrupt original on S3 (HEIC decode crash). Note the asset id and continue — don't abort the run. |

### Phase 5 — Post-flight

- [ ] **5.1** Stop the monitoring loops (`Ctrl-C` in each terminal).
- [ ] **5.2** Restore caffeinate:
  ```bash
  kill "$(cat /tmp/caffeinate.pid)" && rm /tmp/caffeinate.pid
  ```
- [ ] **5.3** Restore Job Settings to defaults (per **1.1** snapshot).
- [ ] **5.4** Final flush + stats snapshot:
  ```bash
  rclone rc --unix-socket data/rclone-rc.sock vfs/sync
  rclone rc --unix-socket data/rclone-rc.sock vfs/stats  > data/logs/thumb-recovery-2026-05-02/vfs-stats.after.json
  rclone rc --unix-socket data/rclone-rc.sock core/stats > data/logs/thumb-recovery-2026-05-02/core-stats.after.json
  ```
- [ ] **5.5** Re-run unknown-date sink (per AGENTS.md):
  ```bash
  scripts/immich-sink-unknown-date.sh
  ```
- [ ] **5.6** Spot-check 10 random recent + 10 older Memory-Lane tiles in the
  Immich UI. All should render thumbs without "Error loading image".
- [ ] **5.7** Re-query DB to confirm coverage:
  ```bash
  docker exec -e PGPASSWORD=immich immich_postgres psql -U immich -d immich -c \
    "SELECT count(*) AS total,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM asset_file f WHERE f.\"assetId\"=a.id AND f.type='thumbnail')) AS still_no_thumb_row
     FROM asset a WHERE a.\"deletedAt\" IS NULL;"
  ```
  Expected: `still_no_thumb_row` = 0 (or matches the 1,155 truly-orphaned set
  whose originals are missing from S3 — which is plan 09's territory).
- [ ] **5.8** Drain the stale `storage-template-migration` waiting job via
  Bull-Board (now safe — only 1 single-asset job; STM enabled flag remains
  `true`). Or leave it; cosmetic.

---

## 6. Manual user-verification gate (per AGENTS.md hard rule #6)

Before declaring this plan done, the developer must:

1. Visually confirm timeline tiles render thumbs (no "Error loading image").
2. Confirm Memory Lane covers (top of timeline) load.
3. Confirm clicking a recent asset (e.g. `402ec149-2bc7-4421-bdc2-c31d65514aa0`)
   shows the full original within ≤ 5 s.
4. Confirm `data/logs/thumb-recovery-2026-05-02/immich-server.log` has fewer
   than ~10 ENOENT entries in a 5-minute window of normal browsing.

---

## 7. Rollback / safety properties

- All file writes during this run are **idempotent**: regenerating a thumb
  twice produces the same content (Sharp output is deterministic for a given
  input). Re-running "All" is safe.
- No DB schema changes.
- No S3 writes (originals untouched). Egress only.
- Bail-out via "Pause" in Immich admin is graceful — in-flight jobs finish,
  queue stops feeding new work.

---

## 8. Tests

Per AGENTS.md hard rule #3, every change ships with tests. **This plan adds
no source code** — it's a runbook. The "test" is the verification gate in
Section 6 plus the post-flight DB query in step 5.7.

If Phase 1 is later automated as a script, that script gets a Vitest unit test
in the same commit per the standard rule.

---

## 9. Future-proofing for NAS migration

When the local-NAS migration plan is written, **inherit Phases 1, 2, 3.3, 3.4,
4 (rows that don't mention rclone), and 5 (steps 5.5–5.8) verbatim**. Discard
Phase 0, 3.2, the rclone-specific bail-outs in Phase 4, and 5.4. The
runbook's storage-agnostic core is the durable artifact.
