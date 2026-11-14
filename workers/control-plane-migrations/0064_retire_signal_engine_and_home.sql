-- 0064 (owner 2026-11-14): retire cryptophys-signal-engine and cryptophys-home from the registry for good.
-- Both were already disabled (0020, TP-018; 0055, ADR-0010 amendment), neither has source, DNA, a deploy unit
-- or a drift target, and neither Worker exists on the Cloudflare account any more (the account's live Workers,
-- checked 2026-11-14). Until now the Drift Detector still walked their rows on every run (reason "disabled",
-- a heartbeat write each run) and the kernel's platform view and GET /v1/drift still listed them.
--
-- Retired, not deleted, as 0020 and 0055 did: the row stays the parent of their history (drift_observations,
-- deployment_requests, recovery_plans, idempotency_records, ai_usage and infra_burn_metrics reference
-- service_registry; the audit chain names them), so deleting it would break those references or lose the
-- history. Only metadata_json gains retired_at, retired_by and retired_reason, and updated_at records when.
-- status stays 'disabled' (what the native retirement gate, the deploy refusals and the Forge's registry
-- fingerprint read) and desired_version, observed_version, display_name and every other key are unchanged.
-- control-plane-shared/src/retired.ts reads the marker: the Drift Detector then neither probes nor records
-- them, and the kernel's platform view and GET /v1/drift leave them out. No other table is touched; existing
-- drift rows age out under the 90-day retention like every other service's.
--
-- Guarded: only a row that is still disabled, has valid metadata and is not yet retired changes, so a second
-- run changes nothing (and a row someone re-enabled is left alone).
-- 0063 is left free for an in-flight branch.
UPDATE service_registry
SET metadata_json = json_set(metadata_json,
      '$.retired_at', '2026-11-14T12:00:00.000Z',
      '$.retired_by', 'migration:0064',
      '$.retired_reason', CASE service_id
        WHEN 'cryptophys-signal-engine' THEN 'crypto Signal Engine retired (owner 2026-11-05, TP-018), Worker deleted'
        ELSE 'Cerebrum Home retired (owner 2026-11-13, ADR-0010 amendment), Worker deleted' END),
    updated_at = '2026-11-14T12:00:00.000Z'
WHERE service_id IN ('cryptophys-signal-engine', 'cryptophys-home')
  AND status = 'disabled'
  AND CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json, '$.retired_at') IS NULL ELSE 0 END;
