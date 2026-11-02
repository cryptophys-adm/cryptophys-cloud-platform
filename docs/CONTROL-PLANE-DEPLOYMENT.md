# Control Plane Deployment Runbook

Deploys `cryptophys-platform-registry`, `cryptophys-policy-engine`, `cryptophys-audit-ledger`, `cryptophys-recovery-manager` and `cryptophys-drift-detector` from one reviewed `main` commit with `.github/workflows/deploy-control-plane.yml`.

## One-time configuration (GitHub → Settings → Environments → `production`)

Add two Environment secrets, each a distinct random value of at least 32 characters (for example `openssl rand -hex 32`, generated on your own machine):

- `CONTROL_PLANE_ADMIN_TOKEN` — operator credential for every control-plane `/v1` endpoint.
- `CONTROL_PLANE_APPROVER_TOKEN` — held only by recovery-plan approvers.

`CLOUDFLARE_API_TOKEN` must allow **Workers Scripts: Edit** and **D1: Edit** on the approved account (D1 for migrations and Time Travel). Workers AI needs no extra token permission.

## Deploy

1. Merge the reviewed change to `main` and wait for every check on the merge commit to pass.
2. **Actions → Deploy Control Plane → Run workflow** on `main` with `DEPLOY` and the full `main` SHA.
3. Approve the `production` Environment if reviewers are configured.

The job then, failing closed at every step:

1. type-checks, runs the endpoint tests and the migration tests;
2. verifies credentials and that both control-plane secrets exist and differ;
3. resolves the D1 database ID by exact name (never committed) and renders runner-only configs;
4. records a D1 Time Travel bookmark (shown in the job summary) as the restore point;
5. applies pending D1 migrations;
6. deploys each Worker in dependency order with `--tag <sha12>` and its secrets uploaded atomically, then verifies the active version is that commit and `/health` + `/ready` pass over workers.dev;
7. records `desired_version` in the registry, runs a drift observation and requires every deployed Worker to be in sync and healthy, appends a deployment audit event and verifies the whole audit chain, and checks the Policy Engine denies a deployment with failing CI.

## Rollback

- Code: redeploy a previous reviewed commit through the same workflow (or `wrangler rollback` to the previous version during an incident, then reconcile Git).
- Data: `wrangler d1 time-travel restore cryptophys-control-plane --bookmark=<bookmark from the job summary>`. Restoring rewinds audit events too, so record the incident in a new audit event afterwards.

## Operating the services

```bash
curl -s -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" "https://cryptophys-audit-ledger.<subdomain>.workers.dev/v1/verify"
```

```bash
curl -s -X POST -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"actor":"operator"}' "https://cryptophys-drift-detector.<subdomain>.workers.dev/v1/observe"
```
