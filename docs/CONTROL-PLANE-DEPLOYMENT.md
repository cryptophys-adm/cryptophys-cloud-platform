# Control Plane Deployment Runbook

Deploys six Control Plane Workers from one reviewed `main` commit with `.github/workflows/deploy-control-plane.yml`: `cryptophys-platform-registry`, `cryptophys-policy-engine`, `cryptophys-audit-ledger`, `cryptophys-recovery-manager`, `cryptophys-ai-kernel` and `cryptophys-drift-detector`. The Platform API and Deployment Orchestrator use separate workflows.

## One-time configuration

### Cloudflare Access (all eight active platform Workers sit behind it)

1. **Zero Trust → Access → Service credentials → Service tokens:** create a token named `cryptophys-ci` and copy its Client ID and Client Secret (the secret is shown once).
2. **API token** `CLOUDFLARE_ACCESS_API_TOKEN` (account-scoped): *Access: Apps and Policies Edit*, *Access: Service Tokens Read*, *Access: Organizations, Identity Providers, and Groups Read*, *Workers Scripts Read*, and *D1 Edit* (used for the D1 steps of the deploy workflows).
3. In the GitHub `production` Environment add:
   - secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (the service token) and `CLOUDFLARE_ACCESS_API_TOKEN`;
   - variable `ACCESS_ALLOWED_EMAILS` (comma-separated operator emails).
4. Run **Actions → Provision Cloudflare Access** on `main` with `PROVISION`. It creates/updates the application `cryptophys-cloud-platform`, then proves that each Worker rejects unauthenticated requests and admits the service token. Re-run it after adding a Worker or changing operators.

Operators open the Worker URLs in a browser and sign in through Access. Scripts send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. That Access identity is the only credential: there is no bearer token.

### Authorization by Access identity (no shared tokens)

Every `/v1` call is authorized by the caller's verified Cloudflare Access identity, and that identity is the actor recorded in the audit chain (a self-declared `actor`, `created_by`, `approved_by` or `executed_by` in a request body is ignored). The deploy workflows derive the lists from existing configuration with `.github/scripts/access-identities.sh`:

| List | Members | Grants |
| --- | --- | --- |
| `OPERATOR_IDENTITIES` (all six Control Plane Workers) | `CF_ACCESS_CLIENT_ID` + `ACCESS_ALLOWED_EMAILS` | every `/v1` endpoint (on the Orchestrator, the read-only `GET /v1/deployments`; its `POST /v1/deployments` and `DEPLOY_ALLOWED_IDENTITIES` were removed 2026-11-14 by the owner) |
| `APPROVER_IDENTITIES` (Recovery Manager) | `ACCESS_ALLOWED_EMAILS` | `POST /v1/plans/{id}/approve` only, never for a plan the same identity authored |

Emails are compared and recorded in lower case; Client IDs exactly. An unset list fails closed (`503 …_not_configured`); an identity outside a list gets `403 forbidden`. Automation can operate but can never approve a recovery plan.

**Identity source after the GitHub cut-over (owner 2026-11-16, migration 0073).** The native deploy (`deployment-orchestrator/src/deploy-vars.ts`) takes the emails from D1 `platform_identities` instead of `ACCESS_ALLOWED_EMAILS`, with the same semantics (`control-plane-shared/src/identity-source.ts`): lower case, duplicates dropped in first order, `access-identities.sh`'s email regex, at least one and at most 20, operators and approvers one list. It builds `OPERATOR_IDENTITIES` and `DEPLOY_ALLOWED_IDENTITIES` as `<Client ID of the Orchestrator's CF_ACCESS_CLIENT_ID>,<emails>` and `APPROVER_IDENTITIES` as `<emails>`, exactly as the script prints them, for the Workers each workflow passes them to (`DEPLOY_VARS`).
- **No row, or the seed** (copied once from the Orchestrator's own active lists, for the Console): each Worker's active values are carried as before.
- **An owner-saved row** (Console → Users, `POST /v1/identities` on the Platform Registry: an owner only, typed `IDENTITIES`, audited as `identity_source.changed`): the expected values come from it, with the same checks (format, Client ID first, equal across the unit). A value that differs from the active version is written as its `plain_text` binding and verified on the new version before traffic (steps `<worker>:vars_from_identity_table`, `<worker>:vars_changed:<NAME>`; audit `deployment.identity_vars_written`, names only).
- **An invalid row:** never deployed; the active values are carried and the Owner page lists `identity_source_invalid`. A row that cannot be read (D1 failed) is carried the same way.

The deploy workflows keep using `ACCESS_ALLOWED_EMAILS` until the cut-over. Keep the two equal until then: a workflow deploy overwrites what a native deploy wrote. How the owner changes an email: `docs/OPERATIONS.md`, "Changing an operator or approver email".

The retired secrets are removed from the Workers by the deploy workflows (`ADMIN_TOKEN`, `APPROVER_TOKEN`, `ORCHESTRATOR_SHARED_SECRET`); the GitHub secrets `CONTROL_PLANE_ADMIN_TOKEN`, `CONTROL_PLANE_APPROVER_TOKEN` and `ORCHESTRATOR_SHARED_SECRET` are unused and can be deleted.

`CLOUDFLARE_API_TOKEN` must allow **Workers Scripts: Edit** on the approved account. D1 operations (database lookup, Time Travel bookmark, migrations) use `CLOUDFLARE_ACCESS_API_TOKEN`, which therefore also needs **Account → D1 → Edit** (owner decision, 2026-11-03). Workers AI needs no extra token permission.

## Deploy

A **new** active platform Worker first needs **Provision Cloudflare Access**: it creates the Worker as a private 503 stub with workers.dev disabled, then adds it to the Access application, so the Worker is protected before its first real deploy.

The crypto Signal Engine is retired. Its Cloudflare Worker and ingest Workflow were deleted by owner-authorized Retire Worker run `42041570698`; the Worker deletion was verified with HTTP 404. Its registry row remains `disabled` for history and is excluded from the active drift inventory. Historical crypto data in D1 is retained.

Order for a fresh commit (after Access is provisioned once): **Deploy Control Plane** (applies D1 migrations) → **Deploy Production Deployment Orchestrator** (refuses to deploy while `0003` is unapplied) → **Request Platform API Deployment**.


1. Merge the reviewed change to `main` and wait for every check on the merge commit to pass.
2. **Actions → Deploy Control Plane → Run workflow** on `main` with `DEPLOY` and the full `main` SHA.
3. Approve the `production` Environment if reviewers are configured.

The job then, failing closed at every step:

1. type-checks, runs the endpoint tests and the migration tests;
2. verifies credentials and builds the operator and approver identity lists;
3. resolves the D1 database ID by exact name (never committed) and renders runner-only configs;
4. records a D1 Time Travel bookmark (shown in the job summary) as the restore point;
5. applies pending D1 migrations;
6. removes the retired shared tokens, deploys each Worker in dependency order with `--tag <sha12>` and its identity lists, proves no retired token is bound, then verifies the active version is that commit and `/health` + `/ready` pass over workers.dev;
7. records `desired_version` in the registry (the Orchestrator and Platform API deploy workflows record their own after deploying, so all eight active platform Workers are drift-managed), runs a drift observation and requires every deployed Worker to be in sync and healthy, appends a deployment audit event and verifies the whole audit chain, and checks the Policy Engine denies a deployment with failing CI. It then verifies the recovery lifecycle Workflow end to end (ADR-0006): as an operator (never an approver) it creates a verification plan, requires its `cryptophys-recovery-lifecycle` instance to be running or waiting in the Cloudflare API, disables the plan and requires the instance to be terminated. Nothing is approved or executed.

## Rollback

- Code: redeploy a previous reviewed commit through the same workflow (or `wrangler rollback` to the previous version during an incident, then reconcile Git).
- Data: `wrangler d1 time-travel restore cryptophys-control-plane --bookmark=<bookmark from the job summary>`. Restoring rewinds audit events too, so record the incident in a new audit event afterwards.

## Operating the services

```bash
curl -s -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "https://cryptophys-audit-ledger.<subdomain>.workers.dev/v1/verify"
```

```bash
curl -s -X POST -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "https://cryptophys-drift-detector.<subdomain>.workers.dev/v1/observe"
```
