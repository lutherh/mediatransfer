# MediaTransfer

A tool that moves your Google Photos library to your own private cloud storage (Scaleway Object Storage). Runs entirely on your computer — your photos never pass through a third-party server.

---

## What can it do?

| Mode | Best for | How it works |
|------|----------|--------------|
| **Wizard** (web page) | Picking specific photos | Select photos in your browser, click transfer |
| **Takeout** (web page or terminal) | Moving your **entire** library | Download your library from Google, then upload it all in one go |

---

## Before you start

You need three things installed on your computer:

1. **Node.js 22 or newer** — [Download here](https://nodejs.org/) (pick the LTS version)
2. **Docker Desktop** — [Download here](https://www.docker.com/products/docker-desktop/) (used to run the database behind the scenes)
3. **Git** — [Download here](https://git-scm.com/downloads)

> **Not sure if you have them?** Open a terminal (PowerShell on Windows, Terminal on Mac) and type:
> ```
> node --version
> docker --version
> git --version
> ```
> Each should print a version number. If instead you see an error, install the missing tool from the links above.

---

## Step 1 — Get your cloud account keys

You need credentials from two services. This is a one-time setup.

### Scaleway (where your photos will be stored)

1. Create a free account at [scaleway.com](https://www.scaleway.com/)
2. In the Scaleway console, go to **Object Storage** → **Create a bucket**
   - Pick a region (e.g. `fr-par`) and give it a name (e.g. `my-photos-backup`)
3. Go to **IAM** → **API Keys** → **Create API Key**
   - Save the **Access Key** and **Secret Key** — you will need them below

### Google Cloud (to let the app read your Google Photos)

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Create a new project (e.g. "Photos Backup")
3. Go to **APIs & Services** → **Library** → search for **Google Photos Picker API** → **Enable** it
4. Go to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
5. Save the **Client ID** and **Client Secret**

> **Tip:** You may also need to set up the OAuth consent screen (same section). Choose "External", fill in the app name, and add your own email as a test user.

---

## Step 2 — Download and configure

Open a terminal and run:

```bash
git clone https://github.com/lutherh/mediatransfer.git
cd mediatransfer
```

Create your configuration file:

```bash
cp .env.example .env
```

Now open the `.env` file in any text editor (Notepad, VS Code, etc.) and fill in the values you got in Step 1:

| Line in `.env` | What to put there |
|---|---|
| `SCW_ACCESS_KEY=` | Your Scaleway Access Key |
| `SCW_SECRET_KEY=` | Your Scaleway Secret Key |
| `SCW_REGION=` | The region you chose (e.g. `fr-par`) |
| `SCW_BUCKET=` | The bucket name you created (e.g. `my-photos-backup`) |
| `GOOGLE_CLIENT_ID=` | Your Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET=` | Your Google OAuth Client Secret |

Optional tuning for very large buckets or slower links:
- `SCW_S3_REQUEST_TIMEOUT_MS=300000`
- `SCW_S3_LIST_MAX_RETRIES=5`

> **Leave everything else as-is.** The defaults work for local development. The setup script will auto-generate a secure encryption key for you.

---

## Step 3 — Install and run

```bash
npm run app:setup
```

This one-time command will:
- Install all dependencies
- Start the database (via Docker) 
- Set up the database tables
- Generate a secure encryption key

Then start the app:

```bash
npm run app:dev
```

Open your browser to **http://localhost:5173** — that's it, the app is running!

> **What `app:dev` does behind the scenes:** It starts Docker Desktop if needed, frees any blocked ports, launches the backend API on port 3000 and the frontend on port 5173, and includes a watchdog that auto-restarts everything if your computer goes to sleep.

---

## How to use it

### Option A — Transfer specific photos (Wizard)

1. Open **http://localhost:5173**
2. Click **Connect Google Account** and sign in
3. Pick the photos you want to transfer
4. Click **Start Transfer** and wait for the progress bar to finish

### Option B — Transfer your entire library (Takeout)

This is the best option for a full backup. It works in two stages:

#### Stage 1 — Download your library from Google

1. Go to [takeout.google.com](https://takeout.google.com/)
2. Deselect everything, then select only **Google Photos**
3. Choose export format: **.zip** files, size **2 GB** (or the largest option available)
4. Click **Create export** and wait for Google to prepare it (can take hours to days)
5. Download all the `.zip` files into the `mediatransfer/data/takeout/input/` folder

#### Stage 2 — Upload to your cloud storage

Open **http://localhost:5173/takeout** in your browser:

1. Click **Scan** — the app will find and organize all your photos from the archives
2. Click **Upload** — the app will upload everything to your Scaleway bucket
3. Click **Verify** — confirms all files arrived safely

> **Don't worry about interruptions.** If your upload gets interrupted (internet drops, computer sleeps, etc.), just click **Upload** again — it will pick up exactly where it left off. Nothing gets uploaded twice.

**Prefer the command line?** You can also do it with terminal commands:
```bash
npm run takeout:scan       # find and organize photos
npm run takeout:upload     # upload to cloud
npm run takeout:verify     # confirm everything landed
npm run takeout:resume     # resume if interrupted
```

### Option C — Continuous download + upload (for huge libraries)

If your Google Takeout is larger than your available disk space (e.g. 1.7 TB takeout, but only 50 GB free), use the **download watcher** mode. It processes each archive as it downloads, deleting it to free space for the next one:

1. Go to [takeout.google.com](https://takeout.google.com/) and request your export
2. Start downloading all parts in your browser (they go to your Downloads folder)
3. In a separate terminal, start the watcher:

```bash
npm run takeout:watch
```

That's it. The watcher will:
- Detect when each ~4 GB download finishes (even from Chrome's `.crdownload` temp files)
- Unpack it, upload all photos to your Scaleway bucket
- Delete the archive to free space for the next download
- Keep going until all parts are done

**You only need ~15-20 GB of free space**, regardless of total takeout size.

To watch a different folder or customize behavior:
```bash
npm run takeout:watch -- --downloads-dir "D:\My Downloads" --concurrency 8
npm run takeout:watch -- --help     # see all options
```

> **Safe to interrupt.** Press Ctrl+C at any time. When you restart, it picks up exactly where it left off — nothing gets re-uploaded.

---

## Browsing your uploaded photos

Once photos are uploaded, go to **http://localhost:5173/catalog** to:

- Browse all your uploaded media in a grid view, grouped by date
- Click any photo to preview it full-size
- Find and remove duplicate files (Dedup tab)
- Organize photos into albums

---

## All pages

| Address | What it does |
|---|---|
| `http://localhost:5173` | Photo Transfer wizard (select & transfer) |
| `http://localhost:5173/takeout` | Takeout migration (full library) |
| `http://localhost:5173/transfers` | View all transfer jobs + cloud storage usage |
| `http://localhost:5173/catalog` | Browse & manage your uploaded photos |

---

## Troubleshooting

| Problem | Solution |
|---|---|
| **"Docker is not running"** | Open Docker Desktop manually, wait until it says "Running", then try again |
| **Port 3000 or 5173 already in use** | The dev script auto-frees ports — if it fails, close other apps using those ports |
| **Google sign-in doesn't work** | Make sure your redirect URI in Google Cloud Console exactly matches `http://localhost:3000/auth/google/callback` |
| **Upload seems stuck** | Check your internet connection. Restart with `npm run app:dev` — it will resume from where it stopped |
| **"ENCRYPTION_SECRET must be set"** | Run `npm run app:setup` again — it generates one automatically |

---

## Stopping the app

Press `Ctrl+C` in the terminal where `npm run app:dev` is running. To also stop the database:

```bash
docker compose down
```

To start everything again later, just run `npm run app:dev`.

---

## Security notes

- All your data stays on your computer and your own Scaleway bucket — nothing goes through third-party servers
- Cloud credentials are encrypted at rest (AES-256)
- Docker ports are only accessible from your machine (bound to `127.0.0.1`)
- The `.env` file with your secrets is excluded from Git (won't be uploaded if you push the code)

---

## Immich Integration (iPhone Auto-Backup)

You can run [Immich](https://immich.app/) alongside MediaTransfer to get automatic photo backup from iPhones and Android devices — no app store or cloud subscription required.

### Setup

1. Copy the example environment file:
   ```bash
   cp .env.immich.example .env.immich
   ```

2. Start the Immich stack:
   ```bash
   docker compose -f docker-compose.immich.yml up -d
   ```

3. Open **http://localhost:2283** and create your admin account.

4. Install the Immich app on your phone ([iOS](https://apps.apple.com/app/immich/id1613945686) / [Android](https://play.google.com/store/apps/details?id=app.alextran.immich)) and connect it to `http://<your-pc-ip>:2283`.

> **Firewall:** On Windows, you may need to allow port 2283 through the firewall:
> ```powershell
> New-NetFirewallRule -DisplayName "Immich Server" -Direction Inbound -LocalPort 2283 -Protocol TCP -Action Allow -Profile Private
> ```

### Migrating existing S3 photos into Immich

If you already have photos in your Scaleway bucket (from Takeout migration), you can import them into Immich using the included migration script. It requires [rclone](https://rclone.org/) and [immich-go](https://github.com/simulot/immich-go):

```powershell
# Configure rclone with your Scaleway credentials (one-time)
rclone config

# Run the migration (downloads year-by-year, uploads to Immich, cleans up)
.\scripts\migrate-s3-to-immich.ps1
```

The script is resume-safe — re-running it skips years already completed.

### Architecture

Immich stores photos locally in `data/immich/` (managed by Docker volumes). To back up Immich photos to S3, set up an rclone sync schedule:

```powershell
# One-time sync
rclone sync ./data/immich/library scaleway:photosync/immich/library --progress

# Or create a Windows scheduled task for automatic backup
```
