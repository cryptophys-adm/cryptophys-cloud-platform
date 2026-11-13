-- 0057 (ADR-0012 G3b; owner 2026-11-13: "kejar cut-over hari ini"): where canonical main moves.
--   github  GitHub merges pull requests; mirror-to-forge.yml copies main to the Forge (the value this sets);
--   forge   the Forge fast-forwards canonical main after a consensus merge_change, or merge_owner_change and the
--           owner's click for a change that touches a guard path. Flipped by a reviewed migration at the cut-over
--           (docs/GITHUB-CUTOVER.md, procedure step 4). Additive: one new table and one row.
CREATE TABLE forge_controls (
  control TEXT PRIMARY KEY CHECK (control IN ('merge_path')),
  value TEXT NOT NULL CHECK (value IN ('github', 'forge')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO forge_controls (control, value, updated_by, updated_at)
VALUES ('merge_path', 'github', 'migration:0057', '2026-11-13T12:00:00.000Z');
