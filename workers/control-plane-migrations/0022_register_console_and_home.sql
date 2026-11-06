-- 0022: register the operator Console and the Cerebrum home portal (ADR-0008) for drift observation.
-- desired_version is set by their deploy workflows.
INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-console', 'Console', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Operator console: allow-listed forwarding with the operator''s own Access JWT (ADR-0008)","data_classification":"internal","source":"workers/console"}',
   '2026-11-06T01:00:00.000Z', '2026-11-06T01:00:00.000Z'),
  ('cryptophys-home', 'Cerebrum Home', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Read-only home portal and navigation (ADR-0008)","data_classification":"internal","source":"workers/home"}',
   '2026-11-06T01:00:00.000Z', '2026-11-06T01:00:00.000Z');
