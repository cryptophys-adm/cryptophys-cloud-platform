-- 0039 (ADR-0012 phase 4): record whether a Forge check was of a commit of main or of a change
-- request head, so earlier heads of a change request never show up among main's checks. Existing
-- rows: main when GitHub CI or a main type-check reported on the commit; otherwise, from the start of
-- change requests (2026-11-09 06:30 UTC), a change request head; older rows are main.
ALTER TABLE forge_check_runs ADD COLUMN source TEXT CHECK (source IS NULL OR source IN ('main', 'change'));
UPDATE forge_check_runs SET source = CASE
  WHEN EXISTS (SELECT 1 FROM forge_ci_reports g WHERE g.commit_sha = forge_check_runs.commit_sha) THEN 'main'
  WHEN EXISTS (SELECT 1 FROM forge_typecheck_reports t WHERE t.commit_sha = forge_check_runs.commit_sha AND t.branch = 'main') THEN 'main'
  WHEN started_at >= '2026-11-09T06:30:00.000Z' THEN 'change'
  ELSE 'main' END
WHERE source IS NULL;
