# mediatransfer

A command-line tool to transfer media assets between cloud providers and home NAS servers, with full metadata preservation.

## Features

- **Multiple providers** – Google Photos, any S3-compatible store (AWS S3, Scaleway, MinIO, …), and local filesystem / NAS
- **Metadata preservation** – EXIF timestamps, camera make/model, description, and original filename are kept intact
- **Date-based organisation** – assets are arranged as `YYYY/MM/DD/filename` at the destination
- **Checksum verification** – MD5 digest is compared after every upload to confirm data integrity
- **Skip-if-exists** – idempotent transfers: re-running only copies missing assets
- **Progress bar** – real-time feedback with `tqdm`
- **Verify command** – independently confirm that every source asset exists at the destination

## Installation

```bash
pip install mediatransfer
```

For development / contribution:

```bash
git clone https://github.com/lutherh/mediatransfer.git
cd mediatransfer
pip install -e ".[dev]"
```

## Quick start

### Transfer Google Photos → Scaleway S3

```bash
export GOOGLE_CLIENT_ID=<your-client-id>
export GOOGLE_CLIENT_SECRET=<your-client-secret>
export AWS_ACCESS_KEY_ID=<scaleway-access-key>
export AWS_SECRET_ACCESS_KEY=<scaleway-secret-key>

mediatransfer transfer \
  --from google-photos \
  --to s3 \
  --to-bucket my-media-bucket \
  --to-prefix photos \
  --to-endpoint https://s3.fr-par.scw.cloud \
  --verify
```

### Transfer Google Photos → AWS S3

```bash
export GOOGLE_CLIENT_ID=…
export GOOGLE_CLIENT_SECRET=…
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export AWS_DEFAULT_REGION=us-east-1

mediatransfer transfer \
  --from google-photos \
  --to s3 \
  --to-bucket my-photos \
  --verify
```

### Transfer Google Photos → local NAS

```bash
mediatransfer transfer \
  --from google-photos \
  --to local \
  --to-path /mnt/nas/photos \
  --verify
```

### Transfer between two S3 buckets

```bash
mediatransfer transfer \
  --from s3 --from-bucket source-bucket --from-endpoint https://s3.fr-par.scw.cloud \
  --to s3   --to-bucket   dest-bucket   --to-endpoint   https://s3.eu-west-3.amazonaws.com \
  --verify
```

### List assets from a provider (sorted by date)

```bash
# Google Photos
mediatransfer list --provider google-photos

# S3 / Scaleway
mediatransfer list \
  --provider s3 \
  --bucket my-media-bucket \
  --endpoint https://s3.fr-par.scw.cloud

# Local directory
mediatransfer list --provider local --local-path /mnt/nas/photos
```

### Verify a completed transfer

```bash
mediatransfer verify \
  --from google-photos \
  --to s3 \
  --to-bucket my-media-bucket \
  --to-endpoint https://s3.fr-par.scw.cloud
```

## Supported providers

| Provider key    | Read | Write | Notes |
|-----------------|------|-------|-------|
| `google-photos` | ✅   | ❌    | OAuth2; stores token in `~/.mediatransfer/google_token.json` |
| `s3`            | ✅   | ✅    | AWS S3, Scaleway, MinIO, etc. Set `--endpoint` for non-AWS |
| `local`         | ✅   | ✅    | Any mounted filesystem or NAS |

## Google Photos authentication

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Photos Library API**.
3. Create an **OAuth 2.0 Client ID** (Desktop application).
4. Download `client_secrets.json` and either:
   - Pass it with `--client-secrets client_secrets.json`, or
   - Set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` environment variables.

On first run a browser window will open for consent; the token is cached for subsequent runs.

## Destination path layout

Assets are stored at `[prefix/]YYYY/MM/DD/filename`:

```
photos/
└── 2023/
    ├── 07/
    │   └── 04/
    │       ├── vacation.jpg
    │       └── sunset.jpg
    └── 12/
        └── 25/
            └── christmas.jpg
```

## Options reference

### `transfer`

| Flag | Default | Description |
|------|---------|-------------|
| `--from` | – | Source provider (`google-photos`, `s3`, `local`) |
| `--to` | – | Destination provider (`s3`, `local`) |
| `--verify / --no-verify` | `--verify` | Compare MD5 checksums after upload |
| `--skip-existing / --no-skip-existing` | `--skip-existing` | Skip already-transferred assets |
| `--preserve-metadata / --no-preserve-metadata` | `--preserve-metadata` | Embed EXIF into JPEG/TIFF |
| `-v / --verbose` | off | Verbose logging |

### `list`

| Flag | Description |
|------|-------------|
| `--provider` | Provider to list from (`google-photos`, `s3`, `local`) |
| `--bucket` | S3 bucket name |
| `--prefix` | S3 key prefix |
| `--endpoint` | S3 endpoint URL |
| `--local-path` | Local directory path |

### `verify`

Accepts the same `--from` / `--to` flags as `transfer`.

## Development

```bash
# Install with dev extras
pip install -e ".[dev]"

# Run tests
pytest tests/ -v
```

## Architecture

```
mediatransfer/
├── providers/
│   ├── base.py           # Abstract BaseProvider + MediaAsset dataclass
│   ├── google_photos.py  # Google Photos (OAuth2 read-only)
│   ├── s3.py             # S3-compatible (read/write)
│   └── local.py          # Local filesystem (read/write)
├── metadata.py           # EXIF read/embed via piexif + Pillow
├── transfer.py           # Transfer engine (skip, verify, progress)
└── cli.py                # Click CLI (transfer / list / verify)
```

