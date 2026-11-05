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

## Registered platform and XAUUSD AI agents (ADR-0007, TP-009, 0016)

There are no third-party or IDE external agents. The AI Worker OS process table (`agents`) registers only:

1. **AI Worker Cloud Platform agents (`cryptophys-cloud-platform`):**
   - `cryptophys-ai-kernel` Durable Object agents: `supervisor` (tier 2), `signal-analyst` (tier 1), and `auditor` (tier 1).
   - Per-Worker AI agents (`tier_max = 1`) for the remaining eight platform Workers: `platform-api`, `deployment-orchestrator`, `platform-registry`, `policy-engine`, `drift-detector`, `audit-ledger`, `recovery-manager`, and `signal-engine`.
2. **XAUUSD AI Trading Assistant deployment agents (`host_worker = 'xauusd-ai-trading-assistant'`, `tier_max = 1`):**
   - Active H1 synthesis chain (`xauusd-analyst`, `xauusd-counselor`, `xauusd-reasoner`) and multi-agent bus / news threads / live 15m room (`xauusd-technical-analyst`, `xauusd-news-analyst`, `xauusd-risk-manager`, `xauusd-moderator`).
   - 14 Pine HUD agents (`hud-r37-funnel`, `hud-prophet`, `hud-trade-management`, `hud-interstellar-eyes`, `hud-kinetic-engine-tva`, `hud-fabio-amt-sensors`, `hud-chronos-matrix`, `hud-aegis-footprint-matrix`, `hud-tactical-muscles`, `hud-macro-aether-sensors`, `hud-gabfx-price-action`, `hud-playbook-execution`, `hud-decision-matrix`, `hud-grid-bot-protocol`).

If a cross-deployment Worker agent reaches the AI Kernel's MCP endpoint `POST /mcp` over Cloudflare Access rather than an in-account binding:

1. **Owner: create the service token (only if cross-HTTP MCP binding is used).** In Cloudflare Zero Trust, go to Access → Service credentials → Service tokens → Create.
   - Name it `cryptophys-agent-<agent-id>`; the prefix matters.
   - Give the **Client Secret only to the Worker's configuration**. Never paste it in git, an issue, a PR or a chat.
   - Send the orchestrator the **Client ID**. A Client ID is an identifier, not a secret.
2. **Orchestrator: Provision Access.** Run the Provision Access workflow. It adds every `cryptophys-agent-*` token to the policy `external-agents` (`non_identity`). Access then admits the token, but the Workers still refuse it on `/v1` because it is not in `OPERATOR_IDENTITIES`.
3. **Bind the principal:** an approver binds `agent_principals.access_identity = Client ID` to the registered `agent_id` (`tier_max` ≤ 1).
4. **The agent connects.** It sends `POST https://cryptophys-ai-kernel.<subdomain>.workers.dev/mcp` with the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`. `tools/list` shows only `agent_whoami`, `agent_observe` and `agent_syscall`.

**Revocation.** An approver can revoke a principal with `DELETE /v1/agents/{id}/principals/{client_id}`. Deleting the service token in Zero Trust and re-running Provision Access removes it at the edge.
