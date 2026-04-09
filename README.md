# MediaTransfer

Keep your photo archive portable. MediaTransfer runs on your machine, pulls media out of Google Photos, and writes it into storage you control instead of trapping everything inside a giant consumer photo cloud.

This repo is local-first. There is no hosted relay server run by this app. The current tested path is:

- Google Photos Picker -> Scaleway Object Storage
- Google Takeout archives -> Scaleway Object Storage

If you want the short version: this is a practical migration tool for getting out of Google Photos while keeping ownership of the storage layer.

## What It Does

- Transfer selected items from Google Photos in the browser
- Import a full library from Google Takeout
- Resume interrupted uploads safely
- Verify uploaded files
- Browse your uploaded library in a local catalog UI
- Review duplicates and organize albums
- Optionally run Immich for phone auto-backup and local photo browsing

## What It Is Today

- The polished storage target in this repo is Scaleway Object Storage
- The codebase is structured around local services plus S3-style object storage, but the documented setup assumes Scaleway
- This is not a hosted SaaS and not a generic no-config multi-cloud appliance yet

## Requirements

Install these first:

1. Node.js 20.19+, 22.12+, or 24.0+
2. Docker Desktop
3. Git

Check them with:

```bash
node --version
docker --version
git --version
```

## Quick Start

Clone the repo:

```bash
git clone https://github.com/lutherh/mediatransfer.git
cd mediatransfer
```

Create your local config file:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux:

```bash
cp .env.example .env
```

Fill in these values in `.env`:

- `SCW_ACCESS_KEY`
- `SCW_SECRET_KEY`
- `SCW_BUCKET`
- `SCW_REGION` if you are not using the default (`fr-par`)
- `SCW_STORAGE_CLASS` defaults to `ONEZONE_IA` (cheaper for infrequently-accessed backup data)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` should stay `http://localhost:5173/auth/google/callback` unless you intentionally change the frontend port

Then run setup:

```bash
npm run app:setup
```

That command:

- installs dependencies
- starts PostgreSQL and Redis with Docker
- prepares the database
- generates `ENCRYPTION_SECRET` if it is still a placeholder

Start the app:

```bash
npm run app:dev
```

Open [http://localhost:5173](http://localhost:5173).

## Google Cloud Setup

To use the Google Photos picker flow, create OAuth credentials in Google Cloud:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable `Google Photos Picker API`
3. Create an OAuth client of type `Web application`
4. Add this redirect URI exactly:

```text
http://localhost:5173/auth/google/callback
```

If prompted, configure the OAuth consent screen and add yourself as a test user.

## Scaleway Setup

To use Scaleway as the storage target:

1. Create a bucket in Scaleway Object Storage
2. Create an API key in Scaleway IAM
3. Put the access key, secret key, region, and bucket name into `.env`

## Main Workflows

## 1. Browser Picker

Use this when you only want selected photos.

1. Open [http://localhost:5173](http://localhost:5173)
2. Connect your Google account
3. Pick the media you want
4. Start the transfer

## 2. Full Library Import With Google Takeout

Use this when you want the whole library.

1. Create a Google Takeout export with only `Google Photos`
2. Download the archive files into `data/takeout/input/`
3. Open [http://localhost:5173/takeout](http://localhost:5173/takeout)
4. Run `Scan`
5. Run `Upload`
6. Run `Verify`

The upload path is resume-safe. If the machine sleeps or the network drops, run it again and it continues from saved state.

You can also do the same flow from the terminal:

```bash
npm run takeout:scan
npm run takeout:upload
npm run takeout:verify
npm run takeout:resume
```

## 3. Low-Disk Watcher Mode

Use this when the Takeout export is much larger than your free disk space.

Start the watcher:

```bash
npm run takeout:watch
```

The watcher will:

- detect finished archive downloads
- unpack them
- upload media to object storage
- delete processed archives to free space

This is the practical path for multi-hundred-GB or multi-TB exports on a small SSD.

## 4. Catalog And Cleanup

After upload, use the local catalog UI:

- [http://localhost:5173/catalog](http://localhost:5173/catalog) for browsing
- [http://localhost:5173/catalog/dedup](http://localhost:5173/catalog/dedup) for duplicate review
- [http://localhost:5173/catalog/albums](http://localhost:5173/catalog/albums) for albums
- [http://localhost:5173/catalog/undated](http://localhost:5173/catalog/undated) for undated items

## Useful Pages

| URL | Purpose |
|---|---|
| `http://localhost:5173/` | Google Photos picker flow |
| `http://localhost:5173/upload` | Local upload page |
| `http://localhost:5173/takeout` | Takeout scan, upload, verify |
| `http://localhost:5173/takeout/sequences` | Sequence analysis |
| `http://localhost:5173/transfers` | Transfer jobs |
| `http://localhost:5173/catalog` | Uploaded media catalog |
| `http://localhost:5173/costs` | Storage cost view |

## Useful Commands

| Command | Purpose |
|---|---|
| `npm run app:setup` | Install deps and prepare local services |
| `npm run app:dev` | Run backend and frontend in dev mode |
| `npm run build` | TypeScript build |
| `npm run test` | Run tests |
| `npm run takeout:scan` | Scan Takeout input |
| `npm run takeout:upload` | Upload processed Takeout media |
| `npm run takeout:verify` | Verify uploaded media |
| `npm run takeout:resume` | Resume interrupted Takeout upload |
| `npm run takeout:watch` | Watch downloads and process incrementally |
| `npm run takeout:process` | Scan + upload in one step |
| `npm run takeout:cleanup` | Clean up processed Takeout files |
| `npm run takeout:repair-dates` | Repair dates from sidecar metadata |
| `npm run takeout:repair-dates-s3` | Repair dates for `unknown-date` prefix in S3 |
| `npm run lint` | Type-check without emitting |

## Optional: Immich

If you want phone auto-backup in addition to object storage, you can run Immich locally alongside this project.

Immich does not have a native S3 storage backend. The supported approach is:
- mount your S3 bucket on the host with rclone
- point `UPLOAD_LOCATION` at the mount (originals go to S3)
- keep thumbs, transcodes, profile, and backups on local disk for performance

### Setup

Create the Immich env file:

```powershell
Copy-Item .env.immich.example .env.immich
```

Edit `.env.immich` and set:
- `RCLONE_BUCKET` — your S3 bucket name
- `RCLONE_PREFIX` — path prefix inside the bucket (default: `immich`)

The defaults point `UPLOAD_LOCATION` at `./data/immich-s3` (the mount point) and keep generated files local under `./data/immich/`.

### Mount your bucket

The mount scripts read S3 credentials from `.env` and mount config from `.env.immich` — no separate rclone remote or `rclone.conf` is needed:

```powershell
# Windows (requires WinFsp + rclone)
.\scripts\mount-s3.ps1

# Linux (requires fuse3 + rclone)
./scripts/mount-s3.sh
```

Both scripts support `-Background` / `--background` for daemon mode and `-Unmount` / `--unmount` to tear down.

### Start Immich

```bash
docker compose -f docker-compose.immich.yml up -d
```

Open [http://localhost:2283](http://localhost:2283) and create the admin account.

To connect a phone, point the Immich mobile app at:

```text
http://<your-pc-ip>:2283
```

On Windows you may need a firewall rule for port `2283`.

If you already have media in Scaleway from earlier uploads, the repo includes helpers to migrate that data into Immich (`scripts/migrate-s3-to-immich.ps1`, `scripts/sync-immich-to-s3.ps1`).

## Security Notes

- `.env` and all `.env.*` files (except the `.example` templates) are gitignored
- The app validates config at startup and fails fast on bad env values
- `ENCRYPTION_SECRET` is used to encrypt stored cloud credentials
- In local development, services are intended to stay on your machine unless you explicitly expose them

## Troubleshooting

| Problem | What to check |
|---|---|
| Docker not running | Start Docker Desktop and rerun `npm run app:dev` |
| Google login fails | Confirm the redirect URI is exactly `http://localhost:5173/auth/google/callback` |
| Upload interrupted | Rerun the same upload command or button action; the state is resumable |
| `ENCRYPTION_SECRET` error | Run `npm run app:setup` to generate a local secret |
| Wrong object storage target | Re-check `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_REGION`, and `SCW_BUCKET` |

## Stopping Everything

Stop the dev app with `Ctrl+C`.

Stop the Docker services with:

```bash
docker compose down
```

If you are also running Immich:

```bash
docker compose -f docker-compose.immich.yml down
```
