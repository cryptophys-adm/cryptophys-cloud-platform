-- AI Worker OS (ADR-0007): agents are registered processes with a maximum autonomy tier and
-- an explicit capability list. Every tier >= 1 action is a "syscall" decided by the Policy
-- Engine and recorded here and in the audit chain. Tier 3 (irreversible) can never be held
-- by an agent: the CHECK constraint caps tier_max at 2.

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY CHECK (length(agent_id) BETWEEN 2 AND 40 AND agent_id NOT GLOB '*[^a-z0-9-]*'),
  display_name TEXT NOT NULL,
  host_worker TEXT NOT NULL,
  purpose TEXT NOT NULL,
  tier_max INTEGER NOT NULL CHECK (tier_max BETWEEN 0 AND 2),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'suspended')),
  status_reason TEXT,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (host_worker) REFERENCES service_registry(service_id)
);

CREATE TABLE agent_actions (
  action_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  decision_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('denied', 'succeeded', 'failed')),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);
CREATE INDEX agent_actions_rate ON agent_actions (agent_id, capability, created_at);

-- Global kill switch for all agent autonomy. Suspending is open to every operator; enabling
-- requires an identity in APPROVER_IDENTITIES (enforced by the kernel).
CREATE TABLE kernel_controls (
  control TEXT PRIMARY KEY CHECK (control IN ('agents_enabled')),
  value TEXT NOT NULL CHECK (value IN ('0', '1')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-ai-kernel', 'AI Kernel', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"AI Worker OS kernel: agent processes, policy-gated syscalls, MCP front door","data_classification":"internal","source":"workers/ai-kernel"}',
   '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');

INSERT OR IGNORE INTO kernel_controls (control, value, updated_by, updated_at)
VALUES ('agents_enabled', '1', 'migration:0010', '2026-11-04T00:00:00.000Z');

INSERT OR IGNORE INTO agents
  (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
VALUES
  ('supervisor', 'Platform Supervisor', 'cryptophys-ai-kernel',
   'Observes drift and signal ingestion, proposes recovery plans for human approval, and may re-run a failed ingestion pass.',
   2, '["platform.observe","recovery.propose","signals.reingest"]', 'enabled', NULL, 'migration:0010',
   '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');

-- Agents may trigger an ingestion pass (tier 2), so runs record that trigger.
CREATE TABLE signal_ingest_runs_new (
  run_id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'agent')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  series_total INTEGER NOT NULL CHECK (series_total >= 0),
  series_failed INTEGER NOT NULL CHECK (series_failed >= 0 AND series_failed <= series_total),
  results_json TEXT NOT NULL CHECK (json_valid(results_json)),
  workflow_instance_id TEXT
);
INSERT INTO signal_ingest_runs_new
  (run_id, trigger, started_at, finished_at, series_total, series_failed, results_json, workflow_instance_id)
SELECT run_id, trigger, started_at, finished_at, series_total, series_failed, results_json, workflow_instance_id
FROM signal_ingest_runs;
DROP TABLE signal_ingest_runs;
ALTER TABLE signal_ingest_runs_new RENAME TO signal_ingest_runs;
CREATE INDEX signal_ingest_runs_started ON signal_ingest_runs (started_at);
