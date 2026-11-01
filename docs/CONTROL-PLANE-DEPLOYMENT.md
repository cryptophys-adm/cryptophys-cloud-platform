# Control Plane Deployment Gate

## Scope

The six control-plane Workers are:
- cryptophys-platform-registry
- cryptophys-deployment-orchestrator
- cryptophys-policy-engine
- cryptophys-drift-detector
- cryptophys-audit-ledger
- cryptophys-recovery-manager

These are planned service boundaries, not production-ready services.

## Persistent state and current status

The Cloudflare account contains a D1 database named `cryptophys-control-plane`. A read-only inspection during the PR audit found the seven application tables and expected indexes from `0001_initial.sql`; all seven application tables had zero rows at that inspection. This is point-in-time evidence, not permission to use the database.

Schema files:
- `workers/control-plane-migrations/0001_initial.sql` — already reflected in the observed live schema; do not edit in place.
- `workers/control-plane-migrations/0002_service_referential_integrity.sql` — forward-only correction; not applied by CI or by this PR.

The resource ownership register still requires maintainer review. Do not bind Workers to this D1 database or write production data until the resource owner, environment, data classification, lifecycle/retention, backup, and recovery plan are reviewed and recorded. Keep the account-specific database ID outside Git as required by ADR-0001.

## Migration controls

1. Run `python3 workers/control-plane-migrations/test_migrations.py` to test both migrations against an isolated in-memory SQLite database.
2. Before any remote migration, use read-only inspection to verify the exact account/database, applied migration history, schema, row counts, and orphan-reference counts.
3. Capture and verify a recoverable backup before applying a forward migration.
4. Apply only through a separately reviewed, manually authorized migration procedure. Never apply remote migrations from pull-request CI.
5. If the forward migration encounters orphan references, stop and reconcile them explicitly. Do not delete or rewrite rows to force success.
6. Bind the D1 database only after the resource ownership record and ADR-0003 are accepted.

## Production readiness gates

Before a Worker is marked production-ready:
1. Bind only the reviewed D1 resource using the exact account-specific ID held outside Git.
2. Configure a per-service authentication secret; never put tokens in vars or source.
3. Enforce authentication for every mutation endpoint and use least-privilege service credentials.
4. Add input validation, idempotency, and audit events for every privileged mutation.
5. Type-check and run endpoint tests, including unauthenticated requests, malformed input, persistence round trips, and failure paths.
6. Deploy through the reviewed production workflow; verify active version and live health/readiness.
7. Do not enable orchestration or recovery mutations until policy checks and explicit approval gates are verified.

## Safety invariant

Health is not readiness. A Worker with missing D1 bindings, missing secrets, or unapplied schema must return `503` from readiness and must not claim operational status. No destructive or automatic recovery action may run without authenticated authorization, an approved policy decision, and a durable audit record.
