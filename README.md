# MediaTransfer

Local tool to move media between providers with three migration paths:
- **Photo Transfer wizard** — browser-based flow: connect Google account → pick photos → review → transfer to Scaleway, all from the UI.
- **Takeout flow** — complete Google Photos exports at scale (download Takeout archives, scan, upload, verify).
- **API batch flow** — fully programmatic Google Photos API batch transfer (download → upload → verify → cleanup) with automatic `.env` token persistence and resumable checkpoints.

## Quick start (for non-technical users)

If you just want to move your Google Photos files to Scaleway, follow this exact flow.

### Step 1: Install required apps (one time)
- Install **Node.js** (version 22 or newer).
- Install **Docker Desktop**.
- Install **Git**.

### Step 2: Open this project
- Open the `mediatransfer` folder in VS Code.
- Open Terminal in VS Code (`Terminal` → `New Terminal`).

### Step 3: Set your credentials
1. Copy `.env.example` to `.env`.
2. Open `.env` and fill in:
	- `SCW_ACCESS_KEY`
	- `SCW_SECRET_KEY`
	- `SCW_REGION`
	- `SCW_BUCKET`
	- `GOOGLE_CLIENT_ID`
	- `GOOGLE_CLIENT_SECRET`
	- `GOOGLE_REDIRECT_URI` (set to `http://localhost:5173/auth/google/callback` for the wizard flow)
3. Leave other values as default unless you know you need to change them.

### Step 4: Run setup commands (copy/paste)
Run this once in the project terminal:

```bash
npm run app:setup
```

It automatically does all non-sensitive setup steps:
- installs missing backend/frontend dependencies,
- starts Docker services (`postgres`, `redis`),
- generates Prisma client.

If you prefer manual commands, you can still run:

```bash
npm ci
npm run prisma:generate
docker compose up -d postgres redis
```

### Step 5: Start the app
Run a single command:

```bash
npm run app:dev
```

This starts backend and frontend together, so you can open `http://localhost:5173` right away.

`app:dev` now includes a watchdog that checks backend/frontend health and automatically restarts stuck services (including after sleep/hibernation) when needed.

### Step 6: Transfer photos with the wizard (no terminal needed)

The home page (`/`) is the **Photo Transfer** wizard. It walks you through 4 steps:

1. **Connect** — Click "Connect Google Account". A Google consent popup opens. Grant access and the popup closes automatically.
2. **Select** — Click "Open Photo Picker". The Google Photos picker opens in a popup. Choose the photos/videos you want, then close the picker. Thumbnails appear in the app.
3. **Review** — See a summary of selected items (count, types, filenames). Click "Start Transfer" when ready.
4. **Transfer** — Watch real-time progress: progress bar, percentage, status, and log output. When complete you'll see a success message and can start a new transfer.

### Alternative: Takeout flow (for full library migration)

If you have a large library, download Google Takeout archives first, then use the Takeout flow:

1. Put all your Google Takeout archive files (`.zip`, `.tar`, `.tgz`) in **`data/takeout/input`** (from project root: `./data/takeout/input`).
2. Go to `/takeout` in the browser, or use terminal commands:

```bash
npm run takeout:scan
npm run takeout:upload
npm run takeout:verify
npm run takeout:resume   # if interrupted
```

On `/takeout`, you can also click the buttons in order: **Start Services** → **Scan** → **Upload** → **Verify**.

### Done checklist
- Photo Transfer wizard: step 4 shows "Transfer completed successfully"
- Takeout flow: `takeout:verify` shows `Missing: 0` and `/takeout` shows `100%`
- You can see your files in Scaleway bucket

### Troubleshooting (common)
- If you see `ECONNREFUSED ... 6379` after `npm run dev`:
	1. Open **Docker Desktop** and wait until it says running.
	2. In terminal run:

```bash
docker compose up -d postgres redis
```

	3. Then run:

```bash
npm run dev
```

	- If frontend fails to start, make sure you are inside the `frontend` folder:

	```bash
	cd frontend
	npm run dev
	```

## Frontend pages

| Route | Page | Description |
|---|---|---|
| `/` | Photo Transfer | 4-step wizard: Connect Google → Pick Photos → Review → Transfer |
| `/takeout` | Takeout Progress | Live progress for Takeout-based migration |
| `/transfers` | Transfers List | All transfer jobs with status |
| `/transfers/new` | New Transfer | Create a manual transfer job |
| `/transfers/:id` | Transfer Detail | Detailed view of a single transfer |
| `/auth/google/callback` | OAuth Callback | Handles Google OAuth redirect (standalone, no layout) |

On `/transfers`, a **Cloud usage (S3)** card shows:
- total uploaded size in GB,
- total object count,
- estimated monthly storage cost by bucket type (`standard`, `infrequent`, `archive`).

The estimate is storage-only in USD; request/transfer/retrieval costs are not included.

## 1) Setup environment values

- Copy `.env.example` to `.env` in the project root.
- Fill these first (required):
	- `DATABASE_URL` → keep default for local Docker unless you use your own DB.
	- `REDIS_URL` → keep default for local Docker unless you use your own Redis.
	- `ENCRYPTION_SECRET` → random secret used to encrypt stored credentials.
	- `API_AUTH_TOKEN` → required in production; clients must send `Authorization: Bearer <token>` or `x-api-key`.
	- `CORS_ALLOWED_ORIGINS` → comma-separated allowlist for browser origins.
- Scaleway values (if destination is Scaleway Object Storage):
	- `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` → Scaleway Console → IAM → API Keys.
	- `SCW_REGION`, `SCW_BUCKET`, optional `SCW_PREFIX` → Scaleway Object Storage settings.
- Google OAuth values (required for Photo Transfer wizard and API batch flow):
	- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` → Google Cloud Console → APIs & Services → Credentials (OAuth client).
	- `GOOGLE_REDIRECT_URI` → must match redirect URI configured on that OAuth client. For the wizard flow, set to `http://localhost:5173/auth/google/callback`.
- Takeout values (for full-library migration):
	- `TAKEOUT_INPUT_DIR` → folder containing downloaded Google Takeout archives.
	- `TAKEOUT_WORK_DIR` → local unpack/staging folder.
	- `TRANSFER_STATE_PATH` → resume checkpoint file path.

## 2) Needed prerequisites

- Install Node.js 22+ and npm.
- Install Docker Desktop (for Postgres + Redis + optional app container run).
- Install Git (to clone/update the repo).
- Run once in project root:
	- `npm ci`
	- `npm run prisma:generate`
- Start local services:
	- `docker compose up -d postgres redis`
- Optional full-stack container run:
	- `docker compose up --build -d`
- Quick health check:
	- `curl.exe http://localhost:3000/health`

## Security defaults

- API authentication:
	- Production requires `API_AUTH_TOKEN`.
	- All routes except `/health` require that token when configured.
- CORS:
	- Restricted to `CORS_ALLOWED_ORIGINS` (no wildcard by default).
- Network exposure:
	- Docker ports are bound to localhost (`127.0.0.1`) by default.
- Logging:
	- Sensitive headers and common credential fields are redacted from API logs.

## 3) Transfer steps (short version)

### A) Photo Transfer wizard (recommended for selective transfers)
1. Open `http://localhost:5173` in your browser.
2. Connect your Google account (step 1).
3. Pick the photos/videos you want to transfer (step 2).
4. Review the selection and start the transfer (step 3).
5. Watch progress until completion (step 4).

### B) Full Google Photos library via Takeout (recommended for complete migration)
1. Download Google Takeout archives and place them in `data/takeout/input` (or your `TAKEOUT_INPUT_DIR`).
2. Build manifest:
   - `npm run takeout:scan`
3. Upload to Scaleway:
   - `npm run takeout:upload`
4. Verify upload:
   - `npm run takeout:verify`
5. If interrupted, resume:
   - `npm run takeout:resume`

### C) API batch mode (app-created data only)
1. Run one-time OAuth bootstrap:
   - `npx tsx scripts/test-google-connection.ts`
2. Start transfer loop:
   - `npm run transfer:google-batch:scaleway -- --batch-items 100 --batch-gb 2`
3. Re-run the same command to resume from checkpoint.

### Important
- API batch mode does **not** read your full historical Google Photos library.
- Use Takeout flow for complete migration, or the Photo Transfer wizard for selective transfers.

### Useful checks
- Type check: `npm run lint`
- Backend tests: `npm run test`
- Frontend tests: `cd frontend && npx vitest run`

## 4) Catalog browser (Scaleway)

Browse and verify transferred media directly in your browser with an infinite-scroll photo grid.

- **Requires** `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_REGION`, and `SCW_BUCKET` in `.env`.
- Start the API: `npm run dev` (or `docker compose up -d app`)
- Open in browser: `http://localhost:3000/catalog`
- If API auth is enabled, append your token:
	- `http://localhost:3000/catalog?apiToken=<YOUR_API_AUTH_TOKEN>`

### Features
- Date-grouped image/video grid with lazy loading.
- Infinite scroll — additional pages load automatically.
- Click any thumbnail to preview the full-resolution image or play video.
- Optional prefix filter to narrow results to a subfolder.
- Scroll position is remembered across page reloads.
- Returns `503` with a helpful message when Scaleway env vars are missing.
