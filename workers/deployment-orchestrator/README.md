# Deployment Orchestrator

This staging-configured Worker dispatches only \`.github/workflows/validate.yml\`, which performs source validation and a Wrangler dry-run. It does not dispatch the production deployment workflow and never deploys a Worker.

## Required gates

- \`GH_ACTIONS_TOKEN\`: repository-scoped GitHub token stored as a Worker secret, with Actions write and minimum read access for refs, commit statuses, check runs, and check suites.
- \`ORCHESTRATOR_SHARED_SECRET\`: independent high-entropy bearer secret stored as a Worker secret.
- \`POST /v1/deployments\` requires bearer authentication, \`SERVICE_ENVIRONMENT=staging\`, a full lowercase 40-character SHA equal to current \`main\`, and exact \`confirm_staging=STAGING_TEST\`.
- Commit statuses (when present), every check run, and every check suite must be complete and successful. Queued, in-progress, failed, cancelled, skipped, missing, or truncated/paginated results fail closed.
- A Durable Object atomically claims each SHA to prevent duplicate staging-validation dispatches. Ambiguous failures require manual reconciliation; do not delete claims blindly.
- The Worker config keeps \`workers_dev = false\` and adds no route or custom domain. Do not expose a public endpoint without a separately reviewed change.
- Readiness reports staging validation only; production dispatch is explicitly disabled.

## Staging-first activation

1. Provision the token and shared secret through the administrator-approved secret-management process; never commit or paste either value into source/chat.
2. Do not use production credentials or dispatch \`.github/workflows/deploy-platform-api.yml\` for staging tests.
3. Validate the non-deploying dispatch path only after an approved, non-public invocation method and staging secrets exist. Until then, CI can type-check and dry-run the Worker config, but live authenticated dispatch remains untested.
4. Verify GitHub production Environment reviewer protection separately before any future production activation.
5. Production orchestration requires a separate reviewed change after staging evidence. This PR does not authorize production secrets, routes, or deployment.
