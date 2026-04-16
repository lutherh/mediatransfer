# MediaTransfer — Implementation Plan

Ordered steps to build the project. This is a **locally-run** tool — all services run on the user's machine via Docker Compose. Each step must include tests.

Legend: `[ ]` not started · `[~]` in progress · `[x]` completed

Decision update (Feb 2026): for **full-library migration**, primary path is
**Google Takeout export → local unpack → resumable uploader to Scaleway**.
Google Photos Picker remains for interactive subset transfers.

---

## Phase 1 — Project Bootstrapping

### Step 1: Initialize Node.js project
`[x]`
- Run `npm init` and configure `package.json` (name, type: module, scripts)
- Install core dev dependencies: `typescript`, `tsx`, `vitest`, `@types/node`
- Create `tsconfig.json` with strict mode, ESM, path aliases
- Create base folder structure:
  ```
  src/
    config/
    providers/
    jobs/
    api/
    db/
    utils/
  tests/
  ```
- **Tests:** Verify the project compiles and a trivial test passes in Vitest

### Step 2: Docker Compose for local services
`[x]`
- Create `docker-compose.yml` with PostgreSQL 16 and Redis 7
- Create `.env.example` with database URL, Redis URL, and default config
- Create `src/config/env.ts` — Zod-validated environment config loader
- **Tests:** Test that `env.ts` validates correct configs and rejects invalid ones

### Step 3: Pino logger setup
`[x]`
- Create `src/utils/logger.ts` — configured Pino instance with env-based log level
- Support pretty printing in development, JSON in production
- **Tests:** Test logger creation, verify log level respects config

---

## Phase 2 — Database Layer

### Step 4: Prisma setup and base schema
`[x]`
- Install `prisma` and `@prisma/client`
- Create `prisma/schema.prisma` with initial models:
  - `TransferJob` (id, status, source provider, dest provider, progress, created/updated)
  - `CloudCredential` (id, provider, encrypted config, created/updated)
  - `TransferLog` (id, job id, level, message, timestamp)
- Generate Prisma client
- **Tests:** Validate schema compiles, test Prisma client instantiation with mocked DB

### Step 5: Database service layer
`[x]`
- Create `src/db/client.ts` — singleton Prisma client with connection management
- Create `src/db/jobs.ts` — CRUD operations for TransferJob
- Create `src/db/credentials.ts` — CRUD for CloudCredential (with encryption placeholder)
- **Tests:** Unit tests for each CRUD function using mocked Prisma client

---

## Phase 3 — Cloud Provider Abstraction

### Step 6: Provider interface and registry
`[x]`
- Define `src/providers/types.ts`:
  - `CloudProvider` interface: `list()`, `download(key): ReadableStream`, `upload(key, stream): void`, `delete(key)`
  - `ProviderConfig` type
- Create `src/providers/registry.ts` — register and retrieve provider implementations by name
- **Tests:** Test registry add/get/list, test unknown provider throws error

### Step 7: Scaleway Object Storage provider (S3-compatible)
`[x]`
- Create `src/providers/scaleway.ts` implementing `CloudProvider`
- Use `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` with Scaleway-specific endpoint
- Support configurable region (→ endpoint mapping), bucket, prefix
- Scaleway is S3-compatible — uses standard S3 SDK with custom endpoint (`s3.<region>.scw.cloud`)
- **Tests:** Mock AWS SDK, test list/download/upload/delete, test region → endpoint mapping

### Step 8: Google Photos provider interface and auth
`[x]`
- Define `src/providers/photos-types.ts`:
  - `PhotosProvider` interface: `listAlbums()`, `listMediaItems(albumId?)`, `downloadMedia(mediaItemId): ReadableStream`, `getMediaItem(id)`
  - `Album` type (id, title, mediaItemsCount)
  - `MediaItem` type (id, filename, mimeType, createdAt, width, height, baseUrl)
- Create `src/providers/google-photos-auth.ts`:
  - OAuth2 flow helpers using `googleapis` / `google-auth-library`
  - Token refresh logic
- **Tests:** Test type exports, mock OAuth2 token exchange and refresh

### Step 9: Google Photos provider implementation
`[x]`
- Create `src/providers/google-photos.ts` implementing `PhotosProvider`
- Use Google Photos Library API (`https://photoslibrary.googleapis.com/v1`)
- Implement `listAlbums()`, `listMediaItems()`, `downloadMedia()`, `getMediaItem()`
- Handle pagination for large libraries
- **Tests:** Mock HTTP responses, test list/download/pagination, test error handling

### Step 10: (Future) Additional providers
`[ ]`
- AWS S3 — reuse S3 SDK base from Scaleway with standard AWS endpoints
- Google Cloud Storage — `@google-cloud/storage`
- Azure Blob Storage — `@azure/storage-blob`
- _These are deferred; implement when needed_

---

## Phase 4 — Takeout-first Full Migration (Priority)

### Step 11: Takeout ingestion workspace + config
`[x]`
- Add `src/takeout/config.ts` for local migration settings:
  - `TAKEOUT_INPUT_DIR` (downloaded archive parts)
  - `TAKEOUT_WORK_DIR` (extract/staging directory)
  - `TRANSFER_STATE_PATH` (resume checkpoint file)
  - `UPLOAD_CONCURRENCY`, `UPLOAD_RETRY_COUNT`
- Add env vars to `.env.example` and `src/config/env.ts`
- **Tests:** Env parsing/validation for new Takeout settings

### Step 12: Unpack + normalize Takeout exports
`[x]`
- Create `src/takeout/unpack.ts`:
  - Detect and extract all Takeout zip/tgz parts
  - Normalize output to a canonical local media tree
  - Handle nested folders + sidecar JSON files
- **Tests:** Fixture-based extraction + normalization tests

### Step 13: Build deterministic manifest
`[x]`
- Create `src/takeout/manifest.ts`:
  - Enumerate local media files
  - Parse sidecar JSON where available
  - Derive date path (`YYYY/MM/DD`) with fallbacks
  - Build deterministic destination keys
  - Persist manifest (`jsonl`) for reproducible retries
- **Tests:** Date extraction, key generation, sidecar parsing, manifest stability

### Step 14: Resumable uploader with idempotency
`[x]`
- Create `src/takeout/uploader.ts`:
  - Stream local files to Scaleway
  - Skip already-uploaded objects safely
  - Retry with exponential backoff + jitter
  - Persist per-item status (`uploaded/skipped/failed`)
- **Tests:** Retry/skip/resume behavior with mocked provider

### Step 15: CLI lifecycle for full migration
`[x]`
- Add commands:
  - `takeout:scan` (unpack + build manifest)
  - `takeout:upload` (process pending items)
  - `takeout:resume` (continue failed/interrupted runs)
  - `takeout:verify` (optional HEAD/size checks)
- **Tests:** Integration-style command tests using temp directories

### Step 16: Reconciliation report + safety rails
`[x]`
- Create `src/takeout/report.ts`:
  - Final counts, bytes transferred, failures by reason
  - Output JSON/CSV summary
- Add safety flags:
  - `--dry-run`, `--max-failures`, include/exclude filters
- **Tests:** Report output + guardrail tests

---

## Phase 5 — Job Queue & Transfer Engine

### Step 17: BullMQ setup
`[x]`
- Install `bullmq`
- Create `src/jobs/queue.ts` — queue and worker configuration
- Create `src/jobs/connection.ts` — Redis connection factory (IORedis)
- **Tests:** Test queue creation, test connection config from env

### Step 18: Transfer worker
`[x]`
- Create `src/jobs/transfer-worker.ts`:
  - Receives job with source/dest provider + keys
  - Streams file from source → destination using provider interface
  - Updates job progress in DB
  - Handles errors and retries
- **Tests:** Mock providers and DB, test full transfer flow, test error handling, test retry logic

### Step 19: Bulk transfer / manifest support
`[x]`
- Create `src/jobs/bulk-transfer.ts`:
  - Accepts a list of keys (manifest) or a prefix to transfer
  - Enqueues individual transfer jobs per file
  - Tracks overall batch progress
- **Tests:** Test manifest parsing, test batch job creation, test progress aggregation

---

## Phase 6 — API Layer

### Step 20: Fastify server setup
`[x]`
- Install `fastify`, `@fastify/cors`, `@fastify/swagger`
- Create `src/api/server.ts` — Fastify instance with plugins
- Create `src/api/health.ts` — `GET /health` endpoint
- Create `src/index.ts` — app entrypoint (start server, connect DB, start workers)
- **Tests:** Test health endpoint returns 200, test server starts and stops cleanly

### Step 21: Credentials API
`[x]`
- Create `src/api/routes/credentials.ts`:
  - `POST /credentials` — store cloud credentials
  - `GET /credentials` — list stored credentials (no secrets in response)
  - `DELETE /credentials/:id` — remove credentials
- Input validation with Zod
- **Tests:** Test each endpoint, test validation rejects bad input

### Step 22: Transfer jobs API
`[x]`
- Create `src/api/routes/transfers.ts`:
  - `POST /transfers` — create a new transfer job (source, dest, keys/prefix)
  - `GET /transfers` — list jobs with status and progress
  - `GET /transfers/:id` — single job detail with logs
  - `DELETE /transfers/:id` — cancel a job
- **Tests:** Test each endpoint, test job creation enqueues to BullMQ

### Step 23: Provider listing API
`[x]`
- Create `src/api/routes/providers.ts`:
  - `GET /providers` — list supported providers
  - `POST /providers/:name/test` — test connection with given credentials
  - `POST /providers/:name/list` — list files/objects in a bucket/container
- **Tests:** Test provider listing, test connection test with mock

---

## Phase 7 — Encryption & Security

### Step 24: Credential encryption
`[x]`
- Create `src/utils/crypto.ts`:
  - AES-256-GCM encryption/decryption for credential storage
  - Key derived from env secret via PBKDF2
- Integrate into credential CRUD (Step 5)
- **Tests:** Test encrypt → decrypt roundtrip, test wrong key fails, test tampered ciphertext fails

---

## Phase 8 — Observability & Polish

### Step 25: Progress events and logging
`[x]`
- Add structured log entries at each transfer stage (start, progress %, complete, error)
- Store logs in `TransferLog` table
- Add `GET /transfers/:id/logs` endpoint
- **Tests:** Test log entries written during transfer, test log retrieval endpoint

---

## Phase 9 — Scaleway Catalog Browser (Google-Photos-like verification)

### Goal
Provide a web catalog page to visually verify transferred media in Scaleway Object Storage, with smooth infinite scrolling behavior similar to a photo library browser.

### Step 26: Catalog backend service
`[x]`
- Create `src/catalog/scaleway-catalog.ts` with:
  - Paginated listing via S3 `ListObjectsV2` (`max`, `token`, optional `prefix`)
  - Media type inference (image/video/other)
  - Date grouping value extraction (`YYYY-MM-DD`)
  - Base64url key encoding/decoding for safe URL routing
- Add object streaming support via `GetObject`
- **Tests:** Covered through API tests with mocked catalog service

### Step 27: Catalog API routes
`[x]`
- Add `src/api/routes/catalog.ts` endpoints:
  - `GET /catalog` → browser UI HTML
  - `GET /catalog/api/items` → paged catalog JSON
  - `GET /catalog/media/:encodedKey` → stream media bytes
- Return clear `503` when Scaleway catalog env vars are missing
- **Tests:** Added route assertions in `src/api/index.test.ts`

### Step 28: Infinite-scroll browser UI
`[x]`
- Build lightweight UI served by `/catalog`:
  - Sticky top bar with prefix filter + reload
  - Date-sectioned grid of thumbnails
  - Infinite scroll with `IntersectionObserver`
  - Lazy media loading and click-to-preview modal
  - Scroll-position persistence in `sessionStorage`
  - Back-to-top control
- **Tests:** Endpoint and API behavior verified in server test suite

### Step 29: Auth compatibility for browser media fetches
`[x]`
- Support `apiToken` query parameter on `/catalog*` requests
- Keep header auth support (`Authorization` / `x-api-key`) unchanged
- Redact `req.query.apiToken` in logs
- **Tests:** Existing auth tests remain green and catalog tests pass

### Step 30: Validation and rollout
`[x]`
- Run `npm run lint` and `npm run test`
- Manual smoke test:
  1. Open `/catalog`
  2. Scroll through multiple pages
  3. Open image and video preview
  4. Reload and verify scroll restoration
- Document usage in `README.md`

### Acceptance criteria
- User can verify transferred Scaleway media visually from browser
- Scrolling loads additional pages without freezing UI
- Clicking an item previews full media stream
- Works with and without API auth token

### Step 26: Error handling & resilience
`[x]`
- Global Fastify error handler with structured error responses
- Provider-specific retry strategies (exponential backoff)
- Dead letter queue for permanently failed jobs
- **Tests:** Test error response format, test retry behavior, test DLQ placement

---

## Phase 9 — Docker & Deployment

### Step 27: Production Dockerfile
`[x]`
- Multi-stage Dockerfile (build → production)
- Update `docker-compose.yml` for full-stack local run (this is the primary deployment target)
- Add npm scripts: `dev`, `build`, `start`, `test`, `lint`
- **Tests:** Verify build succeeds, app starts in container locally

### Step 28: CI pipeline
`[x]`
- Create `.github/workflows/ci.yml`: lint → test → build (no cloud deployment step — tool runs locally)
- **Tests:** Verify pipeline definition is valid (lint the YAML)

---

## Phase 10 (Optional) — Frontend

### Step 29: React frontend scaffold
`[x]`
- Scaffold with Vite + React + TypeScript
- Install shadcn/ui, Tailwind, TanStack Query
- Build pages: Transfers list, New Transfer form, Job detail view
- **Tests:** Component tests with Vitest + Testing Library

---

## Phase 11 — First-Run Setup Wizard & Settings

> Goal: allow a new user to configure all runtime-settable integrations from the
> browser, without ever editing a file.  Bootstrap-only variables (`DATABASE_URL`,
> `ENCRYPTION_SECRET`, `REDIS_*`, `HOST`, `PORT`) stay in `.env` because the
> server cannot start without them.  Everything else can be written to the
> `app_settings` table (AES-256-GCM encrypted) and read back at runtime.

### Security Boundaries

| Layer | Rule |
|---|---|
| Transport | All endpoints behind existing `API_AUTH_TOKEN` bearer check |
| At rest | All secrets encrypted with `encryptStringAsync()` before DB write |
| Read back | Secrets are **never** returned to the client — masked as `"••••••••"` |
| Input validation | Zod schema on every `POST`/`PATCH` request body |
| Connection test | Every provider is test-dialled before its credentials are saved |
| Bootstrap problem | If `API_AUTH_TOKEN` is not set (first run), the `/setup/*` prefix is exempt from auth; once a token is set it is required — same pattern as the existing `/health` exemption |

### Step 30: Backend — `app_settings` runtime config layer

`[x]`

**New file:** `src/api/routes/settings.ts`

Registers the following Fastify routes (all `Content-Type: application/json`,
all validated with Zod):

```
GET  /settings/status
     Returns which integration groups are configured.
     { scaleway: bool, google: bool, immich: bool, authTokenSet: bool }
     Never returns secret values.

GET  /settings/scaleway
     Returns non-secret Scaleway config.
     { region, bucket, prefix, storageClass, configured: bool }
     accessKey / secretKey returned as "••••••••" if set.

POST /settings/scaleway/test
     Body: { accessKey, secretKey, region, bucket }
     Calls ListObjectsV2 with max=1 to verify credentials.
     Returns { ok: bool, error?: string }

PUT  /settings/scaleway
     Body: { accessKey, secretKey, region, bucket, prefix?, storageClass? }
     Validates via /test first, then writes to app_settings key
     "scaleway_config" as encrypted JSON.

GET  /settings/google
     Returns { clientId: "••••••••", clientSecret: "••••••••", redirectUri, configured: bool }

PUT  /settings/google
     Body: { clientId, clientSecret, redirectUri }
     Writes to app_settings key "google_oauth_config" as encrypted JSON.

GET  /settings/immich
     Returns { url, apiKey: "••••••••", configured: bool }

POST /settings/immich/test
     Body: { url, apiKey }
     Calls GET <url>/api/server/ping to verify.
     Returns { ok: bool, serverVersion?: string, error?: string }

PUT  /settings/immich
     Body: { url, apiKey }
     Validates via /test first, then writes to app_settings key
     "immich_config" as encrypted JSON.
```

**Config resolution order** (applied at call time, not process startup):

For each provider the service reads from DB first, falls back to env.  This
means `.env` still works as the authoritative source when DB has nothing.

```
scaleway_config     → SCW_ACCESS_KEY / SCW_SECRET_KEY / SCW_BUCKET / SCW_REGION
google_oauth_config → GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
immich_config       → IMMICH_URL / IMMICH_API_KEY
```

New helper: `src/config/runtime-settings.ts`
- `getRuntimeSettings(key)` — reads `app_settings` row, decrypts, parses JSON
- `setRuntimeSettings(key, value)` — encrypts, upserts `app_settings` row

**Tests:** `src/api/routes/settings.test.ts`
- `GET /settings/status` returns correct flags when nothing configured
- `PUT /settings/scaleway` with valid data writes to DB; GET returns masked key
- `PUT /settings/scaleway` with bad credentials returns 400, nothing written
- `PUT /settings/immich` with unreachable URL returns 400
- Secrets never appear in any GET response body
- PUT without auth token → 401

### Step 31: Backend — `/setup/bootstrap-status` (no auth required)

`[x]`

**New file:** `src/api/routes/setup.ts`

Single unauthenticated endpoint:

```
GET  /setup/bootstrap-status
     Returns { needsSetup: bool, authTokenSet: bool, dbConnected: bool }
     No secrets returned.  No auth required.  Always returns 200.
```

`needsSetup` is `true` when `authTokenSet === false` OR no integration
(Scaleway / Immich / Google) is configured.

Auth exemption: add `/setup/bootstrap-status` to the existing auth-skip list
in `src/api/index.ts` alongside `/health`.

**Tests:**
- Unauthenticated request returns 200
- Returns `needsSetup: true` when auth token not set
- Returns `dbConnected: false` when DB is unreachable (mock Prisma)

### Step 32: Frontend — Setup wizard page

`[x]`

**New file:** `frontend/src/pages/setup-page.tsx`

- On mount: calls `GET /setup/bootstrap-status` (no auth header required).
- If `needsSetup === false`, immediately redirects to `/`.
- Otherwise renders a full-screen wizard using the existing `Stepper` component
  with four steps:
  1. **Auth token** — advisory only; shows instructions to set `API_AUTH_TOKEN`
     in `.env` and restart; green tick if already set.
  2. **Storage (Scaleway S3)** — credential form (Step 33).
  3. **Google Photos** — OAuth client form (Step 34).
  4. **Immich** — URL + API key form (Step 35).
- Steps 2–4 each have a "Skip for now" button.
- A "Done" button on step 4 redirects to `/`.

Route: `/setup` — added to `frontend/src/app.tsx` outside the `<Layout>`
wrapper (full-screen, no nav bar).

**Nav badge:** `frontend/src/components/layout.tsx` adds a red dot on the
"Settings" nav link when `needsSetup === true`.  Polls
`GET /setup/bootstrap-status` with a 5-minute `staleTime`.

### Step 33: Frontend — Scaleway S3 configuration step

`[x]`

Component: `frontend/src/pages/setup/scaleway-step.tsx`

Fields:
- Access Key (`type="password"`, `autocomplete="new-password"`)
- Secret Key (`type="password"`, `autocomplete="new-password"`)
- Region (text, default `fr-par`)
- Bucket (text)
- Prefix (text, optional)
- Storage Class (select: `STANDARD` | `ONEZONE_IA` | `GLACIER`)

Behaviour:
1. On mount: `GET /settings/scaleway` — pre-fills non-secret fields; secret
   inputs show empty placeholder text "already set — leave blank to keep".
2. "Test connection" button → `POST /settings/scaleway/test`; shows green or
   red inline alert.
3. "Save" button disabled until test passes → `PUT /settings/scaleway`.
4. Per-field Zod error messages shown below each input.

### Step 34: Frontend — Google OAuth configuration step

`[x]`

Component: `frontend/src/pages/setup/google-step.tsx`

Fields:
- Client ID (text)
- Client Secret (`type="password"`)
- Redirect URI (text, pre-filled from server default)

Collapsible "How to get credentials" panel with numbered instructions linking
to Google Cloud Console.

After saving: "Connect Google account →" button that triggers the existing
OAuth flow via `GET /auth/google/url`.

### Step 35: Frontend — Immich configuration step

`[x]`

Component: `frontend/src/pages/setup/immich-step.tsx`

Fields:
- Server URL (text, e.g. `http://localhost:2283`)
- API Key (`type="password"`)

"Test" button → `POST /settings/immich/test`; on success shows the Immich
server version from the ping response.

"Save" button disabled until test passes → `PUT /settings/immich`.

### Step 36: Frontend — Settings page (ongoing config)

`[x]`

**New file:** `frontend/src/pages/settings-page.tsx`

Reuses the same three step components (Steps 33–35) rendered as collapsible
`<Card>` sections rather than a wizard, so users can update any integration
without going through the full wizard again.

Route: `/settings` — added to the main `<Layout>` nav with a gear icon.
The red badge from Step 32 appears here when setup is incomplete.

### Step 37: Tests

`[x]`

Backend (`src/api/routes/settings.test.ts`):
- All CRUD routes for each integration (status, get, test, put)
- GET responses mask secrets
- Test-dial failure → 400 returned, nothing written to DB
- Unauthenticated PUT → 401
- `GET /setup/bootstrap-status` → 200 without auth token

Frontend (Vitest + Testing Library):
- `ScalewayStep` shows masked placeholder when config already exists
- "Save" disabled until test succeeds
- Error message shown when test-dial fails
- Setup page redirects to `/` when `needsSetup === false`

---

### What is NOT in scope (stays in `.env` only)

| Variable | Why it cannot be set from UI |
|---|---|
| `DATABASE_URL` | Server cannot start without it |
| `ENCRYPTION_SECRET` | Key derivation happens at process start |
| `REDIS_*` | Queue is initialized at startup |
| `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL` | Structural; restart required |
| `WORKER_CONCURRENCY`, `UPLOAD_CONCURRENCY` | Queue init; restart required |

### Secret masking convention

Any `app_settings` value whose JSON field name ends in `Key`, `Secret`,
`Token`, or `Password` is returned as the literal string `"••••••••"` in all
GET responses.  The client treats a masked value as "already set" and leaves
the input empty; any content typed into a masked field is treated as a new
value to save.

### No new packages required

All building blocks already exist in the codebase:
- `AppSetting` Prisma model (`prisma/schema.prisma`)
- `encryptStringAsync` / `decryptStringAsync` (`src/utils/crypto.ts`)
- `Stepper`, `Card`, `Alert`, `Button` UI components
- Fastify + Zod validation pipeline (`src/api/index.ts`)
- `apiFetch` with bearer token (`frontend/src/lib/api.ts`)
