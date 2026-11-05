# TP-018 status

State: merged — retirement configuration is in main and the control plane deployment completed; deletion of the legacy Cloudflare Worker remains owner-gated.

## Merge record

- Prerequisite PR #109 merged at 2026-11-05T13:47:53Z; merge SHA: `8d0d0d97dcc23838610646dd54ac240df0bf5a6c`.
- PR #110 merged at 2026-11-05T13:50:59Z; merge SHA: `15799daefd670a15bb028a4ef089406d6b16d692`.
- TP-018 PR #108 merged by `cryptophys-adm` at 2026-11-05T13:52:53Z.
- PR #108 head: `a5277db8c204adeb92048c0fdd5cf29db87c7dc3`.
- Merge/main SHA: `d81ce4040ddc89e66b02656f311ba783bd5b4c2d`.

## Pre-merge validation

- `Validate` run #42039480728: SUCCESS; 3/3 checks passed.
- `Validate Control Plane Workers` run #42039480809: SUCCESS.
  - Type-check: PASS.
  - Endpoint/library tests: **117/117 PASS, 0 failed, 0 skipped, 0 todo**.
  - Isolated SQLite migration tests: PASS.
  - Dry-run bundles: all 7 remaining active Worker configs passed.
- Current-head GitHub Actions checks: 4/4 SUCCESS.
- Copilot reviews failed due quota; Codex review failed due usage limit. No independent human approval was recorded. These failures are not approvals.

## Post-merge validation and deployment

- Main push `Validate` run #42039715049: SUCCESS; 3/3 checks.
- Main push `Validate Control Plane Workers` run #42039715075: SUCCESS; 117/117 tests, migration tests, and all 7 active Worker dry-run bundles passed.
- Control Plane deployment run #42039749459: SUCCESS, event `workflow_dispatch`, exact commit `d81ce4040ddc89e66b02656f311ba783bd5b4c2d`. This run was triggered externally by the repository owner; this automation did not dispatch it.
- D1 migrations, including 0020, applied successfully.
- Six Control Plane Workers were deployed and live-verified: Policy Engine, Audit Ledger, Platform Registry, Recovery Manager, AI Kernel, and Drift Detector. Deployment Orchestrator and Platform API retain their separate workflows.
- Post-deploy drift observation: **0 drifted services**.
- The `cryptophys-signal-engine` registry row was reported as `disabled`, with no observed version and no drift. The Drift Detector did not probe it.
- Supervisor operator cycle completed with `platform.observe` successful.
- Agent report summary was healthy; the deployment workflow's audit-chain and Policy Engine negative-decision checks passed.
- The legacy Signal Engine Worker was **not deleted** by this deployment. Deletion remains a separate, explicit owner action.

## Data and architecture safety

- Migration 0020 contains only updates to the service registry and agent rows/grants. It has no DROP or DELETE statements.
- Historical crypto tables and rows remain retained.
- The XAUUSD Mizan/Prophet/GMI ownership boundary remains external and unchanged.
- `architecture/BASELINE.md` is unchanged; ADR-0005, ADR-0006, and ADR-0007 carry dated retirement amendments.
- No secrets, permissions, rulesets, branch protection, or production resources were changed by this automation.

## Post-merge operational follow-up

- Keep `cryptophys-signal-engine` in the Cloudflare Access application destinations while the legacy Worker remains deployed. Removing its destination before the Worker is deleted or workers.dev is disabled could remove Access protection from a still-live endpoint.
- `.github/workflows/provision-access.yml` therefore intentionally retains the legacy Worker in its destination list and now documents why.
- The drift alert inventory must exclude the disabled legacy service from the active expected Worker count and must not flag a disabled row as stale. A follow-up PR adds this behavior and regression coverage.
- The repository's `main` branch reports `protected: false`; the repository rulesets endpoint returns an empty list. Branch-protection details remain inaccessible through the integration (HTTP 403). Independent approvals and required-check enforcement are not established.
