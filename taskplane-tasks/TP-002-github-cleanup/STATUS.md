# TP-002 GitHub Cleanup — STATUS

State: done

## Evidence

Read-only inventory completed. Environment secret and variable values are not included.

Production Environment (name: production, id 25912331663):

Secret names only:
- CF_ACCESS_CLIENT_ID
- CF_ACCESS_CLIENT_SECRET
- CLOUDFLARE_ACCESS_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID
- CLOUDFLARE_API_TOKEN
- CONTROL_PLANE_ADMIN_TOKEN
- CONTROL_PLANE_APPROVER_TOKEN
- ORCHESTRATOR_SHARED_SECRET

Variable names only:
- ACCESS_ALLOWED_EMAILS (value intentionally omitted)

Deployment branch policies (custom_branch_policies=true, protected_branches=false):
- main
- claude/gracious-brown-tkc4e8

Repository branches:
claude/gracious-brown-tkc4e8, copilot/fix-deploy-github-actions-job, docs/adr-0004-sync-access-consequences, docs/current-state, docs/current-worker-deployment-and-ai-counts, docs/readme-deployment-ai-claims, feature/activate-deployment-orchestrator, feature/cloudflare-pr-deployment-validation, feature/control-plane-operational-services, feature/control-plane-source-aligned-deploy, feature/control-plane-workers-foundation, feature/deploy-production-orchestrator, feature/deploy-production-orchestrator-rebased, feature/orchestrated-platform-api-deployment, feature/orchestrator-production-deploy-workflow, feature/platform-api-post-deploy-smoke-check, fix/access-header-whitespace-normalization, fix/orchestrator-healthcheck-workers-dev, fix/orchestrator-main-only-dispatch, fix/platform-api-dispatch-guard-dry-run, fix/platform-api-manual-production-deploy, fix/serialize-signal-engine-pacer-concurrency, fix/trusted-main-api-deployment-request, fix/trusted-main-api-request-v2, main, ops/platform-api-deploy-request

Grep proof (no workflow references the three tokens):
Command: grep -rn "CONTROL_PLANE_ADMIN_TOKEN\\|CONTROL_PLANE_APPROVER_TOKEN\\|ORCHESTRATOR_SHARED_SECRET" .github/
Result: exit code 1 (no matches)

## Changes

- Corrected the report to list variable names only; the prior commit included the allow-list email values, which are now omitted from the current file.
- The read-only inventory itself made no resource changes. The separately authorized Step 2 actions are recorded below; no permissions, rulesets, or branch-protection settings were changed.

## Step 2 (executed)

Owner approval: confirmed by owner to orchestrator, 2026-11-04 (see APPROVAL.md)

Before:
- Environment secrets: CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, CLOUDFLARE_ACCESS_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CONTROL_PLANE_ADMIN_TOKEN, CONTROL_PLANE_APPROVER_TOKEN, ORCHESTRATOR_SHARED_SECRET
- Deployment-branch policies: main, claude/gracious-brown-tkc4e8
- Branches included: ops/platform-api-deploy-request

After:
- Environment secrets: CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, CLOUDFLARE_ACCESS_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
- Deployment-branch policies: main
- Branch ops/platform-api-deploy-request: deleted
- Branch claude/gracious-brown-tkc4e8: retained (not deleted)
