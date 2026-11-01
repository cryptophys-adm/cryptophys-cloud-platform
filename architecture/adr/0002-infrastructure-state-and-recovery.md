# ADR-0002: Infrastructure State and Recovery

- **Status:** Accepted as policy; backend selection/provisioning deferred until an IaC-managed resource requires it.
- **Date:** 2026-11-01

## Context

Production infrastructure provisioning must be recoverable and auditable. Ephemeral GitHub Actions runner storage is not durable and must not be treated as production state. The current platform's initial Worker is deployed with Wrangler and does not require Terraform/OpenTofu state.

## Decision

- Git is the canonical desired-state and code history.
- Cloudflare's live resource inventory is the observed state.
- If Terraform/OpenTofu is introduced, its state must use a durable remote backend with enforced single-writer locking, recoverable version history, encryption, least-privilege access, and auditability.
- Do not select R2 as a state backend until its current S3 API behavior is verified for the exact locking mechanism and recovery requirements. Backend bootstrap/recovery must not depend solely on the state it manages.
- Do not introduce an IaC state backend just for the current Wrangler-only Worker.
- Production mutations remain manually triggered and gated by GitHub Environment approval. Recovery begins by stopping writes, preserving evidence, restoring state only when needed, reconciling against live resources, then generating and reviewing a fresh plan before apply.

## Consequences

- No Terraform state is stored on CI runners or committed to Git.
- Backend provisioning is a separate reviewed change, with a documented test proving lock contention, version recovery, and access boundaries.
- The platform must explicitly report that remote state and automated recovery are not yet implemented until those tests pass.
