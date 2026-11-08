-- 0034 (hardening 2026-11-08): the Signal Analyst reads the XAUUSD rooms (TP-017); the crypto Signal
-- Engine it was first written for is retired (TP-018). Text only; no capability or status change.
UPDATE agents SET
  purpose = 'Reads the XAUUSD advisory rooms, Mizan and macro context hourly and publishes an advisory digest when actions change or every 6 hours.',
  updated_by = 'migration:0034',
  updated_at = '2026-11-08T14:00:00.000Z'
WHERE agent_id = 'signal-analyst';
