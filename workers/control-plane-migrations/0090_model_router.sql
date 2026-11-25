-- 0090 (AIR1, 2026-11-25; owner: "Approve, but Cerebrum only"): the model router's ledger, counters and global state.
-- ADR-0007 amendment 2026-11-25: Beam (Reflection, OpenAI-compatible) may answer Cerebrum's chat, directive drafts and
-- councils, free_only, with Workers AI always the fallback (control-plane-shared/src/model-router.ts). The next free
-- number after CI-WB's 0089.
--
-- Additive only: four new tables and two seed rows. ai_usage and ai_failures are not altered.
--   model_calls_daily: one row per UTC day, system, purpose (the AI task), provider and model, the calls that provider
--     answered, their reported tokens and summed latency, and fallbacks_json, a JSON object of the reasons Beam was not
--     used ({"off": 3, "budget": 1}). Workers AI calls of the allow-listed tasks are recorded too. Never a prompt, an
--     answer or a key.
--   model_router_counters: the router's own Beam counters, one row per UTC minute (bucket "min:YYYY-MM-DDTHH:MM") and per
--     UTC day ("day:YYYY-MM-DD"); a reservation is one conditional upsert, so concurrent Workers never pass a limit.
--   model_router_state: the one global switch (id 'global'), default off. off_paid and off_retention are set by the
--     router itself (a paid sign, a contributor retention header); on and off_owner only by the owner's route.
--   model_router_health: the circuit breaker and the provider's rate-limit back-off (id 'beam').
CREATE TABLE IF NOT EXISTS model_calls_daily (
  day TEXT NOT NULL CHECK (length(day) = 10),
  system TEXT NOT NULL CHECK (system IN ('cerebrum')),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 40),
  provider TEXT NOT NULL CHECK (provider IN ('reflection', 'workers_ai')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  in_tokens INTEGER NOT NULL DEFAULT 0 CHECK (in_tokens >= 0),
  out_tokens INTEGER NOT NULL DEFAULT 0 CHECK (out_tokens >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  fallbacks_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fallbacks_json) AND json_type(fallbacks_json) = 'object'),
  PRIMARY KEY (day, system, purpose, provider, model)
);
CREATE TABLE IF NOT EXISTS model_router_counters (
  bucket TEXT PRIMARY KEY NOT NULL CHECK (bucket GLOB 'min:*' OR bucket GLOB 'day:*'),
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  in_tokens INTEGER NOT NULL DEFAULT 0 CHECK (in_tokens >= 0),
  out_tokens INTEGER NOT NULL DEFAULT 0 CHECK (out_tokens >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_router_state (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
  state TEXT NOT NULL CHECK (state IN ('on', 'off', 'off_paid', 'off_owner', 'off_retention')),
  mode TEXT NOT NULL CHECK (mode IN ('free_only', 'paid_capped')),
  paid_cap_usd REAL CHECK (paid_cap_usd IS NULL OR paid_cap_usd > 0),
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  CHECK (mode = 'free_only' OR paid_cap_usd IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS model_router_health (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'beam'),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  breaker_open_until TEXT,
  probe_until TEXT,
  rate_limited_until TEXT,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO model_router_state (id, state, mode, paid_cap_usd, spent_usd, updated_by, updated_at, reason)
  VALUES ('global', 'off', 'free_only', NULL, 0, 'migration:0090', '2026-11-25T00:00:00.000Z', 'off by default (ADR-0007 amendment 2026-11-25)');
INSERT OR IGNORE INTO model_router_health (id, consecutive_failures, breaker_open_until, probe_until, rate_limited_until, updated_at)
  VALUES ('beam', 0, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z');
