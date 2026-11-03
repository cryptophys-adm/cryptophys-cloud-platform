# Deployment Orchestrator

This Worker coordinates production deployment of `.github/workflows/deploy-platform-api.yml`. It is configured for the production environment and dispatches only after the exact current `main` commit has completed all required CI checks successfully.

## Required gates

- `GH_ACTIONS_TOKEN`: least-privilege repository token stored as a Cloudflare Worker secret. Fine-grained PAT permissions: Actions: Read and write (read workflow runs for the CI gate, dispatch deployments), Commit statuses: Read, Contents: Read, Metadata: Read. The Checks API is not used because fine-grained PATs cannot be granted it.
- `ORCHESTRATOR_SHARED_SECRET`: independent high-entropy bearer secret stored as a Cloudflare Worker secret. Never commit either secret.
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
