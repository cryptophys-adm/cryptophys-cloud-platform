# Deployment Orchestrator

This Worker coordinates production deployment of `.github/workflows/deploy-platform-api.yml`. It is configured for the production environment and dispatches only after the exact current `main` commit has completed all required CI checks successfully.

## Required gates

- `GH_ACTIONS_TOKEN`: the runtime fine-grained PAT has Actions: Read and write, Commit statuses: Read, Contents: Read, and Metadata: Read; it does not have the GitHub App-only `Checks` permission. GitHub permits unauthenticated reads of Check Runs and Check Suites for public repositories. `ciGreen` first uses the scoped token, then retries those two read-only endpoints anonymously only when the token receives HTTP 401/403. If the repository becomes private, the anonymous fallback fails closed; a runtime GitHub App token broker with Checks: Read is then required. Do not store a static one-hour installation token. This PR does not create, rotate, or change secrets or permissions.
- `DEPLOY_ALLOWED_IDENTITIES` (var, set by the deploy workflow): Cloudflare Access identities allowed to `POST /v1/deployments` — the CI service token's Client ID and the operator emails. Callers authenticate through Cloudflare Access; the Worker verifies the Access JWT and checks the identity. There is no shared bearer secret. Never commit `GH_ACTIONS_TOKEN`.
- `POST /v1/deployments` requires bearer authentication, `SERVICE_ENVIRONMENT=production`, a full lowercase 40-character SHA equal to current `main`, and exact `confirm_production=DEPLOY`.
- Commit status must be successful; the latest push/main validation workflows and their linked Check Runs/Check Suites must be complete and successful. All external-app Check Suites are also required. Scheduled, operator-branch, and production `workflow_dispatch` suites are excluded because they are not commit CI; their outcomes remain visible in workflow monitoring but do not poison later CI attempts. Queued, in-progress, failed, cancelled, skipped, missing required evidence, truncated responses, or missing suite mappings fail closed.
- A Durable Object atomically claims each SHA to prevent duplicate production dispatches. Ambiguous failures require manual reconciliation; do not delete claims blindly.
- The production workflow independently validates the SHA against the dispatched workflow ref and checks out that exact SHA.
- The deployment job uses GitHub Environment `production`; any configured reviewer approval remains authoritative.
- `workers_dev = false`; routes and custom domains are managed separately.

## Production activation

1. Store secrets through Cloudflare secret management; do not place secret values in source or chat.
2. Merge this reviewed change only after CI and required reviewer approval succeed.
3. Verify the live Worker health/readiness and inspect GitHub Actions deployment status after activation.
4. The orchestrator does not bypass GitHub Environment protections. An accepted dispatch is not proof that deployment completed.

- Both required main push workflow runs must map to returned Check Suites through `check_suite_id`; missing mappings fail closed.