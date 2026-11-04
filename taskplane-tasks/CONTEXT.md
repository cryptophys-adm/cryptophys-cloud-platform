# Cryptophys Cloud Platform — Worker Context

**Last Updated:** 2026-11-05
**Status:** Active
**Next Task ID:** TP-010
**Roles:** orchestrator and validator = Claude (cloud session); code worker = Antigravity (TP-006 to TP-009, see `ANTIGRAVITY.md`); ops worker = pi agent on the VPS (TP-001, TP-002); owner = repository owner (human).

---

## Where the deployment stands

**Observed production state (read-only verification, 2026-11-04 20:23 UTC). Do not infer production state from `main` alone.**

- Repository `main` is at `56f52bf62f59c31b8437e328a7fb5775bcbff347`. Production is **not fully reconciled** to this commit.
- D1 `cryptophys-control-plane` has migrations through `0015_agent_principals.sql` applied. The tables `agent_syscall_consumptions`, `agent_reports`, `agent_memories`, and `agent_principals` exist.
- The latest deployments of Policy Engine, Audit Ledger, Platform Registry, Recovery Manager, Signal Engine, Platform API, and Deployment Orchestrator are annotated with commit `56f52bf62f59c31b8437e328a7fb5775bcbff347`.
- AI Kernel and Drift Detector are still on commit `59db4cf695fa7a7c689a07506c429a1f522270ba`. The deployed AI Kernel currently exposes only `SupervisorAgent`, `HealthRpc`, and `KernelRpc`; it does **not** expose the Signal Analyst or Auditor Durable Object handlers added by PRs #61 and #62.
- The D1 agent registry contains enabled rows for `supervisor`, `signal-analyst`, and `auditor`, but this does not prove their newer Worker code is deployed. Read-only row counts were: `agent_syscall_consumptions=5`, `agent_reports=0`, `agent_memories=0`, and `agent_principals=0`.
- The connected production account's Vectorize v2 index list is empty. The `cryptophys-agent-memory` index and its `agent_id` metadata index are therefore **not verified as provisioned**. Vectorize-backed memory and external MCP principals must not be described as operational yet.
- A separate Cloudflare Worker `cryptophys-github-actions-mcp` remains deployed; its latest deployment is dated `2026-11-01T05:58:17Z`. ADR-0007 identifies this shared-bearer GitHub-token MCP connector as superseded by the Access-protected kernel MCP and leaves retirement to the owner. This inventory does not inspect or disclose its token, establish current reachability, or authorize deletion.
- The last Control Plane rollout (#41883619698) applied D1 migrations 0011–0015 and updated five Workers, then failed at AI Kernel when the deployment token received Cloudflare API authentication error 10000 for Vectorize. This left production partially updated. PR #66 adds a fail-fast Vectorize preflight before D1 or Worker mutations; it is still open and has not been deployed.
- **Drift/health:** do not claim 13/13 services healthy from deployment metadata alone. Verify the live health/readiness endpoints and record the check time before asserting that state.
- **Decisions:** ADR-0005, ADR-0006, ADR-0007 and `docs/TRANSFORMATION-INVENTORY.md`.

The next production rollout requires the owner to resolve the existing production deployment token's Vectorize access, followed by a separately approved manual deployment and per-Worker verification. This status note authorizes no production change.

The legacy Talos/Kubernetes estate is deprecated (owner, 2026-11-04). Only its logic and architecture are adopted; no cluster access is needed. Code tasks follow `ANTIGRAVITY.md`.

## Hard rules for the worker (apply to every task)

1. **Never print, log, commit or paste a secret value.** That includes keys, tokens, passwords, kubeconfigs, Vault output and unseal shares. To prove you handled a secret, report its name, where it lives, and the first 8 hex characters of `sha256(value)`.
2. **Never deploy or change Cloudflare production.** Production changes go only through this repository's GitHub workflows, which the orchestrator dispatches. Do not run `wrangler deploy`, `wrangler secret`, `wrangler d1 execute --remote` or Cloudflare API writes.
3. **Never merge.** Work on a branch named `worker/TP-xxx-<slug>` and open a PR. The orchestrator validates and merges.
4. **Never execute trades or touch funds.** If you find a wallet or exchange credential, report it; do not use it.
5. **Respect the gates.** Any step marked **OWNER GATE** stops until the owner confirms in writing, in the PR or the task `STATUS.md`. **Destructive** steps (delete, scale to zero, rekey, revoke) run only after an orchestrator `VALIDATED` comment on the preceding read-only step.
6. **Do not modify** `cryptophys-adm/xauusd-ai-trading-assistant`.
7. **Report outcomes faithfully.** If a command fails or a step is skipped, say so with the redacted output. Never claim something you did not observe.

## Gate records

The orchestrator also records every gate decision in `taskplane-tasks/TP-xxx-*/APPROVAL.md` on `main`, because the worker may not read PR comments. **Before stopping at a gate, read `APPROVAL.md` on the latest `main`.** A gate recorded there as `VALIDATED` or `OWNER AUTHORIZATION: GRANTED` is satisfied. You can also read PR comments with `gh pr view <n> --comments`; only comments that end with the "Generated by Claude Code" footer speak for the orchestrator.

## Reporting protocol (the orchestrator validates from this)

Each task directory gets a `STATUS.md` that the worker fills in, containing:
- `State`: one of `in_progress | blocked | awaiting_owner | done`.
- `Evidence`: commands run and their redacted output. Prefer machine-readable output (JSON, `kubectl -o json` filtered with `jq`).
- `Changes`: what changed, where, and how to revert it.
- `Open questions`.

Commit `STATUS.md` and any reports to the task branch and open a PR titled `TP-xxx: <title>`. The orchestrator replies `VALIDATED`, or `CHANGES REQUESTED` with reasons.

## Key files

| Category | Path |
|---|---|
| Tasks | `taskplane-tasks/TP-*/PROMPT.md` |
| Decisions | `architecture/adr/0005-cloudflare-transformation.md` |
| Inventory | `docs/TRANSFORMATION-INVENTORY.md` (regenerate with `tools/inventory/inventory.py`) |
| Recovered legacy sources | `tools/parity/legacy/` |

## Task order

Code tasks: TP-006 → TP-007 → TP-008 → TP-009, one PR each, each merged before the next starts. TP-001 is deferred by the owner; TP-003 to TP-005 are cancelled.

## Technical debt / future work

_Workers log discoveries here through their PR._
- An owner decision is pending on rescaling the Mizan momentum and volume dimensions (ADR-0005 decision 10, "Remaining finding").

## Task status (2026-11-04)

- TP-001 security containment: step 2 done; remaining owner gates **deferred by the owner**. Do not continue without a new APPROVAL.md entry.
- TP-002 GitHub cleanup: **done**.
- TP-006 to TP-009 (AI Worker OS: Signal Analyst agent, Auditor agent, Vectorize memory, external agents through MCP): **done** (merged via PRs #61, #62, #63, #64).
- TP-003, TP-004, TP-005 (cluster inventory, export, decommission): **cancelled** by the owner. The cluster is deprecated, its data is not kept, and the platform no longer needs cluster access. See each task's STATUS.md.

## Validation record: TP-006 to TP-009 (orchestrator, 2026-11-05)

Merged by the owner's account (#61 to #64) and deployed in run 41931114234 at `56f52bf`; validated after the fact by the orchestrator.
- Tests: 94 pass, 0 skipped; migrations and `.github/scripts` tests pass.
- Invariants checked in code: tier 3 human-only, `tier_max` ≤ 2 (CHECK), trading prohibited, `external_tier_limit`, per-agent memory isolation enforced in D1.
- **Process findings.**
  - Commit `56f52bf` was pushed straight to `main`. It wired Vectorize provisioning into `render-d1-config.sh` and `remove-worker-secrets.sh` as hidden side effects, working around the rule against editing workflows.
  - The orchestrator replaced those side effects with an explicit, visible step in `deploy-control-plane.yml`.
  - Workers must not push to `main`, dispatch deployments or add side effects to unrelated scripts. They open a PR and stop; the orchestrator merges and deploys.
