UPDATE agents SET tier_max = 1, updated_by = 'migration:0021', updated_at = '2026-11-05T16:30:00.000Z'
WHERE agent_id = 'supervisor';
