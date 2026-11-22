-- 0086 (HAIC H3e, docs/design/HAIC-H3.md §7.2 and §11 step 5; the owner's answers of 2026-11-19, "Setuju semua
-- rekomendasi"): the Nexus ingress of the corrections ledger (0084). The next free number after H5d's 0085.
--
-- Additive only: one agent row, registered the way 0045 registered knowledge-council. INSERT OR IGNORE, so applying it
-- again, or after the agent exists, changes nothing.
--   nexus-teacher   hosted by the xauusd AI Worker (xauusd-ai-trading-assistant, its AGENTS binding's pinned host),
--                   tier_max 1, no council seat. It holds corrections.record only (tier 1, learning: no rate limit, no
--                   power-mode denial), exactly what XAUUSD_CEILING names for it (control-plane-shared/src/organism.ts);
--                   it relays the owner's Nexus corrections and ratings, masked, as correction.v1.
-- Granting the capability to an existing xauusd agent instead would rewrite its agents row, which migration-rules.ts
-- refuses as destructive. aether-curator's corrections.read (AETHER_CEILING) is not granted here: Aether's own DNA
-- declares it and the census's routine update_agent_capabilities applies it.
INSERT OR IGNORE INTO agents
  (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
VALUES
  ('nexus-teacher', 'Nexus Teacher', 'xauusd-ai-trading-assistant',
   'Relays the owner''s corrections and ratings made in Nexus (cards, room posts, decisions, council turns) to the platform corrections ledger as correction.v1, prices masked; it changes no parameter, weight or strategy.',
   1, '["corrections.record"]', 'enabled', NULL, 'migration:0086',
   '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z');
