-- 0058 (ADR-0012 G6, cut-over step 4; owner 2026-11-13: "kejar cut-over hari ini"): canonical main moves on the
-- Forge from now on. The Forge fast-forwards main after a consensus merge_change (routine paths) or a
-- merge_owner_change and the owner's click (guard paths); GitHub merges nothing and its main is no longer mirrored
-- (the Forge refuses mirror tokens in this state). Reverting this row is the cut-over's rollback before step 7.
UPDATE forge_controls SET value = 'forge', updated_by = 'migration:0058', updated_at = '2026-11-13T13:00:00.000Z'
WHERE control = 'merge_path';
