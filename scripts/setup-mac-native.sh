#!/usr/bin/env bash
set -e

echo "=== MediaTransfer Native macOS Setup ==="

# 1. Install dependencies via Homebrew
if ! command -v brew &> /dev/null; then
  echo "❌ Homebrew is not installed."
  echo "Install it first by running:"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo "Then re-run: npm run setup:mac"
  exit 1
fi

echo "📦 Installing Node.js, PostgreSQL 16 and Redis..."
brew install node postgresql@16 redis

# Make sure postgresql@16 binaries (psql, createuser, createdb) are on PATH for this shell
if ! command -v psql &> /dev/null; then
  PG_PREFIX="$(brew --prefix postgresql@16)"
  export PATH="$PG_PREFIX/bin:$PATH"
fi

# 2. Start services
echo "🚀 Starting Postgres and Redis..."
brew services start postgresql@16 || true
brew services start redis || true

# Give services a moment to start
sleep 3

# 3. Create database and user
echo "🗄️ Configuring Database..."

# Use the default postgres user to create the mediatransfer role and DB.
# In homebrew, the default user is usually your macOS username, which is a superuser.
DB_USER="mediatransfer"
DB_PASS="mediatransfer"
DB_NAME="mediatransfer"

# Check if role exists, if not create it
if ! psql template1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    echo "Creating user $DB_USER..."
    createuser -s $DB_USER
    psql template1 -c "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASS';"
else
    echo "User $DB_USER already exists."
fi

# Check if DB exists, if not create it
if ! psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo "Creating database $DB_NAME..."
    createdb -h localhost -O $DB_USER $DB_NAME
else
    echo "Database $DB_NAME already exists."
fi

# 4. Prompt for .env changes
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
echo "npm run app:setup -- --native"
echo "npm run app:dev -- --native"
