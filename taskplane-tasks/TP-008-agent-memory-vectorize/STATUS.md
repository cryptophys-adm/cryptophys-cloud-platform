# TP-008: Long-term agent memory with Vectorize — Status

- **Status:** COMPLETED (PR opened; ready for CI & validation)
- **Branch:** `antigravity/TP-008-agent-memory-vectorize`
- **Embedding Model Reference:** `@cf/baai/bge-small-en-v1.5` (384 output dimensions, cosine metric) — confirmed in Cloudflare Workers AI docs: <https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/> and Vectorize metadata filtering docs: <https://developers.cloudflare.com/vectorize/reference/metadata-filtering/>.

## Summary of Changes

1. **Migration (`workers/control-plane-migrations/0014_agent_memories.sql`)**:
   - Sequenced as `0014_agent_memories.sql` after `0011_agent_syscall_consumptions.sql`, `0012_agent_reports.sql`, and `0013_auditor_agent.sql`.
   - Creates `agent_memories (memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id), kind TEXT NOT NULL, text TEXT NOT NULL CHECK (length(text) >= 1 AND length(text) <= 1000), source_ref TEXT, created_at TEXT NOT NULL)` and index `agent_memories_agent_created (agent_id, created_at)`.
   - Idempotently appends `memory.recall` and `memory.remember` to `supervisor`, `signal-analyst`, and `auditor` via `json_insert`.
2. **Idempotent Vectorize Index Provisioning (`.github/scripts/ensure-vectorize-index.sh` & `.github/scripts/ensure-vectorize-index.test.sh`)**:
   - Uses `npx wrangler vectorize list --json`, `create`, and `create-metadata-index` (`--property-name=agent_id --type=string`) to idempotently ensure `cryptophys-agent-memory` (384 dimensions, `cosine` metric) exists.
   - Fails closed if the index exists with wrong dimensions or metric; never deletes anything; prints no secrets.
3. **Embeddings & Capabilities (`workers/control-plane-shared/src/ai-engine.ts`, `capabilities.ts`, `readiness.ts`)**:
   - Added `AiEngine.embed(text, correlationId)` using `@cf/baai/bge-small-en-v1.5` (384 dimensions) with the same per-service daily and account-wide `ai_usage` budget accounting under task `"embed"`.
   - Added `memory.recall` (tier 0) and `memory.remember` (tier 1, `reversible: true`, `max_per_hour: 12`) to `CAPABILITIES`.
   - Updated `REQUIRED_MIGRATION = "0014_agent_memories.sql"` and `REQUIRED_MIGRATIONS`.
4. **Kernel Memory Module & Agent Wiring (`workers/ai-kernel/src/memory.ts`, `syscall.ts`, `supervisor.ts`, `signal-analyst.ts`, `auditor.ts`, `index.ts`, `wrangler.toml`)**:
   - `recallMemories` (tier 0): embeds bounded query (`<= 1000` chars), queries `env.MEMORY` with `topK <= 5` and strict metadata filter `{ agent_id }`, and hydrates rows from `agent_memories WHERE agent_id = ?`.
   - `rememberMemory` (tier 1): verifies the Policy Engine decision via `verifySyscallDecision`, embeds bounded text, upserts vector to `env.MEMORY` with metadata `{ agent_id, kind }`, and inserts the matching `memory_id` into `agent_memories`.
   - `supervisor`, `signal-analyst`, and `auditor` recall up to 3 memories before AI drafting (`context` field only, never altering deterministic triggers or output validators) and remember headlines/titles after a successful `recovery.propose` or `reports.publish`. Missing or failing `MEMORY`/embeddings record `memory: "unavailable"` on the cycle report and never fail a cycle.
   - `pruneExpiredMemories`: runs during the auditor's daily `00:37 UTC` cycle and deletes up to 100 rows older than 90 days from both Vectorize and D1.
   - Added `memory_binding: Boolean(env.MEMORY)` to `/ready` and `[[vectorize]] binding = "MEMORY" index_name = "cryptophys-agent-memory"` to `workers/ai-kernel/wrangler.toml`.

## Acceptance Criteria Mapping

| Acceptance Criterion | Test Name |
| --- | --- |
| 1. `memory.recall` only returns the caller's memories (metadata filter is asserted on the fake). | `memory.recall only returns the caller's memories and passes metadata filter { agent_id } to Vectorize` (`test/agent-memory.test.ts`) |
| 2. `memory.remember` writes the D1 row and the vector with the same id, and is rate limited by policy. | `memory.remember writes D1 row and vector with identical memory_id and metadata { agent_id, kind }, enforces decision verification, and is rate-limited by policy` (`test/agent-memory.test.ts`) |
| 3. A failing or missing `MEMORY` or embedding never fails a cycle or changes its actions. | `failing or missing MEMORY binding or embedding failure never fails a supervisor, signal-analyst, or auditor cycle or changes its actions` (`test/agent-memory.test.ts`) |
| 4. Recalled memories appear in the AI input `context` and never in trigger inputs. The AI output is still validated as before. | `recalled memories appear in the AI input context and never in trigger inputs, while AI output validation still holds` (`test/agent-memory.test.ts`) |
| 5. Retention deletes rows older than 90 days in both stores, with a cap of 100 per cycle. | `retention deletes memories older than 90 days in both D1 and Vectorize with a cap of 100 per cycle` (`test/agent-memory.test.ts`) |
| 6. `ensure-vectorize-index.test.sh` creates the index when missing, is a no-op when it exists, and fails on wrong dimensions. | `.github/scripts/ensure-vectorize-index.test.sh` (`passed=3 failed=0`) |
