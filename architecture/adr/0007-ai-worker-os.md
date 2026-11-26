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

### 1.1 In-account AgentRpc and trust boundary (TP-011)

In-account Workers may call the AI Kernel's `AgentRpc` WorkerEntrypoint through a Cloudflare Service Binding, without a shared secret or Access service token. The caller's deployed binding supplies `props.host_worker`; the kernel accepts a call only when that value is well-formed, exactly matches the target agent row's `host_worker`, and the agent has `tier_max <= 1`. The call then passes through the same capability grants, agent status, global kill switch, rate limit, Policy Engine decision, target re-verification and audit path as other syscalls. Tier-2 `supervisor` is not exposed through this entrypoint.

**Trust boundary:** the asserted host is configuration supplied by the caller Worker's Service Binding. The trust boundary is the Cloudflare account and the identities authorized to change or deploy that caller configuration. Such an actor can change `props.host_worker`; this mechanism does not attest a caller against a malicious account deployer. Service Binding changes are therefore security-sensitive and require reviewed source/configuration changes and controlled deployment. No HTTP/MCP request header may choose an agent identity.

Caller bindings are deployed only after the AI Kernel's `AgentRpc` entrypoint is live, in a separate reviewed change. This avoids deploying a caller that references an entrypoint not yet deployed. A D1 agent row marked `enabled` is registered state, not proof that a caller binding or external principal exists.

External MCP sessions remain separate: they require a Cloudflare Access identity explicitly registered in `agent_principals` by an approver. Service-token creation is an owner-controlled Cloudflare operation; repository automation must not create a token and discard its one-time client secret.

### 2. Autonomy tiers

| Tier | Meaning | Rule |
| --- | --- | --- |
| 0 observe | Read-only | Checked in the kernel against the catalog; not persisted. |
| 1 propose | Creates a draft a human must approve (for example a recovery plan authored by `agent:<id>`) | Needs a Policy Engine allow; audited. Separation of duties means only a person approves it. |
| 2 act | Reversible, bounded action (first capability: `signals.reingest`, idempotent writes) | Needs a Policy Engine allow; rate limited per hour; kill switch; audited. |
| 3 human | Irreversible: deploy, secrets, data deletion | **Never** allowed for an agent. The `agents.tier_max` CHECK constraint caps agents at 2, and the policy check `not_human_only` denies tier 3. |
| — | Trading, orders, exchange accounts, wallets, fund movements | Prohibited at every tier (`PROHIBITED_CAPABILITY`), whatever the registry says. |

- **Policy decides.** Tier ≥ 1 requires an `allow` from the Policy Engine for `subject = agent:<id>`, `action = agent.syscall`, `resource = <capability>`.
- **No operator impersonation.** Operator and CI MCP sessions always receive operator tools; no request header selects an agent. External MCP agent sessions require an active `agent_principals` mapping. In-account calls use the host-pinned `AgentRpc` Service Binding described below.
- **Targets re-verify.** The syscall target checks the decision again (`verifySyscallDecision`): same agent and capability, `allow`, at most 5 minutes old, and not yet used. The kernel alone cannot bypass the policy.
- **Kill switch.** Any operator may suspend an agent or turn the global switch off. Resuming an agent, or turning the switch on, needs an identity in `APPROVER_IDENTITIES`.

### 3. Every Worker is AI-based

Each platform Worker owns its own Workers AI engine: a binding, a task allow-list, validators and a D1-enforced budget, as in `AI-ENGINE-REQUIREMENT.md`.
*Amended 2026-11-25 (owner: "Approve, but Cerebrum only"): the AI Kernel's engine may try Beam first for Cerebrum's chat, directive drafts and councils, free_only, with Workers AI always the fallback; see the amendment "Beam for Cerebrum" below.*
- **Platform API.** It was the only Worker without one. It now has `summarize_platform_overview` on `GET /v1/overview?advisory=true`, plus D1 for the budget and a `KernelRpc` binding.
- **AI Kernel.** `draft_recovery_proposal`, used by the supervisor agent.
- **The rest.** Registry, Policy Engine, Drift Detector, Audit Ledger, Recovery Manager, Deployment Orchestrator and Signal Engine keep their existing engines.

*Amended 2026-11-13 (owner: "mulai sekarang Ai harus memutuskan", choice "AI memutuskan, pengaman tetap"): agents decide inside rigid safeguards; see ADR-0014 §10 A. Until that is built, the rule below holds.*

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

`cryptophys-github-actions-mcp` (deployed 2026-11-01, outside this pipeline) was a shared-bearer MCP connector holding a GitHub token, superseded by the kernel's Access-protected MCP endpoint. **Retired 2026-11-05:** the owner revoked its token and deleted the Worker; its source was removed from the repository.

## Usage against the Workers Paid included quotas

- **Durable Objects:** 1 agent and 96 cycles a day, far within the included requests and SQLite storage.
- **Workers AI:** the AI is called only when a proposal is drafted or an operator asks for an advisory overview. The kernel and Platform API caps are 40 a day each, inside the 400-a-day account cap.
- **D1:** an observation is about 20 small reads per cycle.

## Consequences

- New agents are added as data (an `agents` row with a tier limit and grants) plus code for any new capability in the catalog. A capability's tier is fixed in code and reviewed in a PR.
- Raising autonomy beyond tier 2 is impossible without a schema change, a catalog change and a new ADR.
- Operators and external AI clients use one front door: MCP behind Cloudflare Access.

## Alternatives considered

- **A central AI engine Worker shared by all services.** Rejected, as in `AI-ENGINE-REQUIREMENT.md`: per-Worker engines keep budgets, permissions and failures isolated. (The model router of the 2026-11-25 amendment is not such a Worker: it is a library inside the AI Kernel's own engine.)
- **Agents that call Worker APIs directly with their own tokens.** Rejected. There would be no single syscall gate, no uniform audit, and no kill switch.
- **The Cloudflare Agents SDK.** Not adopted for now: the kernel needs only Durable Objects and a small MCP surface, and avoiding the dependency keeps the code testable in Node. The SDK can be adopted later without changing the syscall model.

## Amendment — 2026-11-05: retirement of the crypto Signal Engine

**Status:** Owner-approved retirement, implemented through TP-018.

This amendment supersedes the active Signal Engine runtime and tier-2 re-ingestion behavior described in the original decision while preserving that text as the historical design record.

- The `cryptophys-signal-engine` service is retired and its registry status is disabled. The `signal-engine` agent is suspended.
- The `signals.reingest` capability is removed from the capability catalog and the supervisor grant. No active tier-2 syscall remains; the supervisor's `tier_max = 2` is retained only as a ceiling, not as an active grant.
- The supervisor no longer reads `signal_ingest_runs`, evaluates stale/failed crypto ingestion, or dispatches `SignalRpc.reingest`. Its active cycle is limited to platform drift observation and human-gated recovery proposals.
- `signals.observe` remains a read-only capability for XAUUSD advisory decisions supplied by the external `xauusd-ai-trading-assistant`; it is not a dependency on the retired crypto Signal Engine.
- Existing crypto market, candle, ingestion, indicator, and historical records are retained. TP-018 retires runtime code and bindings; it does not authorize deleting, rewriting, or migrating away historical crypto data.
- Any future reactivation of crypto signal processing, or introduction of a replacement ingestion capability, requires a new owner-approved architecture decision and independent security review.
- Validation, deployment order, Access provisioning, and drift inventory must be reconciled with the retired Worker before any subsequent production deployment. The retirement PR itself does not authorize a deployment.

The original sections describing `SignalRpc`, `signals.reingest`, and the Signal Engine's scheduled ingestion are historical and are superseded for current operation by this amendment.

## Amendment 2026-11-05: supervisor tier 1

Owner decision 2026-11-05: lower the supervisor to tier_max = 1. No agent currently has tier_max = 2. The explicit kernel-internal rule (agents hosted by cryptophys-ai-kernel cannot have external principals or AgentRpc callers) replaces the implicit tier shield. Raising any agent back to tier 2 requires a new owner decision and a tier-2 capability in the catalog.

## Amendment 2026-11-25: Beam for Cerebrum (the model router, AIR1)

**Status:** Owner-approved, 2026-11-25, relayed by the coordinator. On the shared Beam router design (AIR1 v2) the owner answered: "Approve, but Cerebrum only". The owner's earlier words that day: "ok jalankan rekomendasimu termasuk rencana penggunaan router agar menggunakan model external beam dari platform.reflection.ai seperti agent cta" (run the recommendation, including the plan for a router that uses the external Beam model of platform.reflection.ai, as the CTA agent does), and "tetap siapkan callback jika beam tidak bisa dijangkau atau menjadi berbayar atau lebih dari batasan" (keep a fallback ready for when Beam cannot be reached, becomes paid or goes over its limits). The fallback is Workers AI.

This amends section 3 and `AI-ENGINE-REQUIREMENT.md` ("No automatic paid upgrade, paid model fallback, or external AI provider fallback is permitted"), for one scope only.

- **What may use Beam.** Beam (Reflection, `Beam-1.0-501B-A23B`, OpenAI-compatible at `https://api.reflection.ai/openai/v1`) may answer Cerebrum's own AI tasks in the AI Kernel, and only these (R1): the chat (`chat_plan`, `chat_answer`, the ConversationAgent), directive drafts (`directive_draft`), and councils (`council_position`, `council_rebuttal`, `council_synthesis`, the CouncilAgent's seats and synthesis). Nothing else: not the evolver, which stays on `gpt-oss` on Workers AI (ADR-0014 Q2, 2026-11-13), not embeddings, not the agents' advisory drafts, not the Strategist (ADR-0016 leaves a model outside Workers AI to the owner's decision; this is that decision, for the tasks above only). Aether does not use Beam. Of xauusd's calls only one may, the news shadow comparison (meter source `shadow:news_compare`), through xauusd's own router copy; every other xauusd call stays on Workers AI ("xauusd's news_compare on Beam" below, owner 2026-11-25).
- **Workers AI is always the fallback.** The router sits inside `AiEngine.run` (`control-plane-shared/src/ai-engine.ts`, `control-plane-shared/src/model-router.ts`), so call sites do not change. For an allow-listed task it tries Beam first; every other case runs the task's current Workers AI model and path and returns that answer. A Beam answer goes through the same JSON extraction, finish_reason handling, validation and advisory-language check; one that fails them falls back.
  - *Unreachable:* a 25 s timeout, a network error, a 5xx, an empty or invalid answer, a JSON or schema mismatch. Three consecutive failures open a breaker: Beam is skipped for 15 minutes, then one half-open probe decides. An answer cut at its output limit (`finish_reason` `length`) falls back as `output_budget` (coordinator review, 2026-11-25): it is not a failure of Beam, does not count toward the breaker and frees a half-open probe. Beam's reasoning counts as output, so a Beam call asks for `max_completion_tokens` = twice the task's `maxOutputTokens`, at most 8,000 and never less than the task's own (`beamOutputTokens`); the Workers AI path keeps the task's limit.
  - *Over limits:* a 429 or a quota or rate error falls back at once and backs off until the reset. HTTP 429 is always a rate answer, whatever its body says (coordinator review, 2026-11-25: a free daily quota answers "daily limit exceeded ... upgrade your plan for higher limits", which is not a charge); only HTTP 402, or a billing text on another 4xx, is a paid sign. The back-off runs until the reset (Retry-After, rate-limit headers, a daily quota until 00:00 UTC). The router's own counters (D1 `model_router_counters`, conditional upserts) stop Beam before Cerebrum's share is reached: 10 requests a minute, 1,000,000 input and 150,000 output tokens a UTC day (configurable vars), and a request cap per day; after a daily stop, Workers AI until 00:00 UTC.
  - *Becomes paid:* the mode is `free_only` by default. Any paid sign (HTTP 402, a billing, credit or payment error, a non-zero cost in the answer, a plan that is not free when the provider exposes one) turns Beam off for every call (state `off_paid`) and reaches the owner once, through the owner channel (the production problem `model_router_stopped` in the `production_unhandled` notice, Telegram and the Owner page). It stays off until the owner turns it on again: with an explicit paid cap (`paid_capped`, at most 100 USD), which then also turns it off when the cap is reached (the spend is added and compared with the cap in one statement, `UPDATE ... RETURNING`, so calls that run at once cannot overshoot it), or, when the owner judges the sign was not a charge, as `free_only` with an explicit `confirm_free` set to true (coordinator review, 2026-11-25; the Console asks for the phrase `BEAM ON FREE`; audited as `model_router.state_changed` from `off_paid`). `free_only` without it is refused (409), and `free_only` goes off again at the next paid sign.
  - *Retention:* a `reflection-data-retention: contributor` answer is not used and turns Beam off (`off_retention`), as CTA does.
- **Off by default, three switches.** The var `MODEL_ROUTER` (`on` in `wrangler.toml` since 2026-11-26, the owner's decision: "pandu aktifkan beam", "buatkan togglenya di cerebrum > command"; it was `off` until then), the Worker secret `REFLECTION_API_KEY` (set by the owner only; not a required secret, so its absence is simply off) and the global state in D1 `model_router_state` (migration 0090, default `off`). With the var on, Beam stays off until the owner sets the secret and turns the state on, so the owner's switch is the toggle. Only the owner turns the state on or off (`POST /v1/model-router/state`, the Console's Cerebrum → Command page, the Beam toggle, and Organism → Telemetry tab); the router reads it at most once a minute and before its first Beam call.
- **Visibility.** Every call of an allow-listed task is metered in D1 `model_calls_daily` (day, system, purpose, provider, model, calls, tokens, latency, fallbacks by reason: unreachable, rate, budget, paid, retention, breaker, off, disabled, output_budget), Workers AI calls included. Never a prompt, an answer or the key. `GET /v1/model-router` shows the state and today's use to operators.
- **Shares of the Beam account (coordinator, 2026-11-25; xauusd's news_compare added the same day).** Each system's router stops itself at its own share:

  | System | Input/day | Output/day | RPM | Requests/day |
  |---|---|---|---|---|
  | Cerebrum | 1M | 150k | 10 | 500 |
  | xauusd news_compare | 100k | 20k | 2 | 20 |
  | CTA | 1M | 200k | 20 | — |
  | Total | about 2.1M | about 370k | 32 | |

  The organisation-wide guard stays at or below 9M input and 900k output tokens a day and 50 requests a minute (90% of the free allowance of 10M, 1M and 60). Output is the tight budget: Beam's reasoning counts as output, so xauusd sends `reasoning_effort` low and a hard per-call maximum of output tokens on every Beam call, as the kernel's router does.
- **Kernel capabilities.** `model_router.status` (tier 0, read only) and `model_router.report_paid` (tier 1, at most 4 an hour; records a paid sign, so Beam is `off_paid` and the owner hears of it once; idempotent; it can only turn Beam off). Only `XAUUSD_CEILING` grants them, to one xauusd agent, `xauusd-model-router` (`XAUUSD_MODEL_ROUTER_AGENT` in `control-plane-shared/src/organism.ts`), which holds them and nothing else; no other agent, ceiling or migration grants them, and CTA keeps the general ceiling.
- **Design for CTA (not built).** CTA keeps its own router (cryptophys-cta `src/agent/router.mjs`) and its own share. To stop together with Cerebrum, a later change would: name one cta agent (for example `cta-model-router`) in a CTA ceiling in `control-plane-shared/src/organism.ts` holding exactly `model_router.status` and `model_router.report_paid` (a ceiling change, the owner's); have cryptophys-cta's DNA declare it, so the census proposes the routine `register_agent`; and give cryptophys-cta a Service Binding to the kernel's `AgentRpc` entrypoint (section 1.1, host-pinned), over which its router reads `model_router.status` at most once a minute and calls `model_router.report_paid` on its own paid sign. Until then CTA reads nothing from the platform, and this amendment changes nothing in CTA.

### xauusd's news_compare on Beam (owner 2026-11-25)

**Status:** Owner-approved, 2026-11-25, relayed by the coordinator. The owner's answers, in order: (1) on the AIR1 v2 design, the shared Beam router: "Approve, but Cerebrum only"; (2) on whether xauusd's shadow callers may use Beam too: "semua shadow pakai beam" (every shadow caller uses Beam); (3) after xauusd found that most of its shadow callers feed live paths (the knowledge note arm goes live by itself, the benched agents' seats decide their re-entry into the live rooms, and the metric shadow's verdict would promote onto a live model): "news_compare saja" (news_compare only). The third answer is the one in force; it narrows the second.

- **What.** Exactly one xauusd caller may use Beam: the meter source `shadow:news_compare` (xauusd `src/news-shadow-compare.mjs`, once a UTC day, the comparison of TradingView's headlines with the free sources', read on its own page only).
- **Not.** Every other xauusd caller stays on Workers AI, every other `shadow:*` source included (the metric shadow, the benched agents' room openings, the model arena, the shadow-knowledge arm), and so do the live callers (the rooms and councils, the position, entry, profile, mode and strategy councils, the H1 and news reasoners, `plain_decision`). The evolver stays excluded (ADR-0014 Q2). Aether is untouched.
- **Fallback.** `free_only`, and Workers AI (the model news_compare uses today) is always the fallback, for the same reasons as the kernel's router (unreachable, rate, budget, paid, retention, breaker, off, output_budget).
- **How xauusd connects (design; built in xauusd, not here).** xauusd keeps its own router copy (`.mjs`, the contract of `control-plane-shared/src/model-router.ts`) inside its `runModel`, active only for the meter source `shadow:news_compare` and behind a new FS1 switch that defaults off. It meters every call in its own `ai_usage_daily` (model column `beam…` for a Beam answer), never a prompt or a key, and stops itself at its share (the table above). Its agent `xauusd-model-router` (`XAUUSD_MODEL_ROUTER_AGENT`), declared in xauusd's DNA and registered by the census's routine `register_agent` (no migration seeds it, as PF3's `shadow-knowledge`), reads the kernel's `model_router.status` (tier 0) at most once a minute and before its first Beam call, and calls `model_router.report_paid` (tier 1) on its own paid sign, through xauusd's existing kernel syscall path (AgentRpc, host-pinned to `xauusd-ai-trading-assistant`). The org-wide state covers xauusd too: xauusd's router calls Beam only while the kernel's state is `on` with mode `free_only` (not under `off`, `off_owner`, `off_paid` or `off_retention`, and not under `paid_capped`, whose spend only the kernel's router counts against the owner's cap), and a paid sign that xauusd reports turns Beam `off_paid` for Cerebrum as well, and the owner hears of it once.
- **Platform shadow callers: none.** No platform Worker (the AI Kernel included) makes a shadow or measurement-only model call: the platform's "shadow" is the consensus mode, the Forge's deploy plan and a council's strategy window, none of which calls a model. Nothing on the platform side is routed by this section.

