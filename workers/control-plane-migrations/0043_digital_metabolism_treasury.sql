-- 0043: Digital Metabolism & Treasury Loop (Sirkulasi Keuangan Mandiri).
-- Implements self-sustaining economic and compute lifecycle controls (Pillar 2).
-- Tracks infrastructure burn rate (Workers, D1, Vectorize, AI Gateway) vs trading net
-- profit from Omega/EA, maintaining the treasury reserve and adaptive power modes
-- ('survival', 'homeostasis', 'growth').
-- Forward-only. Requires 0001 through 0042.

-- 1. Metabolism Controls: global power mode and autonomous adaptation switches.
CREATE TABLE IF NOT EXISTS metabolism_controls (
  control TEXT PRIMARY KEY CHECK (control IN ('power_mode', 'power_mode_override', 'auto_adaptation_enabled', 'treasury_currency')),
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO metabolism_controls (control, value, updated_by, updated_at) VALUES
  ('power_mode', 'homeostasis', 'migration:0043', '2026-11-10T02:00:00.000Z'),
  ('power_mode_override', 'none', 'migration:0043', '2026-11-10T02:00:00.000Z'),
  ('auto_adaptation_enabled', '1', 'migration:0043', '2026-11-10T02:00:00.000Z'),
  ('treasury_currency', 'USD', 'migration:0043', '2026-11-10T02:00:00.000Z');

-- 2. Treasury Ledger: append-only double-entry balance records for trading profits vs infra expenses.
CREATE TABLE IF NOT EXISTS treasury_ledger (
  entry_id TEXT PRIMARY KEY CHECK (entry_id LIKE 'trz_%'),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('trading_profit', 'trading_loss', 'infra_cost', 'capital_injection', 'reserve_allocation')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 2 AND 128),
  amount_usd REAL NOT NULL,
  balance_after_usd REAL NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_treasury_ledger_created ON treasury_ledger (created_at);
CREATE INDEX IF NOT EXISTS idx_treasury_ledger_type ON treasury_ledger (entry_type, created_at);

-- 3. Infrastructure Burn Metrics: periodic resource consumption and cost per service.
CREATE TABLE IF NOT EXISTS infra_burn_metrics (
  metric_id TEXT PRIMARY KEY CHECK (metric_id LIKE 'brn_%'),
  period_day TEXT NOT NULL CHECK (length(period_day) = 10), -- YYYY-MM-DD
  service_id TEXT NOT NULL REFERENCES service_registry(service_id),
  worker_requests INTEGER NOT NULL DEFAULT 0 CHECK (worker_requests >= 0),
  d1_reads INTEGER NOT NULL DEFAULT 0 CHECK (d1_reads >= 0),
  d1_writes INTEGER NOT NULL DEFAULT 0 CHECK (d1_writes >= 0),
  vectorize_queries INTEGER NOT NULL DEFAULT 0 CHECK (vectorize_queries >= 0),
  ai_neurons INTEGER NOT NULL DEFAULT 0 CHECK (ai_neurons >= 0),
  estimated_cost_usd REAL NOT NULL DEFAULT 0.0 CHECK (estimated_cost_usd >= 0.0),
  calculated_at TEXT NOT NULL,
  UNIQUE (period_day, service_id)
);
CREATE INDEX IF NOT EXISTS idx_infra_burn_day ON infra_burn_metrics (period_day);
CREATE INDEX IF NOT EXISTS idx_infra_burn_service ON infra_burn_metrics (service_id, period_day);

-- 4. Metabolism Cycles: heartbeat logs of the autonomous power mode evaluation.
CREATE TABLE IF NOT EXISTS metabolism_cycles (
  cycle_id TEXT PRIMARY KEY CHECK (cycle_id LIKE 'mtb_%'),
  evaluated_at TEXT NOT NULL,
  market_status TEXT NOT NULL CHECK (market_status IN ('open', 'closed', 'holiday')),
  trading_net_pnl_24h REAL NOT NULL,
  infra_burn_cost_24h REAL NOT NULL,
  metabolic_ratio REAL,
  treasury_reserve_usd REAL NOT NULL,
  runway_days REAL,
  power_mode TEXT NOT NULL CHECK (power_mode IN ('survival', 'homeostasis', 'growth')),
  mode_reason TEXT NOT NULL CHECK (length(mode_reason) <= 300),
  actions_json TEXT NOT NULL CHECK (json_valid(actions_json) AND json_type(actions_json) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_metabolism_cycles_evaluated ON metabolism_cycles (evaluated_at);

-- 5. Seed initial treasury reserve balance ($500.00 initial runway buffer).
INSERT OR IGNORE INTO treasury_ledger
  (entry_id, entry_type, source, amount_usd, balance_after_usd, metadata_json, created_at)
VALUES
  ('trz_seed_00000000000000000000000000000001', 'capital_injection', 'genesis:runway_buffer', 500.0, 500.0,
   '{"note":"Genesis autonomous runway buffer for Cloudflare infrastructure self-sustenance"}',
   '2026-11-10T02:00:00.000Z');
