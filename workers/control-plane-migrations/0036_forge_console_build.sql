-- 0036 (ADR-0012 §5c): the Workers Builds type-check also builds the Console UI (its own type-check
-- and the Vite build, as GitHub CI's "Build the Console UI" step) and reports the result with the
-- type-check of the same commit. Stored as JSON {status, errors, diagnostics, bytes}; NULL for
-- reports from builds before this step.
ALTER TABLE forge_typecheck_reports ADD COLUMN console_build TEXT;
