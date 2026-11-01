# Control Plane Workers — Foundation

This change adds six separately deployable TypeScript Worker service boundaries from `architecture/BASELINE.md`. It preserves the existing `cryptophys-platform-api` and does not deploy any Worker.

| Worker | Logical capability | Status |
|---|---|---|
| `cryptophys-platform-api` | Initial API | Existing Worker; not changed here |
| `cryptophys-platform-registry` | Desired inventory and ownership metadata | Scaffold only; persistence not configured |
| `cryptophys-deployment-orchestrator` | Explicit deployment coordination | Scaffold only; execution disabled |
| `cryptophys-policy-engine` | Deployment/security invariants | Scaffold only; rules not configured |
| `cryptophys-drift-detector` | Desired-vs-observed configuration | Scaffold only; observation bindings not configured |
| `cryptophys-audit-ledger` | Append-only audit records | Scaffold only; storage/integrity not configured |
| `cryptophys-recovery-manager` | Reviewed recovery plans | Scaffold only; recovery execution disabled |

## Safety and limitations

- No production routes, custom domains, DNS, secrets, or storage bindings are added.
- Service operations return HTTP 501 with an explicit `capability_not_configured` response. They do not pretend to perform operations.
- `/ready` returns HTTP 503 unless `SERVICE_CONFIGURED=true`; this foundation intentionally is not production-ready.
- All handlers reject non-GET/HEAD requests. No mutating operation is exposed.
- These are service boundaries and scaffolds, not a complete operational Control Plane. Authentication/authorization, service contracts, persistence, idempotency, audit integrity/retention, drift comparison, policy rules, recovery plans, tests, and manual protected deployment workflows remain prerequisites.
- Production deployment is not performed by this change. Each Worker requires explicit review and manual deployment through the protected production environment.
