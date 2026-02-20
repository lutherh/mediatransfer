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
