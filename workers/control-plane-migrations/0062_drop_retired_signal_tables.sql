-- 0062 (owner 2026-11-14, resource audit decision 2: archive to R2 first, then drop by migration). The crypto
-- Signal Engine was retired on 2026-11-05 (0020); its five tables were read only by the daily backup. The Recovery
-- Manager archived each one to the private backup bucket (archive/retired-signal-tables/<table>.sql.gz, outside
-- the 90-day lifecycle rule) and audited backup.archive_verified "verified" for all five on 2026-11-14 08:14 UTC,
-- the archived row counts equal to D1's: market_candles 4461, signal_indicators 822, signal_confluence 105,
-- signal_ingest_runs 152, macro_context 32. Children first (signal_indicators and signal_confluence reference
-- market_candles). Their indexes go with them. No other table references these.
DROP TABLE IF EXISTS signal_indicators;
DROP TABLE IF EXISTS signal_confluence;
DROP TABLE IF EXISTS market_candles;
DROP TABLE IF EXISTS signal_ingest_runs;
DROP TABLE IF EXISTS macro_context;
