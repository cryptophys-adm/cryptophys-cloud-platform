# Leaving GitHub: cut-over runbook (ADR-0012 G6)

Owner, 2026-11-12: "tunda hingga berhasil lepas dari github", then "lanjutkan G6 sambil menunggu". This page is the gate list and the procedure for step G6. G6 makes the Artifacts repository `cryptophys/platform` canonical and archives the GitHub repository. The archive is not a delete, and the owner decided it in ADR-0012 §6.3.

G6 runs only when every gate below is met. Each gate is measured, not assumed. Until then GitHub stays canonical, and nothing here changes production.

## Gates

| # | Gate | Replaces on GitHub | Status (2026-11-12) |
|---|---|---|---|
| 1 | Deploy decisions read the Forge (G1) | compare and CI lookups | done: merged in #301 |
| 2 | Forge keeps built modules (G2a) | Actions build | done: merged in #301 |
| 3 | Native deploy of code-only changes (G2b) | `deploy-*.yml` for code changes | built in #302; the owner confirmed the credentials are set |
| 4 | Native deploy of every other change: configuration and bindings, D1 migrations, Console assets, the multi-module Forge, recovery redeploys | `deploy-*.yml` for all changes | **partly built (G2c-1, ADR-0012 §5k):** additive D1 migrations, multi-module Workers and recovery redeploys. **Open (G2c-2):** configuration and binding changes, `[limits]` (so the Forge stays on its workflow), Console assets |
| 5 | The Forge merges with a fast-forward (G3a), and `merge_change` runs by consensus (G3b) | the merge button and branch protection | G3a in progress; G3b is enabled at step 4 of the procedure |
| 6 | Contributors push to `platform-work`; the Forge registers change requests from Artifacts (G4) | pull requests | **open**: G4 starts after G3a; the owner provides a repo-scoped write token for `platform-work` through the session's secure credential form |
| 7 | Dependency audit and secret scan (G5) | Dependabot, secret scanning | secret scan done (phase 3); dependency audit in progress |
| 8 | Off-Artifacts copy of the repository: a daily `git bundle` to R2 (ADR-0012 §5) | GitHub as the second copy | **open**: not built |
| 9 | Access provisioning for a new Worker without `provision-access.yml` | `provision-access.yml` | **open**; Access is critical (the owner's click) |
| 10 | Worker retirement through the Orchestrator's Scripts API | `retire-worker.yml` | **open** (critical action) |
| 11 | Rollback, alerts and owner notices off GitHub | `rollback-worker.yml`, `drift-alert.yml`, `owner-attention.yml` | done: native rollback (credentials set), Kernel notices |
| 12 | Checks and type-check off GitHub | `validate-control-plane.yml`, `forge-runner-parity.yml` | done: Forge checks plus Workers Builds; parity 34/34 checks and 78/78 plans |
| 13 | Secrets that leave with GitHub moved to the Secrets Store or Worker secrets | the GitHub `production` environment | **open**: waits for the owner's Secrets Store id |

## Procedure (when gates 1–13 are met)

Each step is reversible until step 7.

1. **Freeze.** Announce a merge freeze. No pull request merges on GitHub from here on.
2. **Final sync.** Run `mirror-to-forge.yml` once more. Confirm the Forge's `main` equals GitHub's `main` (Console Code page, or `GET /v1/forge/status`).
3. **Backup.** Take a fresh `git bundle` of `cryptophys/platform` to R2 (gate 8). Record its SHA-256.
4. **Flip the merge path.** Enable `merge_change` on canonical `main` (G3b), and turn off the GitHub-sourced change requests (`forge-change-request.yml`).
5. **Flip contributors.** Contributors push to `platform-work` only (G4). For Claude Code sessions, the push credential is the owner-provided `platform-work` token, injected by the session proxy and never shown.
6. **Retire GitHub paths.** Disable these workflows; they stay in the history:
   - `mirror-to-forge.yml`, `forge-ci-report.yml`, `forge-change-request.yml`;
   - the `deploy-*.yml` workflows, `rollback-worker.yml` and `retire-worker.yml`;
   - `provision-access.yml`, `access-diagnose.yml` and `d1-backup.yml`.

   The Orchestrator no longer needs `GH_ACTIONS_TOKEN`.
7. **Revoke and archive (owner).**
   1. Revoke the GitHub token used by the Orchestrator (dashboard: Workers → `cryptophys-deployment-orchestrator` → Settings → Variables and Secrets → delete `GH_ACTIONS_TOKEN`).
   2. Archive the repository on GitHub (Settings → General → Danger Zone → Archive this repository). Archiving is reversible by the owner, and nothing is deleted.
8. **Verify.**
   - One routine change goes through the whole path: push to `platform-work` → Forge checks → consensus `merge_change` → native deploy → Drift Detector in sync.
   - The Console Code page shows the merge.
   - The audit chain shows `forge.merged` and `deployment.*` events with no GitHub run.

## Rollback of the cut-over

Before step 7, rolling back means re-enabling the workflows and pushing the Forge's `main` back to GitHub.

After step 7, the owner un-archives the repository and sets a new token. The Forge's `main` is pushed to GitHub, and mirroring resumes from the Forge to GitHub until the cause is fixed.

## What stays on GitHub after G6

Nothing on the build, merge, deploy, rollback or alert path. The archived repository remains a read-only historical copy. Other repositories (`cryptophys-aether`, `xauusd-ai-trading-assistant`) follow only after the owner decides (ADR-0012 phase 6).
