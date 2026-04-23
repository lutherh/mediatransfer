# 04 — Remove `sysctls` block from `immich-tunnel`

**Status:** ✅ Applied 2026‑04‑23
**File:** [../docker-compose.immich.yml](../docker-compose.immich.yml)

## Problem
Starting `immich_tunnel` failed with:
```
failed to create shim task: OCI runtime create failed: runc create failed:
unable to start container process: error during container init:
open sysctl net.core.rmem_max file: unsafe procfs detected:
openat2 fsmount:fscontext:proc/./sys/net/core/rmem_max: no such file or directory
```

## Cause
Docker Desktop on WSL2 refuses to apply the container `sysctls:` entries
`net.core.rmem_max` / `net.core.wmem_max`. The kernel's procfs guard
rejects the write and container init aborts.

## Fix
Removed the `sysctls:` block entirely. It was only ever there to give QUIC
enough UDP buffer space; now that cloudflared runs over HTTP/2
([01-quic-to-http2.md](01-quic-to-http2.md)), the setting is irrelevant.

Before:
```yaml
env_file:
  - .env.immich
sysctls:
  - net.core.rmem_max=7500000
  - net.core.wmem_max=7500000
depends_on:
  - immich-server
```
After:
```yaml
env_file:
  - .env.immich
depends_on:
  - immich-server
```

## Verification
```powershell
docker compose -f docker-compose.yml -f docker-compose.immich.yml up -d immich-tunnel
docker ps --filter name=immich_tunnel --format '{{.Status}}'
# Up <n> seconds
```

## Rollback
Only needed if reverting to QUIC ([01-quic-to-http2.md](01-quic-to-http2.md)).
On Docker Desktop the `sysctls:` approach won't work anyway; the correct
fix there is a host‑level sysctl in WSL, not the container manifest.
