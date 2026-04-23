# 03 — Clear stale `fuse.rclone` mounts in the Docker Desktop VM

**Status:** ✅ Applied 2026‑04‑23 (manual, one‑off). Permanent automation tracked in [05-host-side-fuse-cleanup.md](05-host-side-fuse-cleanup.md).

## Problem
`docker compose up` failed with:
```
invalid mount config for type "bind":
stat /run/desktop/mnt/host/c/dev/PhotosBackup/mediatransfer/data/s3-mount:
transport endpoint is not connected
```
This blocked `immich_rclone_s3`, `immich_server`, and the entire fleet.

## Cause
After an unclean Docker Desktop shutdown, three stale `fuse.rclone` mounts
remained inside the `docker-desktop` WSL VM:
- `/mnt/host/c/dev/PhotosBackup/mediatransfer/data/s3-mount`
- `/tmp/docker-desktop-root/mnt/host/…/data/s3-mount`
- `/tmp/docker-desktop-root/run/desktop/mnt/host/…/data/s3-mount`

The in‑container `rclone-cleanup` sidecar can't fix this: Docker refuses
to create **any** container when the host bind path has a dead FUSE
endpoint, so the sidecar never starts.

## Fix (manual)
Lazy‑unmount all stale FUSE endpoints from the host:
```powershell
wsl -d docker-desktop -- sh -c "mount | grep fuse.rclone | awk '{print \$3}' | xargs -r -n1 umount -l"
```
Then retry `./scripts/start-all.ps1 up`.

## Verification
```powershell
wsl -d docker-desktop -- sh -c "mount | grep fuse.rclone || echo clean"
# clean
```

## Follow‑up
This will happen again after the next unclean shutdown. Automate in
[05-host-side-fuse-cleanup.md](05-host-side-fuse-cleanup.md).
