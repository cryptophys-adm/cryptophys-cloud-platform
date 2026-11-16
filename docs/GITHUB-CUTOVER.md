# Leaving GitHub: cut-over runbook (ADR-0012 G6)

Owner, 2026-11-12: "tunda hingga berhasil lepas dari github", then "lanjutkan G6 sambil menunggu". This page is the gate list and the procedure for step G6. G6 makes the Artifacts repository `cryptophys/platform` canonical and archives the GitHub repository. The archive is not a delete, and the owner decided it in ADR-0012 §6.3.

G6 runs only when every gate below is met. Each gate is measured, not assumed. Until then GitHub stays canonical, and nothing here changes production.

## Gates

| # | Gate | Replaces on GitHub | Status (2026-11-12) |
|---|---|---|---|
| 1 | Deploy decisions read the Forge (G1) | compare and CI lookups | done: merged in #301 |
| 2 | Forge keeps built modules (G2a) | Actions build | done: merged in #301 |
| 3 | Native deploy of code-only changes (G2b) | `deploy-*.yml` for code changes | built in #302; the owner confirmed the credentials are set |
| 4 | Native deploy of every other change: configuration and bindings, D1 migrations, Console assets, the multi-module Forge, recovery redeploys | `deploy-*.yml` for all changes | **partly built:** G2c-1 (ADR-0012 §5k) moves additive D1 migrations, multi-module Workers and recovery redeploys onto the native path. G2c-2 (§5l) wires configuration and binding changes and `[limits]` for Workers without static assets: the Forge keeps each wrangler.toml, the plan is checked against the active version, the uploaded version is verified (bindings and `script_runtime`) before traffic, and schedules and observability are applied after the live check and restored on failure. G2c-2 step 6 wires the Console's assets: eligible only when the Forge stored the commit's Console build and every file matches, `[assets]` is unchanged, the stored `index.html` has no inline script, and the script list (read with `CF_DEPLOY_TOKEN`) reports the route `nexus.cryptophys.work/console*`; the assets are uploaded before the version, or kept when the build is the same. **First native control-plane deploy succeeded live** on 2026-11-13 08:22–08:25 (6144659). Step 7 (#312) is live since the Forge's deploy at 6144659 (08:17): the first stored Console build is ea9ab59's (08:47, 3 files, 1.06 MB) and the main type-check build succeeds. The Console deploy at 6144659 (08:38) still ran `deploy-console.yml` because that commit had no stored build; the Console's first native deploy is not yet run. **Gate 4 part A (2026-11-15, owner "1 setuju"), built, not yet run live:** (1) *Smoke tests through Access* (`native-smoke.ts`): `SMOKE_TABLE` holds, per unit, the workflow's own checks with its jq filters verbatim: for every Worker `verify-worker-live.sh --require-access` (an unauthenticated `GET /health` refused by Access, then `/health` and `/ready` with the service token), and each unit's smoke step that only reads (the Console's whoami, forwarding, allow-list, CSRF and `/console` mount probes and `https://nexus.cryptophys.work/console/health`; the Control Plane's audit-chain verify and kernel MCP, supervisor, consensus and status checks; the Forge's status). They run after each Worker's live check (before its new schedules and the part B topology) and after the whole unit (after every Worker's topology, before the desired version); a failed probe restores the applied topology, the script settings and every changed Worker, like a failed live check. A test reads the five workflows and requires every URL they request through Access to be in the table or in its `not_repeated` list with the reason (the steps that write: desired-version PUT, drift observe, audit append, policy evaluate, recovery plan, supervisor wake, Forge import; and the advisory custom-domain probe). The Orchestrator's config adds `compatibility_flags = ["global_fetch_strictly_public"]`, without which a Worker cannot fetch another Worker's workers.dev hostname (error 1042). (2) *Deploy-time `--var` values* (`deploy-vars.ts`): `DEPLOY_VARS` lists, per Worker, what each workflow passes (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OPERATOR_IDENTITIES`, `APPROVER_IDENTITIES`, `DEPLOY_ALLOWED_IDENTITIES`, `CF_ACCOUNT_ID`; a test derives it from the YAML). They are kept from the active version and now checked before the upload (present as `plain_text`, well formed, equal across the unit; the Access values and the account id equal the Orchestrator's own; the identity lists start with the Client ID of the Orchestrator's service token) and verified on the new version before traffic. A value no platform source holds refuses the deploy with its name (`deploy_var_unsourced:<NAME>`, `deploy_var_mismatch:<NAME>`, ...), read only at eligibility, so the unit stays on its workflow. The version tag (`commit[0:12]`) and the D1 `database_id` (resolved from the active binding) were already native. Both checks switch on together when the owner sets the Worker secrets **`CF_ACCESS_CLIENT_ID`** and **`CF_ACCESS_CLIENT_SECRET`** on `cryptophys-deployment-orchestrator` (the values of the GitHub production secrets of the same names, the `cryptophys-ci` service token; it must then not be revoked at step 7). Until then the values are kept unchecked and the smoke tests do not run (`/ready`: `native_smoke`, `native_deploy_vars`). The break-glass deploy keeps its own rules. *Readiness without GitHub (2026-11-15):* with the native deploy configured, the Orchestrator's `/ready` no longer requires `GH_ACTIONS_TOKEN`: the token serves only the GitHub workflow fallback, reported as `github_fallback: "available" | "absent"` and an informational `production_dispatch_enabled`; without the native deploy it stays a readiness check. The native smoke test of the Orchestrator drops the workflow's term `.production_dispatch_enabled == true`, listed in `not_repeated` ("GitHub fallback readiness; not a native readiness condition (cut-over step 7 revokes GH_ACTIONS_TOKEN)"), so revoking the token at step 7 does not fail its native deploys; nothing else (planner, Supervisor, Drift Detector) reads that field. **Gate 4 part B (2026-11-15, owner "1 setuju"; `deployment-orchestrator/src/topology.ts`, built, not yet run live):** routes, Durable Object migrations and Workflows are planned against the live state instead of refused. Native: a new custom domain (Workers Custom Domains API, after the live check, read back, detached again on a later failure); a new zone route only when the script list already reports it; an additive `[[migrations]]` step (`new_sqlite_classes`, `new_classes`) deployed through the Script Upload API with `{ old_tag, new_tag, steps }` once the live `migration_tag` is the running config's last tag, then checked (deployment, tag, bindings, live tag); a new or changed `[[workflows]]` registration (Workflows API `PUT`, after the live check, read back; an update is put back on a later failure, a created one is kept). Turning `workers_dev` / `preview_urls` on (both configs explicit) goes natively too. Destructive changes are **owner-click** (owner: after step 6 there is no GitHub fallback): the routine deploy refuses each with its reason (`custom_domain_removal_owner_run:…`, `route_changed_owner_run:…`, `do_migration_destructive:…`, `workflow_removal_owner_run:…`, `workers_dev_disable_owner_run:…`), and the break-glass deploy (`force_redeploy_unit`, written by one approver, approved by another) applies exactly the items its plan names in `destructive_topology` (custom domain removal or zone change, deleted / renamed / transferred DO classes, Workflow removal, workers.dev or previews off). Each is audited before it is applied; a DO class change and a Workflow removal first record that no restore can undo them (`deployment.destructive_topology_irreversible`), and the owner notice lists them. An unnamed item is refused; a named item not in main's change refuses the deploy (`named_topology_not_pending`). A DO migration is forward-only: Cloudflare refuses a rollback across it, so a failure after it ends `restored: false` with a critical report (`do_migrations`). Still refused, by an owner settings decision rather than a code gap: zone routes (`zone_route_needs_zone_token:…`, `zone_route_removal_owner_run:…`, `route_change_needs_zone_token:…`), because the deploy token holds no Workers Routes Edit (owner 2026-11-06); a rewritten migration history; `workers_dev` / `preview_urls` set on one side only (`routing_changed`). **Still open:** the first live run of each part A and part B path; changing a deploy-time value (a new operator or approver email, now only the GitHub variable `ACCESS_ALLOWED_EMAILS`, or a new service token) has no native source and needs the owner (gate 13, the Secrets Store id, or a decision on where the identity lists live); a new `[[d1_databases]]` binding stays `unresolved_placeholder`; the state-changing smoke steps above are not repeated; the probes add about 3 subrequests a Worker (plus each unit's step), not yet measured against the account's subrequest limit; the topology changes part B still refuses (zone routes, a rewritten migration history, `routing_changed`) and a parallel change |
| 5 | The Forge merges with a fast-forward (G3a), and `merge_change` runs by consensus (G3b) | the merge button and branch protection | G3a merged in #305; since 2026-11-13 the Forge tick runs the spike on the scratch repository until it has succeeded once (no approver call). **G3b built** (2026-11-13): `merge_change` / `merge_owner_change`, the vote on the Forge's verdict, the Policy Engine's `merge_path_forge` check and the Forge's `MergeRpc` executor; off until step 4 flips `forge_controls.merge_path` |
| 6 | Contributors push to `platform-work`; the Forge registers change requests from Artifacts (G4) | pull requests | G4 merged in #305. **2026-11-13:** the owner forked `platform` into `platform-work` and gave this session a write token (secure form); a push from the session succeeded. The type-check source is the Forge itself: it copies a request's head to `cr/<cr_id>` of `platform`, which `cryptophys-forge-typecheck-cr` builds (`transfer.ts`) |
| 7 | Dependency audit and secret scan (G5) | Dependabot, secret scanning | done: secret scan (phase 3, plus the `npm_token` rule) and the daily npm dependency audit (G5, merged in #305) |
| 8 | Off-Artifacts copy of the repository: a daily `git bundle` to R2 (ADR-0012 §5, §5m) | GitHub as the second copy | **built; first runs succeeded live** (2026-11-13 08:20 at 6144659 and 08:50 at ea9ab59, 4.1 MB, 5,395 objects); **the daily verify is built, not yet run live** (owner 2026-11-15). The Forge tick step `git_backup` clones `platform` over Git smart HTTP once per UTC day per head of main, writes `git-backups/platform/<date>-<sha>.bundle` to `cryptophys-forge-bundles` with its SHA-256 (migration 0054, `GET /v1/forge/git-backup`, Console Code page), and keeps the newest bundle of each of the last 30 days. Once per UTC day, after it, the step `git_backup_verify` reads the newest stored bundle back from R2 and verifies it in code (`bundle-verify.ts`: workerd has no git binary). It checks the header (v2 or v3, only `@object-format=sha1`, no prerequisites, the ref lines), the pack's SHA-1 trailer, and every entry walked to the trailer (inflated to its declared size with its Adler-32, exactly the declared count). Every delta must resolve and every object id is computed, as index-pack does. Every ref must name an object in the pack (HEAD and branches a commit), and everything the refs reach must be present with the type that points to it. Last, the bundle must match its row: SHA-256, size, pack SHA-1, object count, main and branches. `git bundle verify` itself reads only the header and checks prerequisites; the rest is what `git clone` of the bundle checks. Not covered: a `git fsck` of object contents, and a checkout. The result is on the row (migration 0072: `verified_at`, `verify_status`, `verify_details`), in `GET /v1/forge/git-backup` (`verify`), on the Console Code page and in the audit chain (`forge.git_backup_verified`). A failed verify is an Owner page problem (`git_backup_unverified`); an R2 read error is retried after an hour, any other failure the next day. Met once the first scheduled verify succeeds live (a run against Artifacts has succeeded since 2026-11-13) |
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
   - **Linear history (incident 2026-11-14, migration 0071).** Keep a branch current by rebasing it onto `main`, or by a merge with `main` as the first parent (`git checkout -B <branch> origin/main && git merge <old head>`). Do not run `git merge main` on the branch: `main` becomes the second parent, and the Forge refuses the request as `main_not_first_parent` (verdict `blocked`, not checked, never proposed), because its fast-forward would take `main`'s previous heads off `main`'s first-parent history (the deploy planner follows that history).
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
  GitHub's. The Forge's R2 bundles are verified by their pack checksum and SHA-256; since 2026-11-15 the newest is also verified daily in code (gate 8 row).
- Gate 13: met without the Secrets Store. Every secret the native paths read is a Worker secret
  (`CF_DEPLOY_TOKEN`, `CF_ACCESS_TOKEN`, `CF_ACCOUNT_ID`, `ACCESS_GROUPS_TOKEN`); the GitHub `production`
  environment's secrets serve only the workflows this cut-over turns off.
- Steps 4–5: migration 0058 sets `forge_controls.merge_path = forge`; `mirror-to-forge.yml` keeps only a manual
  trigger (run once by hand for the cut-over commit; afterwards the Forge refuses its token) and
  `forge-change-request.yml` is off. Contributors push to `platform-work` (AGENTS.md).
- Known limit after the cut-over: a change that adds a Durable Object class (a DO migration) is refused by the native
  deploy (Cloudflare applies DO migrations only on a full script deploy). Until native DO migrations are built, such
  a change uses an existing class under another instance name.
  Since gate 4 part B (2026-11-15) an additive DO migration deploys natively through the Script Upload API (the full
  script deploy); deleting, renaming or transferring a class needs an owner-approved break-glass plan that names it
  (`destructive_topology`, docs/OPERATIONS.md).
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
- 2026-11-14: change-request branches were updated with `git merge main` (main as the second parent). The fast-forward
  merges took main's previous heads, the deployed versions, off main's first-parent history; the deploy planner stopped
  planning and every deploy stuck. The Forge now refuses such a head (`main_not_first_parent`, the linear-history guard,
  migration 0071): main's head must be on the head's first-parent chain, within 500 commits.
- ~~Open before step 6: a migration the Forge marks destructive (an `UPDATE`, like 0058) has no native path
  (`destructive_migration`); with the workflows off it cannot be deployed.~~ **Built (owner 2026-11-15, "1 setuju"):** the
  Supervisor proposes the critical action `deploy_destructive_migration`, naming the commit and each destructive file with its
  sha256, instead of a routine `deploy_commit`. After the owner's click the native deploy first reads and records D1's Time
  Travel bookmark (`deployment.restore_point_recorded`, `details_json.restore_point`), then applies only the named files. A
  failure reports the bookmark; D1 is never restored automatically (OPERATIONS, "Destructive D1 migrations"). Needs
  Account → D1 → Read on `CF_DEPLOY_TOKEN`. Met once one owner-approved destructive deploy has succeeded live. The two change
  requests reopened before the fix stay `closed` in D1; their merges are in the audit chain (`forge.merged`).

### 2026-11-14: the deploy planner stall, and the gate for steps 6–7

- From main 6db8d31 (about 15:00 UTC) no deploy was planned for about 7 hours. Branch updates had been merged with main as the
  second parent, so the Control Plane's deployed version (3cd2f94) left main's first-parent history. The Forge's planner looked
  only there, recorded `compare_failed_or_diverged`, and with new migrations pending refused every unit
  (`new_migration_control_plane_unavailable`), the Forge's own fix included.
- The way out was one `deploy-control-plane.yml` run on main 0a9e30f, started by the owner (run 43644788075, attempt 2,
  success at 22:03 UTC; attempt 1 failed on a clock-dependent test, fixed in `claude/ob5-clock-fix`). The planner recovered
  at once (22:04: `control-plane` planned first).
- Owner-approved hardening, each its own change request: (a) a linear-history guard (`main_not_first_parent`, migration 0071);
  (b) the planner resolves deployed versions by ancestry, plans migrations from D1's applied list, and redeploys a unit in full
  when its version cannot be resolved; (c) a deploy stall alarm after 2 hours; (d) a break-glass recovery step
  `force_redeploy_unit`; (e) a last-resort runbook in OPERATIONS; (f) one drill of (d).
- **Gate (owner, 2026-11-14): steps 6–7 wait until**
  - the linear-history guard (a), the deploy planner's ancestry and D1-migration rules (b) and the deploy stall alarm (c) are live;
  - the break-glass recovery step `force_redeploy_unit` (d) has been exercised once in production, with the owner's click (drill (f));
  - native deploys have run cleanly for 24 hours.

### 2026-11-15: the executor's own bug blocked its fix

- The native control-plane deploy failed twice on reading a version it had just uploaded: at d300ee1 (09:08 UTC, on
  `cryptophys-platform-registry`) and at 4e64060 (10:38 UTC, on `cryptophys-ai-kernel`), both `cloudflare_api_404_100146`.
  Each failure restored the services already moved and opened a critical report, so the consensus brake held until the owner
  acknowledged it.
- The fix (4e64060: a 404 on that read is read again, at most 4 times) lives in the Deployment Orchestrator, which executes
  the deploys. The planner deploys the Control Plane first and the orchestrator after it, so the fix could not go live through
  the path it repairs. The way out is an owner-run workflow deploy (the orchestrator first, then the Control Plane).
- **Gate addition:** steps 6–7 also wait until a fix to the deploy executor itself can reach production without the executor
  (an executor-first planner rule, or a named runbook path in OPERATIONS), proven once.
  - **Status: built, proof pending** (owner 2026-11-15, "1 setuju"; change request from branch `gate-executor-first`, a guard
    path, so `merge_owner_change`). Two parts:
    - *executor first*: when main changes the orchestrator unit, both planners (the shared `orderPending` and the Forge's
      `forgePlan`) deploy it first and alone, also while a D1 migration is pending, when no pending migration names a
      table, column or index the Orchestrator's bundled code at main mentions (`control-plane-shared/src/executor-first.ts`;
      the Orchestrator's own native deploy accepts the same evidence). Otherwise, or when the evidence is unreadable, the
      Control Plane goes first as before, with the skip `executor_first_not_proven:<reason>`. The Orchestrator's readiness
      needs no migration after 0029, so the 2026-11-07 reason for "Control Plane first" (every readiness required the
      newest migration) no longer applies to it;
    - *rescue deploy*: an owner-approved break-glass plan for `cryptophys-deployment-orchestrator` is deployed by the
      Recovery Manager itself (`control-plane-shared/src/executor-rescue.ts`), never by the Orchestrator, with the new
      owner-set secret `CF_ORCHESTRATOR_DEPLOY_TOKEN` (Workers Scripts Edit) and `CF_ACCOUNT_ID` on
      `cryptophys-recovery-manager`. The Owner page item `executor_deploy_failed` asks for it when the Orchestrator's own
      last deploy of its unit failed.
  - **Met once** the proof drill in OPERATIONS ("Rescue deploy of the Deployment Orchestrator") has succeeded live: record
    the plan id, the request id and the time here.

### 2026-11-16: binding props lost out of band

- On 2026-11-15, about 22:00–23:30 UTC, out-of-band versions of `cryptophys-recovery-manager` and
  `cryptophys-deployment-orchestrator` appeared (most likely dashboard secret edits) without the `AGENTS` binding's
  `props = { host_worker = ... }`. The AI Kernel's `AgentRpc` refused the callers (`caller_identity_missing`), so every
  Recovery Manager report was lost, the rescue drill's reports at 10:17 on 2026-11-16 included. Every later native deploy
  kept the loss (keep_bindings and the check against the active version on the code-only path; unchanged bindings kept
  verbatim by the configuration plan). The GitHub workflow (`wrangler deploy`) restored the props at 10:41.
- **Gate addition (owner, 2026-11-16):** step 6 also waits until every native path that uploads a version ends with each
  Worker's service bindings equal to the `[[services]]` of its `wrangler.toml` as the Forge stored it for the commit
  (binding set, `service`, `entrypoint`, `props`), resending the declared values on a mismatch, and refusing with a report
  what it cannot apply safely.
  - **Status: built, not yet run live** (branch `binding-props`; it changes `executor-rescue.ts`, a guard path, so
    `merge_owner_change`). `control-plane-shared/src/service-bindings.ts` compares; the code-only upload sends the declared
    service bindings when they differ (the other types kept), the configuration plan plans them from the config
    (`config-diff.ts` `service_bindings`), the break-glass deploy uses the same executor, and the rescue executor does the
    same with its own client. The new version is verified to bind exactly the declared values before traffic. Steps
    `<worker>:service_bindings_restored:<BINDING>`, audit `deployment.binding_drift_detected` and
    `deployment.binding_drift_repaired`. An undeclared service binding, a name conflict or a missing target refuses before
    any upload, with a critical report. Native rollback uploads nothing and is exempt. See OPERATIONS, "Binding drift".
  - Not verified live: whether the versions API returns a service binding's `props`. A record without a `props` key is
    treated as "props unknown": the declared binding is resent, `<worker>:service_binding_props_unverifiable:<NAME>` is
    recorded once, no drift audit or report is written, and the new version is accepted without the key; present and
    different props still fail. The first live run shows which case applies (unverifiable steps on every Worker with
    props: the API does not return them).
  - Owner additions (2026-11-16, "sesuai rekomendasimu"), built, not yet run live: a break-glass plan may name
    `service_binding_removal:<worker>:<BINDING>` in `destructive_topology` to drop an undeclared service binding (pending
    only while the active version binds it undeclared, otherwise `named_topology_not_pending`; audited before, verified
    gone, listed in the owner notice); the routine refusal `service_binding_undeclared:<NAME>` names that item. The rescue
    deploy applies the same item for the Orchestrator (and no other topology item), and its client may now also read the
    account's script list (`GET /accounts/{id}/workers/scripts`, read only; every other address is refused), so a missing
    or retargeted binding is restored when the target exists and refused as `service_binding_target_missing` when it does
    not. `CF_ORCHESTRATOR_DEPLOY_TOKEN` (Workers Scripts Edit, account-wide) covers the list; no token change.
  - **Met once** a native deploy has restored a drifted binding live (or one has run live with the check and found none),
    and the AI Kernel accepts the restored Worker's reports again: record the request id and the time here.

## Rollback of the cut-over

Before step 7, rolling back means re-enabling the workflows and pushing the Forge's `main` back to GitHub.

After step 7, the owner un-archives the repository and sets a new token. The Forge's `main` is pushed to GitHub, and mirroring resumes from the Forge to GitHub until the cause is fixed.

## What stays on GitHub after G6

Nothing on the build, merge, deploy, rollback or alert path. The archived repository remains a read-only historical copy. Other repositories (`cryptophys-aether`, `xauusd-ai-trading-assistant`) follow only after the owner decides (ADR-0012 phase 6).
