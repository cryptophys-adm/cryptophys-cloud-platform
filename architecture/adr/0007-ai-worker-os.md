# ADR-0007: AI Worker Operating System

- **Status:** Accepted
- **Date:** 2026-11-04
- **Owner decisions (2026-11-04):**
  - On direction: "arah deployment platform ini justru seharusnya berbasis AI Worker operating system" (the platform should be built as an AI Worker operating system).
  - On the tier model: "setuju dengan usulan tier tersebut, dan pastikan semua workers berbasis AI" (approve the proposed tiers, and make sure every Worker is AI-based).
  - On the legacy cluster: "cluster lama sudah deprecated dan datanya tidak perlu disimpan, kita hanya mengadopsi cara kerja dan logicnya termasuk arsitekturnya" (the old cluster is deprecated and its data need not be kept; only its way of working, logic and architecture are adopted).
- **Amends:** ADR-0005 decision 3. Agents may now take bounded, reversible actions (tier 2) under policy. Trading and execution remain prohibited at every tier.
- **Builds on:** ADR-0004 (control plane), ADR-0006 (Workflows).

## Context

The platform runs only on Cloudflare. The legacy Talos cluster is deprecated, and no cluster tooling is part of the platform. The control plane already had most of what an operating system needs:
- isolated processes (Workers);
- a permission system (Policy Engine plus Access identity);
- a syslog (the hash-chained audit ledger);
- supervision (drift detection and the recovery lifecycle);
- durable jobs (Workflows);
- a per-Worker AI engine.

What it lacked was a runtime for agents, a uniform way for agents to act, and a front door for people and external agents.

## Decision

### 1. Architecture

| OS concept | Cloudflare implementation |
| --- | --- |
| Kernel / syscall gate | `cryptophys-ai-kernel` + Policy Engine action `agent.syscall`. Every agent action is a syscall. |
| Processes | Agents as SQLite-backed Durable Objects (`SupervisorAgent`), woken by Cron and by operators. Cycles are serialized per agent. |
| Process table | D1 `agents`: tier limit, capability list, status. |
| Syscall log | D1 `agent_actions` plus the audit chain (`agent.action`, `agent.suspended`/`agent.resumed`, `kernel.agents_enabled`). |
| Capability table | `control-plane-shared/src/capabilities.ts`, shared by the kernel and the Policy Engine. |
| IPC | RPC service bindings. Syscall targets are `RecoveryRpc.propose` and `SignalRpc.reingest`. |
| Durable jobs | Workflows (ADR-0006). |
| Memory | Durable Object storage (agent memory) and D1 (shared state). Vectorize is reserved for long-term memory. |
| Shell | MCP endpoint `POST /mcp` on the kernel (JSON-RPC, streamable HTTP), and the Platform API gateway `GET /v1/overview`. |
| Kill switch | `kernel_controls.agents_enabled` and per-agent `status`. |

### 2. Autonomy tiers

| Tier | Meaning | Rule |
| --- | --- | --- |
| 0 observe | Read-only | Checked in the kernel against the catalog; not persisted. |
| 1 propose | Creates a draft a human must approve (for example a recovery plan authored by `agent:<id>`) | Needs a Policy Engine allow; audited. Separation of duties means only a person approves it. |
| 2 act | Reversible, bounded action (first capability: `signals.reingest`, idempotent writes) | Needs a Policy Engine allow; rate limited per hour; kill switch; audited. |
| 3 human | Irreversible: deploy, secrets, data deletion | **Never** allowed for an agent. The `agents.tier_max` CHECK constraint caps agents at 2, and the policy check `not_human_only` denies tier 3. |
| — | Trading, orders, exchange accounts, wallets, fund movements | Prohibited at every tier (`PROHIBITED_CAPABILITY`), whatever the registry says. |

- **Policy decides.** Tier ≥ 1 requires an `allow` from the Policy Engine for `subject = agent:<id>`, `action = agent.syscall`, `resource = <capability>`.
- **No impersonation.** Over HTTP the subject is the caller's Access identity, so a person can never pose as an agent.
- **Targets re-verify.** The syscall target checks the decision again (`verifySyscallDecision`): same agent and capability, `allow`, at most 5 minutes old, and not yet used. The kernel alone cannot bypass the policy.
- **Kill switch.** Any operator may suspend an agent or turn the global switch off. Resuming an agent, or turning the switch on, needs an identity in `APPROVER_IDENTITIES`.

### 3. Every Worker is AI-based

Each platform Worker owns its own Workers AI engine: a binding, a task allow-list, validators and a D1-enforced budget, as in `AI-ENGINE-REQUIREMENT.md`.
- **Platform API.** It was the only Worker without one. It now has `summarize_platform_overview` on `GET /v1/overview?advisory=true`, plus D1 for the budget and a `KernelRpc` binding.
- **AI Kernel.** `draft_recovery_proposal`, used by the supervisor agent.
- **The rest.** Registry, Policy Engine, Drift Detector, Audit Ledger, Recovery Manager, Deployment Orchestrator and Signal Engine keep their existing engines.

AI never decides whether to act:
- **Deterministic triggers.** The supervisor acts on persistent drift (two consecutive drifted observations of a managed service) and on stale or failing ingestion.
- **AI writes; templates back it up.** The AI drafts the proposal's title, rationale and steps. These are schema-validated, and a deterministic template is used when AI is unavailable.

### 4. First agent: Platform Supervisor (`supervisor`, tier ≤ 2)

The cron (`7,22,37,52 * * * *`) runs one cycle after the Signal Engine and the Drift Detector have written:
1. `platform.observe`.
2. Persistent drift with no open agent plan and none in 24 h → `recovery.propose`, drafted by AI.
3. Ingestion stale for 40 min, or the last two runs failed every series, and no re-run in the last 30 min → `signals.reingest`.

The deploy workflow verifies the MCP endpoint, the agent registry, and a supervisor cycle on every control-plane deploy.

### 5. Legacy cluster

TP-003, TP-004 and TP-005 are cancelled. No kubectl or Vault access is granted, and no data is exported. Credential revocation stays in TP-001, which the owner has deferred.

`cryptophys-github-actions-mcp` (deployed 2026-11-01, outside this pipeline) is a shared-bearer MCP connector holding a GitHub token. It is superseded by the kernel's Access-protected MCP endpoint and should be retired. Deleting it is the owner's decision.

## Usage against the Workers Paid included quotas

- **Durable Objects:** 1 agent and 96 cycles a day, far within the included requests and SQLite storage.
- **Workers AI:** the AI is called only when a proposal is drafted or an operator asks for an advisory overview. The kernel and Platform API caps are 40 a day each, inside the 400-a-day account cap.
- **D1:** an observation is about 20 small reads per cycle.

## Consequences

- New agents are added as data (an `agents` row with a tier limit and grants) plus code for any new capability in the catalog. A capability's tier is fixed in code and reviewed in a PR.
- Raising autonomy beyond tier 2 is impossible without a schema change, a catalog change and a new ADR.
- Operators and external AI clients use one front door: MCP behind Cloudflare Access.

## Alternatives considered

- **A central AI engine Worker shared by all services.** Rejected, as in `AI-ENGINE-REQUIREMENT.md`: per-Worker engines keep budgets, permissions and failures isolated.
- **Agents that call Worker APIs directly with their own tokens.** Rejected. There would be no single syscall gate, no uniform audit, and no kill switch.
- **The Cloudflare Agents SDK.** Not adopted for now: the kernel needs only Durable Objects and a small MCP surface, and avoiding the dependency keeps the code testable in Node. The SDK can be adopted later without changing the syscall model.
