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
# Usage:
#   ./start-all.sh [up|start|down|stop|restart|status|logs [service…]]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.immich.yml)

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
