# 06 — Raise Cloudflare ingress timeouts for long video uploads

**Status:** 🔧 Recommended — not yet applied
**Where:** Cloudflare dashboard (no repo change)

## Problem
Default Cloudflare Tunnel ingress timeouts are tuned for short web
requests (~30 s). A multi‑hundred‑MB 4K video POST to
`/api/assets` can easily exceed that while the Immich origin is hashing /
writing. When Cloudflare cuts the origin connection, cloudflared logs
`Incoming request ended abruptly: context canceled` and the mobile upload
fails.

## Fix
Set per‑hostname ingress parameters for `immich.4to.uk`:

| Parameter         | Value | Why |
|-------------------|-------|-----|
| `connectTimeout`  | `60s` | time to establish TCP to origin |
| `tlsTimeout`      | `30s` | origin is plain HTTP, but Cloudflare still applies this |
| `tcpKeepAlive`    | `30s` | keeps idle TCP alive during server‑side processing |
| `http2Origin`     | `false` *(leave default)* | Immich origin is plain HTTP/1.1 |
| `noTLSVerify`     | *(leave default)* | origin is HTTP, not HTTPS |

### Steps
1. Open **Cloudflare Zero Trust** → **Networks** → **Tunnels**.
2. Click tunnel `home-immich`.
3. Go to **Public Hostname** tab → find `immich.4to.uk` row → **Edit**.
4. Expand **Additional application settings** → **TCP**.
5. Enter the values above; save.

These settings persist in Cloudflare and survive any `cloudflared`
container restart.

## Verification
1. Upload a large (>200 MB) video from the Immich iOS app over cellular
   (forces the tunnel path). Must complete without error.
2. During / after the upload:
   ```powershell
   docker logs --since 10m immich_tunnel 2>&1 |
     Select-String -Pattern 'context canceled|stream .* canceled by remote'
   ```
   Must return zero matches for that upload's time window.

## Rollback
Clear the three fields in the Cloudflare UI to restore defaults. No
cloudflared restart required.
