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

The D1 process table contains 31 registered and enabled `tier_max = 1` rows: 2 AI Kernel agents (`signal-analyst` and `auditor`), 8 per-Worker platform agents, and 21 XAUUSD/HUD agents. The `supervisor` is the 32nd registered row at tier 2. **A row being enabled does not mean that its host Worker is already wired to invoke it.** This TP-011 change adds the `AgentRpc` entrypoint and report kinds in migration `0017`; it deliberately does not add caller Worker bindings or seed external principals. Until a follow-up reviewed change adds and deploys each caller binding after the AI Kernel exposes `AgentRpc`, those host Workers cannot invoke the in-account RPC. No external MCP agent can invoke the kernel until an owner-created Access identity is explicitly registered in `agent_principals`.

- **In-account RPC Service Binding (no token):** A caller Worker may bind to `cryptophys-ai-kernel` with `entrypoint = "AgentRpc"`. The binding must set `props = { host_worker = "<exact caller Worker name>" }`. The caller may invoke only D1 agents whose `host_worker` exactly matches that property and whose `tier_max <= 1`. Normal grants, suspension, kill switch, rate limit and Policy Engine checks still apply. Example for a future, separately reviewed caller-binding change:

  ```toml
  [[services]]
  binding = "AGENTS"
  service = "cryptophys-ai-kernel"
  entrypoint = "AgentRpc"
  props = { host_worker = "xauusd-ai-trading-assistant" }
  ```

  ```ts
  await env.AGENTS.syscall("xauusd-analyst", "reports.publish", {
    kind: "xauusd_digest", severity: "info", subject: "H1 digest",
    ai_status: "ok", body: { summary: "..." }
  });
  ```

- **Trust boundary:** `host_worker` comes from the caller Worker's deployed Service Binding configuration, not from an HTTP request. The trust boundary is the Cloudflare account and the identities permitted to change/deploy that caller configuration. An actor with that deployment authority can change the asserted property; this is not protection against a malicious account deployer. The kernel checks the exact host match and tier limit before the normal syscall gate.
- **Agent reports:** `reports.publish` stores UTF-8 JSON bodies up to 16 KiB per report; oversized bodies fail closed and are audited as failed syscalls.
- **MCP:** Operator and CI Access identities always receive operator tools. No request header can select an agent. A non-operator Access identity receives agent tools only when its exact Access identity has an active `agent_principals` row for a tier-`<=1` agent.
- **External service tokens:** Credential creation is an owner action in Cloudflare Zero Trust. The owner must securely retain the one-time `client_secret`, then have an approver register the token's Access identity through `POST /v1/agents/{id}/principals`. Do not generate credentials from repository scripts, and never print, commit or log the secret.

**Revocation.** An approver can revoke a principal with `DELETE /v1/agents/{id}/principals/{client_id}`. Deleting the service token in Zero Trust and re-running Provision Access removes it at the edge.
