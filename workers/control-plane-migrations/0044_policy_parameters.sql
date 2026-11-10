-- 0044 (owner 2026-11-10): Policy Engine parameters the Cerebrum council may change by consensus
-- (set_policy_parameter). Only the names in control-plane-shared/src/policy-params.ts are read,
-- and every value is clamped to the hard bounds in that file. The daily deploy limit rises from 6
-- to 10 (owner: "naikkan ke 10"); one executed action per action and target per hour stays.
CREATE TABLE IF NOT EXISTS policy_parameters (
  name TEXT PRIMARY KEY CHECK (name IN ('daily-deploy-limit', 'target-actions-per-hour')),
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 20),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO policy_parameters (name, value, updated_by, updated_at) VALUES
  ('daily-deploy-limit', 10, 'migration:0044', '2026-11-10T16:00:00.000Z'),
  ('target-actions-per-hour', 1, 'migration:0044', '2026-11-10T16:00:00.000Z');
