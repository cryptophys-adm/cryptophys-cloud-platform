-- 0045 (owner 2026-11-11): the Knowledge Council's doctrine amendments ("autonomous doctrine protocol
-- harus dilakukan oleh knowledge council, dilakukan harian dan di propose ke cerebrum untuk
-- eksekusinya"). See control-plane-shared/src/doctrine.ts.
--   1. doctrine_amendments: what Cerebrum executed. A routine amend_doctrine (operational facts inside
--      their hard bounds) runs after the consensus passes; a critical amend_constitution after one owner
--      approval click. The row id is the consensus proposal id; every row has its audit event.
--   2. The knowledge-council agent, hosted by the external Worker 'cryptophys-aether', tier_max 1:
--      consensus.propose (the kernel lets it propose amend_doctrine and amend_constitution only, and
--      no other agent may propose either), doctrine.status (tier 0) and reports.publish.
CREATE TABLE IF NOT EXISTS doctrine_amendments (
  amendment_id TEXT PRIMARY KEY CHECK (amendment_id GLOB 'cns_*'),
  rule_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('amend_doctrine', 'amend_constitution')),
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  previous_json TEXT NOT NULL CHECK (json_valid(previous_json)),
  canon TEXT NOT NULL,
  session_id TEXT NOT NULL,
  executed_by TEXT NOT NULL,
  executed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doctrine_amendments_executed ON doctrine_amendments (executed_at);

INSERT OR IGNORE INTO agents
  (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
VALUES
  ('knowledge-council', 'Knowledge Council', 'cryptophys-aether',
   'The Knowledge Council (Nexus, Omega and Aether seats) meets daily in Aether, compares the Aether Canon doctrine with the measured state and proposes amendments to the Cerebrum consensus, which executes them.',
   1, '["consensus.propose","doctrine.status","reports.publish"]', 'enabled', NULL, 'migration:0045',
   '2026-11-11T02:00:00.000Z', '2026-11-11T02:00:00.000Z');
