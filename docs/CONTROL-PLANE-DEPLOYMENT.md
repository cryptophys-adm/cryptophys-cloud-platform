# Control Plane Deployment Gate

## Scope
The six control-plane Workers are:
- cryptophys-platform-registry
- cryptophys-deployment-orchestrator
- cryptophys-policy-engine
- cryptophys-drift-detector
- cryptophys-audit-ledger
- cryptophys-recovery-manager

## Persistent state
The shared D1 database is `cryptophys-control-plane`. Schema source of truth:
`workers/control-plane-migrations/0001_initial.sql`.

Before a Worker is marked production-ready:
1. Apply the migration and verify all tables/indexes exist.
2. Bind the D1 database using the exact database ID from the Cloudflare account.
3. Configure a per-service authentication secret; never put tokens in vars or source.
4. Enforce authentication for every mutation endpoint and use least-privilege service credentials.
5. Add input validation, idempotency, and audit events for every privileged mutation.
6. Type-check and run endpoint tests, including unauthenticated requests, malformed input, persistence round trips, and failure paths.
7. Deploy through the reviewed production workflow; verify active version and live health/readiness.
8. Do not enable orchestration or recovery mutations until policy checks and explicit approval gates are verified.

## Safety invariant
Health is not readiness. A Worker with missing D1 bindings, missing secrets, or unapplied schema must return `503` from readiness and must not claim operational status. No destructive or automatic recovery action may run without authenticated authorization, an approved policy decision, and a durable audit record.
