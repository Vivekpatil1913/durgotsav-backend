#!/bin/bash
# =============================================================================
# Durgotsav 2026 — Production Deploy Script
# =============================================================================
# Run this on the server every time you deploy a new version.
# Usage:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# Environment: assumes the .env file is already present on the server.
# Process manager: assumes pm2  (change RESTART_CMD if you use systemd).
# =============================================================================

set -euo pipefail   # exit on any error, undefined var, or pipe failure

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2_APP_NAME="durgotsav-api"   # change if your pm2 process has a different name
LOG_FILE="$APP_DIR/logs/deploy.log"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]  ${NC} $1"; }
error() { echo -e "${RED}[ERROR] ${NC} $1"; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
info "=== Durgotsav 2026 Deploy — $TIMESTAMP ==="
cd "$APP_DIR"

[ -f ".env" ] || error ".env file not found in $APP_DIR. Aborting."
mkdir -p logs

# ── 1. Pull latest code ───────────────────────────────────────────────────────
info "1/6  Pulling latest code from git..."
git pull origin main 2>&1 | tee -a "$LOG_FILE"

# ── 2. Install / update Node dependencies ─────────────────────────────────────
info "2/6  Installing dependencies (production only)..."
npm ci --omit=dev 2>&1 | tee -a "$LOG_FILE"

# ── 3. Run pending SQL migrations ─────────────────────────────────────────────
info "3/6  Running database migrations..."
node scripts/migrate.js 2>&1 | tee -a "$LOG_FILE"

# ── 4. Create scale indexes (CONCURRENTLY — no table locks on live DB) ────────
info "4/6  Creating scale indexes (CONCURRENTLY, no table lock)..."
node scripts/create-indexes-live.js 2>&1 | tee -a "$LOG_FILE"

# ── 5. Restart the API server ─────────────────────────────────────────────────
info "5/6  Restarting API server..."
if pm2 list | grep -q "$PM2_APP_NAME"; then
  pm2 reload "$PM2_APP_NAME" --update-env 2>&1 | tee -a "$LOG_FILE"
else
  warn "pm2 process '$PM2_APP_NAME' not found. Starting fresh..."
  pm2 start src/server.js --name "$PM2_APP_NAME" --time 2>&1 | tee -a "$LOG_FILE"
fi

# ── 6. Health check ───────────────────────────────────────────────────────────
info "6/6  Health check..."
sleep 3   # give the server a moment to start
PORT=$(node -e "import('./src/config/env.js').then(m => { console.log(m.env.PORT); process.exit(0); })" 2>/dev/null || echo "4100")
if curl -sf "http://localhost:$PORT/api/health" > /dev/null 2>&1; then
  info "Health check passed ✓"
elif curl -sf "http://localhost:$PORT/" > /dev/null 2>&1; then
  info "Server is responding ✓"
else
  warn "Health check did not respond — check pm2 logs: pm2 logs $PM2_APP_NAME"
fi

info "=== Deploy complete. Log saved to $LOG_FILE ==="
