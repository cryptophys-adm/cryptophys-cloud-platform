# Cryptophys Cloud Platform

Canonical source of truth for the Cloudflare-native Cryptophys platform.

## Repository contract

- Architecture baseline: architecture/BASELINE.md
- Security baseline: architecture/SECURITY.md
- Resource ownership: architecture/RESOURCE-OWNERSHIP.md
- Deployment runbook: docs/DEPLOYMENT.md
- Operations runbook: docs/OPERATIONS.md
- Workers: workers/ (Platform API, Deployment Orchestrator and five control-plane services)
- Control plane: docs/CONTROL-PLANE-WORKERS.md, docs/CONTROL-PLANE-DEPLOYMENT.md, ADR-0004

Git is the source of truth for platform design and code. This repository contains no production secrets. Merging code does not deploy production infrastructure; production deployment is manually triggered and gated by the GitHub production Environment.

## Implemented and deployed to production

- Seven Workers are deployed from exact `main` commits through three manually dispatched production workflows (Platform API, Deployment Orchestrator, and the five-service Control Plane deployment); each deployed Worker is verified live:
  - `cryptophys-platform-api`: health and readiness API.
  - `cryptophys-deployment-orchestrator`: CI-gated, locked (Durable Object) and audited Platform API deployments.
  - `cryptophys-platform-registry`, `cryptophys-policy-engine`, `cryptophys-audit-ledger`, `cryptophys-recovery-manager`, `cryptophys-drift-detector`: the control plane (ADR-0004).
- D1 database `cryptophys-control-plane` with reviewed migrations and Time Travel restore points before every migration.
- A hash-chained, append-only audit ledger.
- Drift detection of every Worker's version and health over RPC service bindings, every 15 minutes.
- Cloudflare Access in front of every Worker, with the JWT verified inside each Worker. Authorization is by verified identity: operators and recovery approvers are allow-lists of Access identities, and there are no shared bearer tokens.
- Each of the six control-plane Workers (Deployment Orchestrator plus five control-plane services) has its own advisory Workers AI binding and daily budget; the Platform API has no AI binding. AI never makes authoritative decisions.
- Validation CI, SHA-pinned actions and Dependabot.

## Not yet provisioned or implemented

KV, R2, Queues, Workflows, DNS automation and a remote IaC state backend (see STATE-AND-RECOVERY.md). Add them in reviewed increments with explicit ownership, account-specific configuration, tests and recovery plans.
