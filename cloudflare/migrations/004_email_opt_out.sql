-- Marketing unsubscribe list.
--
-- Apply to production:  wrangler d1 execute kidvibers --remote --file=migrations/004_email_opt_out.sql
-- Apply to staging:     wrangler d1 execute kidvibers-staging --remote --file=migrations/004_email_opt_out.sql
--
-- Safe to re-run.
--
-- Only marketing mail checks this. Transactional mail — password resets, parental consent
-- links, account notices — is always delivered, because opting out of those would lock
-- someone out of their own account.
CREATE TABLE IF NOT EXISTS email_opt_out (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
