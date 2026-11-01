# Deployment Runbook

## Scope

This deploys only workers/platform-api as Worker cryptophys-platform-api. It does not provision databases, queues, buckets, routes, DNS records, or other services.

## One-time GitHub configuration

1. Open repository Settings → Environments and create production.
2. Configure required reviewers and prevent self-review where supported.
3. Add environment secrets:
   - CLOUDFLARE_ACCOUNT_ID: the intended Cloudflare account ID.
   - CLOUDFLARE_API_TOKEN: a token scoped to that account and only the Workers deployment permissions required.
4. Enable secret scanning, push protection, Dependabot alerts, and branch protection for main.
5. Review and SHA-pin third-party GitHub Actions before treating the workflow as production-hardened.

Do not put these values into repository files or send them in chat.

## Deployment

1. Merge reviewed changes to main.
2. Open Actions → Deploy Platform API → Run workflow.
3. Enter DEPLOY exactly and select the intended ref.
4. Approve the protected production environment.
5. Confirm the run succeeds and inspect the Worker in the intended Cloudflare account.
6. Verify /health and /ready using the workers.dev URL shown in Cloudflare. No custom domain is configured by this repository.

## Current limitations

- No database or other storage is attached.
- No admin API, identity provider, or mutation endpoint exists.
- No production deployment has been performed by creating these files.
- No Cloudflare account/resource identifiers are hard-coded.
- Manual workflow dispatch is the only production deployment trigger.
