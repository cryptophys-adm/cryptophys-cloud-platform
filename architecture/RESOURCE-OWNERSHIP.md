# Resource Ownership Register

Every Cloudflare resource must have an owner, purpose, environment, data classification, lifecycle, and recovery plan before production binding. The machine-readable copy of this register for Workers is the `service_registry` table served by the Platform Registry (`GET /v1/services`).

Owner for every row below: `cryptophys-adm`. Environment: `production`.

| Resource | Purpose | Data classification | Lifecycle | Recovery |
|---|---|---|---|---|
| Worker `cryptophys-platform-api` | Public health/metadata API | public | Deployed by Orchestrator → `deploy-platform-api.yml` | Redeploy a reviewed commit or roll back the Worker version |
| Worker `cryptophys-deployment-orchestrator` | Authenticated, CI-gated deployment dispatch | internal | `deploy-deployment-orchestrator.yml` | Redeploy a reviewed commit; Durable Object holds only deployment locks |
| Worker `cryptophys-platform-registry` | Desired inventory and ownership | internal | `deploy-control-plane.yml` | Redeploy; state lives in D1 |
| Worker `cryptophys-policy-engine` | Deterministic policy decisions | internal | `deploy-control-plane.yml` | Redeploy; decisions persisted in D1 |
| Worker `cryptophys-drift-detector` | Desired-vs-observed comparison (cron `*/15 * * * *`) | internal | `deploy-control-plane.yml` | Redeploy; observations persisted in D1 |
| Worker `cryptophys-audit-ledger` | Append-only hash-chained audit log | internal | `deploy-control-plane.yml` | Redeploy; chain verifiable via `GET /v1/verify` |
| Worker `cryptophys-recovery-manager` | Recovery plans, separated approval, recorded execution | internal | `deploy-control-plane.yml` | Redeploy; plans persisted in D1 |
| D1 `cryptophys-control-plane` | Control-plane state (registry, decisions, drift, audit, recovery, AI usage) | internal; no customer data or secrets (secret-shaped values are redacted before write) | Schema via `workers/control-plane-migrations`, applied only by `deploy-control-plane.yml`; audit rows are never updated or deleted | D1 Time Travel (point-in-time restore, 30-day window); a bookmark is recorded before every migration in the deploy job summary |
| Durable Object `DeploymentLock` (orchestrator) | One-time claim per deployed commit | internal | Migration `v1` in orchestrator `wrangler.toml` | Loss only re-allows a duplicate request, which CI gates still check |
| Workers AI (`AI` binding, 5 Workers) | Advisory summaries/labels only | inputs redacted; prompts and outputs not persisted | Free allocation; 80 requests/service and 400/account per UTC day enforced in `ai_usage` | Unavailable AI never blocks authoritative operations |
| DNS/routes/custom domains | `deploy-orchestrator.cryptophys.work` (orchestrator) only | — | Reviewed change required | Certificate currently does not match; health is verified on workers.dev |
| Secrets | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `ORCHESTRATOR_SHARED_SECRET`, `CONTROL_PLANE_ADMIN_TOKEN`, `CONTROL_PLANE_APPROVER_TOKEN` in the GitHub `production` Environment; Worker secrets `GH_ACTIONS_TOKEN`, `ORCHESTRATOR_SHARED_SECRET`, `ADMIN_TOKEN`, `APPROVER_TOKEN` | restricted | Never stored in Git or logs | Rotate at the issuer, update the GitHub secret, redeploy |
| KV, R2, Queues, Workflows | Not provisioned | — | Define purpose, retention and recovery before use | — |

Never commit credentials or environment-specific identifiers. Update this register through reviewed changes as resources are provisioned.
