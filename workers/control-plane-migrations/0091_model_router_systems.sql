-- 0091 (owner 2026-11-26: "tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"): one Beam switch per
-- system (Cerebrum, CTA and xauusd's news_compare) on Cerebrum → Command, and one global paid stop. The next free number
-- after AIR1's 0090. control-plane-shared/src/model-router.ts reads and writes both tables.
--
--   model_router_global: one row (id 'global'). paid_off = 1 after a paid sign from any system (the kernel's own router,
--     or a paid report from a system's router agent): Beam is off for every system until the owner clears it,
--     by turning one system on as paid_capped or as free_only with confirm_free; clearing it clears it for every system.
--     A table of its own, not a 'global' row in model_router_state, so that every row there is a system's switch with one
--     meaning and one CHECK, and the paid stop is one conditional UPDATE (idempotent: only the first sign writes).
--   model_router_state: keyed by system ('cerebrum', 'cta', 'xauusd'), the owner's switch of that system (on, off,
--     off_owner, off_retention), its mode, paid cap and spend, and last_status_read_at, when that system's router agent
--     last read its state from the kernel. off_paid is no longer a row state: it is model_router_global.paid_off, and a reader
--     sees a system's effective state as off_paid while it is set.
--
-- SQLite cannot change a primary key or a CHECK in place, so model_router_state is rebuilt with its row kept, as in 0069:
-- the 0090 row ('global', Cerebrum's switch until now) becomes the 'cerebrum' row with every value kept (state, mode,
-- paid_cap_usd, spent_usd, updated_by, updated_at, reason). Only an off_paid row changes shape: its paid sign moves to
-- model_router_global (paid_off 1, the same updated_by, updated_at and reason) and the cerebrum row underneath reads
-- 'off', so clearing the paid stop never turns Beam on by itself. CTA and xauusd are seeded off, free_only. The audit
-- trail (audit_events, subject model_router) is not touched. model_calls_daily, model_router_counters and
-- model_router_health (Cerebrum's own router's ledger, counters and breaker) are not altered.
CREATE TABLE IF NOT EXISTS model_router_global (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
  paid_off INTEGER NOT NULL DEFAULT 0 CHECK (paid_off IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300)
);
INSERT OR IGNORE INTO model_router_global (id, paid_off, updated_by, updated_at, reason)
  SELECT 'global', 1, updated_by, updated_at, reason FROM model_router_state WHERE id = 'global' AND state = 'off_paid';
INSERT OR IGNORE INTO model_router_global (id, paid_off, updated_by, updated_at, reason)
  VALUES ('global', 0, 'migration:0091', '2026-11-26T00:00:00.000Z', NULL);
CREATE TABLE model_router_state_0091 (
  system TEXT PRIMARY KEY NOT NULL CHECK (system IN ('cerebrum', 'cta', 'xauusd')),
  state TEXT NOT NULL CHECK (state IN ('on', 'off', 'off_owner', 'off_retention')),
  mode TEXT NOT NULL CHECK (mode IN ('free_only', 'paid_capped')),
  paid_cap_usd REAL CHECK (paid_cap_usd IS NULL OR paid_cap_usd > 0),
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  last_status_read_at TEXT,
  CHECK (mode = 'free_only' OR paid_cap_usd IS NOT NULL)
);
INSERT INTO model_router_state_0091 (system, state, mode, paid_cap_usd, spent_usd, updated_by, updated_at, reason, last_status_read_at)
  SELECT 'cerebrum', CASE WHEN state = 'off_paid' THEN 'off' ELSE state END, mode, paid_cap_usd, spent_usd, updated_by, updated_at, reason, NULL
  FROM model_router_state WHERE id = 'global';
DROP TABLE model_router_state;
ALTER TABLE model_router_state_0091 RENAME TO model_router_state;
INSERT OR IGNORE INTO model_router_state (system, state, mode, paid_cap_usd, spent_usd, updated_by, updated_at, reason, last_status_read_at) VALUES
  ('cerebrum', 'off', 'free_only', NULL, 0, 'migration:0091', '2026-11-26T00:00:00.000Z', 'off by default (ADR-0007 amendment 2026-11-25)', NULL),
  ('cta', 'off', 'free_only', NULL, 0, 'migration:0091', '2026-11-26T00:00:00.000Z', 'off by default (owner 2026-11-26)', NULL),
  ('xauusd', 'off', 'free_only', NULL, 0, 'migration:0091', '2026-11-26T00:00:00.000Z', 'off by default (owner 2026-11-26)', NULL);
