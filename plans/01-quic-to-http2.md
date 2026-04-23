# 01 — Switch cloudflared from QUIC to HTTP/2

**Status:** ✅ Applied 2026‑04‑23
**File:** [../docker-compose.immich.yml](../docker-compose.immich.yml)

## Problem
`immich_tunnel` logs periodically showed:
- `failed to sufficiently increase receive buffer size (was: 208 kiB, wanted: 7168 kiB, got: 416 kiB)` at every start.
- `failed to accept QUIC stream: timeout: no recent network activity` every 1–3 hours.
- Each reconnect aborted any in‑flight HTTP request, manifesting as
  `Incoming request ended abruptly: context canceled` on `POST /api/assets`
  and failed video uploads in the Immich mobile app.

## Cause
Docker Desktop on Windows/WSL2 silently ignores the container‑level
`sysctls:` entries `net.core.rmem_max` and `net.core.wmem_max`. The QUIC
stack falls back to a cramped UDP receive buffer, drops packets, and the
session idles out.

## Fix
Pass `--protocol http2` to `cloudflared`. HTTP/2 over TCP has no UDP buffer
requirement and is Cloudflare's recommended protocol for long‑lived
uploads.

```yaml
command:
  - tunnel
  - --no-autoupdate
  - --protocol
  - http2
  - run
```

## Verification
```powershell
docker logs immich_tunnel 2>&1 | Select-String -Pattern 'protocol|receive buffer'
```
Expect:
- `Initial protocol http2`
- 4 × `Registered tunnel connection ... protocol=http2`
- No `failed to sufficiently increase receive buffer size` line.

## Rollback
Revert the `command:` list to `tunnel --no-autoupdate run` (default
protocol is QUIC). Only do this if Cloudflare drops HTTP/2 support; there
is currently no operational reason to.
