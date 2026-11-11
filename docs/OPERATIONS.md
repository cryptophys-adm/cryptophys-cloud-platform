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
- Owner notices (ADR-0012 phase 2): the AI Kernel computes three notices at :22 and :52, sends them to the Console, and emails them to the owners (`APPROVER_IDENTITIES`) from `alerts@notify.cryptophys.work`. They replace the former GitHub issues of `drift-alert.yml` and `owner-attention.yml`:
  - `owner_attention`: draft recovery plans and critical proposals waiting for an owner click;
  - `drift`: drifted, unhealthy, never observed, or not observed for 45 minutes;
  - `critical_reports`: critical agent reports in the last 24 h.
  - Each opened, changed or closed notice is an `owner.notice_*` audit event. A failed email is retried at the next run.
  - The live notices are at `GET /v1/notices` on the AI Kernel and in the Console under Command → "Needs your attention".
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
   - Per-Worker AI agents (`tier_max = 1`) for the seven active platform Workers: `platform-api`, `deployment-orchestrator`, `platform-registry`, `policy-engine`, `drift-detector`, `audit-ledger`, and `recovery-manager`. The former `signal-engine` agent was suspended by TP-018 and deleted by migration 0047 (2026-11-11).
2. **XAUUSD AI Trading Assistant deployment agents (`host_worker = 'xauusd-ai-trading-assistant'`, `tier_max = 1`):**
   - H1 synthesis chain (`xauusd-reasoner`; the unused `xauusd-analyst` and `xauusd-counselor` identities were deleted by 0048, the chain's Analyst and Counselor model steps are unchanged) and multi-agent bus / news threads / live 15m room (`xauusd-risk-manager`, `xauusd-moderator`). `xauusd-technical-analyst` and `xauusd-news-analyst` were never used and were deleted by 0047.
   - 10 Pine HUD agents (`hud-prophet`, `hud-trade-management`, `hud-interstellar-eyes`, `hud-kinetic-engine-tva`, `hud-fabio-amt-sensors`, `hud-chronos-matrix`, `hud-aegis-footprint-matrix`, `hud-tactical-muscles`, `hud-macro-aether-sensors`, `hud-decision-matrix`). `hud-r37-funnel`, `hud-gabfx-price-action`, `hud-playbook-execution` and `hud-grid-bot-protocol` were dismantled on 2026-11-11 (owner: "dismantle sekarang"; 87-97 % NEUTRAL in the 15m War Room, never a BUY or SELL) and deleted by 0047.
   - **Dismantling (owner 2026-11-11: "dismantle dan delete agent yang sudah tidak berkontribusi"):** consensus action `retire_agent` (routine) deletes an agent no row refers to and otherwise suspends it with a `retired:` reason, so no history is lost and `resume_agent` can bring it back. Each scheduled Supervisor cycle proposes one enabled agent with no action, report or vote for 14 days (`RETIRE_IDLE_DAYS`), at most once a week per agent. Kernel agents, council seats and the agents of `cryptophys-aether` (under deployment) and `xauusd-ai-trading-assistant` (judged on its own room data) are never retired; the executor enforces this whatever the vote.

Since migrations 0047 and 0048 (2026-11-11) the D1 process table holds 28 rows, all enabled: 3 AI Kernel agents, 7 active per-Worker platform agents, 13 XAUUSD/HUD agents and 5 Aether agents (the Knowledge Council included). No registered agent has `tier_max >= 2` after TP-022. **A row being enabled does not mean that its host Worker is already wired to invoke it.** TP-011 added the `AgentRpc` entrypoint and report kinds in migration `0017`. **TP-011 part 2** added the `AGENTS` binding, pinned with `props.host_worker`, to the original 8 platform Workers. TP-018 removed the retired Signal Engine binding, leaving 7 active platform Worker hosts. The Drift Detector's `drift-detector` agent publishes a `platform_digest` when a scheduled observation finds drift; deploy-time manual observations are excluded. The former `signal-engine` agent was deleted by 0047.

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
  await env.AGENTS.syscall("xauusd-reasoner", "reports.publish", {
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

## Consensus (ADR-0009)

The AI Kernel records consensus proposals in `consensus_proposals` and their votes in `consensus_votes`. The mode is stored in `consensus_controls`.

**Phase 1 (`shadow`):**
- only the supervisor proposes, and only for persistent drift (`redeploy_desired_version`);
- 9 control-plane agents vote deterministically, and the proposer does not vote;
- a proposal needs a simple majority, plus a Policy Engine `consensus.execute` allow;
- **nothing executes.**

**Reading proposals:** `GET /v1/consensus` and `GET /v1/consensus/{id}` on the kernel, or the Console Consensus screen.

**Deploy verification** fails if the mode is not `shadow`, or if any proposal is `executing` or `executed`.

## Console

`cryptophys-console` (`console.cryptophys.work`, ADR-0008) is the operator Console. It has no authority of its own: every request needs an Access JWT of an `OPERATOR_IDENTITIES` identity, and `/api/{service}/…` forwards only allow-listed routes (`CONSOLE_ALLOW_LIST` in `workers/console/src/index.ts`) to the platform Workers through Service Bindings, carrying only the operator's own `cf-access-jwt-assertion`. The target Worker verifies it, so the operator rule, approver rule, separation of duties and audit actor are those of the person. The kernel `/mcp` and the audit `POST /v1/events` are never forwarded. Non-GET `/api` calls need a same-origin `Origin` and `x-cryptophys-console: 1`. `/health` and `/ready` follow the other Workers; `/ready` returns 503 when `APPROVER_IDENTITIES` is unset or a binding is missing.

UI (Nexus obsidian redesign): a React SPA (`workers/console/ui`, Vite, Tailwind, lucide-react, framer-motion, three.js) in the original Nexus design, built into `ui/dist` by the deploy and validation workflows and served as Workers Static Assets with `run_worker_first`, so every asset passes the Access, operator and CSP checks first. The shell has the neural-mesh background, a Priority Queue and Cockpit Doctrine on the left, AI Cognition and the Live Event Bus (audit chain) on the right. Screens: Command (health ring, KPIs, approval queue, kill switch, service mesh, attention, XAUUSD display), AI Mesh (radial agent graph and roster; detail with suspend/resume/wake/principals and syscall history), Cognition (reports), Recovery (plans, create, approve/start/finish/disable), Infrastructure (services and drift, observe now, edit service, desired version), Policy (decisions and evaluate), Ledger (events, verify chain, export JSON), Pipelines (deploy request), Markets (XAUUSD display only). Every API call goes through the TP-024 `UI_ROUTES` table. Approver-only actions (hidden unless `whoami.approver`): agents ON, resume, add/remove principal, approve recovery plan. Principal buttons are hidden for agents hosted by `cryptophys-ai-kernel`; Wake is shown only for supervisor, signal-analyst and auditor. State-changing actions require a typed confirmation phrase. No trading actions; XAUUSD data is display only.
