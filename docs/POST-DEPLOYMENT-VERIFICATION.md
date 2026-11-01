# Platform API Post-Deployment Verification

## Scope

This runbook verifies the currently deployed Platform API Worker. It does not claim that the full Cryptophys control plane is implemented.

## Current verified deployment snapshot

Observed on 2026-11-01:
- Cloudflare Worker: `cryptophys-platform-api`
- Active deployment source: Wrangler
- Public worker hostname: `cryptophys-platform-api.afif-kw.workers.dev`
- `GET /health`: HTTP 200
- `GET /ready`: HTTP 200
- `GET /`: HTTP 200
- No custom domain or zone Worker route was present for this Worker during the audit.
- No secret bindings were present in the Worker settings during the audit.

## Manual checks

Run these from a trusted terminal:

```sh
set -eu
BASE_URL="https://cryptophys-platform-api.afif-kw.workers.dev"
curl --fail --silent --show-error --max-time 20 "$BASE_URL/health"
printf '\n'
curl --fail --silent --show-error --max-time 20 "$BASE_URL/ready"
printf '\n'
curl --fail --silent --show-error --max-time 20 "$BASE_URL/"
printf '\n'
```

Confirm that each response is valid JSON and reports the expected service and environment metadata. Do not infer dependency health from a 200 response alone.

## Custom domain gate

Do not create a DNS record or Worker route until the intended public hostname and its ownership are confirmed against the architecture baseline and resource-ownership register. Check for existing DNS records, Workers routes, custom domains, certificate status, and service ownership first. Preserve existing service routes.

## Release gate

The production deployment workflow must:
1. Require the explicit `DEPLOY` confirmation input.
2. Run type-checking and verify Cloudflare credentials before deployment.
3. Check the deployed public health and readiness endpoints after deployment.
4. Fail if either endpoint returns a non-success HTTP status or unexpected JSON.
5. Record the workflow run URL and the resulting deployment version.

## Known implementation limits

This Worker is currently a health/readiness API foundation. Do not represent authentication, administrative mutation endpoints, D1/KV/R2 storage, queues, Durable Objects, or other control-plane services as implemented unless their code, bindings, access controls, tests, and recovery procedures are present and verified.
