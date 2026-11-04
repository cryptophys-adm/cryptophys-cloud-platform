-- Platform Auditor agent seed (TP-007, ADR-0007).
-- Verifies the audit hash chain and reviews 24h governance activity hourly; publishes advisory audit_digest reports.

INSERT OR IGNORE INTO agents
  (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
VALUES
  ('auditor', 'Platform Auditor', 'cryptophys-ai-kernel',
   'Verifies the audit hash chain and reviews the last 24 hours of governance events hourly, publishing an advisory audit digest when issues arise or once daily.',
   1, '["audit.verify","reports.publish"]', 'enabled', NULL, 'migration:0013',
   '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
