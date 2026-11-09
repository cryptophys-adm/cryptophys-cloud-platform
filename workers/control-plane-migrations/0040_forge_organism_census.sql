-- 0040 (ADR-0013 phase 2): the organism census. On each new main commit the Forge reads every
-- Worker's DNA (workers/<dir>/organism.json) from the Artifacts repository and compares it with the
-- live registries (service_registry, agents). One row per main commit: what the DNA declares and what
-- differs (a declared Worker or agent the registries do not know, an agent the DNA no longer
-- declares, a host or capability change). The owner notices and, in phase 3, the Supervisor read it.
CREATE TABLE IF NOT EXISTS forge_organism_census (
  main_sha TEXT PRIMARY KEY CHECK (length(main_sha) = 40),
  status TEXT NOT NULL CHECK (status IN ('consistent', 'changes', 'invalid')),
  organs INTEGER NOT NULL,
  agents INTEGER NOT NULL,
  engines INTEGER NOT NULL,
  voters INTEGER NOT NULL,
  findings TEXT NOT NULL,
  genome TEXT,
  taken_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forge_organism_census_taken ON forge_organism_census(taken_at);
