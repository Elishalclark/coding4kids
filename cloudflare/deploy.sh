#!/bin/bash
# Usage:  ./deploy.sh staging   (private preview)   |   ./deploy.sh production   (live)
set -e
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use --lts >/dev/null 2>&1
# wrangler is installed under a specific node version; if --lts switched to a version that
# doesn't have it, fall back to whichever node bin DOES have wrangler so deploys don't break.
command -v wrangler >/dev/null 2>&1 || {
  W=$(ls "$NVM_DIR"/versions/node/*/bin/wrangler 2>/dev/null | head -1)
  [ -n "$W" ] && export PATH="$(dirname "$W"):$PATH"
} || true
echo "🔢 Auto-bumping the cache-busting version..."
# Every asset URL uses ?v=NNN for cache-busting; this used to be bumped by hand before every
# deploy (easy to forget on a new file, and easy to typo). Find the current highest ?v=NNN
# across every page in the parent dir, bump it by 1, and apply it everywhere in one shot.
CUR_V=$(grep -ohE '\?v=[0-9]+' ../*.html 2>/dev/null | grep -oE '[0-9]+' | sort -n | tail -1)
CUR_V="${CUR_V:-1}"
NEW_V=$((CUR_V + 1))
sed -i '' "s/?v=${CUR_V}\"/?v=${NEW_V}\"/g" ../*.html 2>/dev/null || true
echo "   v${CUR_V} → v${NEW_V}"

echo "📦 Copying the latest site files..."
cp ../*.html public/ 2>/dev/null || true
cp ../app.js ../auth.js ../lessons.js ../editor.js ../pwa.js ../sw.js ../styles.css public/ 2>/dev/null || true
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
  # Post-deploy smoke tests: catch a broken deploy immediately, not from a user report.
  sleep 3   # give the new version a moment to propagate
  bash "$(dirname "$0")/smoke.sh" https://kidvibers.com || echo "⚠️⚠️⚠️  SMOKE TESTS FAILED — check the output above! ⚠️⚠️⚠️"
fi
