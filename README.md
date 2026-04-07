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

1. Node.js 20.19+ or 22.12+
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
- `SCW_REGION` if you are not using the default
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

## Optional: Immich

If you want phone auto-backup in addition to object storage, you can run Immich locally alongside this project.

Create the Immich env file:

```powershell
Copy-Item .env.immich.example .env.immich
```

Start Immich:

```bash
docker compose -f docker-compose.immich.yml up -d
```

Open [http://localhost:2283](http://localhost:2283) and create the admin account.

To connect a phone, point the Immich mobile app at:

```text
http://<your-pc-ip>:2283
```

On Windows you may need a firewall rule for port `2283`.

If you already uploaded media into Scaleway, the repo includes PowerShell helpers to import that media into Immich with `rclone` and `immich-go`.

## Security Notes

- `.env` is gitignored and should stay local
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
