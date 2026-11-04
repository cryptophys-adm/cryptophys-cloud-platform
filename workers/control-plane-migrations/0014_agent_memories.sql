-- Long-term agent memory store and capability grants (TP-008, ADR-0007).
-- Each row in agent_memories mirrors a 384-dimension vector in the cryptophys-agent-memory Vectorize index
-- under the same memory_id, scoped strictly to agent_id.

CREATE TABLE agent_memories (
  memory_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) >= 1 AND length(text) <= 1000),
  source_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_memories_agent_created ON agent_memories (agent_id, created_at);

UPDATE agents
SET capabilities_json = json_insert(capabilities_json, '$[#]', 'memory.recall')
WHERE agent_id IN ('supervisor', 'signal-analyst', 'auditor')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = 'memory.recall'
  );

UPDATE agents
SET capabilities_json = json_insert(capabilities_json, '$[#]', 'memory.remember')
WHERE agent_id IN ('supervisor', 'signal-analyst', 'auditor')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = 'memory.remember'
  );
