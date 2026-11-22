-- 0087 (PF1, 2026-11-22; xauusd Track B PR B27, RFC_INDICATOR_ADOPTION stages 1-6, the Mizan Oracle): register the
-- Mizan Oracle, a HUD agent of the xauusd 15m War Room. Kernel agents are registered by a platform migration, as 0016
-- registered the hud-* agents and 0086 nexus-teacher; without this row the kernel refuses hud-mizan-oracle, and once
-- xauusd's organism.json lists it the census reports unregistered_agent:hud-mizan-oracle.
--
-- Additive only: one agent row, INSERT OR IGNORE, so applying it again, or after the agent exists, changes nothing.
--   hud-mizan-oracle  hosted by the xauusd AI Worker (xauusd-ai-trading-assistant), tier_max 1, exactly the external
--                     ceiling every hud-* row holds (signals.observe, reports.publish, memory.recall, memory.remember);
--                     no council seat, not a Decision Engine witness, no order, no price. XAUUSD_CEILING and
--                     EXTERNAL_CEILING are unchanged. It stays idle until xauusd B27 publishes (B27 gates its first
--                     reports.publish on AGENTS.whoami returning "enabled").
INSERT OR IGNORE INTO agents
  (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
VALUES
  ('hud-mizan-oracle', 'Mizan Oracle', 'xauusd-ai-trading-assistant',
   'XAUUSD 15m War Room HUD agent of the Cryptophys Mizan Probe: reads the Mizan statistical stack as evidence in plain words; no Decision Engine witness, no seat, no order, no price.',
   1, '["signals.observe","reports.publish","memory.recall","memory.remember"]', 'enabled', NULL, 'migration:0087',
   '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z');
