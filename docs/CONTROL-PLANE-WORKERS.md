# Control Plane Workers

Six separately deployed TypeScript Workers implement the logical control plane from `architecture/BASELINE.md`. Design decisions: [ADR-0003](../architecture/adr/0003-service-scoped-d1-integrity.md), [ADR-0004](../architecture/adr/0004-operational-control-plane.md). Deployment: [CONTROL-PLANE-DEPLOYMENT.md](CONTROL-PLANE-DEPLOYMENT.md).

| Worker | Capability | Status | Endpoints (all `/v1` need an Access identity in `OPERATOR_IDENTITIES`) |
|---|---|---|---|
| `cryptophys-platform-api` | AI Worker OS gateway with its own AI engine | Operational | `GET /health`, `/ready`, `/`, `GET /v1/overview[?advisory=true]` |
| `cryptophys-deployment-orchestrator` | Authenticated, CI-gated deployment dispatch, ledgered in `deployment_requests` and audited | Operational | `POST /v1/deployments` (Access identity on `DEPLOY_ALLOWED_IDENTITIES`; `?advisory=true` adds an AI risk summary) |
| `cryptophys-platform-registry` | Desired inventory and ownership | Operational | `GET /v1/services`, `GET/PUT /v1/services/{id}`, `PUT /v1/services/{id}/desired-version` |
| `cryptophys-policy-engine` | Deterministic policy decisions | Operational | `POST /v1/evaluate`, `GET /v1/decisions[/{id}]` |
| `cryptophys-drift-detector` | Desired-vs-observed version and health | Operational, cron every 15 min | `POST /v1/observe`, `GET /v1/drift[/{service_id}]` |
| `cryptophys-audit-ledger` | Append-only hash-chained audit log | Operational | `POST /v1/events`, `GET /v1/events[/{id}]`, `GET /v1/verify` |
| `cryptophys-recovery-manager` | Recovery plans, approval, recorded execution | Operational | `POST/GET /v1/plans`, `GET /v1/plans/{id}`, `POST /v1/plans/{id}/approve` (`APPROVER_IDENTITIES`), `/executions`, `/disable` |
| `cryptophys-signal-engine` | Deterministic indicators from public market data (ADR-0005; advisory only). The cron every 15 min starts a `SignalIngestWorkflow` instance with one retried step per series (ADR-0006) | Operational | `GET /v1/signals?symbol=&timeframe=`, `GET /v1/signals/history`, `GET /v1/status`, `POST /v1/ingest` |
| `cryptophys-ai-kernel` | AI Worker OS kernel (ADR-0007): agent processes (Durable Objects), policy-gated syscalls by tier, MCP front door | Operational, supervisor cycle every 15 min | `POST /mcp`, `GET /v1/kernel`, `GET /v1/status`, `GET /v1/agents[/{id}[/actions]]`, `POST /v1/agents/{id}/wake\|suspend\|resume` (resume: `APPROVER_IDENTITIES`), `POST /v1/kernel/agents-enabled` |

Every Worker sits behind Cloudflare Access and also verifies the Access JWT itself before any route; there is no exception. Worker-to-Worker calls use RPC service bindings (`WorkerEntrypoint`): every Worker exports `HealthRpc.health()`, and the Policy Engine exports `PolicyRpc.evaluate()`. These are not reachable over HTTP. All five services expose `GET /health` (includes the live `version.tag` = deployed commit), `GET /ready` (503 unless schema migrated, secrets and Access configured, AI and service bindings present) and `GET /` (metadata).

## Behaviour guarantees

- **Registry** rejects services without `owner`, `purpose` and `data_classification` metadata; every change is audited.
- **Policy Engine** actions: `deploy` (registered, enabled, production, valid SHA, `DEPLOY` confirmation, CI green), `recovery.execute` (plan approved, approver ≠ author, operator acknowledgement), `registry.update` (ownership metadata). Unknown actions are denied. Every decision is stored with evidence and audited.
- **Audit Ledger** chains each event to its predecessor with SHA-256; UPDATE/DELETE are rejected by triggers; `GET /v1/verify` recomputes the chain.
- **Recovery Manager** requires an identity in `APPROVER_IDENTITIES` (people, never the CI token) to approve, refuses approval by the verified author, and starts an execution only after an `allow` from the Policy Engine. Execution is performed by an operator and recorded; nothing is executed automatically. Each plan has a lifecycle Workflow ([ADR-0006](../architecture/adr/0006-cloudflare-workflows.md)): a draft not approved within 72 h is disabled (`approval_expired`), an approval not acted on within 24 h lapses (`approval_lapsed`), and an execution not finished within 24 h is audited as `recovery.execution_overdue` but never changed automatically. The handlers enforce the same stored deadlines (`409 approval_window_closed` / `execution_window_closed`).
- **Workflows** (ADR-0006): `cryptophys-recovery-lifecycle` and `cryptophys-signal-ingest` are deployed with their Workers; `/ready` requires both bindings. About 35k steps a month against the 500k included in Workers Paid.
- **AI Kernel** (ADR-0007): every agent action is a syscall. Tier 0 reads are checked against the capability catalog; tier 1 (propose) and tier 2 (reversible act) need a Policy Engine `allow` that the target Worker re-verifies; tier 3 (deploy, secrets, data deletion) is never allowed for an agent; trading is prohibited at every tier. Any operator can suspend an agent or stop all agents; resuming needs an approver.
- **Drift Detector** observes Workers through `HealthRpc.health()` RPC calls, not HTTP, and records each run in D1 and the audit log.

## AI engines

Each of the six control-plane Workers runs its own engine (`env.AI`, own task allow-list and output validators) per [AI-ENGINE-REQUIREMENT.md](../architecture/AI-ENGINE-REQUIREMENT.md). AI is opt-in per request with `?advisory=true`, returns `ok | unavailable | invalid_output`, is budgeted in D1, and never changes a decision or stored fact. The Orchestrator's engine runs only after its deterministic gate has dispatched; a red check blocks before any inference.

## Tests

`workers/control-plane-shared/test` runs every service against an in-memory SQLite database built from the real migrations: authentication failures, malformed input, persistence round trips, policy denials (including attempts by AI output to override them), separation of duties, concurrent audit appends, chain tamper detection, drift classification, AI budget/timeout/schema failures, and readiness. CI also dry-run bundles every Worker.
