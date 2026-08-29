-- Outreach tracker for the admin panel.
--
-- Apply to production:  wrangler d1 execute kidvibers --remote --file=migrations/006_outreach.sql
-- Apply to staging:     wrangler d1 execute kidvibers-staging --remote --file=migrations/006_outreach.sql
--
-- Safe to re-run.
--
-- Institutional outreach is the channel that actually scales for a product like this: one
-- librarian or co-op leader reaches dozens of families. This is the list of who has been
-- contacted, what was said, and what is owed a follow-up — the thing a spreadsheet usually
-- does badly and gets abandoned.
CREATE TABLE IF NOT EXISTS outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_name TEXT NOT NULL,
  org_type TEXT NOT NULL DEFAULT 'homeschool',  -- homeschool | library | coop | afterschool | school
  region TEXT,                                   -- state, county, city — free text
  contact_name TEXT,
  contact_email TEXT,
  website TEXT,
  status TEXT NOT NULL DEFAULT 'new',            -- new | emailed | replied | meeting | partnered | declined
  notes TEXT,
  last_contacted_at TEXT,
  follow_up_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach (status, follow_up_at);
CREATE INDEX IF NOT EXISTS idx_outreach_type ON outreach (org_type, org_name);
