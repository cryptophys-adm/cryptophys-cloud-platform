# TP-009: External agents through MCP with their own Access identity

**Worker:** Antigravity. **Depends on:** TP-008 merged. **Read first:** `taskplane-tasks/ANTIGRAVITY.md`.

## Goal

An external AI agent (for example an IDE agent or another Claude session) connects to the kernel's MCP endpoint with **its own Cloudflare Access service token**. It acts as a registered agent, through the same syscall gate, at **tier ≤ 1**. Operators keep the existing operator tools.

## Files

- `workers/control-plane-migrations/0014_agent_principals.sql` (new)
- `workers/control-plane-shared/src/capabilities.ts`
- `workers/control-plane-shared/src/readiness.ts`
- `workers/ai-kernel/src/mcp.ts`, `kernel.ts`, `index.ts`, `syscall.ts`
- `workers/control-plane-shared/test/external-agents.test.ts` (new)
- `taskplane-tasks/TP-009-external-agents-mcp/STATUS.md` (new)

The Access policy and service-token creation are **owner and orchestrator work**. Do not edit `.github/workflows/provision-access.yml`.

## Specification

1. **Migration 0014.**
   - `agent_principals`:
     - `access_identity TEXT PRIMARY KEY` (the service token Client ID, as `actorOf()` returns it);
     - `agent_id TEXT NOT NULL REFERENCES agents`;
     - `created_by TEXT NOT NULL`;
     - `created_at TEXT NOT NULL`;
     - `revoked_at TEXT`.
   - No seed rows.
2. **Policy check** in `agentSyscallChecks`. If the agent has an active principal (not revoked), add check `external_tier_limit`: the capability tier must be ≤ 1. This holds even if `tier_max` is 2.
3. **Registration (approver only).**
   - `POST /v1/agents/{id}/principals {access_identity}` registers a principal.
   - `DELETE /v1/agents/{id}/principals/{access_identity}` sets `revoked_at`.
   - An approver can register a principal only for an agent whose `tier_max` ≤ 1.
   - Both actions are audited (`agent.principal_added`, `agent.principal_revoked`).
   - `GET /v1/agents/{id}` lists the agent's principals (operator).
4. **MCP identity resolution.**
   - After `accessGate`, if the caller's identity is an active principal, the session is an **agent session**. Otherwise the existing operator check applies, unchanged.
   - An identity that is neither an operator nor a principal gets 403, as today.
   - In an agent session, `tools/list` returns only:
     - `agent_whoami`: agent id, tier_max and granted capabilities with tiers;
     - `agent_observe {capability}`: tier 0 only;
     - `agent_syscall {capability, input}`: tier ≤ 1, through `syscall()` as that agent.
   - Operator tools are neither listed nor callable in an agent session.
   - `/v1/*` HTTP routes stay operator-only. Principals can use MCP only.
5. **No privilege mixing.** An identity that is both an operator and a principal is treated as an operator, and the overlap is logged as a warning. Document this choice in `STATUS.md`.

## Budget

There are no new background jobs. The cost is proportional to external calls, and the existing rate limits apply.

## Acceptance criteria (each needs a test)

1. An unregistered service token gets 403 on `/mcp`. A registered principal gets an agent session, and `tools/list` shows only the three agent tools.
2. An agent session cannot call operator tools such as `set_agents_enabled`, `resume_agent` or `suspend_agent`, even by name.
3. A tier-2 capability through `agent_syscall` is denied with `external_tier_limit`, even for a `tier_max` 2 agent. A tier-1 capability is allowed when granted, recorded and audited as that agent.
4. A revoked principal gets 403.
5. Registering a principal requires an approver (an operator alone gets 403), and is refused for an agent with `tier_max` 2.
6. Existing operator MCP behaviour is unchanged: the existing tests still pass untouched.
