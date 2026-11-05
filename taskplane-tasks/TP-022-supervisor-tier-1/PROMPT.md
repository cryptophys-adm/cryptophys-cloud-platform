# TP-022: Lower the supervisor to tier 1, and keep kernel-hosted agents internal

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-021 (merged and deployed).
- **Branch:** `worker/TP-022-supervisor-tier-1`.
- **PR title:** `TP-022: supervisor tier 1; kernel-hosted agents stay internal`.

## Why

**Owner decision (2026-11-05):** lower the `supervisor` from `tier_max = 2` to **1**.

- Since TP-018 there has been no tier-2 capability (`signals.reingest` was removed). The supervisor only proposes recovery plans, which a human approves. Least privilege says its ceiling should match what it does.
- **Side effect to close.** `tier_max > 1` was implicitly shielding the supervisor in two places:
  1. principal registration refuses agents with `tier_max > 1`, so no external Access token could ever act as the supervisor (`kernel.ts`, around line 60);
  2. `AgentRpc` refuses agents with `tier_max > 1` (`agent-rpc.ts`, `resolve`).
- At tier 1 both shields disappear. They must be replaced by an **explicit rule**: agents hosted by `cryptophys-ai-kernel` are the kernel's own Durable Object processes, and **no external principal and no `AgentRpc` caller may ever act as them**. The rule covers `supervisor`, `signal-analyst` and `auditor`. That is stricter than today, because `signal-analyst` and `auditor` are tier 1 and currently eligible.

## Read first (and nothing else)

- `workers/ai-kernel/src/kernel.ts`, around lines 45–90: principal registration.
- `workers/ai-kernel/src/agent-rpc.ts`: `resolve()`.
- `workers/ai-kernel/src/index.ts`, around line 71: the agent session is resolved there with `getActivePrincipalByIdentity` (defined in `control-plane-shared/src/capabilities.ts`, line 62) and passed to `handleMcp` (`mcp.ts`) as `agentSession`. Put the kernel-hosted guard in `index.ts`, right after that lookup. Do not change `getActivePrincipalByIdentity`; other callers rely on it.
- `workers/control-plane-migrations/0010_ai_worker_os.sql`, lines 50–60, and `0020_retire_signal_engine.sql`, for the migration style.
- `workers/control-plane-shared/src/readiness.ts`: `REQUIRED_MIGRATION` and `REQUIRED_MIGRATIONS`.
- `architecture/adr/0007-ai-worker-os.md`: the 2026-11-05 amendment at the end.
- Tests that reference the supervisor's tier: `ai-kernel.test.ts` (around lines 154 and 433) and `external-agents.test.ts` (around line 336).

## Files you may change

- `workers/control-plane-migrations/0021_supervisor_tier_1.sql` (new)
- `workers/control-plane-shared/src/readiness.ts`
- `workers/ai-kernel/src/kernel.ts`, `agent-rpc.ts`, and `index.ts` (the agent-session lookup only). Change only the kernel-hosted guard there.
- `workers/control-plane-shared/test/ai-kernel.test.ts`, `external-agents.test.ts` and `ai-diagnostics-tp016.test.ts`: only assertions that break because of this change. **Rewrite** them; never delete or skip them. List each one in `STATUS.md` with the reason.
- `workers/control-plane-shared/test/supervisor-tier1-tp022.test.ts` (new)
- `architecture/adr/0007-ai-worker-os.md`: append a dated amendment only. Do not edit earlier text.
- `docs/OPERATIONS.md`: update the supervisor's tier in the agent inventory text.
- `taskplane-tasks/TP-022-supervisor-tier-1/STATUS.md`

Do **not** touch `.github/*`. The orchestrator updates the deploy verification, which currently expects `tier_max == 2`.

## Specification

### 1. Migration `0021_supervisor_tier_1.sql`

```sql
UPDATE agents SET tier_max = 1, updated_by = 'migration:0021', updated_at = '2026-11-05T16:30:00.000Z'
WHERE agent_id = 'supervisor';
```

- Nothing else. The supervisor keeps its grants (`platform.observe, recovery.propose, memory.recall, memory.remember`) and its status.
- Set `REQUIRED_MIGRATION` to `0021_supervisor_tier_1.sql`, and add `0020_retire_signal_engine.sql` to `REQUIRED_MIGRATIONS`.

### 2. Kernel-hosted agents stay internal

1. Export one constant in `kernel.ts` (or a small shared spot that both files import): `KERNEL_HOST = "cryptophys-ai-kernel"`.
2. **Principal registration:** if `agent.host_worker === KERNEL_HOST`, refuse with HTTP 400:

   ```json
   { "error": "kernel_agent_internal", "message": "agents hosted by the AI Kernel cannot have external principals" }
   ```

   Check this **before** the tier check. Keep the tier check as is (`tier_max > 1` → `external_tier_limit`).
3. **Agent session (MCP):** when an Access identity resolves to an active principal whose agent is hosted by `KERNEL_HOST`, treat it as **no agent session**. Fall back to the existing operator check, so a non-operator gets 403. Log the event (`event: "kernel_agent_principal_ignored"`). This covers rows that were registered before this change.
4. **`AgentRpc.resolve`:** if `agent.host_worker === KERNEL_HOST`, return `{ error: "kernel_agent_internal" }` **before** the host comparison. Keep the existing checks.
5. **The kernel's own syscalls are unaffected.** The supervisor, signal-analyst and auditor Durable Objects call `syscall()` directly, not through principals or `AgentRpc`.

### 3. Docs

- **ADR-0007:** add a dated amendment, "2026-11-05: supervisor tier 1", stating:
  - the owner decision;
  - the new `tier_max = 1`;
  - that no agent currently has `tier_max = 2`;
  - that the explicit kernel-internal rule replaces the implicit tier shield;
  - that raising any agent back to tier 2 needs a new owner decision and a tier-2 capability in the catalog.
- **`docs/OPERATIONS.md`:** the supervisor is now tier 1, so the inventory reads 31 enabled tier-1 rows and 1 suspended row.

## Budget

No runtime cost change.

## Acceptance criteria (one `test()` per criterion, in `supervisor-tier1-tp022.test.ts`)

1. **Migration.** After all migrations:
   - the supervisor has `tier_max = 1`, the same 4 grants in the same order, and status `enabled`;
   - no agent has `tier_max = 2`;
   - `REQUIRED_MIGRATION` is 0021, and `schemaReady` is true.
2. **Supervisor still works.** With persistent drift on a managed service, a supervisor cycle still produces a successful `recovery.propose` that a human can approve. Reuse the pattern of the existing supervisor test.
3. **No principal for kernel agents.** Registering a principal for `supervisor`, `signal-analyst` and `auditor` each returns 400 `kernel_agent_internal`, even for an approver. Registering one for a non-kernel tier-1 agent such as `platform-api` still works.
4. **Pre-existing principal is ignored.** Insert a principal row for `auditor` directly into D1. An MCP request with that Access identity gets no agent tools: 403, or operator tools only if that identity is also an operator, exactly per the existing operator rule.
5. **No `AgentRpc` for kernel agents.** `rpcWhoami` and `rpcSyscall` with `host_worker = "cryptophys-ai-kernel"` and agent `supervisor` both return `kernel_agent_internal`. A normal platform Worker acting as its own agent still works.
6. **The tier check still applies.** A non-kernel agent temporarily set to `tier_max = 2` in the test DB is still refused, both as a principal and through `AgentRpc`, with `external_tier_limit`.
7. **No regressions.**
   - typecheck is clean;
   - `npm test` is higher than 136, with 0 fail, 0 skipped and 0 todo;
   - every rewritten assertion is listed in `STATUS.md`.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`, and paste the **real** output tails into `STATUS.md`. Dry-run:

```bash
npx wrangler deploy --dry-run --config ../ai-kernel/wrangler.toml --outdir /tmp/dry-ai-kernel
```

Run `test_migrations.py`. Set `State: done` only with 0 failures.

## After merge (orchestrator only)

1. Change the deploy verification in `deploy-control-plane.yml` from `.tier_max == 2` to `.tier_max == 1` **before** deploying. Otherwise the verification fails right after migration 0021.
2. Deploy Control Plane.
3. Verify in D1 that the supervisor is tier 1 and no agent is tier 2.
4. Verify that the next supervisor cycle still completes.
