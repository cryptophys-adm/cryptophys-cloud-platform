# Deployment Runbook

## Scope

This deploys only `workers/platform-api` as Worker `cryptophys-platform-api`. It does not provision databases, queues, buckets, routes, DNS records, or other services.

## One-time GitHub configuration

1. Open repository **Settings → Environments** and create `production`.
2. Configure required reviewers and prevent self-review where supported.
3. Add these **Environment secrets** to `production`:
   - `CLOUDFLARE_ACCOUNT_ID`: the ID of the explicitly approved Cloudflare account.
   - `CLOUDFLARE_API_TOKEN`: a dedicated token scoped to that account with the minimum permission required to deploy/update Workers Scripts. Do not use a Global API Key. Do not add unrelated DNS, R2, D1, or account-admin permissions unless a separately reviewed workflow requires them.
4. Limit deployment to the protected `main` ref or an explicitly reviewed release ref, according to Environment protection options available to the repository.
5. Enable secret scanning, push protection, Dependabot alerts, and branch protection for `main`.
6. Review and SHA-pin third-party GitHub Actions before treating the workflow as production-hardened.

Do not put these values into repository files or send them in chat. Secrets must be entered directly in GitHub Settings and must never be echoed by workflows.

## Deployment

Production has three protected `workflow_dispatch` workflows, all gated by the `production` Environment and pinned to an exact `main` SHA:

| Workflow | Deploys | Started by |
|---|---|---|
| `deploy-platform-api.yml` | `cryptophys-platform-api` | The Deployment Orchestrator (`POST /v1/deployments`, or a consensus `deploy_commit`) dispatches it directly |
| `deploy-deployment-orchestrator.yml` | `cryptophys-deployment-orchestrator` | Operator |
| `deploy-control-plane.yml` | The five control-plane services | Operator — see [CONTROL-PLANE-DEPLOYMENT.md](CONTROL-PLANE-DEPLOYMENT.md) |

### Ops dispatch (automation operator)

The repository owner authorized the platform's automation operator to start these workflows (2026-11-03). Its GitHub integration cannot call the `workflow_dispatch` API, so it commits one request file per action to `ops/requests/` on its operator branch, `claude/gracious-brown-tkc4e8`. `.github/workflows/ops-dispatch.yml` then dispatches the requested workflow using the job's own `GITHUB_TOKEN` and follows the run to completion.

- **Allowed workflows:** `provision-access.yml`, `deploy-control-plane.yml` and `deploy-deployment-orchestrator.yml` (all run on `main`). All of them run from `main`: no workflow definition that receives production secrets is ever loaded from the operator branch, so the `production` Environment no longer needs to allow that branch.
- **Allowed inputs:** `confirm_production`, `commit_sha` and `orchestrator_url`.
- Every gate of the dispatched workflow still applies, and the request files form the audit trail.

### Platform API through the Orchestrator

1. Merge reviewed changes to `main`; a merge alone does not deploy.
2. Run **Request Platform API Deployment** on `main` with the current `main` SHA, `DEPLOY` and the Orchestrator workers.dev URL. The Orchestrator excludes this exact workflow path from its CI gate (it is necessarily in progress while asking), and still requires at least one other green validation workflow on the commit.
3. The Orchestrator authenticates the request, requires the SHA to be current `main`, requires the combined commit status and the latest run of every GitHub Actions workflow on it to be successful (owner decision: the Checks API is not readable by the fine-grained `GH_ACTIONS_TOKEN`, so checks posted by non-Actions apps are not part of the gate), claims a one-time deployment lock, and dispatches `deploy-platform-api.yml`.
4. The workflow re-checks confirmation and SHA, type-checks, deploys with `--tag <sha12>`, and verifies the active version and `/health` + `/ready` on workers.dev.

All Workers are behind Cloudflare Access (`provision-access.yml`, run once before the first deploy). Every deploy workflow refuses to deploy unless the Access application protects the target Worker, passes the Access team domain and AUD to the Worker, and verifies it live with `.github/scripts/verify-worker-live.sh --require-access`. The verification checks that an unauthenticated request is rejected by Access, that the active version is annotated with the commit, and that health and readiness return HTTP 200 and their JSON contract through the CI service token. TLS verification is always on.

## Infrastructure state and recovery

See [State and Recovery Contract](../architecture/STATE-AND-RECOVERY.md). The current Wrangler-based Worker deployment does not require Terraform state. If Terraform/OpenTofu is added later, production state must be remote, durable, recoverable, and protected by enforced locking; runner-local state is prohibited. The remote backend is not yet provisioned.

## Current limitations

- The Platform API has no storage and no mutation endpoints; the control-plane services own D1 state.
- Control-plane `/v1` APIs are authorized by verified Cloudflare Access identity (`OPERATOR_IDENTITIES`, `APPROVER_IDENTITIES`); the identity is the recorded actor.
- No Cloudflare account/resource identifiers are committed; the D1 ID is resolved at deploy time.
- `workflow_dispatch` is the only production deployment trigger.
