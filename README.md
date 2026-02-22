# MediaTransfer

Local tool to move media between providers with two migration paths:
- Takeout-first flow for complete Google Photos exports at scale.
- Fully programmatic Google Photos API batch flow (download → upload → verify → cleanup) with automatic `.env` token persistence and resumable checkpoints.

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
3. Leave other values as default unless you know you need to change them.

### Step 4: Put your Takeout files in the input folder
- Put all your Google Takeout photo/video files in:
  - `data/takeout/input`

### Step 5: Run setup commands (copy/paste)
Run these commands in the project terminal, one by one:

```bash
npm ci
npm run prisma:generate
docker compose up -d postgres redis
```

### Step 6: Start transfer
Run these commands in order:

```bash
npm run takeout:scan
npm run takeout:upload
npm run takeout:verify
```

### Step 7: If transfer stops halfway
Run:

```bash
npm run takeout:resume
```

### Step 8: See progress in the browser
1. Start API server:

```bash
npm run dev
```

2. In another terminal, start frontend:

```bash
cd frontend
npm ci
npm run dev
```

3. Open the URL shown by Vite (usually `http://localhost:5173`) and go to:
	- `/takeout` for live transfer progress
	- `/catalog` (API URL `http://localhost:3000/catalog`) to browse uploaded media

### Done checklist
- `takeout:verify` shows `Missing: 0`
- `/takeout` shows `100%`
- You can see your files in Scaleway bucket

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
- Google OAuth values (if using Google API / picker flow):
	- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` → Google Cloud Console → APIs & Services → Credentials (OAuth client).
	- `GOOGLE_REDIRECT_URI` → must match redirect URI configured on that OAuth client.
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

### A) Full Google Photos library (recommended)
1. Download Google Takeout archives and place them in `data/takeout/input` (or your `TAKEOUT_INPUT_DIR`).
2. Build manifest:
   - `npm run takeout:scan`
3. Upload to Scaleway:
   - `npm run takeout:upload`
4. Verify upload:
   - `npm run takeout:verify`
5. If interrupted, resume:
   - `npm run takeout:resume`

### B) API batch mode (app-created data only)
1. Run one-time OAuth bootstrap:
   - `npx tsx scripts/test-google-connection.ts`
2. Start transfer loop:
   - `npm run transfer:google-batch:scaleway -- --batch-items 100 --batch-gb 2`
3. Re-run the same command to resume from checkpoint.

### Important
- API batch mode does **not** read your full historical Google Photos library.
- Use Takeout flow for complete migration.

### Useful checks
- Type check: `npm run lint`
- Tests: `npm run test`

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
