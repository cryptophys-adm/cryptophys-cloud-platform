-- Dismantle the H1 chain's unused kernel identities (owner 2026-11-11: "ya, dismantle juga analyst dan
-- counselor"). Measured in production D1 on 2026-11-11: neither xauusd-analyst nor xauusd-counselor ever
-- made an action, a syscall, a report, a memory, a principal, a proposal or a vote, and neither holds a
-- council seat; no code in either repository uses these ids (the H1 chain reports as xauusd-reasoner).
-- The XAUUSD H1 chain's Analyst and Counselor model steps are unchanged: only these two registry rows
-- go. Guarded like 0047: an agent that any row refers to is left in place.
DELETE FROM agents
WHERE agent_id IN ('xauusd-analyst', 'xauusd-counselor')
  AND agent_id NOT IN (SELECT agent_id FROM agent_actions)
  AND agent_id NOT IN (SELECT agent_id FROM agent_syscall_consumptions)
  AND agent_id NOT IN (SELECT agent_id FROM agent_reports)
  AND agent_id NOT IN (SELECT agent_id FROM agent_memories)
  AND agent_id NOT IN (SELECT agent_id FROM agent_principals)
  AND agent_id NOT IN (SELECT proposer_agent_id FROM consensus_proposals)
  AND agent_id NOT IN (SELECT voter_agent_id FROM consensus_votes)
  AND agent_id NOT IN (SELECT proposer_agent_id FROM knowledge_proposals);
