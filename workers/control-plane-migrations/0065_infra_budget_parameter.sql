-- 0065 (owner 2026-11-14: monthly infrastructure budget $30): the council-adjustable Policy Engine parameter
-- infra-budget-usd-month (control-plane-shared/src/policy-params.ts, hard bounds 5-50, default 30). The Supervisor
-- enters survival when the projected month of Cloudflare spend exceeds it, instead of the hard $0.20/day "free tier"
-- threshold that kept the organism in survival on the Workers Paid plan from 2026-11-12.
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt with every row kept, as in 0050.
-- The existing parameters keep their table bound of 1-40; the budget gets its own bound, the same as in code.
CREATE TABLE policy_parameters_0065 (
  name TEXT PRIMARY KEY CHECK (name IN ('daily-deploy-limit', 'target-actions-per-hour', 'infra-budget-usd-month')),
  value INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((name = 'infra-budget-usd-month' AND value BETWEEN 5 AND 50)
      OR (name <> 'infra-budget-usd-month' AND value BETWEEN 1 AND 40))
);
INSERT INTO policy_parameters_0065 (name, value, updated_by, updated_at)
  SELECT name, value, updated_by, updated_at FROM policy_parameters;
DROP TABLE policy_parameters;
ALTER TABLE policy_parameters_0065 RENAME TO policy_parameters;
INSERT OR IGNORE INTO policy_parameters (name, value, updated_by, updated_at) VALUES
  ('infra-budget-usd-month', 30, 'migration:0065', '2026-11-14T12:00:00.000Z');
