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

## Registering an external AI agent (ADR-0007, TP-009)

An external agent (an IDE agent, another AI session) reaches the AI Kernel's MCP endpoint `POST /mcp` with **its own** Cloudflare Access service token. It acts as a registered agent at tier ≤ 1, through the same policy-gated syscalls as internal agents.

1. **Owner: create the service token.** In Cloudflare Zero Trust, go to Access → Service credentials → Service tokens → Create.
   - Name it `cryptophys-agent-<agent-id>`; the prefix matters.
   - Give the **Client Secret only to the agent's MCP configuration**. Never paste it in git, an issue, a PR or a chat.
   - Send the orchestrator the **Client ID**. A Client ID is an identifier, not a secret.
2. **Orchestrator: Provision Access.** Run the Provision Access workflow. It adds every `cryptophys-agent-*` token to the policy `external-agents` (`non_identity`). Access then admits the token, but the Workers still refuse it on `/v1` because it is not in `OPERATOR_IDENTITIES`.
3. **Owner approves the agent definition in writing:** its `agent_id`, `tier_max` ≤ 1 and capabilities. The orchestrator then adds a migration that registers the agent and its principal (`agent_principals.access_identity` = Client ID) and deploys the control plane.
4. **The agent connects.** It sends `POST https://cryptophys-ai-kernel.<subdomain>.workers.dev/mcp` with the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`. `tools/list` shows only `agent_whoami`, `agent_observe` and `agent_syscall`.

**Revocation.** An approver can revoke a principal with `DELETE /v1/agents/{id}/principals/{client_id}`. Deleting the service token in Zero Trust and re-running Provision Access removes it at the edge.
