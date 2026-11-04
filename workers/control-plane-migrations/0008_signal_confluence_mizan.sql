-- Revised Mizan (ADR-0005 decision 10): phi is computed once per symbol across timeframes and
-- stored with the confluence row it was derived with.
ALTER TABLE signal_confluence ADD COLUMN mizan_json TEXT CHECK (mizan_json IS NULL OR json_valid(mizan_json));
