# Control Plane Workers

Six separately deployed TypeScript Workers implement the logical control plane from `architecture/BASELINE.md`. Design decisions: [ADR-0003](../architecture/adr/0003-service-scoped-d1-integrity.md), [ADR-0004](../architecture/adr/0004-operational-control-plane.md). Deployment: [CONTROL-PLANE-DEPLOYMENT.md](CONTROL-PLANE-DEPLOYMENT.md).

| Worker | Capability | Status | Endpoints (all `/v1` need `Authorization: Bearer <ADMIN_TOKEN>`) |
|---|---|---|---|
| `cryptophys-platform-api` | Public API | Operational | `GET /health`, `/ready`, `/` |
| `cryptophys-deployment-orchestrator` | Authenticated, CI-gated deployment dispatch | Operational | `POST /v1/deployments` (shared secret) |
| `cryptophys-platform-registry` | Desired inventory and ownership | Operational | `GET /v1/services`, `GET/PUT /v1/services/{id}`, `PUT /v1/services/{id}/desired-version` |
| `cryptophys-policy-engine` | Deterministic policy decisions | Operational | `POST /v1/evaluate`, `GET /v1/decisions[/{id}]` |
| `cryptophys-drift-detector` | Desired-vs-observed version and health | Operational, cron every 15 min | `POST /v1/observe`, `GET /v1/drift[/{service_id}]` |
| `cryptophys-audit-ledger` | Append-only hash-chained audit log | Operational | `POST /v1/events`, `GET /v1/events[/{id}]`, `GET /v1/verify` |
| `cryptophys-recovery-manager` | Recovery plans, approval, recorded execution | Operational | `POST/GET /v1/plans`, `GET /v1/plans/{id}`, `POST /v1/plans/{id}/approve` (approver token), `/executions`, `/disable` |

All five services expose `GET /health` (includes the live `version.tag` = deployed commit), `GET /ready` (503 unless schema migrated, secrets configured, AI and service bindings present) and `GET /` (metadata).

## Behaviour guarantees

- **Registry** rejects services without `owner`, `purpose` and `data_classification` metadata; every change is audited.
- **Policy Engine** actions: `deploy` (registered, enabled, production, valid SHA, `DEPLOY` confirmation, CI green), `recovery.execute` (plan approved, approver ≠ author, operator acknowledgement), `registry.update` (ownership metadata). Unknown actions are denied. Every decision is stored with evidence and audited.
- **Audit Ledger** chains each event to its predecessor with SHA-256; UPDATE/DELETE are rejected by triggers; `GET /v1/verify` recomputes the chain.
- **Recovery Manager** requires the separate approver credential to approve, refuses self-approval, and starts an execution only after an `allow` from the Policy Engine. Execution is performed by an operator and recorded; nothing is executed automatically.
- **Drift Detector** observes Workers through service bindings, not public URLs, and records each run in D1 and the audit log.

## AI engines

Each of the five service Workers runs its own engine (`env.AI`, own task allow-list and output validators) per [AI-ENGINE-REQUIREMENT.md](../architecture/AI-ENGINE-REQUIREMENT.md). AI is opt-in per request with `?advisory=true`, returns `ok | unavailable | invalid_output`, is budgeted in D1, and never changes a decision or stored fact. The Deployment Orchestrator remains deterministic without an AI engine; adding one is a tracked follow-up.

## Tests

`workers/control-plane-shared/test` runs every service against an in-memory SQLite database built from the real migrations: authentication failures, malformed input, persistence round trips, policy denials (including attempts by AI output to override them), separation of duties, concurrent audit appends, chain tamper detection, drift classification, AI budget/timeout/schema failures, and readiness. CI also dry-run bundles every Worker.
