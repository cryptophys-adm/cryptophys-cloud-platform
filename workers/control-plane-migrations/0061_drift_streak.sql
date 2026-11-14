-- 0061 (resource audit, owner decision 1, 2026-11-14): the Drift Detector records an observation only when a
-- service's observed state changes, instead of one row per service on every 15-minute run (about 70% of all D1
-- writes, almost always the same state). streak counts the runs that saw the state of a row: 1 when it is recorded,
-- 2 once a later run saw the same state ("two in a row", persistent drift). service_registry.updated_at, which every
-- run already sets, is the freshness signal. Additive: existing rows keep streak 1, and the readers also count a
-- drifted row whose previous row drifted as persistent, so per-run history from before this migration reads the same.
ALTER TABLE drift_observations ADD COLUMN streak INTEGER NOT NULL DEFAULT 1 CHECK (streak >= 1);
