-- 0068 (owner 2026-11-15, "tambahkan"): the Observer's binding index (control-plane-shared/src/observer-bindings.ts).
-- Additive: one new table, nothing else. One row per Worker on the account's scripts list, as the last recorded
-- inventory read it from GET /accounts/{account}/workers/scripts/{name}/settings. The code rewrites every row of a run
-- and removes the rows of Workers no longer listed; a Worker that was not read keeps a row with its status, so
-- "no live Worker binds X" is proven only when every row is 'ok'.
-- bindings_json: [{type, name, id?, class_name?, script_name?}], never a value (plain_text, secret_text, json and
-- secret_key bindings are not kept).
CREATE TABLE IF NOT EXISTS observer_worker_bindings (
  worker TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok', 'permission_missing', 'unavailable', 'skipped')),
  bindings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bindings_json) AND json_type(bindings_json) = 'array'),
  detail TEXT,
  observed_at TEXT NOT NULL
);
