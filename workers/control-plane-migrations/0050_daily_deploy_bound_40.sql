-- 0050 (owner 2026-11-12: "naikkan batas deploy harian"): the hard bound of daily-deploy-limit rises
-- from 20 to 40 (control-plane-shared/src/policy-params.ts). The owner's value of 40 is written to
-- production after this migration (ADR-0009 amendment 2026-11-12); fresh databases keep the seeded 10.
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt with every row kept.
-- target-actions-per-hour stays bounded 1-3 in code; the table bound only has to admit both.
CREATE TABLE policy_parameters_0050 (
  name TEXT PRIMARY KEY CHECK (name IN ('daily-deploy-limit', 'target-actions-per-hour')),
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 40),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO policy_parameters_0050 (name, value, updated_by, updated_at)
  SELECT name, value, updated_by, updated_at FROM policy_parameters;
DROP TABLE policy_parameters;
ALTER TABLE policy_parameters_0050 RENAME TO policy_parameters;
