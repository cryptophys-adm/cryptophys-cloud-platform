-- 0042: register xauusd-omega (the 5th XAUUSD Worker, deployed from cryptophys-adm/xauusd-ai-trading-assistant;
-- owner decisions 2026-11-09) for drift observation at /health over EXT_XAUUSD_OMEGA.
INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('xauusd-omega', 'XAUUSD Omega Execution Engine', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Omega Execution Engine: MT5 EA monitoring, broker engine bridge sync and execution telemetry (advisory only)","data_classification":"internal","deployed_by":"cryptophys-adm/xauusd-ai-trading-assistant","health_path":"/health"}',
   '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
