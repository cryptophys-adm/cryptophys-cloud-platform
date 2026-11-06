# Deployment Orchestrator

This Worker coordinates production deployment of `.github/workflows/deploy-platform-api.yml`. It is configured for the production environment and dispatches only after the exact current `main` commit has completed all required CI checks successfully.

## Required gates

- `GH_ACTIONS_TOKEN`: the current runtime token is documented as a fine-grained PAT with Actions: Read and write, Commit statuses: Read, Contents: Read, and Metadata: Read. That token cannot read Check Runs or Check Suites. Phase 3 now requires both APIs and therefore **fails closed** with the current token. GitHub's Check Runs/Check Suites endpoints require a GitHub App user or installation token; fine-grained PATs do not expose a `Checks` repository permission. A GitHub App installation token expires after one hour, so do not store a static installation token as a long-lived Worker secret. Before enabling phase 3, implement an approved runtime App-token exchange or token broker (App ID, installation ID, and private key held as secrets) and grant the App only the required repository permissions: Checks: Read, Actions: Read and write, Commit statuses: Read, Contents: Read, Metadata: Read. Until that token path is provisioned, consensus deployment remains blocked by design. This PR does not create or rotate secrets or change permissions. The current Worker code does not implement App JWT signing or installation-token exchange; a static one-hour installation token is not a viable long-lived replacement. A runtime token provider/broker is a separate prerequisite, and `ciGreen` must remain fail-closed until it is implemented and configured.
- `DEPLOY_ALLOWED_IDENTITIES` (var, set by the deploy workflow): Cloudflare Access identities allowed to `POST /v1/deployments` — the CI service token's Client ID and the operator emails. Callers authenticate through Cloudflare Access; the Worker verifies the Access JWT and checks the identity. There is no shared bearer secret. Never commit `GH_ACTIONS_TOKEN`.
- `POST /v1/deployments` requires bearer authentication, `SERVICE_ENVIRONMENT=production`, a full lowercase 40-character SHA equal to current `main`, and exact `confirm_production=DEPLOY`.
- Commit statuses, every check run, and every check suite must be complete and successful. Queued, in-progress, failed, cancelled, skipped, missing, or truncated results fail closed.
- A Durable Object atomically claims each SHA to prevent duplicate production dispatches. Ambiguous failures require manual reconciliation; do not delete claims blindly.
- The production workflow independently validates the SHA against the dispatched workflow ref and checks out that exact SHA.
- The deployment job uses GitHub Environment `production`; any configured reviewer approval remains authoritative.
- `workers_dev = false`; routes and custom domains are managed separately.

## Production activation

1. Store secrets through Cloudflare secret management; do not place secret values in source or chat.
2. Merge this reviewed change only after CI and required reviewer approval succeed.
3. Verify the live Worker health/readiness and inspect GitHub Actions deployment status after activation.
4. The orchestrator does not bypass GitHub Environment protections. An accepted dispatch is not proof that deployment completed.
