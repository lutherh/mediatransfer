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

## Quick Start — Step by Step

Follow these steps in order. Each step depends on the one before it.

### Step 1: Clone the repo

```bash
git clone https://github.com/lutherh/mediatransfer.git
cd mediatransfer
```

### Step 2: Create your config file

Windows (PowerShell):
```powershell
Copy-Item .env.example .env
```

macOS / Linux:
```bash
cp .env.example .env
```

### Step 3: Fill in your `.env`

Open `.env` in any text editor. You need to fill in **at minimum** these values:

| Variable | Where to get it | Example |
|---|---|---|
| `SCW_ACCESS_KEY` | [Scaleway IAM → API Keys](https://console.scaleway.com/iam/api-keys) | `SCWXXXXXXXXXX` |
| `SCW_SECRET_KEY` | Same page as above | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `SCW_REGION` | Your bucket's region | `nl-ams` |
| `SCW_BUCKET` | Name of your Scaleway bucket | `my-photos` |

Leave everything else as-is for now. The defaults work.

> **Tip:** `SCW_STORAGE_CLASS` defaults to `ONEZONE_IA` which is cheaper for backup data. You don't need to change it.

### Step 4: Run setup

```bash
npm run app:setup
```

This does everything for you:
- Installs Node.js dependencies
- Starts PostgreSQL and Redis via Docker
- Creates the database tables
- Generates a random `ENCRYPTION_SECRET` (if yours still says `change-me-to-a-random-secret`)

### Step 5: Verify S3 connectivity

```bash
npx tsx scripts/test-s3-quick.ts
```

You should see `4 passed, 0 failed`. If it fails, double-check your Scaleway keys.

### Step 6: Start the app

```bash
npm run app:dev
```

Open [http://localhost:5173](http://localhost:5173). You're running.

### What next?

- **Transfer selected photos:** Use the browser picker at [localhost:5173](http://localhost:5173)
- **Migrate your full library:** See [Full Library Import](#2-full-library-import-with-google-takeout) below
- **Add phone auto-backup:** See [Optional: Immich](#optional-immich) below

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

Immich gives you phone auto-backup and a local photo browsing UI — like Google Photos, but on your own machine. It runs alongside MediaTransfer and stores originals on your S3 bucket.

> **How it works:** Immich only knows about local folders. We use rclone to mount your S3 bucket as a local folder. Immich writes to it, rclone syncs to S3 in the background. Thumbnails and transcodes stay on your local disk for speed.

### Step 1: Install prerequisites

**Windows:**
```powershell
winget install Rclone.Rclone
winget install WinFsp.WinFsp
```
> You may need to **restart your terminal** after installing WinFsp.

**Linux:**
```bash
sudo apt install rclone fuse3
```

### Step 2: Create the Immich config

Windows:
```powershell
Copy-Item .env.immich.example .env.immich
```

Linux / macOS:
```bash
cp .env.immich.example .env.immich
```

Open `.env.immich` and set your bucket name:
```env
RCLONE_BUCKET=my-photos
```

That's it. S3 credentials are read from your main `.env` automatically — no need to paste them again.

### Step 3: Start the S3 mount

```powershell
.\scripts\mount-s3.ps1
```

Or on Linux:
```bash
./scripts/mount-s3.sh
```

You should see:
```
Mounting :s3:my-photos/immich -> C:\dev\...\data\immich-s3
```

**Leave this terminal open.** The mount must stay running while Immich is up.

> **Tip:** Use `-Background` (Windows) or `--background` (Linux) to run it as a daemon so you don't need to keep the terminal open. Use `-Unmount` / `--unmount` to stop it later.

### Step 4: Migrate existing Immich data to S3 (skip if fresh install)

If you already have photos in `data/immich/library/`, sync them to S3 first:

```powershell
.\scripts\sync-immich-to-s3.ps1           # dry run — shows what would happen
.\scripts\sync-immich-to-s3.ps1 -Execute  # actually copies files
```

This uploads your local originals to S3 so they're still accessible after the switch.

### Step 5: Start Immich

```bash
docker compose -f docker-compose.immich.yml up -d
```

Open [http://localhost:2283](http://localhost:2283) and create the admin account.

### Step 6: Connect your phone

Install the **Immich** app ([iOS](https://apps.apple.com/app/immich/id1613945686) / [Android](https://play.google.com/store/apps/details?id=app.alextran.immich)).

In the app, set the server URL to:
```
http://<your-pc-ip>:2283
```

On Windows you may need a firewall rule:
```powershell
New-NetFirewallRule -DisplayName "Immich" -Direction Inbound -LocalPort 2283 -Protocol TCP -Action Allow
```

### Startup order (every time)

1. Start Docker Desktop
2. Start the S3 mount: `.\scripts\mount-s3.ps1 -Background`
3. Start Immich: `docker compose -f docker-compose.immich.yml up -d`

> **Important:** The mount must be running **before** Immich starts. If Immich starts without the mount, it will write to an empty local folder and won't see existing files.

### Stopping Immich

```bash
docker compose -f docker-compose.immich.yml down
.\scripts\mount-s3.ps1 -Unmount
```

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

Stop the Docker services:

```bash
docker compose down
```

If you are also running Immich:

```bash
docker compose -f docker-compose.immich.yml down
```

Then unmount S3 (if mounted):

Windows:
```powershell
.\scripts\mount-s3.ps1 -Unmount
```

Linux:
```bash
./scripts/mount-s3.sh --unmount
```
