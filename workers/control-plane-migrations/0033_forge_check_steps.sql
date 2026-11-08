-- 0033 (ADR-0012 phase 3): Forge checks run the Worker bundles and the secret-scan guard as well as
-- the tests. `steps` holds each step's result as JSON (tests, bundles, secrets; a secret finding is a
-- rule, path and line, never the matched text). `guard_status` is 'clean' or 'findings'.
ALTER TABLE forge_check_runs ADD COLUMN steps TEXT;
ALTER TABLE forge_check_runs ADD COLUMN guard_status TEXT CHECK (guard_status IS NULL OR guard_status IN ('clean', 'findings'));
