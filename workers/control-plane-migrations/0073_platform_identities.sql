-- 0073 (owner 2026-11-16): the native source of the deploy-time identity lists. Until the GitHub cut-over the deploy
-- workflows build OPERATOR_IDENTITIES / DEPLOY_ALLOWED_IDENTITIES (the CI service token's Client ID, then the emails)
-- and APPROVER_IDENTITIES (the emails) from the GitHub variable ACCESS_ALLOWED_EMAILS (access-identities.sh). After the
-- cut-over that variable is gone, so the owner edits the emails here instead, in the Console (Users page), and the
-- native deploy writes the values from this row (deployment-orchestrator/src/deploy-vars.ts).
--
-- One row, id 'access'. operator_emails and approver_emails are the canonical comma-joined lists (lower case, no
-- duplicates, in the owner's order); today both are the one ACCESS_ALLOWED_EMAILS list, and the code refuses a row
-- whose two lists differ. source: 'seed' (copied once from the Deployment Orchestrator's own active version; the
-- deploys keep carrying each Worker's active value) or 'owner' (an owner saved it in the Console; the deploys use it).
-- revision counts the saves, so a stale form cannot overwrite a newer list. Every change is an audit event
-- (identity_source.seeded / identity_source.changed) written in the same D1 batch. Additive only: a new table, no row.
CREATE TABLE IF NOT EXISTS platform_identities (
  id TEXT PRIMARY KEY CHECK (id = 'access'),
  operator_emails TEXT NOT NULL CHECK (length(operator_emails) BETWEEN 6 AND 5200),
  approver_emails TEXT NOT NULL CHECK (length(approver_emails) BETWEEN 6 AND 5200),
  source TEXT NOT NULL CHECK (source IN ('seed', 'owner')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
