# TP-009: External agents through MCP with their own Access identity — Status

- **Status:** COMPLETED
- **Branch:** `antigravity/TP-009-external-agents-mcp`

## Summary of Changes

1. **Migration (`workers/control-plane-migrations/0015_agent_principals.sql`)**:
   - Sequenced as `0015_agent_principals.sql` after `0011_agent_syscall_consumptions.sql`, `0012_agent_reports.sql`, `0013_auditor_agent.sql`, and `0014_agent_memories.sql`.
   - Creates `agent_principals (access_identity TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id), created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)` and index `agent_principals_agent_id (agent_id)` with no seed rows.
   - Updated `REQUIRED_MIGRATION = "0015_agent_principals.sql"` in `workers/control-plane-shared/src/readiness.ts`.
2. **Policy Gate (`workers/control-plane-shared/src/capabilities.ts`)**:
   - Added `getActivePrincipalByIdentity` and `hasActivePrincipal`.
   - In `agentSyscallChecks`, if the agent has an active (non-revoked) principal in `agent_principals`, adds check `external_tier_limit`: `cap.tier <= 1` (enforced even if the agent row in `agents` has `tier_max = 2`).
   - Reinforced the atomic `INSERT OR IGNORE INTO agent_syscall_consumptions` in `verifySyscallDecision` with `AND NOT (? > 1 AND EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.agent_id = a.agent_id AND ap.revoked_at IS NULL))`.
3. **Principal Registration & Revocation (`workers/ai-kernel/src/kernel.ts`, `index.ts`)**:
   - `POST /v1/agents/{id}/principals { access_identity }` (approver only): validates `tier_max <= 1`, binds the identity, and appends `agent.principal_added` to `audit_events`.
   - `DELETE /v1/agents/{id}/principals/{access_identity}` (approver only): sets `revoked_at` and appends `agent.principal_revoked` to `audit_events`.
   - `GET /v1/agents/{id}` (operator): includes `principals` in its response payload.
   - `/v1/*` HTTP routes remain strictly operator-only; external principals may use `/mcp` only.
4. **MCP Session Resolution & No-Privilege-Mixing Choice (`workers/ai-kernel/src/index.ts`, `mcp.ts`)**:
   - After `accessGate`, `/mcp` resolves the verified caller identity via `actorOf(auth.identity)`.
   - If the identity is in `OPERATOR_IDENTITIES`, the session is an **operator session** with the existing operator tools unchanged.
   - If the identity is both in `OPERATOR_IDENTITIES` and an active row in `agent_principals`, **no privilege mixing** applies: the session is treated strictly as an operator session (never mixing operator and agent tools) and logs a structured warning (`event: "principal_operator_overlap"`, `resolution: "operator"`).
   - If the identity is not an operator and is an active principal in `agent_principals`, the session is an **agent session** exposing only `agent_whoami`, `agent_observe` (tier 0 only), and `agent_syscall` (tier <= 1 through `syscall()`). Operator tools are neither listed nor callable by name.

## Acceptance Criteria Mapping

| Acceptance Criterion | Test Name |
| --- | --- |
| 1. An unregistered service token gets 403 on `/mcp`. A registered principal gets an agent session, and `tools/list` shows only the three agent tools. | `unregistered service token gets 403 on /mcp; registered principal gets an agent session and tools/list shows only the three agent tools` (`test/external-agents.test.ts`) |
| 2. An agent session cannot call operator tools such as `set_agents_enabled`, `resume_agent` or `suspend_agent`, even by name. | `an agent session cannot call operator tools such as set_agents_enabled, resume_agent or suspend_agent, even by name` (`test/external-agents.test.ts`) |
| 3. A tier-2 capability through `agent_syscall` is denied with `external_tier_limit`, even for a `tier_max` 2 agent. A tier-1 capability is allowed when granted, recorded and audited as that agent. | `a tier-2 capability through agent_syscall is denied with external_tier_limit even for a tier_max 2 agent, while a granted tier-1 capability is allowed, recorded and audited` (`test/external-agents.test.ts`) |
| 4. A revoked principal gets 403. | `a revoked principal gets 403 on /mcp and revocation is audited` (`test/external-agents.test.ts`) |
| 5. Registering a principal requires an approver (an operator alone gets 403), and is refused for an agent with `tier_max` 2. | `registering a principal requires an approver (operator alone gets 403) and is refused for an agent with tier_max 2` (`test/external-agents.test.ts`) |
| 6. Existing operator MCP behaviour is unchanged: the existing tests still pass untouched. | `operator MCP behaviour is unchanged, and an identity that is both an operator and a principal is treated as an operator with a warning` (`test/external-agents.test.ts`) & `MCP: initialize, tools/list, tools/call; approver-only tools refuse operators` (`test/ai-kernel.test.ts`) |
