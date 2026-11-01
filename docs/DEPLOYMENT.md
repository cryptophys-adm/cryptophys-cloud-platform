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

1. Merge reviewed changes to `main`.
2. Open **Actions → Deploy Platform API → Run workflow**.
3. Enter `DEPLOY` exactly and select the intended ref.
4. Approve the protected `production` Environment.
5. Confirm the run succeeds and inspect the Worker in the intended Cloudflare account.
6. Verify `/health` and `/ready` using the workers.dev URL shown in Cloudflare. No custom domain is configured by this repository.

## Infrastructure state and recovery

See [State and Recovery Contract](../architecture/STATE-AND-RECOVERY.md). The current Wrangler-based Worker deployment does not require Terraform state. If Terraform/OpenTofu is added later, production state must be remote, durable, recoverable, and protected by enforced locking; runner-local state is prohibited. The remote backend is not yet provisioned.

## Current limitations

- No database or other storage is attached.
- No admin API, identity provider, or mutation endpoint exists.
- No production deployment has been performed by creating these files.
- No Cloudflare account/resource identifiers are hard-coded.
- Manual workflow dispatch is the only production deployment trigger.
