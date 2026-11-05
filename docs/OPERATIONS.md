# Operations

## Health checks

- GET /health or /healthz: process-level health metadata.
- GET /ready or /readyz: readiness; currently no external dependencies.
- GET /: service metadata and implemented endpoints.
- Unsupported paths return JSON 404; non-GET/HEAD methods return JSON 405.

## Incident handling

1. Restrict the GitHub production Environment if further deployments must be paused.
2. Inspect the GitHub Actions run, commit SHA, and Cloudflare Worker logs.
3. Revert through a reviewed commit and deploy manually; do not use force-push as routine rollback.
4. If a token or secret is exposed, revoke/rotate it at its issuer immediately.
5. Record the timeline, impact, mitigation, and follow-up work in a reviewed document or issue.

## Control-plane checks

- Audit integrity: `GET /v1/verify` on the Audit Ledger must return `"valid": true`.
- Drift: the Drift Detector runs every 15 minutes; `GET /v1/drift` shows the latest observation per Worker. A Worker is `degraded` when its live version tag differs from the registry `desired_version`, and `unavailable` when its health check fails.
- Drift alerting: `.github/workflows/drift-alert.yml` reads `/v1/drift` every 30 minutes and keeps one issue, "Drift detected in production", open while any Worker is drifted, unhealthy, unobserved or has no observation for 45 minutes; it closes the issue when everything is back in sync.
- Readiness of every control-plane Worker lists the individual checks that failed.

## Recovery posture

Durable state lives only in D1 `cryptophys-control-plane` (owner `cryptophys-adm`).

- Backup: D1 Time Travel provides continuous point-in-time recovery within its 30-day window; every control-plane deploy records a bookmark before migrating.
- RPO: minutes (Time Travel granularity). RTO: under 30 minutes (restore + redeploy through the workflow).
- Restore verification: after any restore, run `GET /v1/verify` on the Audit Ledger and a drift observation, and record the restore as a new audit event.
- Recovery plans for each service are stored in the Recovery Manager and need a second person to approve.

## Registered platform and XAUUSD AI agents (ADR-0007, TP-009, 0016, 0017)

There are no third-party or IDE external agents. The AI Worker OS process table (`agents`) registers only:

1. **AI Worker Cloud Platform agents (`cryptophys-cloud-platform`):**
   - `cryptophys-ai-kernel` Durable Object agents: `supervisor` (tier 2), `signal-analyst` (tier 1), and `auditor` (tier 1).
   - Per-Worker AI agents (`tier_max = 1`) for the remaining eight platform Workers: `platform-api`, `deployment-orchestrator`, `platform-registry`, `policy-engine`, `drift-detector`, `audit-ledger`, `recovery-manager`, and `signal-engine`.
2. **XAUUSD AI Trading Assistant deployment agents (`host_worker = 'xauusd-ai-trading-assistant'`, `tier_max = 1`):**
   - Active H1 synthesis chain (`xauusd-analyst`, `xauusd-counselor`, `xauusd-reasoner`) and multi-agent bus / news threads / live 15m room (`xauusd-technical-analyst`, `xauusd-news-analyst`, `xauusd-risk-manager`, `xauusd-moderator`).
   - 14 Pine HUD agents (`hud-r37-funnel`, `hud-prophet`, `hud-trade-management`, `hud-interstellar-eyes`, `hud-kinetic-engine-tva`, `hud-fabio-amt-sensors`, `hud-chronos-matrix`, `hud-aegis-footprint-matrix`, `hud-tactical-muscles`, `hud-macro-aether-sensors`, `hud-gabfx-price-action`, `hud-playbook-execution`, `hud-decision-matrix`, `hud-grid-bot-protocol`).

All 29 `tier_max = 1` agents are active and can invoke `agent_whoami`, `agent_observe`, and `agent_syscall` (including publishing `platform_digest`, `xauusd_digest`, and `hud_digest` reports to `agent_reports` via migration `0017`) in three ways:
- **In-account RPC Service Binding (`KernelRpc`):** `KernelRpc.agentWhoami(agentId)`, `KernelRpc.agentObserve(agentId, capability, input)`, and `KernelRpc.agentSyscall(agentId, capability, input)` require no shared secret or service token.
- **Authenticated MCP header (`X-Cryptophys-Agent-Id`):** An authenticated operator or CI service token calling `POST /mcp` with header `X-Cryptophys-Agent-Id: <agent-id>` enters a scoped `tier_max <= 1` MCP session for that agent (`tools/list` shows only `agent_whoami`, `agent_observe`, and `agent_syscall`).
- **Dedicated Cloudflare Access Service Token (`cryptophys-agent-<agent-id>`):** Can be created idempotently with `.github/scripts/ensure-agent-service-tokens.sh <agent-id> ...` (which prints only `{agent_id, name, id, client_id, created}` and never outputs `client_secret`) and bound in `agent_principals` (`POST /v1/agents/{id}/principals`).

**Revocation.** An approver can revoke a principal with `DELETE /v1/agents/{id}/principals/{client_id}`. Deleting the service token in Zero Trust and re-running Provision Access removes it at the edge.
