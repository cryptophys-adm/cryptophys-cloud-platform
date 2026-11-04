-- Recovery plan lifecycle (ADR-0006): each plan is driven by a Cloudflare Workflow instance
-- that enforces the approval and execution windows. The deadlines are stored so the HTTP
-- handlers enforce them too, whether or not the Workflow has run yet. Expired plans move to
-- the existing 'disabled' status with a reason, so the status CHECK constraint is unchanged.
ALTER TABLE recovery_plans ADD COLUMN approve_by TEXT;
ALTER TABLE recovery_plans ADD COLUMN execute_by TEXT;
ALTER TABLE recovery_plans ADD COLUMN finish_by TEXT;
ALTER TABLE recovery_plans ADD COLUMN disabled_reason TEXT;
ALTER TABLE recovery_plans ADD COLUMN workflow_instance_id TEXT;

-- Signal Engine ingestion runs record the Workflow instance that produced them (NULL for
-- inline runs such as POST /v1/ingest).
ALTER TABLE signal_ingest_runs ADD COLUMN workflow_instance_id TEXT;
