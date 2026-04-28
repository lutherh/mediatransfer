# Immich Tunnel — Reliability Plans (index)

Root cause of failing video uploads: the Cloudflare Tunnel was running over
QUIC with an undersized UDP receive buffer (Docker Desktop / WSL2 silently
ignores the container `sysctls`), causing periodic
`failed to accept QUIC stream: timeout: no recent network activity` errors.
Every reconnect aborted in‑flight HTTP requests, so multi‑minute video
POSTs to `/api/assets` failed with
`Incoming request ended abruptly: context canceled`.

Each step below lives in its own file under [plans/](plans/).

## ✅ Fixed — 2026‑04‑23
1. [plans/01-quic-to-http2.md](plans/01-quic-to-http2.md) — switch cloudflared to HTTP/2.
2. [plans/02-compose-token-interpolation.md](plans/02-compose-token-interpolation.md) — fix `${CLOUDFLARE_TUNNEL_TOKEN}` parse error.
3. [plans/03-stale-fuse-mounts.md](plans/03-stale-fuse-mounts.md) — clear stale `fuse.rclone` mounts in WSL VM (manual one‑off; permanent automation in plan 05).
4. [plans/04-remove-sysctls.md](plans/04-remove-sysctls.md) — drop `sysctls` block that Docker Desktop rejects.
5. [plans/05-host-side-fuse-cleanup.md](plans/05-host-side-fuse-cleanup.md) — pre‑`docker compose up` WSL unmount baked into `start-all.ps1`.

## ✅ Fixed — 2026‑04‑23 (host side)
7. [plans/07-lan-endpoint-mobile.md](plans/07-lan-endpoint-mobile.md) — bypass tunnel on home Wi‑Fi. Host listens on `${IMMICH_LAN_IP}:2283` (set in `.env.immich`, auto‑detected by `scripts/start-all.sh`); firewall rule allows the home LAN subnet on the Private/trusted profile. Per-device app config still required on each phone.

## 🔧 Recommended — not yet applied
6. [plans/06-cloudflare-ingress-timeouts.md](plans/06-cloudflare-ingress-timeouts.md) — raise `connectTimeout` / `tlsTimeout` / `tcpKeepAlive`.
8. [plans/08-remove-quic-comments.md](plans/08-remove-quic-comments.md) — trim now‑obsolete QUIC comments.

## Verification checklist (run after any change)

1. `docker compose -f docker-compose.yml -f docker-compose.immich.yml config --quiet` exits 0.
2. `./scripts/start-all.ps1 up` brings all 10 containers to `healthy` / `Up` within ~30s on a clean state.
3. `docker logs immich_tunnel` shows `protocol=http2` on all four `Registered tunnel connection` lines, no `failed to sufficiently increase receive buffer size`.
4. `Invoke-WebRequest http://127.0.0.1:2283/api/server/ping` → `{"res":"pong"}`.
5. `Invoke-WebRequest https://immich.4to.uk/api/server/ping` → `{"res":"pong"}`.
6. A real mobile upload of a >200 MB video over the tunnel completes without `Incoming request ended abruptly: context canceled` or `stream N canceled by remote` in `docker logs immich_tunnel`.
