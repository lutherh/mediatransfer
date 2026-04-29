#!/usr/bin/env bash
# Start / stop / restart the MediaTransfer + Immich stacks.
#
# Works on:
#   - Linux (Docker Engine)
#   - macOS (Docker Desktop)
#   - WSL2 (Docker Desktop with WSL integration)
#   - Git Bash on Windows
#
# The rclone-cleanup sidecar defined in docker-compose.immich.yml handles
# stale FUSE mounts inside the Docker host namespace. That same mechanism
# works identically on Linux / macOS / Windows Docker Desktop, so this
# wrapper deliberately stays OS-agnostic and does no host-side fiddling.
#
# macOS prerequisite (Immich):
#   docker-compose.immich.yml binds ${UPLOAD_LOCATION:-./data/immich} into the
#   Immich container as /usr/src/app/upload. With UPLOAD_LOCATION pointing at
#   ./data/immich-s3 (the rclone S3 mount), that path MUST be a live NFS mount
#   before the container starts — otherwise Immich silently writes originals
#   into a stale snapshot inside the container layer, which is a data-loss
#   risk on the next restart.
#
#   On macOS we therefore verify that data/immich-s3 is currently an `nfs`
#   mount before bringing the stack up. Set START_ALL_AUTO_MOUNT=1 to have
#   this script auto-run ./scripts/mount-s3.sh --background when the mount
#   is missing; otherwise it fails loud and points at the docs.
#
# Usage:
#   ./start-all.sh [up|start|down|stop|restart|status|logs [service…]]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.immich.yml)

# Activate the `linux` compose profile only on Linux. This gates the
# rclone-s3 + rclone-cleanup sidecars (in-container FUSE mount), which are
# non-functional on macOS — OrbStack cannot propagate FUSE mounts back to
# the host bind, so rclone-s3 never goes healthy and `immich-server` blocks
# in `Created` if the dependency is active. On macOS the originals are
# served from the host NFS mount validated by ensure_macos_s3_mount() below.
if [ "$(uname -s)" = "Linux" ]; then
  export COMPOSE_PROFILES="${COMPOSE_PROFILES:-linux}"
else
  unset COMPOSE_PROFILES
fi

wait_for_docker() {
  local retries=30
  while ! docker info >/dev/null 2>&1; do
    retries=$((retries - 1))
    if [ "$retries" -le 0 ]; then
      echo "ERROR: Docker daemon not available after 60 seconds" >&2
      exit 1
    fi
    echo "Waiting for Docker daemon..."
    sleep 2
  done
}

require_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: 'docker compose' (v2) is required. Install Docker Desktop or the compose-plugin package." >&2
    exit 1
  fi
}

# Read a key from a .env-style file (no shell sourcing → no token interpolation surprises).
read_env_val() {
  local file="$1" key="$2" default="${3:-}"
  local val
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//" | tr -d '\r')
  echo "${val:-$default}"
}

# macOS-only: ensure the rclone S3 mount backing UPLOAD_LOCATION is live before
# bringing the Immich stack up. Without it, Immich writes originals into a
# stale path inside the container layer instead of S3 — silent data loss.
ensure_macos_s3_mount() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  [ -f .env.immich ] || return 0  # no Immich config = no Immich stack to guard

  local upload_location
  upload_location="$(read_env_val .env.immich UPLOAD_LOCATION ./data/immich)"

  # Only guard when UPLOAD_LOCATION is the dedicated S3 mount path.
  case "$upload_location" in
    *immich-s3*) ;;
    *) return 0 ;;
  esac

  local abs_mount="$upload_location"
  if [[ "$abs_mount" != /* ]]; then
    abs_mount="$ROOT_DIR/$abs_mount"
  fi
  # Normalize without entering the mount point. If the mount is stale, even
  # `cd "$abs_mount"` can hang before the bounded liveness probe below gets
  # a chance to run. Resolve only the parent directory and append the mount
  # basename.
  local mount_parent mount_base
  mount_parent="$(dirname "$abs_mount")"
  mount_base="$(basename "$abs_mount")"
  if mount_parent="$(cd "$mount_parent" 2>/dev/null && pwd -P)"; then
    abs_mount="$mount_parent/$mount_base"
  fi

  is_nfs_mounted() {
    local target="$1"
    mount | grep -F " on ${target} " | grep -Fq "(nfs"
  }

  # `mount | grep` only proves the kernel still has a mount entry — it does
  # NOT detect a stale NFS endpoint where the rclone-side server has died
  # but the entry hasn't been reaped yet. A real syscall round-trip is the
  # only reliable liveness probe. We list a sentinel subdir (`library/` is
  # always present in the canonical photosync/immich layout) with a 5s
  # bound to avoid hanging on a wedged NFS endpoint. See AGENTS.md
  # "Things that bite" — stale FUSE / dead NFS look identical from `mount`.
  probe_mount_live() {
    local target="$1"
    # Use a backgrounded `ls` + perl-bounded wait. macOS lacks GNU `timeout`
    # by default; perl is shipped with the system and gives us a hard cap.
    perl -e '
      use strict; use warnings;
      my ($path, $secs) = @ARGV;
      my $pid = fork();
      if (!defined $pid) { exit 2; }
      if ($pid == 0) {
        open STDOUT, ">", "/dev/null"; open STDERR, ">", "/dev/null";
        exec("/bin/ls", "-1", "$path/library") or exit 127;
      }
      local $SIG{ALRM} = sub { kill 9, $pid; waitpid($pid, 0); exit 3; };
      alarm $secs;
      waitpid($pid, 0);
      my $code = $? >> 8;
      exit($code == 0 ? 0 : 1);
    ' "$target" 5
  }

  if is_nfs_mounted "$abs_mount"; then
    if probe_mount_live "$abs_mount"; then
      echo "S3 mount: $abs_mount (nfs, live)"
      return 0
    fi
    echo "WARN: $abs_mount is in the mount table but unresponsive (stale NFS endpoint)." >&2
    if [ "${START_ALL_AUTO_MOUNT:-0}" = "1" ]; then
      echo "  attempting forced unmount + remount (START_ALL_AUTO_MOUNT=1)..." >&2
      "$SCRIPT_DIR/mount-s3.sh" --unmount >/dev/null 2>&1 || true
      diskutil unmount force "$abs_mount" >/dev/null 2>&1 || true
      "$SCRIPT_DIR/mount-s3.sh" --background
      sleep 2
      if is_nfs_mounted "$abs_mount" && probe_mount_live "$abs_mount"; then
        echo "S3 mount: $abs_mount (nfs, live after remount)"
        return 0
      fi
      echo "ERROR: remount of $abs_mount still unresponsive." >&2
      exit 1
    fi
    cat >&2 <<EOF
ERROR: $abs_mount is mounted but stale (rclone has likely died).

  Force-unmount and remount:
    ./scripts/mount-s3.sh --unmount || diskutil unmount force "$abs_mount"
    ./scripts/mount-s3.sh --background

  Or re-run this script with auto-mount enabled:
    START_ALL_AUTO_MOUNT=1 $0 ${ACTION}

EOF
    exit 1
  fi

  if [ "${START_ALL_AUTO_MOUNT:-0}" = "1" ]; then
    echo "S3 mount missing at $abs_mount — auto-mounting (START_ALL_AUTO_MOUNT=1)..."
    "$SCRIPT_DIR/mount-s3.sh" --background
    sleep 2
    if ! is_nfs_mounted "$abs_mount" || ! probe_mount_live "$abs_mount"; then
      echo "ERROR: auto-mount of $abs_mount did not produce a live nfs mount." >&2
      exit 1
    fi
    return 0
  fi

  cat >&2 <<EOF
ERROR: Immich expects $abs_mount to be a live S3 mount, but it isn't.

  Mount it first:
    ./scripts/mount-s3.sh --background

  Or re-run this script with auto-mount enabled:
    START_ALL_AUTO_MOUNT=1 $0 ${ACTION}

  See README.md → "Native macOS Setup" / "Optional: Immich" for details.
EOF
  exit 1
}

# Auto-detect the host's LAN IP and export it for compose so phones on
# home Wi-Fi can reach immich-server on :2283 without going through the
# Cloudflare tunnel. Never hardcoded — the value is local to this host.
# Honors IMMICH_LAN_IP if already set in .env.immich; otherwise picks
# the first non-loopback, non-Docker IPv4 in the 10/172.16/192.168 ranges.
detect_lan_ip() {
  if [ -n "${IMMICH_LAN_IP:-}" ]; then
    echo "$IMMICH_LAN_IP"
    return
  fi
  local ip=""
  case "$(uname -s)" in
    Darwin)
      for iface in en0 en1 en2 en3; do
        ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
        [ -n "$ip" ] && break
      done
      ;;
    Linux)
      ip="$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
      ;;
  esac
  # Filter out anything that's not a real LAN IP.
  if ! echo "$ip" | grep -Eq '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'; then
    ip=""
  fi
  echo "$ip"
}

ACTION="${1:-up}"
shift || true

wait_for_docker
require_compose

# Source .env.immich so IMMICH_LAN_IP (if user-pinned) wins over auto-detect.
if [ -f .env.immich ]; then
  set -a; . ./.env.immich; set +a
fi
IMMICH_LAN_IP="$(detect_lan_ip)"
export IMMICH_LAN_IP
if [ -n "$IMMICH_LAN_IP" ]; then
  echo "LAN endpoint: http://${IMMICH_LAN_IP}:2283"
else
  echo "LAN endpoint: not detected — binding to 127.0.0.1 only"
fi

case "$ACTION" in
  up|start)
    ensure_macos_s3_mount
    echo "Starting all services..."
    docker compose "${COMPOSE_FILES[@]}" up -d --remove-orphans
    echo ""
    echo "All services started."
    docker compose "${COMPOSE_FILES[@]}" ps --format 'table {{.Name}}\t{{.Status}}'
    ;;

  down|stop)
    echo "Stopping all services..."
    docker compose "${COMPOSE_FILES[@]}" down
    ;;

  restart)
    "$0" stop
    "$0" up
    ;;

  status|ps)
    docker compose "${COMPOSE_FILES[@]}" ps
    ;;

  logs)
    docker compose "${COMPOSE_FILES[@]}" logs -f "$@"
    ;;

  *)
    echo "Usage: $0 {up|start|down|stop|restart|status|logs [service…]}" >&2
    exit 1
    ;;
esac
