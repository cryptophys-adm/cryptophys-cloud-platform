-- Macro context from the apps-gitops corpus sources (ADR-0005 decision 9). One row per hourly
-- observation; a failed source leaves no row (it is recorded in signal_ingest_runs instead).
CREATE TABLE macro_context (
  observed_hour INTEGER PRIMARY KEY CHECK (observed_hour > 0),
  fear_greed INTEGER NOT NULL CHECK (fear_greed BETWEEN 0 AND 100),
  fear_greed_class TEXT,
  fear_greed_sentiment REAL NOT NULL CHECK (fear_greed_sentiment BETWEEN -1 AND 1),
  fear_greed_time INTEGER,
  btc_dominance REAL NOT NULL CHECK (btc_dominance BETWEEN 0 AND 100),
  total_market_cap REAL NOT NULL CHECK (total_market_cap > 0),
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
  observed_at TEXT NOT NULL
);
