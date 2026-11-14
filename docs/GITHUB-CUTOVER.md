# Leaving GitHub: cut-over runbook (ADR-0012 G6)

Owner, 2026-11-12: "tunda hingga berhasil lepas dari github", then "lanjutkan G6 sambil menunggu". This page is the gate list and the procedure for step G6. G6 makes the Artifacts repository `cryptophys/platform` canonical and archives the GitHub repository. The archive is not a delete, and the owner decided it in ADR-0012 §6.3.

G6 runs only when every gate below is met. Each gate is measured, not assumed. Until then GitHub stays canonical, and nothing here changes production.

## Gates

| # | Gate | Replaces on GitHub | Status (2026-11-12) |
|---|---|---|---|
| 1 | Deploy decisions read the Forge (G1) | compare and CI lookups | done: merged in #301 |
| 2 | Forge keeps built modules (G2a) | Actions build | done: merged in #301 |
| 3 | Native deploy of code-only changes (G2b) | `deploy-*.yml` for code changes | built in #302; the owner confirmed the credentials are set |
| 4 | Native deploy of every other change: configuration and bindings, D1 migrations, Console assets, the multi-module Forge, recovery redeploys | `deploy-*.yml` for all changes | **partly built:** G2c-1 (ADR-0012 §5k) moves additive D1 migrations, multi-module Workers and recovery redeploys onto the native path. G2c-2 (§5l) wires configuration and binding changes and `[limits]` for Workers without static assets: the Forge keeps each wrangler.toml, the plan is checked against the active version, the uploaded version is verified (bindings and `script_runtime`) before traffic, and schedules and observability are applied after the live check and restored on failure. G2c-2 step 6 wires the Console's assets: eligible only when the Forge stored the commit's Console build and every file matches, `[assets]` is unchanged, the stored `index.html` has no inline script, and the script list (read with `CF_DEPLOY_TOKEN`) reports the route `nexus.cryptophys.work/console*`; the assets are uploaded before the version, or kept when the build is the same. **First native control-plane deploy succeeded live** on 2026-11-13 08:22–08:25 (6144659). Step 7 (#312) is live since the Forge's deploy at 6144659 (08:17): the first stored Console build is ea9ab59's (08:47, 3 files, 1.06 MB) and the main type-check build succeeds. The Console deploy at 6144659 (08:38) still ran `deploy-console.yml` because that commit had no stored build; the Console's first native deploy is not yet run. **Open:** the workflow's smoke tests through Access, which the native path does not repeat (§5l), and the changes the plan refuses (routes, Durable Object migrations, workflows, deploy-time `--var` values) |
| 5 | The Forge merges with a fast-forward (G3a), and `merge_change` runs by consensus (G3b) | the merge button and branch protection | G3a merged in #305; since 2026-11-13 the Forge tick runs the spike on the scratch repository until it has succeeded once (no approver call). **G3b built** (2026-11-13): `merge_change` / `merge_owner_change`, the vote on the Forge's verdict, the Policy Engine's `merge_path_forge` check and the Forge's `MergeRpc` executor; off until step 4 flips `forge_controls.merge_path` |
| 6 | Contributors push to `platform-work`; the Forge registers change requests from Artifacts (G4) | pull requests | G4 merged in #305. **2026-11-13:** the owner forked `platform` into `platform-work` and gave this session a write token (secure form); a push from the session succeeded. The type-check source is the Forge itself: it copies a request's head to `cr/<cr_id>` of `platform`, which `cryptophys-forge-typecheck-cr` builds (`transfer.ts`) |
| 7 | Dependency audit and secret scan (G5) | Dependabot, secret scanning | done: secret scan (phase 3, plus the `npm_token` rule) and the daily npm dependency audit (G5, merged in #305) |
| 8 | Off-Artifacts copy of the repository: a daily `git bundle` to R2 (ADR-0012 §5, §5m) | GitHub as the second copy | **built; first runs succeeded live** (2026-11-13 08:20 at 6144659 and 08:50 at ea9ab59, 4.1 MB, 5,395 objects); `git bundle verify` of a stored bundle is not yet done. The Forge tick step `git_backup` clones `platform` over Git smart HTTP once per UTC day per head of main, writes `git-backups/platform/<date>-<sha>.bundle` to `cryptophys-forge-bundles` with its SHA-256 (migration 0054, `GET /v1/forge/git-backup`, Console Code page), and keeps the newest bundle of each of the last 30 days. Met once a run against Artifacts has succeeded and its bundle passes `git bundle verify` |
| 9 | Access provisioning for a new Worker without `provision-access.yml` | `provision-access.yml` | **built, not yet run live** (2026-11-13, ADR-0012 §5o): the owner set `CF_ACCESS_TOKEN` on the Orchestrator. Each hour the Supervisor compares the Access application with the workflow's definition (`native-access.ts`); a difference is one critical `change_access` proposal listing its changes, which waits for the owner's click. Then the Orchestrator applies exactly that plan, bootstrapping a new Worker as a private stub first, and reads the result back. Operator emails and the CI token are kept as they are live; the application and the group must already exist. Met once one owner-approved change has applied live |
| 10 | Worker retirement through the Orchestrator's Scripts API | `retire-worker.yml` | **built, live, not yet run** (2026-11-13, ADR-0012 §5n; the Orchestrator runs 1976d75, and `cryptophys-home` was retired through `retire-worker.yml` at 07:13–07:17, before that deploy): with the native credentials, an owner-approved `retire_worker` is queued and run by the Orchestrator (`native-retire.ts`). The plan reads the workflow's gates from the Forge's bundles for main. The run detaches the custom domains, deletes the Workflow and the script without `force`, and verifies them gone. It falls back to the workflow only when `CF_DEPLOY_TOKEN` may not read something (401/403). Met once one owner-approved native retirement has succeeded live |
| 11 | Rollback, alerts and owner notices off GitHub | `rollback-worker.yml`, `drift-alert.yml`, `owner-attention.yml` | done: native rollback (credentials set), Kernel notices |
| 12 | Checks and type-check off GitHub | `validate-control-plane.yml`, `forge-runner-parity.yml` | done: Forge checks plus Workers Builds; parity 34/34 checks and 78/78 plans |
| 13 | Secrets that leave with GitHub moved to the Secrets Store or Worker secrets | the GitHub `production` environment | **open**: waits for the owner's Secrets Store id |

## Procedure (when gates 1–13 are met)

Each step is reversible until step 7.

1. **Freeze.** Announce a merge freeze. No pull request merges on GitHub from here on.
2. **Final sync.** Run `mirror-to-forge.yml` once more. Confirm the Forge's `main` equals GitHub's `main` (Console Code page, or `GET /v1/forge/status`).
3. **Backup.** Take a fresh `git bundle` of `cryptophys/platform` to R2 (gate 8). Record its SHA-256.
   - The Forge takes one by itself within one tick (:04/:19/:34/:49) of the final sync, because a new head of main is due at once (ADR-0012 §5m).
   - Read `GET /v1/forge/git-backup` (or the Console Code page) and check two things: `last_ok_run.main_sha` equals the Forge's main, and the run's `day` is today. Record `bundle_sha256`, `r2_key` and `objects`.
   - Download that object and check its SHA-256. Then run `git bundle verify <file>` and `git clone <file> platform-restore`; the clone must check out main at the same SHA.
4. **Flip the merge path.** A reviewed migration sets `forge_controls.merge_path` to `forge` (migration 0057 created it as `github`). From then on:
   - the Supervisor proposes `merge_change` for a `platform-work` change request whose every check passed (`would_merge`), or `merge_owner_change` when it touches a guard path (`needs_owner`, the owner's click);
   - the Policy Engine allows a merge only in that state (`merge_path_forge`);
   - the Forge's `MergeRpc` re-verifies the proposal, copies the head to `cr/<cr_id>` of `platform` and fast-forwards `main` (`forge.merged`).

   Turn off the GitHub-sourced change requests (`forge-change-request.yml`) in the same change. That change is the last one GitHub merges, and `mirror-to-forge.yml` must copy it to the Forge (run it by hand if the change disabled its trigger).
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

## Cut-over log (2026-11-13; owner: "kejar cut-over hari ini")

- Gate 6: the owner forked `platform` into `platform-work` and gave the orchestrator session a write token through
  the session's secure form; a push from the session succeeded. Interoperability of the Forge's own transfer
  (`transfer.ts`) was proven against Artifacts: a pack of 11 objects / 16 KB with `have <main>`.
- Gate 8: a full clone of the repository passes `git fsck --full --strict` (5,466 objects) and main's tree equals
  GitHub's. The Forge's R2 bundles are verified by their pack checksum and SHA-256.
- Gate 13: met without the Secrets Store. Every secret the native paths read is a Worker secret
  (`CF_DEPLOY_TOKEN`, `CF_ACCESS_TOKEN`, `CF_ACCOUNT_ID`, `ACCESS_GROUPS_TOKEN`); the GitHub `production`
  environment's secrets serve only the workflows this cut-over turns off.
- Steps 4–5: migration 0058 sets `forge_controls.merge_path = forge`; `mirror-to-forge.yml` keeps only a manual
  trigger (run once by hand for the cut-over commit; afterwards the Forge refuses its token) and
  `forge-change-request.yml` is off. Contributors push to `platform-work` (AGENTS.md).
- Known limit after the cut-over: a change that adds a Durable Object class (a DO migration) is refused by the native
  deploy (Cloudflare applies DO migrations only on a full script deploy). Until native DO migrations are built, such
  a change uses an existing class under another instance name.
- Steps 6–7 (retire the remaining GitHub paths, revoke `GH_ACTIONS_TOKEN`, archive the repository) follow after a day
  without incident, by the owner.

### After the flip (2026-11-13 17:55 to 2026-11-14 01:10)

- First Forge merges: `merge_owner_change` of `claude/adr-agentic-e0-e5` after the owner's click (18:22), then four
  `merge_change` by consensus without a person (18:53, 22:53, 23:23, 00:23; 8 of 8 each). The agents deployed the control
  plane (`44b13bf`) and the Forge (`6eedf61`, `595f052`).
- Three gaps found and fixed through `platform-work`:
  - two Supervisor tests compared a cycle's findings on the wall clock; from Friday 22:00 UTC (market closed, power mode
    survival) every check failed on GitHub and on the Forge (`44b13bf`);
  - a merged branch that was not deleted reopened its change request and erased its merge record (`6eedf61`);
  - a commit the Forge merged kept its change-request check, so its Worker bundles were never stored and the native deploy
    refused it (`no_bundle`); every deploy fell back to the GitHub workflow, which needs GitHub's main to equal the Forge's
    (`595f052`). Until a native deploy of a Forge-merged commit has succeeded, the owner allowed the orchestrator session to
    fast-forward GitHub's main to the Forge's main (2026-11-13), so the fallback keeps working.
- A deploy refused by both paths is audited as `deployment.no_path` with the native reason.
- Open before step 6: a migration the Forge marks destructive (an `UPDATE`, like 0058) has no native path
  (`destructive_migration`); with the workflows off it cannot be deployed. The two change requests reopened before the fix
  stay `closed` in D1; their merges are in the audit chain (`forge.merged`).

## Rollback of the cut-over

Before step 7, rolling back means re-enabling the workflows and pushing the Forge's `main` back to GitHub.

After step 7, the owner un-archives the repository and sets a new token. The Forge's `main` is pushed to GitHub, and mirroring resumes from the Forge to GitHub until the cause is fixed.

## What stays on GitHub after G6

Nothing on the build, merge, deploy, rollback or alert path. The archived repository remains a read-only historical copy. Other repositories (`cryptophys-aether`, `xauusd-ai-trading-assistant`) follow only after the owner decides (ADR-0012 phase 6).
