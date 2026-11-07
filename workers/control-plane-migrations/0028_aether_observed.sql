-- 0028 (TP-027 follow-up): Aether's Worker cryptophys-aether is deployed (Workers Builds, 2026-11-07)
-- and the Drift Detector has its EXT_AETHER binding, so its row moves from 'disabled' to
-- 'registered' and is probed at /health like the xauusd Workers (health-managed only).
UPDATE service_registry
SET status = 'registered',
    metadata_json = '{"owner":"cryptophys-adm","purpose":"Knowledge Guardian cluster: decision audit, agent compliance, the Aether Canon and learned knowledge (advisory only)","data_classification":"internal","deployed_by":"cryptophys-adm/cryptophys-aether (Cloudflare Workers Builds)","health_path":"/health"}',
    updated_at = '2026-11-07T12:00:00.000Z'
WHERE service_id = 'cryptophys-aether' AND status = 'disabled';
