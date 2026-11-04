# Cryptophys Cloud Platform

Canonical source of truth for the Cloudflare-native Cryptophys platform.

## Repository contract

- Architecture baseline: architecture/BASELINE.md
- Security baseline: architecture/SECURITY.md
- Resource ownership: architecture/RESOURCE-OWNERSHIP.md
- Deployment runbook: docs/DEPLOYMENT.md
- Operations runbook: docs/OPERATIONS.md
- Workers: workers/ (Platform API gateway, Deployment Orchestrator, five control-plane services, Signal Engine and the AI Kernel)
- AI Worker OS: architecture/adr/0007-ai-worker-os.md (agents, autonomy tiers, MCP front door); Workflows: ADR-0006
- Control plane: docs/CONTROL-PLANE-WORKERS.md, docs/CONTROL-PLANE-DEPLOYMENT.md, ADR-0004

Git is the source of truth for platform design and code. This repository contains no production secrets. Merging code does not deploy production infrastructure; production deployment is manually triggered and gated by the GitHub production Environment.

## Implemented and deployed to production

- Eight platform Workers are deployed from exact `main` commits through three manually dispatched production workflows (Platform API, Deployment Orchestrator, and the Control Plane workflow deploying five control-plane services plus Signal Engine), with each Worker verified live. The four live xauusd Workers are registered and health-monitored, without changes to their repository (ADR-0005):
  - `cryptophys-platform-api`: health and readiness API.
  - `cryptophys-deployment-orchestrator`: CI-gated, locked (Durable Object) and audited Platform API deployments.
  - `cryptophys-platform-registry`, `cryptophys-policy-engine`, `cryptophys-audit-ledger`, `cryptophys-recovery-manager`, `cryptophys-drift-detector`: the control plane (ADR-0004).
- D1 database `cryptophys-control-plane` with versioned migrations and a Time Travel restore point recorded before each migration batch.
- A hash-chained, append-only audit ledger.
- `cryptophys-signal-engine`: the apps-gitops signal-edge (trend, volume, momentum, volatility, structure, multi-timeframe confluence) and Mizan (KWW, regime, confluence, advisory risk levels) engines, migrated off Kubernetes from source recovered in apps-gitops history, with parity fixtures from the original Python (pandas_ta_classic 0.4.47) and compiled Rust (ADR-0005 decision 8; inventory in docs/TRANSFORMATION-INVENTORY.md).
- Drift detection every 15 minutes: the Drift Detector observes its own version and health locally, its seven platform peers over RPC, and the four external xauusd Workers for health only over private service bindings.
- Cloudflare Access in front of every platform Worker, with the JWT verified inside each platform Worker. Authorization is by verified identity: operators and recovery approvers are allow-lists of Access identities, and there are no shared bearer tokens.
- **AI Worker OS (ADR-0007).** `cryptophys-ai-kernel` runs agents as Durable Object processes. Every agent action is a policy-gated syscall by autonomy tier: 0 observe, 1 propose (a human approves), 2 reversible act (rate limited, with a kill switch), 3 human only. Trading is prohibited at every tier. Operators and external AI clients use the Access-protected MCP endpoint `POST /mcp`.
- Every platform Worker is AI-based: all nine have a dedicated Workers AI engine with a daily budget, including the Platform API gateway (`GET /v1/overview?advisory=true`) and the AI Kernel. AI never makes authoritative decisions; it drafts and explains.
- Validation CI, SHA-pinned actions and Dependabot.

## Not yet provisioned or implemented

KV, R2, Queues, Workflows, DNS automation and a remote IaC state backend (see STATE-AND-RECOVERY.md). Add them in reviewed increments with explicit ownership, account-specific configuration, tests and recovery plans.
