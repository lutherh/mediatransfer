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

ACTION="${1:-up}"
shift || true

wait_for_docker
require_compose

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
