#!/bin/bash
# Usage:  ./deploy.sh staging   (private preview)   |   ./deploy.sh production   (live)
set -e
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use --lts >/dev/null 2>&1 || true
echo "📦 Copying the latest site files..."
cp ../*.html public/ 2>/dev/null || true
cp ../app.js ../auth.js ../lessons.js ../pwa.js ../sw.js ../styles.css public/ 2>/dev/null || true
cp ../manifest.json ../robots.txt ../sitemap.xml public/ 2>/dev/null || true
# safety: never ship secrets
rm -f public/data.db public/admin_config.json public/server.py public/test_email.py 2>/dev/null || true
if [ "$1" = "staging" ]; then
  echo "🔒 Deploying to STAGING (password-protected preview)..."
  wrangler deploy --env staging
  echo "✅ Staging: https://kidvibers-staging.elishalclark.workers.dev"
else
  echo "🚀 Deploying to PRODUCTION (live)..."
  wrangler deploy
  echo "✅ Production: https://kidvibers.elishalclark.workers.dev"
fi
