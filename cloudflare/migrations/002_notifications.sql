-- Notification Center: the admin.html panels have been calling these since they were built,
-- but the endpoints only ever existed in server.py, so every "Send notification" in production
-- hit the Worker's catch-all and came back "Not found." This adds the storage the ported
-- endpoints need.
--
-- Apply to production:  wrangler d1 execute kidvibers --remote --file=migrations/002_notifications.sql
-- Apply to staging:     wrangler d1 execute kidvibers-staging --remote --file=migrations/002_notifications.sql
--
-- Safe to re-run: every statement is IF NOT EXISTS except the two ALTERs, which D1 will
-- reject with "duplicate column name" if they've already been applied. That error is
-- expected on a second run and can be ignored.

-- Who has actually accepted notifications. The "opted in" audience filters on this, and
-- turning it off is what lets someone opt back out on their own.
ALTER TABLE users ADD COLUMN notif_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN notif_opt_in_at TEXT;

-- Accountability log: what was sent, to whom, by whom.
CREATE TABLE IF NOT EXISTS sent_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_by TEXT,
  audience TEXT,
  audience_detail TEXT,
  title TEXT,
  body TEXT,
  recipients INTEGER NOT NULL DEFAULT 0,
  emailed INTEGER NOT NULL DEFAULT 0,
  pushed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- "Send later" queue, drained by the hourly cron.
CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by TEXT,
  audience TEXT NOT NULL DEFAULT 'all',
  role TEXT,
  user_id INTEGER,
  title TEXT,
  body TEXT NOT NULL,
  email INTEGER NOT NULL DEFAULT 0,
  send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_notif_due ON scheduled_notifications (status, send_at);

-- Rule-based sends (inactivity nudge, trial-ending reminder), also driven by the cron.
CREATE TABLE IF NOT EXISTS notification_automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_days INTEGER NOT NULL DEFAULT 3,
  audience_role TEXT NOT NULL DEFAULT 'kid',
  title TEXT,
  body TEXT NOT NULL,
  email INTEGER NOT NULL DEFAULT 0,
  cooldown_days INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  last_run_at TEXT
);

-- Per-user cooldown ledger, so an automation can't nag the same person every hour.
CREATE TABLE IF NOT EXISTS automation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_log_pair ON automation_log (automation_id, user_id, sent_at);
