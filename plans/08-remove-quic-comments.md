# 08 — Trim obsolete QUIC comments in compose file

**Status:** 🔧 Recommended — apply after HTTP/2 has run cleanly for ≥ 1 week
**File to change:** [../docker-compose.immich.yml](../docker-compose.immich.yml)
**Related:** [01-quic-to-http2.md](01-quic-to-http2.md), [04-remove-sysctls.md](04-remove-sysctls.md)

## Problem
The `immich-tunnel` service carries a long comment block explaining *why*
we forced HTTP/2 over QUIC, referencing UDP buffer sizes and Docker
Desktop behaviour. Useful context during the migration, but it hides the
actual configuration and will rot.

## Fix
Once HTTP/2 has proven stable (see §Verification), shrink the explanatory
comment to a single line and keep the operational knobs obvious.

### Target shape
```yaml
immich-tunnel:
  image: cloudflare/cloudflared:latest
  container_name: immich_tunnel
  restart: unless-stopped
  # HTTP/2 over TCP — more reliable than QUIC behind Docker Desktop for
  # long video uploads. See plans/01-quic-to-http2.md for history.
  command:
    - tunnel
    - --no-autoupdate
    - --protocol
    - http2
    - run
  env_file:
    - .env.immich
  depends_on:
    - immich-server
```

## Do NOT remove
- The `rclone-cleanup` sidecar and its FUSE comment — still needed on
  Linux hosts, and a partial safety net even on Docker Desktop.
- The write‑based healthcheck on `rclone-s3` — unrelated to QUIC, guards
  against silently dead FUSE mounts at runtime.

## Verification
Apply the trim, then:
```powershell
docker compose -f docker-compose.yml -f docker-compose.immich.yml config --quiet
./scripts/start-all.ps1 restart
docker logs immich_tunnel 2>&1 | Select-String 'protocol=http2'
# 4 lines expected
```

## When to apply
Wait at least **7 days** of continuous operation with HTTP/2 before
trimming, so the comment remains a searchable audit trail if anything
regresses in that window.
