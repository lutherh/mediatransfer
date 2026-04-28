#!/usr/bin/env bash
# MediaTransfer — native macOS setup.
#
# Idempotent: safe to re-run. Installs / verifies:
#   - Homebrew (must already be present)
#   - Node.js, PostgreSQL 16, Redis (Homebrew services)
#   - rclone (host-side S3 mount for Immich; uses macOS NFS client, no macFUSE)
#   - Docker Desktop running (only checked, never installed)
#   - macOS sleep settings (opt-in; long-running takeout/upload jobs and the
#     Cloudflare Tunnel container need the machine to stay awake)
#
# Notes:
#   - macFUSE is NOT installed and NOT required. We use `rclone nfsmount`,
#     which serves NFS over a local port and uses macOS's built-in NFS
#     client — no kernel extension, no reboot.
#   - This script never touches `.env` files or VCS state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

ASSUME_YES="${ASSUME_YES:-0}"
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
  esac
done

confirm() {
  local prompt="$1"
  if [ "$ASSUME_YES" = "1" ]; then
    echo "$prompt [auto-yes]"
    return 0
  fi
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

echo "=== MediaTransfer Native macOS Setup ==="

# 1. Homebrew presence
if ! command -v brew &> /dev/null; then
  echo "❌ Homebrew is not installed."
  echo "Install it first by running:"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo "Then re-run: npm run setup:mac"
  exit 1
fi

echo "📦 Installing Node.js, PostgreSQL 16, Redis, rclone..."
brew install node postgresql@16 redis rclone

# Make sure postgresql@16 binaries (psql, createuser, createdb) are on PATH for this shell
if ! command -v psql &> /dev/null; then
  PG_PREFIX="$(brew --prefix postgresql@16)"
  export PATH="$PG_PREFIX/bin:$PATH"
fi

# 2. Start services (idempotent)
echo "🚀 Starting Postgres and Redis..."
brew services start postgresql@16 || true
brew services start redis || true

sleep 3

# 3. Database
echo "🗄️ Configuring Database..."

DB_USER="mediatransfer"
DB_PASS="mediatransfer"
DB_NAME="mediatransfer"

if ! psql template1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    echo "Creating user $DB_USER..."
    createuser -s "$DB_USER"
    psql template1 -c "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASS';"
else
    echo "User $DB_USER already exists."
fi

if ! psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo "Creating database $DB_NAME..."
    createdb -h localhost -O "$DB_USER" "$DB_NAME"
else
    echo "Database $DB_NAME already exists."
fi

# 4. Docker Desktop check (only relevant if user plans to run Immich)
echo ""
echo "🐳 Checking Docker Desktop..."
if command -v docker &>/dev/null && docker info >/dev/null 2>&1; then
  echo "✅ Docker daemon is reachable."
else
  echo "⚠️  Docker Desktop is not running (or not installed)."
  echo "   This is fine for the MediaTransfer-only flow."
  echo "   To run Immich and the Cloudflare Tunnel, install Docker Desktop"
  echo "   and enable 'Start Docker Desktop when you log in' in its settings."
fi

# 5. Sleep settings — opt-in, requires sudo
echo ""
echo "💤 macOS sleep settings"
echo "   Long-running takeout imports, S3 uploads, and the Cloudflare Tunnel"
echo "   container all break if the Mac sleeps. Recommended for a 24/7 host:"
echo "     AC:      sleep 0 disksleep 0 displaysleep 0 womp 1 powernap 1"
echo "     Battery: sleep 0 disksleep 0 displaysleep 0 womp 1 powernap 1"
echo "   Battery sleep=0 will drain the battery if unplugged — only enable"
echo "   if this Mac is intended to act as an always-on server."
if confirm "Apply these pmset settings now (requires sudo)?"; then
  sudo pmset -c sleep 0 disksleep 0 displaysleep 0 womp 1 powernap 1
  if confirm "Also apply to BATTERY profile (drains faster when unplugged)?"; then
    sudo pmset -b sleep 0 disksleep 0 displaysleep 0 womp 1 powernap 1
  fi
  echo "Current pmset profile:"
  pmset -g custom || true
else
  echo "Skipped pmset changes."
fi

# 6. Optional: mount the S3 bucket so Immich's UPLOAD_LOCATION is live
echo ""
echo "🪣 Optional: rclone S3 mount for Immich"
if [ -f "$ROOT_DIR/.env.immich" ] && [ -f "$ROOT_DIR/.env" ]; then
  if mount | grep -E 'on .*immich-s3.*\(nfs' >/dev/null 2>&1; then
    echo "✅ S3 NFS mount already active."
  elif confirm "Mount the S3 bucket now via ./scripts/mount-s3.sh --background?"; then
    "$SCRIPT_DIR/mount-s3.sh" --background
  else
    echo "Skipped S3 mount. Run ./scripts/mount-s3.sh --background before starting Immich."
  fi
else
  echo "Skipping — .env or .env.immich not found yet."
  echo "After you create them, run:  ./scripts/mount-s3.sh --background"
fi

# 7. Recap
echo ""
echo "✅ Native dependencies installed and running!"
echo "⚠️  Update your .env file with the following:"
echo ""
echo "POSTGRES_USER=$DB_USER"
echo "POSTGRES_PASSWORD=$DB_PASS"
echo "POSTGRES_DB=$DB_NAME"
echo "DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
echo "REDIS_HOST=localhost"
echo "REDIS_URL=redis://localhost:6379"
echo ""
echo "Once .env is updated, you can run:"
echo "  npm run app:setup:native"
echo "  npm run app:dev:native"
echo ""
echo "To start the full Docker stack (MediaTransfer + Immich):"
echo "  ./scripts/mount-s3.sh --background     # if not already mounted"
echo "  ./scripts/start-all.sh up"
