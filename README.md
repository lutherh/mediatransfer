# MediaTransfer

Move Google Photos to Scaleway Object Storage. Three paths:
- **Wizard** (`/`) — pick photos in the browser, transfer with one click
- **Takeout** (`/takeout`) — bulk-migrate full library via Google Takeout archives
- **API batch** — programmatic transfer with resumable checkpoints

## Prerequisites

- Node.js 22+, Docker Desktop, Git

## Quick start

```bash
# 1. Configure
cp .env.example .env   # fill in SCW_* and GOOGLE_* values

# 2. Setup (installs deps, starts Postgres + Redis, generates Prisma client)
npm run app:setup

# 3. Run
npm run app:dev
```

Open `http://localhost:5173`. Backend runs on `:3000`.

The dev script auto-starts Docker Desktop, frees blocked ports, and includes a watchdog that restarts services after sleep/hibernation.

## Environment variables

Copy `.env.example` → `.env`. Required values:

| Variable | Notes |
|---|---|
| `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` | Scaleway IAM → API Keys |
| `SCW_REGION`, `SCW_BUCKET` | Scaleway Object Storage |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth |
| `GOOGLE_REDIRECT_URI` | `http://localhost:5173/auth/google/callback` |

Defaults are fine for `DATABASE_URL`, `REDIS_URL`, and most other values.
Set `ENCRYPTION_SECRET` to a real secret (at least 16 chars, not the placeholder).

## Transfer flows

### Wizard (selective)
1. Connect Google account
2. Pick photos via Google Picker
3. Review & start transfer
4. Watch progress bar until done

### Takeout (full library)
Place `.zip`/`.tar`/`.tgz` archives in `data/takeout/input`, then:

```bash
npm run takeout:scan      # build manifest
npm run takeout:upload    # upload to Scaleway
npm run takeout:verify    # confirm all files landed
npm run takeout:resume    # resume if interrupted
```

Or use the UI at `/takeout`: **Scan** → **Upload** → **Verify**.

For large archives:
```bash
npm run takeout:process -- --concurrency 2 --progress-interval-sec 2
```

For low disk usage (auto-clean local files after each successfully uploaded archive):
```bash
npm run takeout:process -- --move-archive
# or permanently delete archives after successful upload:
npm run takeout:process -- --delete-archive
```

If you used `takeout:scan`/`takeout:upload` and want to reclaim disk safely afterward:
```bash
npm run takeout:cleanup -- --apply --move-archives
# or: npm run takeout:cleanup -- --apply --delete-archives
```

### API batch (app-created media only)
```bash
npx tsx scripts/test-google-connection.ts                          # one-time OAuth
npm run transfer:google-batch:scaleway -- --batch-items 100 --batch-gb 2  # run/resume
```

> API batch does **not** access your full Google Photos library. Use Takeout for that.

## Pages

| Route | Description |
|---|---|
| `/` | Photo Transfer wizard |
| `/takeout` | Takeout migration progress |
| `/transfers` | Transfer jobs list + cloud usage |
| `/transfers/:id` | Transfer detail |
| `/catalog` | Browse uploaded media (Scaleway) |

## Catalog browser

View transferred files at `http://localhost:3000/catalog`. Requires `SCW_*` env vars.
Infinite-scroll grid, date grouping, click to preview, prefix filtering.

## Security

- `API_AUTH_TOKEN` required in production (all routes except `/health`)
- CORS restricted to `CORS_ALLOWED_ORIGINS`
- Docker ports bound to `127.0.0.1`
- Credentials redacted from logs

## Dev commands

| Command | Purpose |
|---|---|
| `npm run app:dev` | Start everything (backend + frontend + services) |
| `npm run app:setup` | One-time setup |
| `npm run lint` | Type check |
| `npm run test` | Backend tests |
| `cd frontend && npx vitest run` | Frontend tests |
