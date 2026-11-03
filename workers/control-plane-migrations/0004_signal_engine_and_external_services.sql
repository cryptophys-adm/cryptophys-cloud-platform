-- ADR-0005: first migrated workload (cryptophys-signal-engine) and registration of the
-- externally deployed xauusd Workers so the Drift Detector observes them.

-- Closed candles from public market data. A closed candle is immutable: writes use
-- INSERT OR IGNORE and never update an existing row.
CREATE TABLE market_candles (
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 5 AND 20 AND symbol NOT GLOB '*[^A-Z0-9]*'),
  timeframe TEXT NOT NULL CHECK (timeframe IN ('15m', '1h', '4h', '1d')),
  open_time INTEGER NOT NULL CHECK (open_time > 0),
  close_time INTEGER NOT NULL CHECK (close_time > open_time),
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL CHECK (volume >= 0),
  source TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close),
  PRIMARY KEY (symbol, timeframe, open_time)
);

-- Deterministic indicator outputs, one row per engine per closed candle.
CREATE TABLE signal_indicators (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('trend', 'volume')),
  implementation TEXT NOT NULL,
  window_size INTEGER NOT NULL CHECK (window_size > 0),
  indicators_json TEXT NOT NULL CHECK (json_valid(indicators_json)),
  computed_at TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time, engine),
  FOREIGN KEY (symbol, timeframe, open_time) REFERENCES market_candles(symbol, timeframe, open_time) ON DELETE CASCADE
);

INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-signal-engine', 'Signal Engine', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Deterministic trend and volume indicators from public market data (advisory only)","data_classification":"internal","source":"workers/signal-engine","migrated_from":"cryptophys-work/apps-gitops apps/user/cognitive-risk/signal-edge"}',
   '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
  ('xauusd-ai-trading-assistant', 'XAUUSD AI Engine', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Evidence fusion and Analyst/Counselor/Reasoner advisory decisions for XAUUSD","data_classification":"internal","deployed_by":"cryptophys-adm/xauusd-ai-trading-assistant","health_path":"/health"}',
   '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
  ('xauusd-fundamental-news-ingestion', 'XAUUSD TradingView MCP Gateway', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Fundamental news ingestion and TradingView OHLCV gateway","data_classification":"internal","deployed_by":"cryptophys-adm/xauusd-ai-trading-assistant","health_path":"/health"}',
   '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
  ('xauusd-tradingview-pull-adapter', 'XAUUSD Market Data Adapter', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Closed-candle market data pulls for local engines","data_classification":"internal","deployed_by":"cryptophys-adm/xauusd-ai-trading-assistant","health_path":"/health"}',
   '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
  ('xauusd-nexus-dashboard', 'XAUUSD Nexus Dashboard', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Operator dashboard for XAUUSD decisions and news","data_classification":"internal","deployed_by":"cryptophys-adm/xauusd-ai-trading-assistant","health_path":"/"}',
   '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
