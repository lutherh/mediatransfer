# 05 — Host‑side FUSE cleanup before `docker compose up`

**Status:** 🔧 Recommended — not yet applied
**File to change:** [../scripts/start-all.ps1](../scripts/start-all.ps1)
**Related:** [03-stale-fuse-mounts.md](03-stale-fuse-mounts.md)

## Problem
The existing `rclone-cleanup` sidecar in
[../docker-compose.immich.yml](../docker-compose.immich.yml) runs **inside
a container**. After an unclean Docker Desktop shutdown, Docker refuses to
create any container when the host bind path has a dead FUSE endpoint —
so the cleanup sidecar itself fails to start, and every `docker compose
up` needs a manual `wsl -d docker-desktop -- umount` dance.

## Fix
Add a Windows‑only pre‑up step to `scripts/start-all.ps1` that
lazy‑unmounts stale `fuse.rclone` mounts in the `docker-desktop` WSL VM
before invoking `docker compose up`. No‑op on Linux / macOS where FUSE
mounts are handled natively by Docker Engine.

Insert **after** `Wait-Docker` / `Assert-Compose` and **before** the `up`
branch of the `switch ($Action)` block:

```powershell
function Clear-StaleFuseMounts {
    # Only relevant on Windows with Docker Desktop (WSL2).
    if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) { return }
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { return }

    # Silently lazy-unmount any stale rclone FUSE endpoints in the
    # docker-desktop VM. Required because Docker refuses to create
    # containers when the host bind path has a dead FUSE endpoint,
    # which prevents the in-container rclone-cleanup sidecar from
    # running. See plans/03-stale-fuse-mounts.md.
    wsl -d docker-desktop -- sh -c `
        "mount 2>/dev/null | grep fuse.rclone | awk '{print \$3}' | xargs -r -n1 umount -l 2>/dev/null" `
        *> $null
}

# Call before any `docker compose up` action:
if ($Action -in 'up', 'start', 'restart') { Clear-StaleFuseMounts }
```

## Verification
1. Simulate an unclean shutdown: stop Docker Desktop abruptly (Task
   Manager → end `Docker Desktop.exe`).
2. Start Docker Desktop again.
3. Confirm stale mounts are present:
   ```powershell
   wsl -d docker-desktop -- sh -c "mount | grep fuse.rclone || echo clean"
   ```
4. Run `./scripts/start-all.ps1 up` — must succeed on the first try with
   no `transport endpoint is not connected` error.
5. Confirm no stale mounts remain after startup:
   ```powershell
   wsl -d docker-desktop -- sh -c "mount | grep fuse.rclone" | Select-String 'grep fuse.rclone'
   # Only the live mount (if any) remains.
   ```

## Risks
- On a clean system the `wsl` call adds ~200 ms to every `up` / `restart`.
  Acceptable.
- If the user runs WSL distros without a `docker-desktop` distro (e.g.
  Docker Engine in a custom distro), the call fails silently — harmless.
- Does **not** address the symmetric case on `down` where leaving the
  mount live is intentional. Only clean on `up`/`start`/`restart`.
