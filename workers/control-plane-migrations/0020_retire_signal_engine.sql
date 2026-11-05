UPDATE service_registry SET status = 'disabled', updated_at = '2026-11-05T14:00:00.000Z' WHERE service_id = 'cryptophys-signal-engine';

UPDATE agents SET status = 'suspended', status_reason = 'retired: crypto Signal Engine (owner decision 2026-11-05)', updated_by = 'migration:0020', updated_at = '2026-11-05T14:00:00.000Z' WHERE agent_id = 'signal-engine';

UPDATE agents SET capabilities_json = (SELECT json_group_array(value) FROM json_each(agents.capabilities_json) WHERE value <> 'signals.reingest'),
  updated_by = 'migration:0020', updated_at = '2026-11-05T14:00:00.000Z'
WHERE agent_id = 'supervisor';
