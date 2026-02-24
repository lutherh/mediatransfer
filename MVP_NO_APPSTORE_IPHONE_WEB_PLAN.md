# MVP Plan — No App Store, iPhone + Web Photo Library

## Product goal
Build a self-hosted/cloud-owned photo library that replaces Google Photos, works well on iPhone via browser/PWA, and does not require publishing a native app in the App Store.

## Constraints and design principles
- Primary clients: iPhone Safari + desktop web.
- No native iOS app required for MVP.
- First storage target: Scaleway Object Storage (S3-compatible).
- Future storage target: home NAS.
- Use resumable, retryable jobs for all heavy operations.
- Prefer deterministic, idempotent processing (safe re-runs).

## P0 — Must Have (ship first)

### 1) Authentication and account baseline
- Single-user admin account (email/password or magic link).
- Secure session handling and logout.
- Basic account settings (change password, session revoke).

### 2) Storage target setup (Scaleway first)
- Connect storage credentials and validate bucket/prefix access.
- Health check endpoint for storage read/write permissions.
- Clear setup diagnostics and actionable error messages.

### 3) Google exit path (bulk import)
- Google Takeout ingestion flow:
  - scan archives,
  - unpack/normalize,
  - upload,
  - verify,
  - resume.
- UI + API status tracking for long-running imports.

### 4) iPhone web uploads (no App Store)
- Multi-file upload from iPhone browser picker.
- Resumable chunked uploads with retry.
- Pause/resume controls and per-file progress.

### 5) Data correctness and dedup
- Hash-based deduplication and idempotent upload behavior.
- Metadata normalization with fallback chain:
  - EXIF capture date,
  - filename/path date patterns,
  - object modified timestamp as last resort.
- Canonical UTC handling for consistent timeline sorting.

### 6) Job engine and reliability
- Queue-based processing with retries/backoff.
- Transfer states: pending, in progress, retrying, failed, completed, skipped.
- Item-level retry and bulk retry actions.
- Crash-safe resume after restart.

### 7) Library browsing MVP
- Timeline grid with date grouping.
- Photo/video filtering.
- Date sort options (newest/oldest).
- Basic filename/date-range search.

### 8) Transfer observability
- Transfer detail page with:
  - item-level status,
  - progress,
  - attempts,
  - error reason,
  - logs.
- Actions: retry item, queue all retryable items, pause/resume transfer.

### 9) Security baseline
- HTTPS in production.
- Secrets encrypted at rest.
- Signed media URLs / protected media access.
- Minimal role model: owner/admin only for MVP.

### 10) Safety and recoverability
- Backup export for DB state and transfer metadata.
- Restore runbook (documented steps).
- Verification report with missing/corrupt counts.

## P1 — Should Have (next after launch)

### 1) NAS backend support
- Add NAS adapter (prefer S3-compatible first).
- Optional WebDAV/SMB bridge if needed.

### 2) PWA quality pass
- Installable web app (Add to Home Screen).
- Offline shell and fast startup caching.
- Better reconnect behavior after network drop.

### 3) Album and sharing basics
- Manual albums.
- Favorites and hidden media.
- Expiring share links (optional passcode).

### 4) Operational dashboard
- Queue depth, failed jobs, storage usage, recent import health.
- Simple retry/reconcile controls from admin panel.

### 5) Multi-user lite
- Owner + family members.
- Shared/private album visibility model.

## P2 — Nice to have
- On-server tagging/classification pipeline.
- Memories/on-this-day features.
- Desktop relay helper for more automatic home-WiFi backups.
- Additional storage target plugins.

## iPhone reality check (important)
- A pure web/PWA approach on iOS cannot reliably provide fully automatic background camera-roll backup like a native app.
- MVP should optimize for: open app → one-tap sync/upload with strong resume/retry.

## Recommended launch scope
- Ship P0 with Scaleway only, Google Takeout import, and iPhone web upload.
- Add NAS in P1 after reliability metrics stabilize.

## Success criteria (MVP)
- User can migrate a full library from Google using Takeout without manual per-item handling.
- User can upload new media from iPhone browser with resumable reliability.
- Timeline browsing and basic search are responsive and correct by date.
- Re-running import/upload does not duplicate objects.
- Failures are visible, retryable, and recoverable without data loss.
