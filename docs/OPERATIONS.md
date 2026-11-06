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
- Registry and drift inventory (TP-026): the Platform Registry holds 15 services: 10 platform Workers (`cryptophys-platform-api`, `cryptophys-deployment-orchestrator`, `cryptophys-platform-registry`, `cryptophys-policy-engine`, `cryptophys-drift-detector`, `cryptophys-audit-ledger`, `cryptophys-recovery-manager`, `cryptophys-ai-kernel`, `cryptophys-console`, `cryptophys-home`), 4 external XAUUSD Workers (`xauusd-ai-trading-assistant`, `xauusd-fundamental-news-ingestion`, `xauusd-tradingview-pull-adapter`, `xauusd-nexus-dashboard`), and the retired `cryptophys-signal-engine`. The Drift Detector probes the 9 other platform Workers over their `HealthRpc` entrypoint service bindings and the 4 external Workers over HTTP `/health`.
- Drift alerting: `.github/workflows/drift-alert.yml` reads `/v1/drift` every 30 minutes and keeps one issue, "Drift detected in production", open while any Worker is drifted, unhealthy, unobserved or has no observation for 45 minutes; it closes the issue when everything is back in sync.
- Critical-report alerting: the same workflow's `agent-reports` job reads the AI Kernel `/v1/status` (`agent_reports_24h`) every 30 minutes and keeps one issue, "Critical agent report in production", open while any **critical** agent report exists in the last 24 hours (for example a broken audit chain). The public issue contains only bounded time, agent id and kind metadata. Report subjects, report IDs and bodies are never copied into the public repository; read full details through the authenticated MCP tool `list_reports`. After the AI Kernel rollout, the complete critical-report ID fingerprint drives updates; the legacy fallback uses only the bounded IDs available from the pre-upgrade summary until then. The issue closes when no critical report remains. Warnings and info reports never open an issue.
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
   - `cryptophys-ai-kernel` Durable Object agents: `supervisor`, `signal-analyst`, and `auditor` (all `tier_max = 1` after TP-022). All three are kernel-internal: they cannot receive external principals and cannot be invoked through AgentRpc.
   - Per-Worker AI agents (`tier_max = 1`) for the seven active platform Workers: `platform-api`, `deployment-orchestrator`, `platform-registry`, `policy-engine`, `drift-detector`, `audit-ledger`, and `recovery-manager`. The former `signal-engine` agent remains registered but is suspended by TP-018.
2. **XAUUSD AI Trading Assistant deployment agents (`host_worker = 'xauusd-ai-trading-assistant'`, `tier_max = 1`):**
   - Active H1 synthesis chain (`xauusd-analyst`, `xauusd-counselor`, `xauusd-reasoner`) and multi-agent bus / news threads / live 15m room (`xauusd-technical-analyst`, `xauusd-news-analyst`, `xauusd-risk-manager`, `xauusd-moderator`).
   - 14 Pine HUD agents (`hud-r37-funnel`, `hud-prophet`, `hud-trade-management`, `hud-interstellar-eyes`, `hud-kinetic-engine-tva`, `hud-fabio-amt-sensors`, `hud-chronos-matrix`, `hud-aegis-footprint-matrix`, `hud-tactical-muscles`, `hud-macro-aether-sensors`, `hud-gabfx-price-action`, `hud-playbook-execution`, `hud-decision-matrix`, `hud-grid-bot-protocol`).

The D1 process table contains 32 registered rows: 31 enabled `tier_max = 1` rows (3 AI Kernel agents, 7 active per-Worker platform agents, and 21 XAUUSD/HUD agents), plus one suspended `tier_max = 1` row (`signal-engine`, TP-018). No registered agent has `tier_max >= 2` after TP-022. **A row being enabled does not mean that its host Worker is already wired to invoke it.** TP-011 added the `AgentRpc` entrypoint and report kinds in migration `0017`. **TP-011 part 2** added the `AGENTS` binding, pinned with `props.host_worker`, to the original 8 platform Workers. TP-018 removed the retired Signal Engine binding, leaving 7 active platform Worker hosts. The Drift Detector's `drift-detector` agent publishes a `platform_digest` when a scheduled observation finds drift; deploy-time manual observations are excluded. The former `signal-engine` agent is suspended and no longer publishes reports.

The xauusd and HUD agents still need the owner to add the same binding in `xauusd-ai-trading-assistant`. No external principal is seeded. No external MCP agent can invoke the kernel until an owner-created Access identity is explicitly registered in `agent_principals`.

- **In-account RPC Service Binding (no token):** A caller Worker may bind to `cryptophys-ai-kernel` with `entrypoint = "AgentRpc"`. The binding must set `props = { host_worker = "<exact caller Worker name>" }`. The caller may invoke only D1 agents whose `host_worker` exactly matches that property and whose `tier_max <= 1`. AgentRpc explicitly rejects every agent whose `host_worker = 'cryptophys-ai-kernel'` (`supervisor`, `signal-analyst`, `auditor`), regardless of tier. Normal grants, suspension, kill switch, rate limit and Policy Engine checks still apply. Example for a future, separately reviewed caller-binding change:

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
- **MCP:** Operator and CI Access identities always receive operator tools. No request header can select an agent. A non-operator Access identity receives agent tools only when its exact Access identity has an active `agent_principals` row for a tier-`<=1` non-kernel agent. The three AI-Kernel-hosted agents are excluded even if a stale active principal row exists: MCP resolution ignores that row, and a non-operator receives 403.
- **External service tokens:** Credential creation is an owner action in Cloudflare Zero Trust. The owner must securely retain the one-time `client_secret`, then have an approver register the token's Access identity through `POST /v1/agents/{id}/principals`. Do not generate credentials from repository scripts, and never print, commit or log the secret.

**Revocation.** An approver can revoke a principal with `DELETE /v1/agents/{id}/principals/{client_id}`. Deleting the service token in Zero Trust and re-running Provision Access removes it at the edge.

## Data retention

Drift observations are pruned daily at 03:00 UTC by the Drift Detector: rows older than 90 days are deleted, but the 2 newest observations per service are always kept. Agent syscall consumptions are pruned daily at 03:07 UTC by the AI Kernel: rows older than 7 days are deleted. Audit events, policy decisions, agent reports, recovery plans, deployment requests, registry rows and crypto history tables are never deleted. Owner decision, 2026-11-05.

## Console

`cryptophys-console` (`console.cryptophys.work`, ADR-0008) is the operator Console. It has no authority of its own: every request needs an Access JWT of an `OPERATOR_IDENTITIES` identity, and `/api/{service}/…` forwards only allow-listed routes (`CONSOLE_ALLOW_LIST` in `workers/console/src/index.ts`) to the platform Workers through Service Bindings, carrying only the operator's own `cf-access-jwt-assertion`. The target Worker verifies it, so the operator rule, approver rule, separation of duties and audit actor are those of the person. The kernel `/mcp` and the audit `POST /v1/events` are never forwarded. Non-GET `/api` calls need a same-origin `Origin` and `x-cryptophys-console: 1`. `/health` and `/ready` follow the other Workers; `/ready` returns 503 when `APPROVER_IDENTITIES` is unset or a binding is missing.

Screens (TP-024): Mission Control (overview, kill switch, AI summary on demand), Agents (list/detail, suspend/resume/wake/principals), Reports, Recovery (plans, approve/start/finish/disable), Services & Drift (observe now, edit service, desired version), Policy (decisions and evaluate), Audit (events, verify chain, export JSON), Deploy. Approver-only actions (hidden unless `whoami.approver`): agents ON, resume, add/remove principal, approve recovery plan. Principal buttons are hidden for agents hosted by `cryptophys-ai-kernel`; Wake is shown only for supervisor, signal-analyst and auditor. State-changing actions require a typed confirmation phrase. No trading actions; XAUUSD data is display only.
