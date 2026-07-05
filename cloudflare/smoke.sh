#!/bin/bash
# KidVibers post-deploy smoke tests.
# Usage: ./smoke.sh [base_url]   (default: https://kidvibers.com)
# Every check hits the LIVE site read-only — no accounts created, nothing written.
# Exits non-zero if anything fails, so deploy.sh can flag a broken deploy loudly.

BASE="${1:-https://kidvibers.com}"
FAILS=0

check() { # check <label> <expected_code> <actual_code>
  if [ "$2" = "$3" ]; then echo "  ✅ $1"; else echo "  ❌ $1 (expected $2, got $3)"; FAILS=$((FAILS+1)); fi
}

# --retry-all-errors: rapid sequential requests occasionally get a dropped connection (curl
# code 000) that isn't a real outage — retry a couple of times before calling it a failure.
CURL="curl -s -o /dev/null -w %{http_code} --max-time 15 --retry 2 --retry-all-errors --retry-delay 1"
code_get()  { $CURL "$BASE$1"; }
code_getL() { $CURL -L "$BASE$1"; }
code_post() { $CURL -X POST -H "Content-Type: application/json" -d "${2:-{}}" "$BASE$1"; }

echo "🚬 Smoke tests against $BASE"

# ── Pages load (follow the .html → clean-URL redirect) ──
for p in /index.html /dashboard.html /lessons.html /parent.html /district.html /playground.html /settings.html /whats-new.html; do
  check "page $p" 200 "$(code_getL $p)"
done

# ── Public APIs healthy ──
check "GET /api/site-config" 200 "$(code_get /api/site-config)"
check "GET /api/lessons"     200 "$(code_get /api/lessons)"

# ── ANTI-CHEAT: quiz answers must NEVER appear in the public lesson payload ──
ANSWERS=$(curl -s --max-time 20 "$BASE/api/lessons" | grep -c '"answer"')
check "no quiz answers in /api/lessons" 0 "$ANSWERS"

# ── Auth-gated endpoints reject anonymous with 401/403 (a 404 or 500 = broken route) ──
check "GET /api/me"            401 "$(code_get /api/me)"
check "GET /api/test/1 (boss)" 401 "$(code_get /api/test/1)"
check "GET /api/projects/mine" 401 "$(code_get /api/projects/mine)"
check "POST /api/quiz/answer"  401 "$(code_post /api/quiz/answer)"
check "POST /api/progress"     401 "$(code_post /api/progress)"
check "POST /api/test/submit"  401 "$(code_post /api/test/submit)"

# ── Login endpoint alive (wrong creds = 401, never 500) ──
check "POST /api/login (bad creds)" 401 "$(code_post /api/login '{"username":"smoke_test_x","password":"wrong"}')"

# ── Signup validation alive (bad username = 400, never 500) ──
check "POST /api/signup (rejects bad input)" 400 "$(code_post /api/signup '{"name":"x","username":"ab","password":"123"}')"

echo ""
if [ "$FAILS" -gt 0 ]; then
  echo "🔥 $FAILS SMOKE TEST(S) FAILED — the deploy may be broken. Investigate before walking away!"
  exit 1
else
  echo "✅ All smoke tests passed."
fi
