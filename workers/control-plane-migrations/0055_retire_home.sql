-- 0055 (ADR-0010 amendment 2026-11-13, owner: "setuju pension domain lama"): retire cryptophys-home.
-- After a week of Nexus as the single origin, the Cerebrum Home Worker and the custom domains
-- home.cryptophys.work and console.cryptophys.work are retired (retire-worker.yml). The registry row
-- is kept, as for cryptophys-signal-engine in 0020: only its status changes to 'disabled', which the
-- Drift Detector records as an observation with reason "disabled" and never counts as drift, so no
-- owner notice or recovery plan follows. No row is deleted and no other table is touched.
-- 0054 is left free for an in-flight branch.
UPDATE service_registry SET status = 'disabled', updated_at = '2026-11-13T12:00:00.000Z' WHERE service_id = 'cryptophys-home';
