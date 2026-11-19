-- 0059 (resource audit, owner 2026-11-14: "lebih hemat read/write D1"): an index on drift_observations(observed_at).
-- The daily retention scans rows older than 90 days by observed_at, and counts over a time window (the last 24 h)
-- scanned the whole table: the only index was (service_id, observed_at). Additive; no row changes.
CREATE INDEX IF NOT EXISTS idx_drift_observed ON drift_observations(observed_at);
