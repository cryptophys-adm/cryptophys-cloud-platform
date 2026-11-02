# Architecture Baseline — Cryptophys Cloud Platform

**Status:** Initial baseline, revision 1  
**Source of truth:** This repository  
**Runtime target:** Cloudflare-native; no Kubernetes, Talos, containers, or long-running Linux hosts.

## Non-negotiable rules

1. Git is authoritative for architecture, Worker source, deployment configuration, policies, and runbooks.
2. Never commit production secrets, API keys, tokens, private certificates, or unseal material. Use GitHub Environment secrets and Cloudflare secret bindings.
3. No production deployment on ordinary push or pull request. Production deployment is manual and uses a protected GitHub Environment.
4. No production custom domain, route, DNS change, or destructive infrastructure operation without an explicit reviewed change.
5. Do not share bindings with existing Cryptophys projects by default. Every binding/resource must be explicitly named and assigned to this platform.
6. Prefer Workers for stateless request handling; use D1 for relational state, KV for small key/value data, R2 for objects, Queues for asynchronous delivery, Durable Objects for coordination/stateful actors, and Workflows for durable multi-step processes only when required.
7. TypeScript is the initial control-plane language. Additional languages require an ADR and runtime compatibility validation.
8. Administrative endpoints require authentication and authorization before implementation. Initial API exposes health/readiness metadata only.
9. Material architecture changes require an ADR in architecture/adr/.
10. No guessed resource IDs, implicit account selection, or undocumented manual patches.

## Initial deployment unit

- Worker: `cryptophys-platform-api`
- Source: `workers/platform-api/src/index.ts`
- Config: `workers/platform-api/wrangler.toml`
- Deployment: GitHub Actions `workflow_dispatch`, requested through the authenticated Deployment Orchestrator, protected `production` environment.
- Public routes/custom domains: none for the Platform API (workers.dev only).
- Persistence bindings: none for the Platform API. Control-plane state is in D1 `cryptophys-control-plane` (see RESOURCE-OWNERSHIP.md and ADR-0004).

## Target logical control plane

- Platform Registry — desired inventory and ownership metadata.
- Deployment Orchestrator — explicit, auditable deployment requests.
- Policy Engine — validates deployment and security invariants.
- Drift Detector — compares desired configuration with observed Cloudflare state.
- Audit Ledger — append-only event records with retention and integrity requirements.
- Recovery Manager — documented recovery plans; no automatic destructive remediation by default.

All six are implemented and deployed as separate Workers (see `docs/CONTROL-PLANE-WORKERS.md` and ADR-0004). Extend them incrementally with contracts, tests, and explicit resource bindings.

## Promotion flow

1. Pull request: static validation and review.
2. Merge to `main`: source of truth advances; no production deployment.
3. Workflow dispatch (Platform API via the authenticated Orchestrator; Orchestrator and control plane by an operator): deploy only the selected Worker(s) to the protected production environment.
4. Verify health and record the commit SHA/deployment result.
5. Rollback uses a reviewed commit or deployment version; no blind overwrite.

## Explicitly out of scope

- Broker connectivity or trade execution.
- Importing credentials or bindings from existing trading/news Workers.
- Automatic DNS/domain changes.
- Automatic resource creation/deletion based on unreviewed changes.
- Claiming complete reconciliation/drift detection before those functions exist.
