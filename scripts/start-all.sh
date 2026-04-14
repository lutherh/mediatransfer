#!/usr/bin/env bash
# Start MediaTransfer + Immich services
# Works on Linux, macOS, and WSL.
#
# Usage:
#   ./start-all.sh          # start both stacks
#   ./start-all.sh stop     # stop both stacks
#   ./start-all.sh restart  # restart both stacks

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Wait for Docker daemon to be ready (relevant at boot)
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

# Ensure the rclone volume plugin is enabled (may be disabled after reboot)
ensure_rclone_plugin() {
  if docker plugin ls --format '{{.Name}} {{.Enabled}}' 2>/dev/null | grep -q 'rclone.*false'; then
    echo "Enabling rclone Docker plugin..."
    docker plugin enable rclone || true
  fi
}

ACTION="${1:-up}"

wait_for_docker
ensure_rclone_plugin

case "$ACTION" in
  up|start)
    echo "Starting MediaTransfer stack..."
    docker compose -f docker-compose.yml up -d

    echo "Starting Immich stack..."
    docker compose -f docker-compose.immich.yml up -d

    echo ""
    echo "All services started."
    docker compose -f docker-compose.yml ps --format 'table {{.Name}}\t{{.Status}}'
    docker compose -f docker-compose.immich.yml ps --format 'table {{.Name}}\t{{.Status}}'
    ;;

  down|stop)
    echo "Stopping Immich stack..."
    docker compose -f docker-compose.immich.yml down

    echo "Stopping MediaTransfer stack..."
    docker compose -f docker-compose.yml down
    ;;

  restart)
    "$0" stop
    "$0" up
    ;;

  *)
    echo "Usage: $0 {up|start|down|stop|restart}" >&2
    exit 1
    ;;
esac
