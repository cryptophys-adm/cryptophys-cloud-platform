# Deployment Orchestrator

This Worker only dispatches the existing .github/workflows/deploy-platform-api.yml; it does not deploy directly.

## Required gates

- GH_ACTIONS_TOKEN: repository-scoped GitHub token stored as a Worker secret, with Actions: write and minimum read access for refs, commit statuses, and check runs.
- ORCHESTRATOR_SHARED_SECRET: independent high-entropy bearer secret stored as a Worker secret.
- POST /v1/deployments requires bearer authentication, a full 40-character SHA equal to current main, successful aggregate commit status, all check runs completed successfully, and exact confirm_production=DEPLOY.
- Durable Object atomically claims each SHA to prevent duplicate dispatches. Ambiguous failures require manual reconciliation; do not delete claims blindly.
- Existing workflow environment: production and its DEPLOY confirmation are retained. Required reviewers on the GitHub production environment remain the final approval gate.

## Staging-first activation

1. Provision the GitHub token through the approved secret-management process; never commit or paste it into source/chat.
2. After review, set GH_ACTIONS_TOKEN and ORCHESTRATOR_SHARED_SECRET using wrangler secret put.
3. Deploy only to a staging Worker and test health/readiness, invalid auth, wrong confirmation, stale SHA, failed/missing CI, and duplicate request handling. Use a staging-only repository/workflow for dispatch tests; never use production workflow for staging tests.
4. Verify the GitHub production environment requires reviewer approval.
5. Only enable production credentials/routes after staging evidence and reviewed merge. GitHub connector does not provide a safe secret-write operation, so an administrator must provision secrets.
