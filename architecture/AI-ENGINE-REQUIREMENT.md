# Architecture Decision: Shared AI Engine for Control Plane Workers

Status: **Accepted architectural requirement; implementation pending review**

Date: 2026-11-01

## Decision

Every Control Plane capability must use a single shared **Cryptophys AI Engine Worker** for AI-assisted tasks. The AI Engine must run inference through Cloudflare **Workers AI** using the native `env.AI` binding and models available under the Cloudflare Workers Free plan. Each capability calls the AI Engine through an authenticated internal service binding; capabilities must not independently select arbitrary models or call external AI providers.

This repository does not currently contain an implemented AI Engine Worker. Do not claim this requirement is implemented or production-ready until the engine, service bindings, authentication, tests, and deployment are completed.

## Free-tier constraints

- Workers AI currently provides a shared account allocation of **10,000 Neurons per day** on Workers Free; usage is account-wide, not a separate free allocation per Worker.
- Requests beyond the free allocation fail on Workers Free rather than silently upgrading to paid service.
- Model availability and rate limits vary by model and can change. The engine must use only models explicitly confirmed as available on the account's Free plan.
- Apply bounded input/output tokens, per-capability rate limits, timeouts, request deduplication/caching where safe, and per-day budget guardrails.
- On quota exhaustion, model errors, or timeout, return a typed unavailable result. Never silently route to a paid model or external provider.
- AI responses are advisory and untrusted input. Validate output against strict schemas and never treat generated text as executable instructions.

## Capability-specific AI responsibilities

| Control Plane capability | Permitted AI-assisted responsibility | Must remain deterministic / non-AI authoritative |
|---|---|---|
| Platform Registry | Classify resource metadata, normalize descriptions, suggest tags, summarize inventory | Resource identity, ownership, canonical desired state, access checks, and writes |
| Deployment Orchestrator | Summarize a deployment request, explain dependency order, produce a risk summary from supplied evidence | Authorization, approval gates, idempotency, execution, rollback trigger, and final deployment state |
| Policy Engine | Explain a policy result and summarize relevant evidence for operators | Policy rules, allow/deny decision, security invariants; AI must never approve or override a denied request |
| Drift Detector | Summarize known desired-vs-observed diffs, cluster similar drift, explain likely impact | Fetching observed state, computing diffs, severity thresholds, and whether drift exists |
| Audit Ledger | Categorize event labels and generate optional human-readable summaries from committed audit facts | Canonical event facts, append-only persistence, sequence/order, integrity hashes, retention, and access controls; AI must never author or rewrite audit evidence |
| Recovery Manager | Draft recovery options and explain blast radius from verified evidence | Recovery eligibility, policy validation, human approval, execution, and post-action verification; no autonomous destructive remediation |

## Required internal API contract

The shared AI Engine must expose a versioned internal contract with:
- authenticated caller identity and capability name;
- allow-listed task type and model selected by server-side policy;
- input schema, maximum payload size, and explicit output schema;
- correlation/request ID, timeout, rate limit, and budget accounting;
- structured result: `ok`, `unavailable`, or `invalid_output`, with model metadata and usage where provided;
- redaction of secrets and sensitive configuration before inference;
- no storage of prompts or outputs by default, unless an explicitly reviewed retention policy requires it;
- health and readiness endpoints that reflect model binding and configuration state.

## Security and failure behavior

- The AI Engine is not an authority boundary and must not possess deployment credentials or direct write access to Control Plane state.
- Internal service bindings must be private; no public route is to be enabled merely for inter-Worker communication.
- Every caller validates the returned schema and treats the result as untrusted.
- AI outage/quota exhaustion must fail closed for security-sensitive actions. Deterministic read-only functions may continue without AI when their contract permits it.
- No AI output may directly invoke tools, change Cloudflare resources, mutate registry state, write canonical audit facts, approve policy, or execute recovery.
- No paid model, external provider, or automatic billing change is permitted without explicit architecture approval.

## Delivery gates

Before the requirement is considered implemented:
1. Add `cryptophys-ai-engine` source, Wrangler configuration, model allow-list, input/output schemas, and tests.
2. Add authenticated internal service bindings from all six capability Workers.
3. Add per-capability task policies and deterministic fallback behavior.
4. Add tests for malformed model output, quota exhaustion, timeouts, unauthorized callers, and attempts to override policy.
5. Validate the exact model and free-tier availability against current Cloudflare account settings.
6. Pass CI and security review. Deployment remains subject to the repository's manual production approval process.

## Non-goals

This decision does not authorize production deployment, create Cloudflare resources, set secrets, enable public routes, or permit paid AI usage.
