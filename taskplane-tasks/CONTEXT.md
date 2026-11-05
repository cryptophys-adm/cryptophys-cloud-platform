# Cryptophys Cloud Platform — Worker Context

**Last Updated:** 2026-11-05
**Status:** Active
**Next Task ID:** TP-022 (TP-020 reserved: fix AI drafts from TP-016 data, if the Auditor digest still fails)
**Roles:** orchestrator and validator = Claude (cloud session); code worker = pi agent on the VPS with Reflection's `beam` model from TP-012 (see `PI.md`; Antigravity did TP-006 to TP-009 and is out of quota); ops worker = pi agent on the VPS (TP-001, TP-002); owner = repository owner (human).

---

## Where the deployment stands

**Verified production state (orchestrator, 2026-11-05 15:50 UTC). Do not infer production state from `main` alone; re-verify it before asserting it.**

- **Last deploy:** Deploy Control Plane run 42058008673 at `6c531bb`: success. Platform API run 42054089679 at `4909c89`: success.
- **Workers:** 8 platform Workers.
  - Platform API, Deployment Orchestrator, Platform Registry, Policy Engine, Drift Detector, Audit Ledger, Recovery Manager, AI Kernel.
  - The crypto Signal Engine was **retired and deleted** (TP-018). Its D1 history is kept.
  - The registry has 13 services: the 8 above, 4 xauusd Workers (health only) and the disabled `cryptophys-signal-engine` row.
- **D1:** migrations through `0020_retire_signal_engine.sql`.
- **Agents:**
  - `supervisor`: tier 2, enabled. No tier-2 capability exists any more.
  - 30 tier-1 agents, enabled.
  - `signal-engine`: suspended.
  - Kill switch on. No external principals.
- **Signal Analyst:** reads XAUUSD decisions (TP-017) and publishes `xauusd_digest`. It runs at minute 22 and makes no AI call.
- **Reports and alerts:**
  - Seven per-Worker agents publish advisory reports (TP-011 to TP-014).
  - `observe()` carries `agent_reports_24h` (TP-015, #115) and `xauusd_latest` (TP-019).
  - Drift Alert opens GitHub issues for drift and for critical reports. Issues never include report subjects.
- **AI:**
  - Text drafts failed until TP-016 fixed the object-response handling. The first successful draft was on 2026-11-05 at 13:07.
  - Every draft passes the advisory-language guard. The guard fails closed: TP-019 and #121.
  - `ai_failures` records failure categories.
  - TP-020 is reserved in case the Auditor digest still fails.
- **Retention (TP-021):** drift observations are kept 90 days (03:00 UTC), and syscall consumptions 7 days (03:07 UTC).
- **Drift:** 0 at 15:46 UTC.
- **Open recovery plans:** 5 stale supervisor drafts from 2026-11-04 18:37. **Do not approve them.** They expire automatically (`approval_expired`) after 72 h.
- **Decisions:** ADR-0005, ADR-0006 and ADR-0007, each with its 2026-11-05 amendments, and `docs/TRANSFORMATION-INVENTORY.md`.
- **Repository:** temporarily **public**, an owner decision for Actions billing. Treat every issue, PR and log as public.

The legacy Talos/Kubernetes estate is deprecated (owner, 2026-11-04). Only its logic and architecture are adopted; no cluster access is needed. Code tasks follow `PI.md`.

## Owner decisions (2026-11-05)

- **The signal role moves to XAUUSD.** The Signal Analyst reads `xauusd-ai-trading-assistant` decisions (TP-017), and the crypto Signal Engine (BTC/ETH/SOL) is retired (TP-018). The platform never changes the xauusd repository; it reads that repository's read-only API through an in-account Service Binding.

- **Data retention (TP-021).** Keep `drift_observations` for 90 days, always keeping the 2 newest per service. Keep `agent_syscall_consumptions` for 7 days. Never delete audit events, policy decisions, reports, plans, deployment requests, the registry or crypto history.

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

Code tasks TP-006 to TP-010 are done (one PR each). TP-001 is done; TP-003 to TP-005 are cancelled.

## Technical debt / future work

_Workers log discoveries here through their PR._
- **Mizan rescaling: authorized by the owner, in writing, 2026-11-05** ("hapus branch, skala ulang mizan, dan daftarkan agent external"). Implemented as ADR-0005 decision 11 (`mizan-revised/2`). Orchestrator note: commits pushed by another session to `claude/gracious-brown-tkc4e8` (the volume fail-closed fix) were merged with #80. A later orchestrator force-push removed them from the branch only, not from `main`. Other sessions must not push to the orchestrator branch; use their own branch and open a PR.

## Task status (2026-11-04)

- TP-001 security containment: **done** (2026-11-05). The cluster was destroyed, the owner revoked the external credentials (B1, B2 and B4 on the owner's statement), and both gitops repositories are verified archived.
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
- **Owner ratification (2026-11-05):** "lanjutkan validasi untuk accept semua commit dan PR yang dikerjakan oleh akun saya" (continue validating, to accept all commits and PRs made by my account). The owner accepts the work done from the owner account (#53, #57, #59, #61 to #64, `56f52bf`, #66, #67) after the orchestrator's validation recorded above. #66 and #67 were integrated by the orchestrator, merged with #68. Going forward, the process rule above applies.
