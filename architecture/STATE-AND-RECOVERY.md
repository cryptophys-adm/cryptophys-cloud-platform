# Infrastructure State and Recovery Contract

**Status:** Approved baseline for implementation; backend provisioning remains pending.  
**Scope:** Provisioning and lifecycle management of resources owned by Cryptophys Cloud Platform.

## Authority and state separation

1. Git on `main` is the authoritative desired state: Worker source, Wrangler configuration, infrastructure definitions, policy, and runbooks.
2. Cloudflare API is the observed live state. Deployment/reconciliation must compare it with the reviewed desired state; never infer success from a CI exit code alone.
3. Terraform/OpenTofu state is operational metadata, not the source of truth for design and must never exist only on an ephemeral CI runner.
4. Do not commit state, plan files, credentials, provider cache, or state backups to Git.
5. Never run concurrent production applies against the same state.

## Backend decision

For any future Terraform/OpenTofu-managed resources, use a dedicated remote backend with:
- server-side encryption at rest and TLS in transit;
- state locking or an equivalent enforced single-writer mechanism;
- state history/versioning and recoverable prior versions;
- least-privilege access scoped to this platform;
- access audit logs and a documented restore procedure;
- separate state keys/workspaces per environment, with production isolated from non-production.

**Do not use a local state file or runner filesystem as production state.** CI must fail closed if the configured remote backend or locking prerequisite is absent.

The backend itself is not provisioned by this change. Before selecting Cloudflare R2 or another backend, verify the provider's current support for locking, conditional writes, version recovery, and access controls. Do not claim R2 is production-safe for state locking until that verification is recorded in an ADR and tested. Do not place the state backend under management by the same state it stores; bootstrap and recovery ownership must be independent.

The current Worker-only deployment uses Wrangler and does not require Terraform state. Do not introduce Terraform/OpenTofu solely to deploy the existing Worker.

## Change and apply controls

- Pull requests run formatting, static validation, policy checks, and plan/diff generation only.
- Production mutation is manually triggered from a reviewed commit and requires the protected GitHub `production` Environment.
- Before apply, record repository commit SHA, backend/workspace, plan identifier or digest, and operator/approval context in the deployment log.
- Reject unreviewed destructive changes. Resource deletion, DNS/domain changes, and replacement of persistent resources require explicit review.
- Never print state, plan contents, API tokens, or secret values in logs or artifacts.
- CI permissions must be read-only by default; grant write permissions only to the approved production deployment job.

## Recovery procedure

1. **Stop writes:** disable or cancel new provisioning/deployment runs; prevent concurrent applies.
2. **Classify:** identify whether the incident is code/configuration drift, a failed apply, lost/corrupt state, or a Cloudflare resource outage.
3. **Preserve evidence:** record commit SHA, workflow run URL, timestamp, backend/workspace, state object/version identifier, and relevant Cloudflare resource IDs. Do not copy secrets into the incident record.
4. **Restore state only if required:** use the backend's documented version recovery/backup process; restore to a new recoverable version or isolated recovery key first where supported. Never overwrite the only known-good copy blindly.
5. **Reconcile:** compare restored state with live Cloudflare resources using read-only inspection. Do not run apply/import/destroy until discrepancies are reviewed.
6. **Plan:** produce a fresh plan from the reviewed commit and recovered state. Require human review of resource additions, replacements, and deletions.
7. **Apply and verify:** run the approved production workflow; verify health, resource inventory, and expected bindings/routes.
8. **Close out:** preserve the timeline, plan digest, approval, recovery actions, and post-incident follow-ups in the audit record.

If state cannot be trusted, stop and escalate for manual inventory/reconciliation. Never create a new empty production state and apply it against existing resources without a reviewed import/adoption plan.

## Current implementation status

- Existing Worker deployment: Wrangler-based; no Terraform/OpenTofu state is currently required.
- Remote IaC state backend: **not provisioned**.
- State locking/version recovery: **not yet tested**.
- Automated drift detection and recovery: **not implemented**.
- Production deployment: must remain gated until required GitHub Environment secrets and protections are configured.
