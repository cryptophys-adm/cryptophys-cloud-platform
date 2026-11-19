-- 0060 (resource audit, owner 2026-11-14: "lebih hemat read/write D1"): indexes for the queries that run every
-- Supervisor cycle, every Auditor cycle and on every Policy page poll, which scanned their tables. Additive.
-- Owner-decision sweep and inbox: status = 'pending_owner' AND created_at < ?
CREATE INDEX IF NOT EXISTS idx_consensus_proposals_status_created ON consensus_proposals(status, created_at);
-- Daily deploy count: action IN (...) AND status IN (...) AND decided_at >= ?
CREATE INDEX IF NOT EXISTS idx_consensus_proposals_action_decided ON consensus_proposals(action, decided_at);
-- main's head: WHERE forge_at IS NOT NULL ORDER BY forge_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_forge_deploy_plans_forge_at ON forge_deploy_plans(forge_at);
-- Agent recovery plans in the last 24 h
CREATE INDEX IF NOT EXISTS idx_recovery_plans_created ON recovery_plans(created_at);
-- Policy page (newest first) and deny counts over 24 h
CREATE INDEX IF NOT EXISTS idx_policy_decisions_created ON policy_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_decision_created ON policy_decisions(decision, created_at);
