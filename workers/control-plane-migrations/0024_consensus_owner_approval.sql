-- 0024: consensus autonomy, phase 4 (ADR-0009). One owner decision per critical proposal.
-- A critical action runs only after consensus, a Policy Engine allow, and exactly one approval
-- click by a person in APPROVER_IDENTITIES; the primary key makes a second decision (or a
-- replayed click) impossible. Additive and forward-only.

CREATE TABLE consensus_owner_decisions (
  proposal_id TEXT PRIMARY KEY REFERENCES consensus_proposals(proposal_id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  decided_by TEXT NOT NULL CHECK (length(decided_by) BETWEEN 3 AND 200 AND instr(decided_by, '@') > 1),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  created_at TEXT NOT NULL
);
