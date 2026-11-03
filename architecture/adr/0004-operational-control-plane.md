# ADR-0004: Operational control-plane services

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deploy order:** Provision Cloudflare Access → Deploy Control Plane (applies migrations) → Deploy Production Deployment Orchestrator → Request Platform API Deployment.
- **Supersedes:** the "scaffold only" status in `docs/CONTROL-PLANE-WORKERS.md`. ADR-0001's no-public-route consequence is kept: every hostname is behind Cloudflare Access (decision 5).

## Context

The five control-plane Workers (Platform Registry, Policy Engine, Drift Detector, Audit Ledger, Recovery Manager) were scaffolds returning HTTP 501. The D1 database `cryptophys-control-plane` already held the `0001` schema with zero rows and no Wrangler migration ledger. ADR-0003 defined the service-scoped integrity correction (`0002`).

## Decision

1. **Persistence.** All five services and the Deployment Orchestrator bind the single D1 database `cryptophys-control-plane` as `DB`. The schema is owned by `workers/control-plane-migrations/` and is applied only by `.github/workflows/deploy-control-plane.yml` with `wrangler d1 migrations apply --remote`. `0001` is idempotent (`IF NOT EXISTS`), so applying it to the live database records the ledger without changing the existing schema. `0003` adds AI budgets, append-only triggers and a fork guard for the audit chain, the recovery plan author, and the inventory seed.
2. **Account identifiers stay out of Git (ADR-0001).** `wrangler.toml` carries the placeholder `__CONTROL_PLANE_D1_DATABASE_ID__`; the deploy job resolves the ID from the Cloudflare API by exact database name, requires exactly one match, masks it, and renders `wrangler.deploy.toml` on the runner only.
3. **Recovery point.** Every deploy records a D1 Time Travel bookmark before migrating and writes it to the job summary.
4. **Authentication.** *(Amended 2026-11-03.)* Every `/v1` endpoint requires a verified Cloudflare Access identity listed in `OPERATOR_IDENTITIES` (the CI service token's Client ID plus `ACCESS_ALLOWED_EMAILS`); 503 when the list is unset, 403 otherwise. Recovery plan approval requires an identity in `APPROVER_IDENTITIES` (people only), and the approver must differ from the plan author, compared on verified identities. The verified identity is the recorded actor; self-declared actor fields are ignored. The former shared `ADMIN_TOKEN`/`APPROVER_TOKEN` are removed from the Workers: a shared bearer token named nobody and let any holder claim any actor.
5. **Exposure: every Worker behind Cloudflare Access (owner decision, 2026-11-03).** A public `workers.dev` endpoint was rejected. One self-hosted Access application, `cryptophys-cloud-platform`, has a `worker` destination for each of the seven Workers, so their workers.dev URLs, preview URLs and the orchestrator custom domain are all covered. It has exactly two policies: Service Auth for the CI service token, and Allow for the operator emails in `ACCESS_ALLOWED_EMAILS`. It is created and converged only by `.github/workflows/provision-access.yml`.
   - **Defence in depth:** every Worker also verifies the `Cf-Access-Jwt-Assertion` JWT itself (RS256 against the team's published keys, plus AUD, issuer and expiry), before any route including `/health`. If the edge policy is misconfigured or bypassed, requests still fail closed. Without `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`, a Worker answers 503.
   - **Internal calls (amended 2026-11-03):** Worker-to-Worker calls use RPC service bindings to named `WorkerEntrypoint` classes (`HealthRpc` on every Worker, `PolicyRpc` on the Policy Engine). RPC methods are not reachable over HTTP, so the HTTP gate has no exception at all and internal hops carry no bearer token. This replaced an earlier `.internal`-hostname exception.
   - **CI:** deploy jobs resolve the team domain and AUD at deploy time (`resolve-access.sh`), refuse to deploy unless the Access application protects the target Worker, and pass both as `--var`. They then prove protection live: an unauthenticated `/health` must be rejected by Access (302/401/403), and the service token must reach the Worker.
   - **Scope:** ADR-0001's "no public route" consequence is therefore retained: nothing is reachable without an Access identity. Custom domains and routes remain governed by BASELINE rule 4.
6. **Audit integrity.** `audit_events` is a SHA-256 hash chain over canonical JSON. A UNIQUE index on `previous_hash` makes concurrent writers retry instead of forking; triggers reject UPDATE and DELETE. `GET /v1/verify` recomputes the whole chain. Secret-shaped keys and token values are redacted before persistence.
7. **Policy.** Decisions are deterministic code in the Policy Engine and are persisted with their evidence. The Recovery Manager cannot start an execution without an `allow` decision obtained from the Policy Engine over a service binding. Recovery steps are executed by an operator and recorded (start/finish); no automatic destructive remediation exists (BASELINE).
8. **Drift.** The Drift Detector reads each Worker's live version tag via `HealthRpc.health()` (`version_metadata` binding) over RPC service bindings, compares it with `service_registry.desired_version` (set by the deploy workflow), writes `drift_observations`, updates observed state, and appends an audit event. It runs every 15 minutes and on demand.
9. **AI engines.** Each of the six control-plane Workers has its own `AI` binding, task allow-list and validators (`control-plane-shared/src/ai-engine.ts` is a library, not a runtime service). Default model `@cf/meta/llama-3.1-8b-instruct-fast` (listed by Cloudflare as remaining active). Budget: 80 requests per service and 400 across the account per UTC day, enforced in D1 before inference. Outcomes are `ok`, `unavailable` or `invalid_output`; AI output is returned only as `advisory` and never changes a decision, record or state transition. AI is opt-in per request (`?advisory=true`) so routine traffic consumes no quota.

10. **Deployment authorization by identity (amended 2026-11-03).** `POST /v1/deployments` on the Orchestrator is authorized by the caller's verified Cloudflare Access identity, which must be on `DEPLOY_ALLOWED_IDENTITIES` (the CI service token's Client ID and the operator emails, set by the deploy workflow). The recorded `requested_by` is that identity, not a claim from the request body. The former `ORCHESTRATOR_SHARED_SECRET` is retired: an external caller (a GitHub Actions runner) cannot use RPC, but it already authenticates to Access, so a second shared credential added rotation burden without adding an independent factor.

## Consequences

- The control plane is operational and its correctness is covered by endpoint tests that run against the real migrations, plus a dry-run bundle of every Worker in CI.
- Operators and the CI service token authenticate through Cloudflare Access. Each Worker verifies the Access JWT and authorizes the verified identity against `OPERATOR_IDENTITIES` (or `APPROVER_IDENTITIES` for recovery-plan approval). Audit actors come from the verified identity; client-supplied actor fields are ignored. No shared admin or approver bearer token is used by `/v1`.
- The Deployment Orchestrator records every accepted request in `deployment_requests` (whose `(service_id, idempotency_key)` uniqueness backs up its Durable Object lock), audits dispatches and rejections, and has its own advisory AI engine. Its deploy therefore requires migration `0003`, so Deploy Control Plane runs first.
- The deploy token needs `D1:Edit` in addition to `Workers Scripts:Edit` for migrations and Time Travel.

## Alternatives considered

- One D1 database per service: rejected for now; ADR-0003's shared schema with foreign keys to `service_registry` is the reviewed model and all tables were empty.
- Observing versions through the Cloudflare API from the Drift Detector: rejected because it would put a Cloudflare API token inside a runtime Worker.
- Committing the D1 database ID: rejected by ADR-0001.
