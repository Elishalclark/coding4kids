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
# checkAny <label> <actual_code> <ok_code1> [ok_code2...]  — for endpoints where more than one
# code is a legitimate "this route is alive and working" signal, e.g. signup validation can
# correctly return 400 (bad input) OR 429 (rate-limited from repeated smoke-test runs hitting
# the same durable per-IP counter) — both mean the route works, only a real 5xx means it's broken.
checkAny() {
  local label="$1" actual="$2"; shift 2
  for ok in "$@"; do if [ "$actual" = "$ok" ]; then echo "  ✅ $label"; return; fi done
  echo "  ❌ $label (expected one of: $* — got $actual)"; FAILS=$((FAILS+1))
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
checkAny "POST /api/signup (rejects bad input)" "$(code_post /api/signup '{"name":"x","username":"ab","password":"123"}')" 400 429

# ── Honeypot: a filled hidden field must be rejected as bad input (never a 500, never a 200) ──
checkAny "POST /api/signup (honeypot filled)" "$(code_post /api/signup '{"name":"x","username":"validname","password":"123456","website":"http://spam.example"}')" 400 429

# ── Security-sensitive endpoints must reject anonymous requests (403/401, never a 200 or 500) ──
check "GET /api/admin/security-dashboard" 403 "$(code_get /api/admin/security-dashboard)"
check "GET /api/admin/audit-log"          403 "$(code_get /api/admin/audit-log)"
check "GET /api/admin/backup-check"       403 "$(code_get /api/admin/backup-check)"
check "GET /api/admin/data-requests"      403 "$(code_get /api/admin/data-requests)"
check "POST /api/admin/breach-notice"     403 "$(code_post /api/admin/breach-notice)"
check "GET /api/incident-log"             403 "$(code_get /api/incident-log)"
check "GET /api/my-logins"                401 "$(code_get /api/my-logins)"

# ── Baseline security headers present on every response ──
HEADERS=$(curl -s -D - -o /dev/null --max-time 15 "$BASE/index.html")
check "X-Frame-Options header present"      1 "$(echo "$HEADERS" | grep -ic 'X-Frame-Options')"
check "Content-Security-Policy header present" 1 "$(echo "$HEADERS" | grep -ic 'Content-Security-Policy')"
check "X-Content-Type-Options header present"  1 "$(echo "$HEADERS" | grep -ic 'X-Content-Type-Options')"

echo ""
if [ "$FAILS" -gt 0 ]; then
  echo "🔥 $FAILS SMOKE TEST(S) FAILED — the deploy may be broken. Investigate before walking away!"
  exit 1
else
  echo "✅ All smoke tests passed."
fi
