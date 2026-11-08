-- 0030 (ADR-0012 phase 1b): register the Forge (platform source on Cloudflare Artifacts) for drift
-- observation and consensus deploys. desired_version is set by deploy-forge.yml.
INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-forge', 'Forge', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Platform source on Cloudflare Artifacts: import, mirror and read-only history (ADR-0012)","data_classification":"internal","source":"workers/forge"}',
   '2026-11-08T05:30:00.000Z', '2026-11-08T05:30:00.000Z');
