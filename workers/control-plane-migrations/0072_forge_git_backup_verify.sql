-- 0072 (ADR-0012 gate 8, owner 2026-11-15 "1 setuju"): the daily verify of a stored git bundle. Once per UTC day,
-- after the backup step, the Forge reads the newest stored bundle back from R2 and checks it in code as
-- `git bundle verify` and git's index-pack would (forge/src/bundle-verify.ts): the header, no prerequisites, the
-- pack's SHA-1, every entry inflated and every delta resolved, the refs and everything they reach, and the bundle
-- against this row (SHA-256, size, pack SHA-1, object count, main, branches). The result goes on the bundle's row:
-- verified_at (when), verify_status ('verified' or 'failed') and verify_details (JSON: the counts measured, or the
-- reason of the failure). A later verify of the same bundle replaces them. Additive only: every existing row reads
-- NULL (not verified yet).
ALTER TABLE forge_git_backups ADD COLUMN verified_at TEXT;
ALTER TABLE forge_git_backups ADD COLUMN verify_status TEXT CHECK (verify_status IS NULL OR verify_status IN ('verified', 'failed'));
ALTER TABLE forge_git_backups ADD COLUMN verify_details TEXT;
CREATE INDEX IF NOT EXISTS idx_forge_git_backups_verified ON forge_git_backups(verified_at);
