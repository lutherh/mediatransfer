#!/usr/bin/env bash
# Mount Scaleway S3 bucket for Immich originals storage.
# Requires:
#   - Linux: rclone + fuse3   (apt install rclone fuse3)
#   - macOS: rclone only      (brew install rclone) — uses `rclone nfsmount`,
#                              NO macFUSE / NO kernel extension / NO reboot.
#
# Usage:
#   ./scripts/mount-s3.sh              # mount (foreground — Ctrl+C to stop)
#   ./scripts/mount-s3.sh --background # mount as daemon (writes a PID file)
#   ./scripts/mount-s3.sh --unmount    # unmount AND stop the daemon
#
# S3 credentials are read from .env (single source of truth):
#   SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_REGION
#
# Mount config is read from .env.immich:
#   RCLONE_BUCKET, RCLONE_PREFIX, UPLOAD_LOCATION
#
# No rclone remote or rclone.conf is needed — credentials are passed inline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# rclone remote-control endpoint as a Unix domain socket. Auto-created by
# rclone with 0600 perms (owner-only) — eliminates the loopback-attack
# surface of `--rc-no-auth` on a TCP port.
RC_SOCK="$ROOT_DIR/data/rclone-rc.sock"

# ── Helper: read a key from a .env file ──
read_env_val() {
  local file="$1" key="$2" default="${3:-}"
  local val
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//" | tr -d '\r')
  echo "${val:-$default}"
}

# ── Load config ──
MAIN_ENV="$ROOT_DIR/.env"
IMMICH_ENV="$ROOT_DIR/.env.immich"

if [ ! -f "$MAIN_ENV" ]; then
  echo "ERROR: .env not found at $MAIN_ENV" >&2
  exit 1
fi
if [ ! -f "$IMMICH_ENV" ]; then
  echo "ERROR: .env.immich not found at $IMMICH_ENV — copy from .env.immich.example first." >&2
  exit 1
fi

# S3 credentials from .env
ACCESS_KEY=$(read_env_val "$MAIN_ENV" SCW_ACCESS_KEY)
SECRET_KEY=$(read_env_val "$MAIN_ENV" SCW_SECRET_KEY)
REGION=$(read_env_val "$MAIN_ENV" SCW_REGION "fr-par")
STORAGE_CLASS=$(read_env_val "$MAIN_ENV" SCW_STORAGE_CLASS)

if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
  echo "ERROR: SCW_ACCESS_KEY and SCW_SECRET_KEY must be set in .env" >&2
  exit 1
fi

# Resolve endpoint and signing region from SCW_REGION (accepts code or full URL)
if [[ "$REGION" =~ ^https?:// ]]; then
  ENDPOINT="$REGION"
  SIGNING_REGION=$(echo "$REGION" | sed -n 's|.*s3\.\([a-z0-9-]*\)\.scw\.cloud.*|\1|p')
  if [ -z "$SIGNING_REGION" ]; then
    echo "ERROR: Cannot derive signing region from endpoint URL: $REGION" >&2
    exit 1
  fi
else
  ENDPOINT="https://s3.${REGION}.scw.cloud"
  SIGNING_REGION="$REGION"
fi

# Mount config from .env.immich (falls back to .env for bucket)
BUCKET=$(read_env_val "$IMMICH_ENV" RCLONE_BUCKET "$(read_env_val "$MAIN_ENV" SCW_BUCKET)")
PREFIX=$(read_env_val "$IMMICH_ENV" RCLONE_PREFIX "immich")
MOUNT_POINT=$(read_env_val "$IMMICH_ENV" UPLOAD_LOCATION "./data/immich-s3")
# Pinning the NFS port matters on macOS: when rclone is restarted by launchd,
# reusing the same port lets the kernel NFS client reconnect transparently.
# Without this, every restart picks a new ephemeral port and Finder shows
# "Server connections interrupted" on the now-orphaned mount.
NFS_PORT=$(read_env_val "$IMMICH_ENV" RCLONE_NFS_PORT "32049")
# DEPRECATED: kept only as a fallback knob in case we ever need to revert
# from the Unix domain socket (see RC_SOCK above) back to a TCP rc server.
# The rc server now binds to RC_SOCK; this value is no longer wired in.
RCLONE_RC_PORT=$(read_env_val "$IMMICH_ENV" RCLONE_RC_PORT "5573")

if [ -z "$BUCKET" ]; then
  echo "ERROR: No bucket configured. Set RCLONE_BUCKET in .env.immich or SCW_BUCKET in .env" >&2
  exit 1
fi

# Resolve relative paths from repo root
if [[ "$MOUNT_POINT" != /* ]]; then
  MOUNT_POINT="$ROOT_DIR/$MOUNT_POINT"
fi

SOURCE=":s3:${BUCKET}/${PREFIX}"

# Pre-flight
if ! command -v rclone &>/dev/null; then
  echo "ERROR: rclone is not installed. Install with: sudo apt install rclone  (or brew install rclone)" >&2
  exit 1
fi

if ! grep -q fuse /proc/filesystems 2>/dev/null && [ "$(uname)" != "Darwin" ]; then
  echo "WARNING: FUSE not found. Install with: sudo apt install fuse3" >&2
fi

# PID file lives next to the mount point so multiple repos / mount points
# don't fight over a single global file.
PID_FILE="${MOUNT_POINT%/}.rclone.pid"

# Unmount
if [[ "${1:-}" == "--unmount" || "${1:-}" == "-u" ]]; then
  # 1) Drain the rclone vfs writeback queue FIRST — before tearing the mount
  #    down. Unmounting can kill the rc server (or invalidate cache state),
  #    so any in-flight writes (--vfs-cache-mode writes) would be lost.
  #
  #    There is NO `vfs/sync` rc method on rclone 1.x (only forget|list|
  #    queue|queue-set-expiry|refresh|stats). The correct primitive is to
  #    poll `vfs/queue` until it reports zero pending uploads. Earlier
  #    versions of this script called the non-existent `vfs/sync` and the
  #    `|| true` masked the 404 — it was relying on rclone's graceful
  #    SIGTERM drain (ExitTimeOut=900s in launchd) the whole time.
  if command -v rclone &>/dev/null; then
    if rclone rc rc/noop --unix-socket "$RC_SOCK" --timeout 3s &>/dev/null; then
      echo "Draining rclone vfs writeback queue via rc on $RC_SOCK ..."
      drain_deadline=$(( $(date +%s) + 120 ))
      while [ "$(date +%s)" -lt "$drain_deadline" ]; do
        q_len=$(rclone rc vfs/queue --unix-socket "$RC_SOCK" --timeout 5s 2>/dev/null \
          | jq -r '[.queue[]?] | length' 2>/dev/null || echo 0)
        if [ "${q_len:-0}" = "0" ]; then
          echo "  writeback queue empty"
          break
        fi
        echo "  $q_len item(s) still pending; sleeping 2s"
        sleep 2
      done
    else
      echo "WARN: rclone rc unreachable at $RC_SOCK — skipping queue drain (relying on rclone SIGTERM grace period)" >&2
    fi
  fi
  # 2) Unmount the filesystem.
  echo "Unmounting $MOUNT_POINT ..."
  if [ "$(uname)" = "Darwin" ]; then
    diskutil unmount force "$MOUNT_POINT" 2>/dev/null || umount -f "$MOUNT_POINT" 2>/dev/null || true
  else
    fusermount -uz "$MOUNT_POINT" 2>/dev/null || umount "$MOUNT_POINT" 2>/dev/null || true
  fi
  # 3) Stop the rclone daemon — without this it survives the unmount and
  #    leaks an orphan NFS server on a random localhost port.
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      sleep 1
      kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # 4) Belt-and-braces formerly used `pkill -f` here, but the regex inter-
  #    polated $MOUNT_POINT (which contains `.` and `/`) and could SIGTERM
  #    unrelated rclone processes. PID-file kill above is sufficient.
  echo "Done."
  exit 0
fi

# Ensure mount + runtime directories. The rclone rc Unix socket lives under
# data/ and trusts filesystem permissions, so keep that directory owner-only
# before rclone creates the socket.
mkdir -p "$ROOT_DIR/data" "$MOUNT_POINT"
chmod 0750 "$ROOT_DIR/data"

# Defensively unmount any stale NFS / FUSE handle still pointing at this path.
# Without this, when launchd restarts a crashed rclone the kernel keeps the old
# mount handle alive (pointing at the dead rclone NFS port), and Finder pops
# "Server connections interrupted." `mount` always lists active entries, so a
# match here means the previous server is gone but the client mount lingers.
if mount | grep -Fq " ${MOUNT_POINT} "; then
  echo "Found stale mount at $MOUNT_POINT — clearing before remount..."
  if [ "$(uname)" = "Darwin" ]; then
    diskutil unmount force "$MOUNT_POINT" 2>/dev/null \
      || umount -f "$MOUNT_POINT" 2>/dev/null \
      || true
  else
    fusermount -uz "$MOUNT_POINT" 2>/dev/null || umount -l "$MOUNT_POINT" 2>/dev/null || true
  fi
fi

echo "Mounting $SOURCE -> $MOUNT_POINT"
echo "  Endpoint: $ENDPOINT"
echo "  Bucket:   $BUCKET"
echo "  Prefix:   $PREFIX"
echo ""

# On macOS, Homebrew's rclone bottle does NOT include macFUSE bindings, so the
# `mount` subcommand fails immediately. Use `nfsmount` instead — it serves NFS
# on a local port and uses the system's built-in NFS client (no kernel ext,
# no reboot, no macFUSE). On Linux we keep the original FUSE-based `mount`.
if [ "$(uname)" = "Darwin" ]; then
  MOUNT_SUBCMD="nfsmount"
  # Pin the NFS server port so launchd-restarts are transparent to the kernel
  # NFS client. See NFS_PORT comment above.
  EXTRA_MOUNT_FLAGS=(--addr "localhost:$NFS_PORT")
else
  MOUNT_SUBCMD="mount"
  EXTRA_MOUNT_FLAGS=(--allow-other)
fi

RCLONE_ARGS=(
  "$MOUNT_SUBCMD" "$SOURCE" "$MOUNT_POINT"
  --s3-provider Scaleway
  --s3-access-key-id "$ACCESS_KEY"
  --s3-secret-access-key "$SECRET_KEY"
  --s3-endpoint "$ENDPOINT"
  --s3-region "$SIGNING_REGION"
  ${STORAGE_CLASS:+--s3-storage-class "$STORAGE_CLASS"}
  # `full` (vs `writes`) caches READS to disk too. Critical for Finder
  # browsing on a remote bucket: without it, every QuickLook / icon-preview
  # re-fetches the file from Scaleway nl-ams on each access. With `full`,
  # the second open is local-disk fast.
  --vfs-cache-mode full
  --vfs-write-back 5s
  # Keep cached reads for a day; LRU-evicted by --vfs-cache-max-size.
  --vfs-cache-max-age 24h
  # 20 GiB read cache under ~/Library/Caches/rclone — enough to hold a
  # working set of recently-browsed photos/videos.
  --vfs-cache-max-size 20G
  # Refuse to grow the cache when the disk has < 5 GiB free. Prevents
  # rclone from filling the boot volume if ~/Library/Caches lives there.
  --vfs-cache-min-free-space 5G
  # Pre-fetch the next 128 MiB on sequential reads. Big QuickLook win for
  # video scrubbing; only meaningful with --vfs-cache-mode full.
  --vfs-read-ahead 128M
  # Use only modtime+size for cache-invalidation fingerprinting (skip the
  # slower hash check). Safe for an immutable photo archive — rclone still
  # re-fetches if size or mtime changes.
  --vfs-fast-fingerprint
  --vfs-read-chunk-size 16M
  --vfs-read-chunk-size-limit 64M
  # 5 minutes is the freshness ceiling for new objects written to S3
  # OUT-OF-BAND (i.e. by MediaTransfer's S3 SDK, bypassing this mount).
  # We CANNOT use a longer value here: the S3 backend silently ignores
  # --poll-interval ("poll-interval is not supported by this remote"),
  # so dir-cache-time is the ONLY freshness mechanism. Going higher than
  # 5m means Immich's library scan can miss freshly-uploaded assets for
  # up to that long. If you need lower latency, push an explicit
  # `rclone rc --unix-socket data/rclone-rc.sock vfs/refresh dir=<path>`
  # from the upload pipeline after each batch.
  --dir-cache-time 5m
  # Recursively warm the dir cache at mount time so the first Finder click
  # doesn't have to round-trip to nl-ams to enumerate the bucket root.
  --vfs-refresh
  --transfers 8
  --s3-chunk-size 16M
  # Default --low-level-retries=10 is intentional — do not lower; flaky
  # Scaleway 503s during multi-GB writeback need the retries.
  --rc
  --rc-addr "unix://$RC_SOCK"
  ${EXTRA_MOUNT_FLAGS[@]+"${EXTRA_MOUNT_FLAGS[@]}"}
  --log-level NOTICE
)

if [[ "${1:-}" == "--background" || "${1:-}" == "-b" ]]; then
  RCLONE_ARGS+=(--daemon)
  # Tighten umask so the rc Unix socket is created 0600 even in the brief
  # window between bind() and rclone's chmod(). Parity with --supervised /
  # foreground branches below. See security review P3-1.
  umask 077
  # Clear any stale Unix socket from a previously crashed rclone — otherwise
  # bind() returns EADDRINUSE and rclone retries forever ("Failed to start
  # remote control: ... bind: address already in use").
  rm -f "$RC_SOCK" 2>/dev/null || true
  rclone "${RCLONE_ARGS[@]}"
  # Capture the PID of the daemon rclone forks. `rclone --daemon` double-forks,
  # so we record the most recent rclone PID owning this mount point.
  sleep 1
  RCLONE_PID=$(pgrep -f "rclone .*${MOUNT_SUBCMD}.* ${MOUNT_POINT}" | tail -1 || true)
  if [ -n "${RCLONE_PID:-}" ]; then
    echo "$RCLONE_PID" > "$PID_FILE"
  fi
  echo "Mount running in background (pid ${RCLONE_PID:-?}, pidfile $PID_FILE)."
  echo "Unmount with: $0 --unmount"
elif [[ "${1:-}" == "--supervised" ]]; then
  # For launchd: run rclone as a foreground child, replacing the shell so
  # signals from launchd reach rclone directly (clean SIGTERM → unmount → exit).
  # Do NOT use --daemon here; launchd is the supervisor.
  echo "Mount running supervised (foreground, exec'd into rclone)."
  # Tighten umask so the rc Unix socket is created 0600 even in the brief
  # window between bind() and rclone's chmod(). See security review P3-1.
  umask 077
  # Clear any stale Unix socket from a prior rclone instance — launchd's
  # SIGKILL on ExitTimeOut can leave the socket file behind, and the next
  # supervised launch then loops on EADDRINUSE forever.
  rm -f "$RC_SOCK" 2>/dev/null || true
  exec rclone "${RCLONE_ARGS[@]}"
else
  echo "Mount running in foreground. Press Ctrl+C to stop."
  echo ""
  umask 077
  rm -f "$RC_SOCK" 2>/dev/null || true
  exec rclone "${RCLONE_ARGS[@]}"
fi
