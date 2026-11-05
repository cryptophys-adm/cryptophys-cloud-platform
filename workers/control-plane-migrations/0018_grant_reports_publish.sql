-- Grant reports.publish to recovery-manager and deployment-orchestrator (TP-012).
-- These two per-Worker agents lacked the capability, so the AI Kernel would deny them
-- with capability_not_granted. Tier and rows are unchanged.

UPDATE agents
SET capabilities_json = json_insert(capabilities_json, '$[#]', 'reports.publish'),
    updated_by = 'migration:0018',
    updated_at = '2026-11-05T12:00:00.000Z'
WHERE agent_id IN ('recovery-manager', 'deployment-orchestrator')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = 'reports.publish'
  );
