-- 0046 (owner 2026-11-11: "asses juga penggunaan high usage di D1 row read"): indexes for the
-- time-window and event-type reads that scanned whole tables on every Supervisor cycle and Console
-- poll. Each query below read the full table (rows_read = table size); with these indexes it reads
-- only the rows in its window. Indexes only: no data changes.
CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_reports_created ON agent_reports (created_at);
CREATE INDEX IF NOT EXISTS idx_consensus_votes_created ON consensus_votes (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_created ON audit_events (event_type, created_at);
