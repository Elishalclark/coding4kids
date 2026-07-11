# KidVibers Incident Response Runbook

A short, practical "if X happens, do Y" guide. Not a compliance document — just enough to keep a
level head during a real incident.

## 🚨 Data breach / suspected unauthorized access
1. **Confirm it's real** before acting — check the admin panel's 🕵️ Audit Log and 🛡️ Security
   Dashboard for anything unusual (unexpected suspensions, a spike in failed logins, error log spikes).
2. **Rotate secrets immediately** if credentials may be exposed: Cloudflare Worker secrets (API
   keys), the staging password, admin passwords. You (the account owner) do this — the assistant
   never types or handles credentials directly.
3. **Notify affected users** via the admin panel's 🚨 emergency data-breach tool (🛡️ Security
   Dashboard → "Emergency: send a data-breach notice"). Requires typing an exact confirmation
   phrase — it emails every account holder with an email on file. Only use for a real incident.
4. **Log what happened** — add an entry to the 📄 Data Requests tracker if any student data was
   involved (COPPA/FERPA transparency).
5. **Contact schools/districts directly** if they have a signed DPA — they'll likely have their
   own breach-notification obligations to their students' families.

## 🔥 Site is down / erroring for everyone
1. Check `https://kidvibers.elishalclark.workers.dev` (the raw Workers URL) — if that also fails,
   it's likely a Cloudflare-side outage, not the app. Check Cloudflare's status page.
2. Check the admin panel's 🐛 Error Log for a spike — if one error type dominates, that's your lead.
3. Check recent deploys — `git log` in the repo, and Cloudflare dashboard → Workers → Deployments
   for the last few versions. If a recent deploy caused it, the fastest fix is usually rolling back
   to the previous Version ID in the Cloudflare dashboard (Workers → kidvibers → Deployments →
   promote an earlier version), not debugging forward under pressure.
4. Run `cloudflare/smoke.sh` manually against production to see exactly which routes are broken.

## 🚩 A safety alert needs urgent attention
1. Check the account's incident-log.html page, or the 🛡️ Security Dashboard for open/escalated counts.
2. If it involves a real child-welfare concern (self-harm, abuse), the family/school has already
   been emailed automatically — but a personal follow-up (a real email or call) is warranted, not
   just relying on the automated alert.
3. Mark it resolved only after you've actually followed up — the incident log keeps resolved items
   too, specifically so nothing is quietly marked "done" without real action.

## 💳 Payment / billing issue
1. Check the Stripe dashboard directly — this app never stores card data, so billing problems are
   almost always Stripe-side or a webhook delivery issue.
2. Check `error_log` (via 🛡️ Security Dashboard → error log panel) for webhook handler errors.
3. Never manually charge, refund, or adjust a subscription through code — always via the Stripe
   dashboard directly, or ask the user to do it.

## 🎟️ A library/school session is having problems mid-event
1. The fastest fix during a live event is usually **starting a fresh session** (new code) rather
   than debugging — `district.html`/`parent.html` → "🔄 New code".
2. If kids can't join at all, check: is the session locked? Is the seat cap hit (check the plan)?
   Is the code being typed correctly (case-insensitive, but exact digits/letters matter)?
3. `run-a-session.html` has the volunteer-facing troubleshooting cheat sheet — point helpers there.

## 📋 General principles
- **Prefer rollback over a rushed forward-fix** when something is actively broken in production.
- **Never skip smoke tests** (`deploy.sh` runs them automatically) — if they fail after a deploy,
  investigate before walking away, don't assume it's fine.
- **When in doubt about anything touching money, credentials, or mass communication** (like the
  breach-notice tool), pause and think it through rather than acting fast.
