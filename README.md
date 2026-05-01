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

## Tech Stack

- **Runtime:** Node.js (`^20.19 || ^22.12 || >=24.0`), TypeScript only, ESM
- **API:** Fastify 5, Pino logging, Zod validation
- **Database:** PostgreSQL 16 + Prisma 7
- **Job queue:** BullMQ on Redis 7 (`transfer-jobs` + `transfer-jobs-dlq`)
- **Frontend:** React 19, Vite 8, Tailwind 4, TanStack Query/Virtual
- **Storage:** Scaleway Object Storage (S3-compatible) via AWS SDK v3
- **Tests:** Vitest (backend + frontend)

See [TECH_STACK.md](TECH_STACK.md) for the full version matrix.

## Repository Layout

```
src/        Backend (Fastify routes, BullMQ workers, providers, takeout pipeline)
frontend/   React 19 + Vite SPA
prisma/     Prisma schema
scripts/    TypeScript operational scripts (takeout, S3↔Immich migration)
plans/      Numbered tactical plans
data/       Runtime data (gitignored: takeout, immich volumes, mounts)
```

## Requirements

Install these first:

1. Node.js 20.19+, 22.12+, or 24.0+
2. Docker Desktop *(or skip Docker entirely — see [Native macOS Setup](#5-native-macos-setup-no-docker))*
3. Git

Check them with:

```bash
node --version
docker --version
git --version
```

> **macOS users:** before starting any long-running job (Takeout import, S3 upload, Immich), apply the recommended sleep settings — see [macOS sleep settings](#macos-sleep-settings). On a sleeping Mac, transfers stall, the Cloudflare Tunnel drops, and Immich loses its S3 mount.

## Quick Start — Step by Step

Follow these steps in order. Each step depends on the one before it.

### Step 1: Clone the repo

```bash
git clone https://github.com/lutherh/mediatransfer.git
cd mediatransfer
```

### Step 2: Add your Scaleway credentials

```bash
npm run app:setup
```

If `.env` doesn't exist yet, setup creates it from `.env.example` automatically.

Open `.env` in any text editor and fill in **at minimum** these values:

| Variable | Where to get it | Example |
|---|---|---|
| `SCW_ACCESS_KEY` | [Scaleway IAM → API Keys](https://console.scaleway.com/iam/api-keys) | `SCWXXXXXXXXXX` |
| `SCW_SECRET_KEY` | Same page as above | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `SCW_REGION` | Your bucket's region | `nl-ams` |
| `SCW_BUCKET` | Name of your Scaleway bucket | `my-photos` |

Leave everything else as-is for now. The defaults work.

> **Tip:** `SCW_STORAGE_CLASS` defaults to `ONEZONE_IA` which is cheaper for backup data. You don't need to change it.

### Step 3: Run setup again (with credentials)

```bash
npm run app:setup
```

This does everything for you:
- Installs Node.js dependencies
- Starts PostgreSQL and Redis via Docker
- Creates the database tables
- Generates a random `ENCRYPTION_SECRET` (if yours still says `change-me-to-a-random-secret`)
- Verifies S3 connectivity (you should see `4 passed, 0 failed`)

If the S3 check fails, double-check your Scaleway keys in `.env` and run setup again.

### Step 4: Start the app

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
| `http://localhost:5173/` | Google Photos picker flow (4-step wizard) |
| `http://localhost:5173/setup` | First-run setup wizard for Google, Scaleway, and Immich |
| `http://localhost:5173/settings` | Reconfigure Google / Scaleway / Immich credentials at any time |
| `http://localhost:5173/upload` | Direct file upload page |
| `http://localhost:5173/takeout` | Takeout scan, upload, verify, auto-upload toggle, archive history |
| `http://localhost:5173/takeout/sequences` | Detect missing or duplicate archive numbers in a Takeout export |
| `http://localhost:5173/transfers` | Transfer jobs list (filter, costs) |
| `http://localhost:5173/transfers/new` | Create a custom cloud-to-cloud transfer |
| `http://localhost:5173/catalog` | Uploaded media catalog (timeline grid + lightbox) |
| `http://localhost:5173/catalog/dedup` | Stream-based duplicate detection and cleanup |
| `http://localhost:5173/catalog/albums` | Album management |
| `http://localhost:5173/catalog/undated` | Items with unknown date — bulk fix |
| `http://localhost:5173/catalog/immich-compare` | Find S3 files unmatched in Immich and remap |
| `http://localhost:5173/costs` | Storage cost calculator |
| `http://localhost:5173/pipeline` | Visual pipeline overview and schedule config |

## Useful Commands

| Command | Purpose |
|---|---|
| `npm run app:setup` | Install deps, start services, create DB tables, verify S3 |
| `npm run app:dev` | Run backend and frontend in dev mode |
| `npm run setup:mac` | Install Postgres + Redis natively via Homebrew (macOS, no Docker) |
| `npm run app:setup:native` | Same as `app:setup` but skips all Docker checks |
| `npm run app:dev:native` | Same as `app:dev` but skips all Docker checks |
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

## 5. Native macOS Setup (No Docker)

For better performance on macOS (lower RAM/CPU overhead, faster disk I/O), you can run MediaTransfer fully native — Postgres and Redis as Homebrew services, no Docker Desktop required. The repo ships with a setup script and dedicated `:native` npm scripts that bypass Docker entirely.

This was tested end-to-end on a fresh macOS machine. Total time on a clean install: ~5 minutes.

### Step 1: Stop Docker services (if running)

```bash
docker compose down
```

If Docker Desktop isn't installed at all, skip this step.

### Step 2: Install Homebrew (one-time, skip if you already have it)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

The Homebrew installer is interactive — it will ask for your sudo password and pause for confirmation. Run this directly in your terminal.

### Step 3: Install Node.js, PostgreSQL 16, and Redis

Run the bundled setup script. Use `bash` directly the first time because `npm` won't exist yet on a clean machine:

```bash
bash scripts/setup-mac-native.sh
```

This script will:

- `brew install node postgresql@16 redis rclone`
- Start Postgres and Redis as Homebrew background services (autostart on login)
- Create the `mediatransfer` Postgres role and database
- Verify Docker Desktop is reachable (only relevant if you also plan to run Immich)
- Offer to apply [macOS sleep settings](#macos-sleep-settings) so long-running jobs aren't killed mid-flight (interactive — say `y` only if this Mac is meant to stay on)
- Offer to mount your S3 bucket via `./scripts/mount-s3.sh --background` (only if `.env` and `.env.immich` are already present)
- Print a recap of the values that were configured

The script is **idempotent** — re-running it is safe and skips work that's already done. Pass `-y` / `--yes` (or set `ASSUME_YES=1`) to take all defaults non-interactively.

### Step 4: Create your `.env`

```bash
cp .env.example .env
```

The shipped `.env.example` already points the database and Redis at `localhost`, so for the native setup **you don't need to change those lines** — they will just work:

```env
POSTGRES_USER=mediatransfer
POSTGRES_PASSWORD=mediatransfer
POSTGRES_DB=mediatransfer
DATABASE_URL=postgresql://mediatransfer:mediatransfer@localhost:5432/mediatransfer
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_URL=redis://localhost:6379
```

You only need to fill in your `SCW_*` credentials when you're ready to run actual transfers — the dev server boots fine without them.

### Step 5: Run native setup and start the app

```bash
npm run app:setup:native
npm run app:dev:native
```

`app:setup:native` installs npm deps, generates the Prisma client, pushes the schema to the local Postgres, generates a fresh `ENCRYPTION_SECRET`, and runs the S3 connectivity check (skipped automatically if `SCW_*` keys aren't set yet). It does **not** touch Docker.

`app:dev:native` runs the same dev runner as `app:dev`, but with all Docker checks bypassed.

Open [http://localhost:5173](http://localhost:5173). You're running natively.

### Managing the native services

```bash
brew services list                  # see status of postgresql@16 and redis
brew services stop postgresql@16    # stop Postgres
brew services stop redis            # stop Redis
brew services start postgresql@16   # start Postgres
brew services start redis           # start Redis
```

### Troubleshooting native setup

| Symptom | Fix |
|---|---|
| `npm install` fails with `ENOTFOUND github.com` (e.g. while building `ffmpeg-static`) | Stale macOS DNS cache. Run `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, then retry `npm run app:setup:native`. |
| `psql: could not connect to server` | Run `brew services start postgresql@16` and re-run setup. |
| `Error: connect ECONNREFUSED 127.0.0.1:6379` | Run `brew services start redis`. |
| Old Docker containers still bound to ports 5432/6379 | Run `docker compose down` once to release them. |

## macOS sleep settings

Long-running jobs (Takeout import, S3 upload, the Cloudflare Tunnel container, the rclone S3 mount) all break if the Mac sleeps. If this machine acts as an always-on host, disable sleep on **both** AC and battery profiles:

```bash
# AC power (always-on host)
sudo pmset -c sleep 0 disksleep 0 displaysleep 0 womp 1 powernap 1

# Battery (only if the laptop must keep running while unplugged — drains battery)
sudo pmset -b sleep 0 disksleep 0 displaysleep 0 womp 1 powernap 1
```

Verify with:

```bash
pmset -g custom
```

Expected (relevant fields) on both `AC Power` and `Battery Power` blocks:

```
 sleep                0
 disksleep            0
 displaysleep         0
 womp                 1
 powernap             1
```

`scripts/setup-mac-native.sh` will offer to apply these settings interactively (it asks for confirmation before each profile because battery sleep=0 has real cost).

> **Cloudflare Tunnel:** the tunnel runs as the `immich_tunnel` Docker container, so its uptime depends on Docker Desktop being up. Enable Docker Desktop → Settings → General → **Start Docker Desktop when you log in** so the tunnel comes back automatically after a reboot.

## Optional: Immich

Immich gives you phone auto-backup and a local photo browsing UI — like Google Photos, but on your own machine. It runs alongside MediaTransfer and stores originals on your S3 bucket.

> **How it works:** Immich only knows about local folders. We mount your S3 bucket on the **host** with rclone, then bind-mount that directory into the Immich container as `UPLOAD_LOCATION`. Thumbnails and transcodes stay on your local disk for speed; originals live on S3.
>
> Two host-mount flavors are supported:
> - **Linux / WSL2:** rclone FUSE mount (`rclone mount`, requires `fuse3`).
> - **macOS:** rclone NFS mount (`rclone nfsmount`, uses macOS's built-in NFS client). **No macFUSE required** — do not install kernel extensions.
>
> Both are wrapped by [`scripts/mount-s3.sh`](scripts/mount-s3.sh), which auto-detects the OS.

### Step 1: Install rclone on the host

| Platform | Command |
|---|---|
| macOS | `brew install rclone` *(no macFUSE, no reboot)* |
| Linux | `sudo apt install rclone fuse3` |

> The Homebrew `rclone` bottle does not ship the FUSE `mount` subcommand. `scripts/mount-s3.sh` automatically uses `rclone nfsmount` on Darwin instead, which uses the system NFS client — no kernel extension is involved.

### Step 2: Configure `.env.immich` and mount the bucket

```bash
cp .env.immich.example .env.immich
```

Open `.env.immich` and set at least:

```env
RCLONE_BUCKET=my-photos
RCLONE_PREFIX=immich
UPLOAD_LOCATION=./data/immich-s3
TUNNEL_TOKEN=eyJhIjoi...   # only if you use the Cloudflare Tunnel
```

S3 credentials (`SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_REGION`) are read from your main `.env` — not duplicated here.

Mount the bucket as a host directory **before** starting Immich:

```bash
./scripts/mount-s3.sh --background
```

Verify it's live:

```bash
mount | grep immich-s3
# macOS expected output:
#   <host>:/ on /…/data/immich-s3 (nfs, nodev, nosuid, mounted by …)
# Linux expected output:
#   :s3:my-photos/immich on /…/data/immich-s3 type fuse.rclone (…)
```

To unmount later:

```bash
./scripts/mount-s3.sh --unmount
```

> **Why this matters:** `docker-compose.immich.yml` bind-mounts `${UPLOAD_LOCATION}` into the Immich container as `/usr/src/app/upload`. If `data/immich-s3` is **not** a live mount when the container starts, Immich silently writes originals into a stale path inside the container layer — invisible to S3, lost on the next `down`/`up`. `scripts/start-all.sh` enforces this on macOS by refusing to start unless the NFS mount is live (set `START_ALL_AUTO_MOUNT=1` to have it auto-mount instead).

### Step 3: Start Immich

```bash
./scripts/start-all.sh up
# or, Immich-only:
docker compose -f docker-compose.immich.yml up -d
```

Open [http://localhost:2283](http://localhost:2283) and create the admin account.

Originals land at `${UPLOAD_LOCATION}` on the host — i.e. directly on the S3 mount. Thumbs, transcodes, profile pictures, and backups stay on local disk per the per-folder overrides in `.env.immich`.

### Step 4a: Generate an Immich API key (for MediaTransfer)

MediaTransfer talks to Immich over its REST API, so it needs an API key. The key can **only** be created in the Immich web UI — the mobile app cannot generate one.

1. Make sure Immich is running (Step 3 above) and reachable at [http://localhost:2283](http://localhost:2283).
2. Sign in (or create the admin account on first launch).
3. Click your **profile picture** (top-right) → **Account Settings** → **API Keys** → **New API Key**.
4. Give it a name (e.g. `MediaTransfer`) and create it.
5. **Copy the key immediately** — Immich shows it only once.
6. Paste it into MediaTransfer's setup page (Immich step), click **Test connection**, then **Save**.

If you lose the key, just delete the entry in Immich and create a new one.

### Step 5: Remap existing assets to S3 (skip if fresh install)

If you already have photos in `data/immich/library/` that also exist in S3, update Immich's database to point at the S3 mount instead of the local copies:

```bash
npx tsx scripts/remap-immich-to-s3.ts --dry-run      # preview changes
npx tsx scripts/remap-immich-to-s3.ts --execute --backup  # backup paths + apply
```

The script matches Immich assets to S3 files by filename and date, then updates `originalPath` in the database. It creates a backup table (`asset_path_backup`) so you can revert if needed.

Once everything looks good, you can free local disk space by removing the local originals that are now served from S3.

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

1. Start Docker Desktop.
2. Mount the S3 bucket on the host: `./scripts/mount-s3.sh --background`
3. Start the stack: `./scripts/start-all.sh up`

On macOS, `start-all.sh` will refuse to start Immich if `data/immich-s3` isn't a live NFS mount. Set `START_ALL_AUTO_MOUNT=1` to have it auto-run the mount script for you.

### Stopping Immich

```bash
docker compose -f docker-compose.immich.yml down
```

## Long-Running Jobs and Unattended Operation

MediaTransfer is designed to support multi-hour Takeout imports and large S3 uploads without losing data when the laptop sleeps, the API container restarts, or you keep the web UI open during a CLI run.

**Cross-process lock.** Both the API and the long-running CLI scripts coordinate through a shared lockfile at `data/takeout/work/.takeout-run.lock` ([src/takeout/run-lock.ts](src/takeout/run-lock.ts)). Acquire is exclusive (`O_EXCL` + atomic `tmp + rename`); the holder writes a `lastSeenAt` heartbeat every 30 s; readers reclaim the lock only after a 5-minute staleness window. A corrupt lockfile is treated as **unknown state** (fail-closed) — it is not auto-deleted.

**External-run UI banner.** When a foreign CLI holds the lock, [http://localhost:5173/takeout](http://localhost:5173/takeout) shows an amber banner with the holder's PID, source, and start time, and disables every mutating control (action buttons, auto-upload toggle, path editing). The API returns `409 EXTERNAL_JOB_RUNNING` for the same actions. This makes the page safe to leave open during a 24–48 h overnight run.

**Upload stall watchdog.** [src/providers/scaleway.ts](src/providers/scaleway.ts) tracks raw socket-level bytes per upload and aborts a single S3 part if no bytes flow for 5 minutes (checked every 30 s), in addition to TCP/TLS and read-idle timeouts. Aborts are retried by the uploader's normal failure path, so a hung connection no longer wedges the whole import.

**Resume safety.** Every state file (`state.json`, `archive-state.json`, `manifest.jsonl`) is appended or rewritten atomically. After any crash, restart, or manual `Ctrl+C`, re-running the same action picks up where it left off.

**External heartbeater.** If you started a CLI run before the in-process heartbeat existed, [scripts/heartbeat-takeout-lock.ts](scripts/heartbeat-takeout-lock.ts) refreshes the lockfile for an external PID:

```bash
npx tsx scripts/heartbeat-takeout-lock.ts <pid> data/takeout/work
```

**macOS unattended runs.** On a laptop, sleep > 5 minutes can stale the lock and let the API reclaim it under the live CLI. Either disable sleep with `pmset` (see [macOS sleep settings](#macos-sleep-settings)) or attach `caffeinate` to the CLI's PID for the duration of the run:

```bash
caffeinate -dimsu -w <cli-pid> &
```

**rclone S3 mount.** If you mount your bucket for Immich, **always flush the rclone VFS cache before unmounting**, or any pending writes since the last flush will be lost silently:

```bash
rclone rc --unix-socket data/rclone-rc.sock vfs/sync
```

Never `kill -9` rclone or yank `data/immich-s3` while writes are pending.

## Frontend Build-Time Variables

The React SPA is a static bundle, so any backend URL or auth token must be baked in at build time via `frontend/Dockerfile` ARGs:

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `http://<window.hostname>:3000` | Base URL the SPA calls. Set when the API is on a different host or proxied. |
| `VITE_API_AUTH` / `VITE_API_TOKEN` | unset | If set, the SPA injects `Authorization: Bearer <token>` on every API call. Pair with `API_AUTH_TOKEN` on the backend. |

For local dev these are usually left unset; the SPA falls back to `http://<your-host>:3000` and unauthenticated requests.

## Security Notes

- `.env` and all `.env.*` files (except the `.example` templates) are gitignored
- The app validates config at startup and fails fast on bad env values
- `ENCRYPTION_SECRET` is used to encrypt stored cloud credentials
- `API_AUTH_TOKEN` (when set) is required as `Authorization: Bearer <token>` on every API call; pair with `VITE_API_AUTH` for the SPA
- In local development, services are intended to stay on your machine unless you explicitly expose them

## Troubleshooting

| Problem | What to check |
|---|---|
| Docker not running | Start Docker Desktop and rerun `npm run app:dev`, or switch to the [Native macOS Setup](#5-native-macos-setup-no-docker) |
| `ENOTFOUND github.com` during `npm install` on macOS | Flush DNS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, then retry |
| Google login fails | Confirm the redirect URI is exactly `http://localhost:5173/auth/google/callback` |
| Upload interrupted | Rerun the same upload command or button action; the state is resumable |
| `ENCRYPTION_SECRET` error | Run `npm run app:setup` to generate a local secret |
| Wrong object storage target | Re-check `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_REGION`, and `SCW_BUCKET` |
| Takeout buttons disabled, amber “External run in progress” banner | A CLI/script holds the lock — wait for it, or remove `data/takeout/work/.takeout-run.lock` only after confirming no `tsx scripts/takeout-*.ts` process is running |
| API returns `409 EXTERNAL_JOB_RUNNING` | Same as above — the API refuses to start a second writer |
| Photos missing in Immich after a restart | rclone cache wasn't flushed before remount. See [Long-Running Jobs and Unattended Operation](#long-running-jobs-and-unattended-operation) for the `vfs/sync` command |

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
