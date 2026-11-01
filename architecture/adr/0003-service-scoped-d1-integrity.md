# ADR-0003: Service-scoped D1 integrity and idempotency

- **Status:** Proposed — requires maintainer review before production use
- **Date:** 2026-11-02

## Context

The initial D1 schema was applied before the resource ownership register was updated. A read-only inspection found the seven application tables and their indexes, with no application rows at inspection time. The initial schema has no foreign-key constraints for service-scoped records, and it uses globally unique idempotency keys even though requests and records carry a `service_id`.

The existing `0001_initial.sql` must remain immutable because it has been applied to the live database. Its comment claiming all records are tenant/service scoped is not an implemented tenant-isolation guarantee; this proposed ADR and the deployment documentation explicitly define the initial contract as single-tenant. The read-only inspection did not find a `d1_migrations` table, so the live schema's Wrangler migration history is not reconciled with repository migration files.

## Proposed decision

1. Treat the initial control plane as single-tenant. Do not imply tenant isolation or add a `tenant_id` contract without a separate reviewed ADR.
2. Require `deployment_requests.service_id`, `drift_observations.service_id`, `recovery_plans.service_id`, and `idempotency_records.service_id` to reference `service_registry.service_id`.
3. Scope idempotency uniqueness to a service: `(service_id, idempotency_key)` in both deployment requests and idempotency records.
4. Implement the schema correction as a forward migration. Never rewrite `0001_initial.sql` in place. If existing rows violate the new references, fail the migration and require explicit reconciliation; do not delete or silently repair rows.
5. Test migrations only against an isolated SQLite database in CI. CI must not bind to or mutate the remote D1 database.

## Consequences

- Orphan service references are rejected by the database after the forward migration is applied.
- Different services can independently use the same idempotency key; a single service cannot reuse its key.
- The live database must be reconciled before applying the forward migration. This ADR does not authorize remote migration, Worker binding, production deployment, or production data writes.
- The D1 resource remains unapproved for Worker use until ownership, environment, data classification, lifecycle, backup, and recovery requirements are recorded in `architecture/RESOURCE-OWNERSHIP.md`.

## Alternatives considered

- Keep global idempotency uniqueness: rejected as it couples independent service namespaces without a documented platform-wide key contract.
- Omit foreign keys and rely on application checks: rejected because the service implementations do not yet exist and database integrity should not depend on future handler correctness.
- Edit the applied initial migration: rejected because it would make Git history disagree with the live migration history.
