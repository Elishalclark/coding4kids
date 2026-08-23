-- Storage for support-inbox.html, whose endpoints only existed in server.py until now.
--
-- Apply to production:  wrangler d1 execute kidvibers --remote --file=migrations/003_support_inbox.sql
-- Apply to staging:     wrangler d1 execute kidvibers-staging --remote --file=migrations/003_support_inbox.sql
--
-- Safe to re-run.
--
-- Nothing writes to this table yet. It is filled by an EXTERNAL inbound-email webhook
-- (Cloudflare Email Routing, Resend inbound, Mailgun routes, ...) forwarding mail sent to
-- support@kidvibers.com. Until that is wired up the page will simply show an empty inbox,
-- which is the correct behaviour — previously it showed an error.
CREATE TABLE IF NOT EXISTS support_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_email TEXT,
  subject TEXT,
  body TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_inbox_unread ON support_inbox (is_read, id);
