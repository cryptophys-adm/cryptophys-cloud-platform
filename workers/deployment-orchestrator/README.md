# Deployment Orchestrator

This Worker carries out the platform's deploys. Since 2026-11-14 (owner: "hapus aja, karena roadmap berikutnya kita kembangkan Human Ai Interaction & Collaboration") the only paths to production are consensus (`deploy_commit`: the native deploy, or the unit's GitHub workflow as the consensus-driven fallback), the owner's click on critical actions, and native rollback (`docs/SSOT.md`, "Paths to production"). The AI Kernel and the Recovery Manager reach it over RPC (`DeployRpc`); it has no HTTP route that deploys.

## HTTP

- `GET /health`, `GET /ready`: behind Cloudflare Access like every `/v1` call.
- `GET /v1/deployments`: the read-only deployments list for the Console's Pipelines page (operators and viewer accounts).
- Any other method on `/v1/deployments` answers 405. The manual `POST /v1/deployments` (a GitHub ref lookup and CI gate, then a dispatch of `deploy-platform-api.yml`) and its allow-list `DEPLOY_ALLOWED_IDENTITIES` were removed on 2026-11-14.

## Required gates

- `GH_ACTIONS_TOKEN`: least-privilege repository token stored as a Cloudflare Worker secret, for the consensus-driven workflow fallback, the rollback workflow before the native path, and the ledger reconcile. Fine-grained PAT permissions: Actions: Read and write, Commit statuses: Read, Contents: Read, Metadata: Read. Never commit it.
- A consensus or recovery deploy re-verifies its proposal or plan, requires the commit to be the Forge's main head with the Forge's checks `ready` (and, for the fallback, GitHub's main to be the same commit), and claims a Durable Object lock per workflow and commit, so a commit is queued natively or dispatched once. A refused fallback is audited as `deployment.no_path`.
- The deploy workflows independently validate the SHA against the dispatched workflow ref, check out that exact SHA and roll back automatically on failure. Any configured reviewer approval on the GitHub Environment remains authoritative.
