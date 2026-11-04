# TP-008: Long-term agent memory with Vectorize

**Worker:** Antigravity. **Depends on:** TP-007 merged. **Read first:** `taskplane-tasks/ANTIGRAVITY.md`.

## Goal

Agents remember what they reported or proposed and recall similar past situations as context for their AI drafts. Memory is **advisory context only**: it never changes a trigger, a decision or a validator.

## Files

- `workers/control-plane-migrations/0013_agent_memories.sql` (new)
- `workers/control-plane-shared/src/capabilities.ts`
- `workers/control-plane-shared/src/ai-engine.ts`: add `embed()` only.
- `workers/control-plane-shared/src/readiness.ts`
- `workers/ai-kernel/src/memory.ts` (new)
- `workers/ai-kernel/src/syscall.ts`, `supervisor.ts`, `signal-analyst.ts`, `auditor.ts`, `index.ts`
- `workers/ai-kernel/wrangler.toml`
- `.github/scripts/ensure-vectorize-index.sh` and `.github/scripts/ensure-vectorize-index.test.sh` (new; the **only** `.github` files allowed; the orchestrator wires them into the workflow)
- `workers/control-plane-shared/test/agent-memory.test.ts` (new)
- `taskplane-tasks/TP-008-agent-memory-vectorize/STATUS.md` (new)

## Specification

1. **Vectorize index.**
   - Index `cryptophys-agent-memory`: 384 dimensions, cosine metric, metadata index on `agent_id` (string).
   - Embedding model: `@cf/baai/bge-small-en-v1.5`. Confirm in the Cloudflare docs that it is available and returns 384 dimensions, and cite the docs URL in `STATUS.md`.
   - Binding `MEMORY` in the kernel's `wrangler.toml`.
2. **`ensure-vectorize-index.sh`.**
   - Idempotent: create the index and its metadata index only if missing, using `npx wrangler vectorize create|create-metadata-index|list --json`.
   - Never deletes anything. Prints no secrets.
   - The test uses a fake `npx` on `PATH`, like the other `.github/scripts/*.test.sh` files.
3. **Migration 0013.**
   - `agent_memories`: `memory_id PK`, `agent_id REFERENCES agents`, `kind`, `text` (≤1000 characters, CHECK), `source_ref`, `created_at`.
   - Grant `memory.recall` and `memory.remember` to `supervisor`, `signal-analyst` and `auditor`. Write this as an `UPDATE agents SET capabilities_json = json_insert(...)` that is idempotent.
4. **Capabilities.**
   - `memory.recall`: tier 0. Top-k ≤ 5, filtered by metadata `agent_id` = the caller, so agents never read each other's memories.
   - `memory.remember`: tier 1, `max_per_hour: 12`. The D1 row and the vector use the same id. The vector metadata is `{agent_id, kind}`.
5. **`AiEngine.embed(text)`.**
   - Same budget accounting as `run()`: counts toward `ai_usage` under task `embed` and respects the daily and account caps.
   - Returns a typed outcome: `ok` with a vector, or `unavailable`.
6. **Use in agents.**
   - Before drafting, recall the top 3 memories for a short query built from the deterministic finding, and pass them to the AI as `context` (never to validators or triggers).
   - After a successful `recovery.propose` or `reports.publish`, `memory.remember` the headline or title.
   - If `MEMORY` is missing or fails, carry on without memory and record `memory: "unavailable"` in the cycle report.
7. **Retention.** Delete memories older than 90 days from D1 and Vectorize, at most 100 per cycle, in the auditor's daily 00:37 cycle.
8. **Readiness.** Add `memory_binding`.

## Budget

- At most about 30 memories a day (rate limits).
- 384 dimensions × at most 3,000 vectors after 90 days is about 1.2M stored dimensions, against 10M included.
- Queries: about 100 a day × 384, well below the 50M queried dimensions a month included.
- Embeddings count against the existing AI caps.

## Acceptance criteria (each needs a test, using a fake `MEMORY` binding)

1. `memory.recall` only returns the caller's memories (metadata filter is asserted on the fake).
2. `memory.remember` writes the D1 row and the vector with the same id, and is rate limited by policy.
3. A failing or missing `MEMORY` or embedding never fails a cycle or changes its actions.
4. Recalled memories appear in the AI input `context` and never in trigger inputs. The AI output is still validated as before.
5. Retention deletes rows older than 90 days in both stores, with a cap of 100 per cycle.
6. `ensure-vectorize-index.test.sh`:
   - creates the index when it is missing;
   - is a no-op when it exists;
   - fails on an index with the wrong dimensions instead of changing it.
