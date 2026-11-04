-- 0011: make every policy-gated agent syscall a single-use, atomic consumption.
-- Backfill target calls already dispatched under migration 0010 so the rate limit remains
-- continuous across this schema change. Denied policy decisions never reached a target.
CREATE TABLE agent_syscall_consumptions (
  decision_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);
CREATE INDEX agent_syscall_consumptions_rate
  ON agent_syscall_consumptions (agent_id, capability, consumed_at);

INSERT OR IGNORE INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at)
SELECT decision_id, agent_id, capability, created_at
FROM agent_actions
WHERE decision_id IS NOT NULL AND outcome IN ('succeeded', 'failed');
