-- 0025: audit-chain checkpoint (Wave A reliability). A full verification of the hash chain reads
-- every event; consensus evidence needs it on every proposal and was taking ~25 s at 1,000+
-- events. The checkpoint records the last verified event, so later checks verify only newer
-- events and confirm the checkpointed event is unchanged. Full verifications (Audit Ledger
-- /v1/verify, the auditor agent, deploy verification) still re-read the whole chain.
-- Additive and forward-only.

CREATE TABLE audit_checkpoints (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_rowid INTEGER NOT NULL CHECK (last_rowid >= 0),
  event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  events_checked INTEGER NOT NULL CHECK (events_checked >= 0),
  verified_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'incremental'))
);
