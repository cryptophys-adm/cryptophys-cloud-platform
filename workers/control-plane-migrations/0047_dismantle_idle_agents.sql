-- Dismantle agents that no longer contribute (owner 2026-11-11: "hardening juga untuk dismantle dan
-- delete agent yang sudah tidak berkontribusi"; "hapus yang sudah suspended, sisanya cek lagi news
-- analysis dan technical analysis jika memang tidak digunakan sebaiknya dismantle juga"; the four HUD
-- agents: "dismantle sekarang"). Measured in production D1 on 2026-11-11: none of these seven agents ever
-- made an action, a syscall, a report, a memory, a principal, a proposal or a vote.
--   signal-engine             suspended since TP-018 (its Worker was retired);
--   xauusd-news-analyst,      registered by 0016; no code in either repository uses these ids
--   xauusd-technical-analyst  (the XAUUSD rooms' news and technical agents report as xauusd-moderator);
--   hud-gabfx-price-action, hud-grid-bot-protocol, hud-playbook-execution, hud-r37-funnel:
--                             removed from the XAUUSD rooms the same day (15m War Room, 3 days: 87-97 %
--                             NEUTRAL bias, never a BUY or SELL).
-- Kept: the Aether agents (owner: still under deployment), xauusd-analyst and xauusd-counselor.
-- Every DELETE is guarded: an agent that any row refers to is left in place (retire_agent then
-- suspends it as retired instead). Nothing declares these agents in a Worker's DNA, so the census never
-- proposes them again.
DELETE FROM agents
WHERE agent_id IN ('signal-engine', 'xauusd-news-analyst', 'xauusd-technical-analyst',
                   'hud-gabfx-price-action', 'hud-grid-bot-protocol', 'hud-playbook-execution', 'hud-r37-funnel')
  AND agent_id NOT IN (SELECT agent_id FROM agent_actions)
  AND agent_id NOT IN (SELECT agent_id FROM agent_syscall_consumptions)
  AND agent_id NOT IN (SELECT agent_id FROM agent_reports)
  AND agent_id NOT IN (SELECT agent_id FROM agent_memories)
  AND agent_id NOT IN (SELECT agent_id FROM agent_principals)
  AND agent_id NOT IN (SELECT proposer_agent_id FROM consensus_proposals)
  AND agent_id NOT IN (SELECT voter_agent_id FROM consensus_votes)
  AND agent_id NOT IN (SELECT proposer_agent_id FROM knowledge_proposals);
