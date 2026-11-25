-- 0089 (CI-WB, 2026-11-25; owner: "ok jalankan rekomendasimu"): the Forge's test results from Workers Builds. The
-- control-plane test suite runs natively in the same Workers Builds run as the type-check; a build of main posts its
-- result (POST /v1/forge/test-report, the CI service token), a change request's build prints it on one log line that the
-- Forge reads through the Workers Builds API. A Forge check takes a report of its exact commit instead of running the
-- suite in Dynamic Workers (workers/forge/src/test-report.ts, validated by control-plane-shared/src/forge-test-report.ts).
-- The next free number after PF3's 0088.
--
-- Additive only: two new tables. forge_check_runs is not altered; a run that used a report says so in its steps JSON.
--   forge_test_reports: one row per commit, the newest report of it (a later report of the same commit replaces it).
--     origin is 'ci_report' (posted by the main build) or 'cr_build_log' (read from a change request build's log).
--     files_json is the sorted list of test files the build ran; the check refuses a report whose list differs from
--     the test files of its own snapshot. failures_json holds at most 50 {file, name}, never a message.
--   forge_test_report_waits: when the Forge first saw a head with no report (a check waits two ticks for one before it
--     falls back to Dynamic Workers), and the newest change request build whose log was read without a test line.
--     Rows older than 7 days are deleted by the Forge when it adds one.
CREATE TABLE IF NOT EXISTS forge_test_reports (
  commit_sha TEXT PRIMARY KEY NOT NULL CHECK (length(commit_sha) = 40),
  tree_sha TEXT CHECK (tree_sha IS NULL OR length(tree_sha) = 40),
  build_uuid TEXT NOT NULL CHECK (length(build_uuid) BETWEEN 1 AND 64),
  branch TEXT CHECK (branch IS NULL OR length(branch) <= 200),
  origin TEXT NOT NULL CHECK (origin IN ('ci_report', 'cr_build_log')),
  files INTEGER NOT NULL CHECK (files >= 1),
  files_json TEXT NOT NULL CHECK (json_valid(files_json) AND json_type(files_json) = 'array' AND json_array_length(files_json) = files),
  pass INTEGER NOT NULL CHECK (pass >= 0),
  fail INTEGER NOT NULL CHECK (fail >= 0),
  skip INTEGER NOT NULL CHECK (skip >= 0),
  failures_json TEXT NOT NULL CHECK (json_valid(failures_json) AND json_type(failures_json) = 'array' AND json_array_length(failures_json) <= 50),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  node_version TEXT,
  reported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forge_test_report_waits (
  commit_sha TEXT PRIMARY KEY NOT NULL CHECK (length(commit_sha) = 40),
  first_seen_at TEXT NOT NULL,
  log_build_uuid TEXT CHECK (log_build_uuid IS NULL OR length(log_build_uuid) BETWEEN 1 AND 64)
);
CREATE INDEX IF NOT EXISTS idx_forge_test_report_waits_seen ON forge_test_report_waits (first_seen_at);
