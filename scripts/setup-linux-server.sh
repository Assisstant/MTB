#!/usr/bin/env bash
# ============================================================================
# setup-linux-server.sh — turn a Linux machine into THE server for the
# therapy apps: PostgreSQL + the API, running as a service, reachable from
# every other machine over Tailscale.
#
# This is the machine that holds the one database. Every other PC, laptop and
# phone just opens a browser pointed at it — they need nothing installed.
#
# Tested shape: Debian / Ubuntu (apt). Run as a normal user with sudo rights:
#   chmod +x scripts/setup-linux-server.sh
#   ./scripts/setup-linux-server.sh
#
# Safe to re-run: existing role, database and service are kept.
# ============================================================================

set -euo pipefail

APP_ROLE="therapy"
APP_PASSWORD="therapy_local"     # same credentials as the Windows machines
APP_DB="therapy_dev"
PORT=3000

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

echo "Project: $REPO_ROOT"

# --- 1. packages -------------------------------------------------------------
echo "==> Installing PostgreSQL and Node.js (sudo may ask for your password)"
sudo apt-get update -qq
sudo apt-get install -y postgresql curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
    echo "==> Installing Node.js 22 LTS"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "    node $(node -v), $(psql --version)"

sudo systemctl enable --now postgresql

# --- 2. role and database (idempotent) ---------------------------------------
echo "==> Creating role and database"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_ROLE'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASSWORD';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$APP_DB'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE DATABASE $APP_DB OWNER $APP_ROLE;"
sudo -u postgres psql -c "ALTER ROLE $APP_ROLE CREATEDB;" >/dev/null   # for the test suite

# --- 3. migrations -----------------------------------------------------------
echo "==> Applying migrations"
export PGPASSWORD="$APP_PASSWORD"
for f in "$REPO_ROOT"/database/migrations/*.sql; do
    echo "    $(basename "$f")"
    psql -U "$APP_ROLE" -h localhost -d "$APP_DB" -q -v ON_ERROR_STOP=1 -f "$f"
done

# --- 4. server config and dependencies ---------------------------------------
if [ -f "$SERVER_DIR/.env" ]; then
    echo "==> server/.env already exists - keeping it"
else
    printf 'DATABASE_URL=postgres://%s:%s@localhost:5432/%s\nPORT=%s\n' \
        "$APP_ROLE" "$APP_PASSWORD" "$APP_DB" "$PORT" > "$SERVER_DIR/.env"
    echo "==> server/.env written"
fi

echo "==> Installing server dependencies"
(cd "$SERVER_DIR" && npm install --no-fund --no-audit)

# --- 5. run as a service ------------------------------------------------------
# A service, not a login script: this machine should serve whether or not
# anyone is logged in, and come back by itself after a reboot or a crash.
echo "==> Installing the systemd service"
sudo tee /etc/systemd/system/therapy-api.service >/dev/null <<UNIT
[Unit]
Description=Therapy apps API
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$SERVER_DIR
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now therapy-api
sleep 4

# --- 6. check ------------------------------------------------------------------
echo ""
if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "API is answering on http://localhost:$PORT"
else
    echo "API is NOT answering yet. Look at: sudo journalctl -u therapy-api -n 40"
fi

cat <<NEXT

================= DONE =================

Load your data (JSON exports from the apps):
  cd "$SERVER_DIR"
  npm run import -- ../backups/UnifiedSync-....json ../backups/SDnevnik_....json
  npm run import -- ../backups/UnifiedSync-....json ../backups/SDnevnik_....json --apply

Reach this machine from every other PC and phone:
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up                # sign in with the same account
  sudo tailscale serve --bg $PORT   # gives an https://<name>.ts.net address

Then on any other device open:
  https://<name>.ts.net/Rasporedi-Unified-Sync-v5.0.html
  https://<name>.ts.net/Pregled-Baza.html

Useful:
  sudo systemctl status therapy-api
  sudo journalctl -u therapy-api -f
NEXT
