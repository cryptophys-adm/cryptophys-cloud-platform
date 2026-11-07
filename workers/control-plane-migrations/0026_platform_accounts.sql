-- 0026: platform accounts (owner decision 2026-11-07: "buat menu khusus di cerebrum console untuk
-- menambahkan user baru, dengan role admin (berhak akses cerebrum), dan user (tidak bisa akses
-- cerebrum)"; roles Viewer / Operator / Approver; one owner plus a typed confirmation).
--
-- kind 'admin' may open the Cerebrum Console with a privilege: viewer (read only), operator
-- (routine actions) or approver (also approvals). kind 'user' may sign in to Nexus only.
-- The two owners are not rows here: they stay in the APPROVER_IDENTITIES / OPERATOR_IDENTITIES
-- configuration and cannot be changed or locked out from the panel. Only those owners manage
-- this table, and every change is written atomically with its audit event. Accounts are
-- disabled, never deleted, so the history stays. Additive and forward-only.

CREATE TABLE platform_accounts (
  email TEXT PRIMARY KEY
    CHECK (email = lower(email) AND length(email) BETWEEN 6 AND 254 AND email LIKE '%_@_%._%' AND email NOT GLOB '*[ ,;]*'),
  kind TEXT NOT NULL CHECK (kind IN ('admin', 'user')),
  privilege TEXT CHECK (privilege IN ('viewer', 'operator', 'approver')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'admin' AND privilege IS NOT NULL) OR (kind = 'user' AND privilege IS NULL))
);

CREATE INDEX platform_accounts_status ON platform_accounts (status, kind);
