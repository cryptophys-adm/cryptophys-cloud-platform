-- HAIC H5d, the collaborator schema (docs/design/HAIC-H5.md §7.1 and §11 H5d; the owner's answers of 2026-11-19, every
-- recommended default). Numbered 0085, the next free number after H3b's 0084: a number kept free for a later step cannot
-- be held once a higher one is applied (the native deploy refuses it as migration_out_of_order), so H3e takes the next
-- free number when it lands.
--
-- Additive only: two new nullable or defaulted columns, three new tables and one index. No row is written or seeded.
-- Nothing reads or writes any of it yet: the reviewer role and the role table come in H5e, the Registry and the Users
-- page in H5f, comments in H5g, the collaborator chat pool and its switch in H5i.
--   platform_accounts.reviewer   1 marks a reviewer (Q2: kind admin, privilege viewer, plus this flag). Every existing
--                                row reads 0, so code from before H5 reads a reviewer as a plain viewer: it can only
--                                under-grant. "reviewer = 1 only with kind admin and privilege viewer" is checked in
--                                accounts.ts (H5f), because a cross-column CHECK here would need a table rebuild.
--   platform_accounts.expires_at the optional grant expiry the owner sets per grant (Q8); NULL means no expiry.
--   collab_comments              notes for people on one ev: target (§5.1); hidden by the owner, never deleted.
--   conversation_collab_budget   the collaborators' own chat pool (§6), per person per UTC day; the owner's pool
--                                (conversation_budget, 0078) is untouched.
--   collab_controls              the collaborators' chat switch (§6): conversation_controls admits only 'enabled' in its
--                                CHECK (0078), and widening that is a table rebuild. No row: H5i decides the first one.
-- Collaborators teach through the H3 ledger (corrections, 0084, label reviewer_correction; ADR-0017 amendment of
-- 2026-11-19), so the design's separate human_feedback table is not created here.
ALTER TABLE platform_accounts ADD COLUMN reviewer INTEGER NOT NULL DEFAULT 0 CHECK (reviewer IN (0, 1));
ALTER TABLE platform_accounts ADD COLUMN expires_at TEXT;

CREATE TABLE IF NOT EXISTS collab_comments (
  comment_id TEXT PRIMARY KEY NOT NULL CHECK (length(comment_id) BETWEEN 4 AND 40),
  target_ref TEXT NOT NULL CHECK (substr(target_ref, 1, 3) = 'ev:' AND length(target_ref) BETWEEN 4 AND 300),
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 254),
  author_role TEXT NOT NULL CHECK (author_role IN ('reviewer', 'operator', 'approver', 'owner')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1200),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  hidden_by TEXT CHECK (hidden_by IS NULL OR length(hidden_by) BETWEEN 1 AND 254),
  created_at TEXT NOT NULL,
  CHECK ((status = 'visible' AND hidden_by IS NULL) OR (status = 'hidden' AND hidden_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_collab_comments_target ON collab_comments(target_ref, created_at);

CREATE TABLE IF NOT EXISTS conversation_collab_budget (
  day TEXT NOT NULL CHECK (length(day) = 10),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  role TEXT NOT NULL CHECK (role IN ('reviewer', 'operator', 'approver')),
  turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
  PRIMARY KEY (day, actor)
);

CREATE TABLE IF NOT EXISTS collab_controls (
  control TEXT PRIMARY KEY NOT NULL CHECK (control IN ('collaborators_enabled')),
  value TEXT NOT NULL CHECK (value IN ('0', '1')),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  updated_at TEXT NOT NULL
);
