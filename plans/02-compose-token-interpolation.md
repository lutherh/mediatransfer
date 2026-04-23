# 02 — Fix `${CLOUDFLARE_TUNNEL_TOKEN}` compose interpolation

**Status:** ✅ Applied 2026‑04‑23
**Files:** [../docker-compose.immich.yml](../docker-compose.immich.yml), `.env.immich` (local — not in repo)

## Problem
```
error while interpolating services.immich-tunnel.command.[]: required
variable CLOUDFLARE_TUNNEL_TOKEN is missing a value
```

## Cause
When the token is referenced as `${CLOUDFLARE_TUNNEL_TOKEN}` inside a
`command:` list, Docker Compose interpolates it at **parse time**, which
only loads the project's `.env` — it does not consult `env_file:` entries.
The token actually lives in `.env.immich`.

## Fix
1. Load `.env.immich` into the tunnel container via `env_file`.
2. Let `cloudflared` pick up the token from its **native** env var
   `TUNNEL_TOKEN`, avoiding any compose‑level interpolation.
3. Append an alias line to `.env.immich`:
   ```bash
   # Alias consumed by cloudflared (its native env var name)
   TUNNEL_TOKEN=<same value as CLOUDFLARE_TUNNEL_TOKEN>
   ```

Compose snippet:
```yaml
command:
  - tunnel
  - --no-autoupdate
  - --protocol
  - http2
  - run
env_file:
  - .env.immich
```

## Verification
```powershell
docker compose -f docker-compose.yml -f docker-compose.immich.yml config --quiet
# exit 0
docker exec immich_tunnel env | Select-String '^TUNNEL_TOKEN='
# one line — value redacted by shell if you want: ... | ForEach-Object { $_ -replace '=.*', '=<redacted>' }
```

## Rollback
Remove the `TUNNEL_TOKEN=` line from `.env.immich` and revert the
`command:` list to include `--token ${CLOUDFLARE_TUNNEL_TOKEN}`. Then move
`CLOUDFLARE_TUNNEL_TOKEN` into the project's `.env` so compose can see it
at parse time. Not recommended — the current setup keeps all
Immich‑specific secrets in one file.
