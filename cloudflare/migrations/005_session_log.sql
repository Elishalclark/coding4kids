-- Session history.
--
-- Apply to production:  wrangler d1 execute kidvibers --remote --file=migrations/005_session_log.sql
-- Apply to staging:     wrangler d1 execute kidvibers-staging --remote --file=migrations/005_session_log.sql
--
-- Safe to re-run.
--
-- A live drop-in session lived only in the settings table and was deleted the moment it
-- ended, so there was no way to look back at who hosted a session or which kids were in it.
-- Every path that ends a session now writes a row here first: the host ending it, an admin
-- ending it, and the hourly cron sweeping ones that simply expired.
--
-- kids is a JSON array of {id, name, username, joinedAt} captured at the time the session
-- ended. It is stored rather than joined at read time because guest accounts can be deleted
-- afterwards, and the point of a history is that it still tells you what happened.
CREATE TABLE IF NOT EXISTS session_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  session_name TEXT,
  host_id INTEGER,
  host_name TEXT,
  host_username TEXT,
  host_role TEXT,
  kid_count INTEGER NOT NULL DEFAULT 0,
  kids TEXT,
  started_at TEXT,
  ended_at TEXT NOT NULL,
  ended_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_log_recent ON session_log (ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_log_host ON session_log (host_id, ended_at DESC);
