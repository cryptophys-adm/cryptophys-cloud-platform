-- Recovered engines (ADR-0005, 2026-11-04): momentum, volatility, structure and Mizan rows per
-- closed candle, and the signal-edge multi-timeframe confluence per symbol. SQLite cannot widen
-- a CHECK constraint in place, so signal_indicators is rebuilt with its rows preserved.
CREATE TABLE signal_indicators_new (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('trend', 'volume', 'momentum', 'volatility', 'structure', 'mizan')),
  implementation TEXT NOT NULL,
  window_size INTEGER NOT NULL CHECK (window_size > 0),
  indicators_json TEXT NOT NULL CHECK (json_valid(indicators_json)),
  computed_at TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time, engine),
  FOREIGN KEY (symbol, timeframe, open_time) REFERENCES market_candles(symbol, timeframe, open_time) ON DELETE CASCADE
);
INSERT INTO signal_indicators_new SELECT symbol, timeframe, open_time, engine, implementation, window_size, indicators_json, computed_at FROM signal_indicators;
DROP TABLE signal_indicators;
ALTER TABLE signal_indicators_new RENAME TO signal_indicators;

CREATE TABLE signal_confluence (
  symbol TEXT NOT NULL,
  basis_close_time INTEGER NOT NULL,
  implementation TEXT NOT NULL,
  confluence_score REAL NOT NULL CHECK (confluence_score >= 0 AND confluence_score <= 100),
  tf_scores_json TEXT NOT NULL CHECK (json_valid(tf_scores_json)),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  computed_at TEXT NOT NULL,
  PRIMARY KEY (symbol, basis_close_time)
);
