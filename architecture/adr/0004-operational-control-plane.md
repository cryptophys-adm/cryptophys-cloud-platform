# ADR-0004: Operational control-plane services

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** the "scaffold only" status in `docs/CONTROL-PLANE-WORKERS.md`

## Context

The five control-plane Workers (Platform Registry, Policy Engine, Drift Detector, Audit Ledger, Recovery Manager) were scaffolds returning HTTP 501. The D1 database `cryptophys-control-plane` already held the `0001` schema with zero rows and no Wrangler migration ledger. ADR-0003 defined the service-scoped integrity correction (`0002`).

## Decision

1. **Persistence.** All five services, plus nothing else, bind the single D1 database `cryptophys-control-plane` as `DB`. The schema is owned by `workers/control-plane-migrations/` and is applied only by `.github/workflows/deploy-control-plane.yml` with `wrangler d1 migrations apply --remote`. `0001` is idempotent (`IF NOT EXISTS`), so applying it to the live database records the ledger without changing the existing schema. `0003` adds AI budgets, append-only triggers and a fork guard for the audit chain, the recovery plan author, and the inventory seed.
2. **Account identifiers stay out of Git (ADR-0001).** `wrangler.toml` carries the placeholder `__CONTROL_PLANE_D1_DATABASE_ID__`; the deploy job resolves the ID from the Cloudflare API by exact database name, requires exactly one match, masks it, and renders `wrangler.deploy.toml` on the runner only.
3. **Recovery point.** Every deploy records a D1 Time Travel bookmark before migrating and writes it to the job summary.
4. **Authentication.** Every `/v1` endpoint requires `Authorization: Bearer <ADMIN_TOKEN>` (constant-time comparison; 503 when unset). Recovery plan approval requires a separate `APPROVER_TOKEN`, and the approver identity must differ from the plan author. Both secrets come from the GitHub `production` Environment (`CONTROL_PLANE_ADMIN_TOKEN`, `CONTROL_PLANE_APPROVER_TOKEN`) and are uploaded atomically with each version via `wrangler deploy --secrets-file`; they are never written to Git or printed.
5. **Exposure.** The services are reachable on workers.dev so the deploy job can verify them live, consistent with the Platform API. No custom domain or route is added (BASELINE rule 4). Unauthenticated callers can reach only `/`, `/health` and `/ready`, which expose no data.
6. **Audit integrity.** `audit_events` is a SHA-256 hash chain over canonical JSON. A UNIQUE index on `previous_hash` makes concurrent writers retry instead of forking; triggers reject UPDATE and DELETE. `GET /v1/verify` recomputes the whole chain. Secret-shaped keys and token values are redacted before persistence.
7. **Policy.** Decisions are deterministic code in the Policy Engine and are persisted with their evidence. The Recovery Manager cannot start an execution without an `allow` decision obtained from the Policy Engine over a service binding. Recovery steps are executed by an operator and recorded (start/finish); no automatic destructive remediation exists (BASELINE).
8. **Drift.** The Drift Detector reads each Worker's live version tag from `/health` (`version_metadata` binding) over service bindings, compares it with `service_registry.desired_version` (set by the deploy workflow), writes `drift_observations`, updates observed state, and appends an audit event. It runs every 15 minutes and on demand.
9. **AI engines.** Each of the five Workers has its own `AI` binding, task allow-list and validators (`control-plane-shared/src/ai-engine.ts` is a library, not a runtime service). Default model `@cf/meta/llama-3.1-8b-instruct-fast` (listed by Cloudflare as remaining active). Budget: 80 requests per service and 400 across the account per UTC day, enforced in D1 before inference. Outcomes are `ok`, `unavailable` or `invalid_output`; AI output is returned only as `advisory` and never changes a decision, record or state transition. AI is opt-in per request (`?advisory=true`) so routine traffic consumes no quota.

## Consequences

- The control plane is operational and its correctness is covered by endpoint tests that run against the real migrations, plus a dry-run bundle of every Worker in CI.
- A single shared admin credential identifies operators only by the `actor` they declare; per-operator identity (e.g. Cloudflare Access) is a follow-up.
- The Deployment Orchestrator's own AI engine is not part of this change; the orchestrator remains deterministic.
- The deploy token needs `D1:Edit` in addition to `Workers Scripts:Edit` for migrations and Time Travel.

## Alternatives considered

- One D1 database per service: rejected for now; ADR-0003's shared schema with foreign keys to `service_registry` is the reviewed model and all tables were empty.
- Observing versions through the Cloudflare API from the Drift Detector: rejected because it would put a Cloudflare API token inside a runtime Worker.
- Committing the D1 database ID: rejected by ADR-0001.
