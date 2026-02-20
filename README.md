# MediaTransfer

Local tool to move media between providers (with a Takeout-first flow for full Google Photos migration).

## 1) Setup environment values

- Copy `.env.example` to `.env` in the project root.
- Fill these first (required):
	- `DATABASE_URL` → keep default for local Docker unless you use your own DB.
	- `REDIS_URL` → keep default for local Docker unless you use your own Redis.
	- `ENCRYPTION_SECRET` → random secret used to encrypt stored credentials.
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

## 3) How to use the tool to transfer

- Quick start (create one transfer via API)
	- Ensure app is running (`docker compose up -d` **or** `npm run dev`).
	- Create transfer job (PowerShell):
		- `Invoke-WebRequest -UseBasicParsing -Uri http://localhost:3000/transfers -Method POST -ContentType "application/json" -Body '{"sourceProvider":"google-photos","destProvider":"scaleway","keys":["example.jpg"]}'`
	- List jobs:
		- `Invoke-WebRequest -UseBasicParsing http://localhost:3000/transfers | Select-Object -ExpandProperty Content`
- Note about `npm run dev`
	- If Docker app is already running on port `3000`, `npm run dev` will fail.
	- Stop container app first (`docker compose stop app`) or keep using Docker API at `http://localhost:3000`.
- Full library (recommended): Google Takeout → Scaleway
	- Put Takeout archives in `TAKEOUT_INPUT_DIR`.
	- Build manifest: `npm run takeout:scan`
	- Upload: `npm run takeout:upload`
	- Resume failed/interrupted uploads: `npm run takeout:resume`
	- Verify output: `npm run takeout:verify`
- API/server mode:
	- Start API locally: `npm run dev`
	- Health: `GET /health`
	- Create/list transfer jobs via `/transfers` endpoints.
- Fully programmatic Google Photos batch mode (no manual batch steps):
	- Add these env values once: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_REGION`, `SCW_BUCKET`.
	- Run batch loop:
		- `npm run transfer:google-batch:scaleway -- --batch-items 100 --batch-gb 2`
	- What each batch does automatically:
		1. Downloads next media batch from Google Photos API (up to `--batch-items` or `--batch-gb`).
		2. Uploads batch to Scaleway.
		3. Verifies uploaded object presence + size.
		4. Deletes local temporary file only after successful verification.
		5. Saves checkpoint state and continues with the next batch until complete.
	- Resume behavior:
		- Uses `GOOGLE_BATCH_STATE_PATH` checkpoint file; rerunning command resumes from last successful position.
	- Useful options:
		- `--max-batches <n>` limit a run window.
		- `--state-path <path>` override checkpoint file.
		- `--temp-dir <path>` override local temporary folder.
		- `--dry-run` simulate without upload/delete.
- Useful checks:
	- Type check: `npm run lint`
	- Tests: `npm run test`
