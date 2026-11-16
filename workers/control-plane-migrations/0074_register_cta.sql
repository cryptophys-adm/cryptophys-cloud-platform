-- 0074 (owner 2026-11-15/16: cta is an external organ of the platform): register cryptophys-cta, the content studio,
-- deployed from cryptophys-adm/cryptophys-cta by its own workflow and live since 2026-11-16 11:36 UTC at
-- https://cta.cryptophys.work (/health answers {"ok":true,"service":"cryptophys-cta","publish":"off"}).
--   - The Forge reads its DNA over EXT_ORGANISM_CTA (origin cta, the general EXTERNAL_CEILING); the census proposes
--     register_agent for its agents, and every voter rejected it while the host had no active registry row
--     (consensus-rules.ts registrationVote). The agents are NOT registered here: register_agent stays the
--     census/consensus path, within the general ceiling.
--   - The Drift Detector probes it over EXT_CRYPTOPHYS_CTA (CtaHealth.health(), health() only) once this row exists.
--     Like Aether (0027/0028) and the xauusd Workers it is health-managed only: desired_version and observed_version
--     stay NULL (the probe reports no version), so drift reads "desired_version_unset" and never a version mismatch.
-- Additive: one new row; INSERT OR IGNORE leaves an existing row and every other row unchanged.
INSERT OR IGNORE INTO service_registry
  (service_id, display_name, endpoint, desired_version, observed_version, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-cta', 'Cryptophys CTA · content studio', 'https://cta.cryptophys.work', NULL, NULL, 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Content studio: drafts, review and the content queue for cta.cryptophys.work (publish off until the owner turns it on)","data_classification":"internal","repository":"cryptophys-adm/cryptophys-cta","deployed_by":"cryptophys-adm/cryptophys-cta (its own deploy workflow)","origin":"cta","health_rpc":"CtaHealth.health() over EXT_CRYPTOPHYS_CTA"}',
   '2026-11-16T11:36:00.000Z', '2026-11-16T11:36:00.000Z');
