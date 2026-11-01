# Architecture Decision: One AI Engine per Control Plane Worker

Status: **Accepted architectural requirement; implementation pending review**

Date: 2026-11-01

## Decision

**One Control Plane Worker = one dedicated AI Engine instance within that Worker.** There must not be a shared AI Engine Worker serving all capabilities.

Each of the six capability Workers owns its own AI inference adapter, task policy, model allow-list, input/output schemas, prompt construction, output validation, quota/error handling, and observability. Each instance uses the native Cloudflare Workers AI binding (env.AI) and only models verified as available under the Cloudflare Workers Free plan.

This means six independently governed AI Engines:
1. cryptophys-platform-registry — Registry AI Engine
2. cryptophys-deployment-orchestrator — Deployment Orchestrator AI Engine
3. cryptophys-policy-engine — Policy AI Engine
4. cryptophys-drift-detector — Drift AI Engine
5. cryptophys-audit-ledger — Audit AI Engine
6. cryptophys-recovery-manager — Recovery AI Engine

The engine logic may use a common source-code library for safe shared mechanics, but each Worker must instantiate and configure its own engine locally. A shared library is not a shared runtime service. No central AI Engine Worker is part of this architecture.

The six current Workers are scaffolds and do not yet contain functioning AI Engine implementations. This decision is not considered implemented until each Worker has its own binding, task/model policy, validation, tests, and usage/error telemetry.

## Free-tier constraints

- Cloudflare Workers AI Free allocation is account-wide (currently documented as 10,000 Neurons per day), not six independent allocations. Six engines do not multiply the account's free quota.
- Confirm the current allocation and model availability against Cloudflare's official plan/pricing documentation and the actual account before deployment.
- Each engine must have its own per-Worker request/token limits and budget guardrails, while respecting a coordinated account-wide budget policy to avoid one engine consuming the entire daily allocation.
- No automatic paid upgrade, paid model fallback, or external AI provider fallback is permitted.
- When the account quota is exhausted, a model fails, or a request times out, the engine must return a typed unavailable result and follow that capability's safe deterministic behavior.
- Apply input/output size bounds, timeouts, request limits, safe caching/deduplication where suitable, and usage telemetry.
- Model output is untrusted and must be schema-validated; it must never be treated as executable instructions.

## Per-Worker AI responsibilities

| Worker / dedicated AI Engine | Permitted AI-assisted responsibility | Must remain deterministic / non-AI authoritative |
|---|---|---|
| Platform Registry AI | Classify metadata, normalize descriptions, suggest tags, summarize inventory | Resource identity, ownership, canonical desired state, access checks, and writes |
| Deployment Orchestrator AI | Summarize requests, explain dependency order, assess risk from supplied evidence | Authorization, approval gates, idempotency, execution, rollback trigger, and final state |
| Policy Engine AI | Explain policy results and summarize evidence for operators | Policy rules and allow/deny decisions; AI must never approve or override a denied request |
| Drift Detector AI | Summarize known diffs, cluster similar drift, explain possible impact | Observed-state retrieval, diff computation, severity thresholds, and whether drift exists |
| Audit Ledger AI | Categorize labels and create optional human-readable summaries of committed facts | Canonical facts, append-only persistence, sequence/order, integrity hashes, retention, and access controls |
| Recovery Manager AI | Draft recovery options and explain blast radius from verified evidence | Eligibility, policy validation, human approval, execution, and post-action verification |

## Required implementation for each engine

Each Worker must:
- declare its own AI binding in its Wrangler configuration;
- own an allow-list of model IDs and task types appropriate to its capability;
- expose no public endpoint solely for inference; AI inference is an internal implementation detail of that Worker;
- validate input/output with explicit schemas and redact secrets before inference;
- include correlation IDs, timeout, request limits, usage/error telemetry, and quota-exhaustion behavior;
- return structured ok, unavailable, or invalid_output outcomes;
- never persist prompts/outputs by default unless an approved retention policy requires it;
- keep AI advisory and separate from authoritative state transitions.

## Security and failure behavior

- No engine may possess more permissions than its owning Worker needs.
- AI output may not directly change Cloudflare resources, mutate canonical registry state, write canonical audit facts, approve policy, authorize deployments, or execute recovery.
- Policy decisions, security invariants, audit integrity, authorization, and recovery execution must remain deterministic and explicitly controlled.
- AI outage or quota exhaustion must fail closed for security-sensitive actions. A deterministic non-AI path may continue only where the capability contract explicitly permits it.
- No paid usage or billing change without explicit architecture approval.

## Delivery gates

1. Implement an independent AI Engine inside each of the six Workers using env.AI.
2. Define per-Worker model/task allow-lists, schemas, limits, and safe failure behavior.
3. Add tests for invalid model output, quota exhaustion, timeouts, and attempts to override authoritative decisions.
4. Validate model availability and free-tier limits against current official Cloudflare documentation and the account.
5. Pass CI and security review. Production deployment remains subject to manual approval.

## Non-goals

This decision does not authorize production deployment, create Cloudflare resources, set secrets, enable public routes, or permit paid AI usage.
