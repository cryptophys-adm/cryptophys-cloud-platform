-- 0023: consensus autonomy, phase 1 (ADR-0009). Proposals, votes and the consensus mode.
-- In mode 'shadow' nothing executes: proposals are classified, voted and tallied, and the
-- Policy Engine decision is recorded, so agreement can be measured before any action runs.
-- Forward-only.

CREATE TABLE consensus_controls (
  control TEXT PRIMARY KEY CHECK (control = 'mode'),
  value TEXT NOT NULL CHECK (value IN ('shadow', 'routine', 'deploy', 'critical')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO consensus_controls (control, value, updated_by, updated_at)
VALUES ('mode', 'shadow', 'migration:0023', '2026-11-06T02:00:00.000Z');

CREATE TABLE consensus_proposals (
  proposal_id TEXT PRIMARY KEY CHECK (proposal_id LIKE 'cns_%'),
  proposer_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 64),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
  class TEXT NOT NULL CHECK (class IN ('routine', 'critical', 'prohibited')),
  params_json TEXT NOT NULL CHECK (json_valid(params_json) AND json_type(params_json) = 'object'),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'routine', 'deploy', 'critical')),
  eligible INTEGER NOT NULL CHECK (eligible >= 0),
  approvals INTEGER NOT NULL CHECK (approvals >= 0),
  rejections INTEGER NOT NULL CHECK (rejections >= 0),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  policy_decision_id TEXT,
  policy_decision TEXT CHECK (policy_decision IS NULL OR policy_decision IN ('allow', 'deny')),
  status TEXT NOT NULL CHECK (status IN ('rejected', 'shadow_passed', 'shadow_blocked', 'pending_owner', 'executing', 'executed', 'failed', 'expired')),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  created_at TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX idx_consensus_proposals_created ON consensus_proposals(created_at);
CREATE INDEX idx_consensus_proposals_target ON consensus_proposals(action, target, created_at);

CREATE TABLE consensus_votes (
  proposal_id TEXT NOT NULL REFERENCES consensus_proposals(proposal_id),
  voter_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  vote TEXT NOT NULL CHECK (vote IN ('approve', 'reject', 'abstain')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, voter_agent_id)
);

-- The supervisor proposes remediations it already drafts as recovery plans.
UPDATE agents
SET capabilities_json = json_insert(capabilities_json, '$[#]', 'consensus.propose'),
    updated_by = 'migration:0023',
    updated_at = '2026-11-06T02:00:00.000Z'
WHERE agent_id = 'supervisor'
  AND NOT EXISTS (SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = 'consensus.propose');
