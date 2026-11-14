# Single source of truth: current topology

`CLAUDE.md` and `AGENTS.md` point here. This page says what runs where **today**. The decisions behind it are in `architecture/adr/` (0001–0016). When this page and an ADR disagree, the newer ADR wins and this page is corrected.

Last reviewed: 2026-11-13 (owner channel and Owner page; critical report acknowledgement; `cryptophys-home` and the old custom domains retired); 2026-11-10 (power mode rules); before that 2026-11-08 (`docs/RETROSPECTIVE-2026-11-08.md`).

## Platform rules

These hold everywhere:

- **No fund movement; trading only with the owner's click.** Wallets, withdrawals, transfers and other fund movements are prohibited at every tier. Since 2026-11-12 (owner: "larangan trading harus dicabut karena kita sudah masuk fase production", "Trading boleh, dana tidak"; ADR-0009 amendment), a trading action is allowed but always critical (consensus, then one owner click), and a trading capability must be tier 2 or above. Nothing in the platform trades yet. The knowledge validator's rules for learned knowledge (no orders, no price levels) are unchanged.
- **No containers.** Production runs on Workers and their bindings only (ADR-0005 decision 1). The Forge type-check, which does not fit in an isolate, runs on Workers Builds from the Artifacts repository (ADR-0012 §5c, owner 2026-11-08; first report passed 2026-11-09).
- **Never weaken Access, auth or tests.** No test is skipped. A test that cannot run somewhere keeps running where it can.
- **The owner creates every secret and credential.** None is created by an agent or stored in the repository.
- **Data deletion and irreversible actions are critical.** The owner decides them.
- **The brake always works.** Consensus mode `shadow` and the kill switch (`kernel_controls.agents_enabled`) can be used at any time.
- **Repositories out of scope.** `cryptophys-adm/xauusd-ai-trading-assistant` (Nexus) and `cryptophys-adm/cryptophys-aether` are not changed from this repository. Since 2026-11-14 (owner; ADR-0016), agents may change Aether in its own repository only after its bootstrap PR (DNA, CI DNA tests, guard paths) is merged, and then only through its CI, with its guard paths needing the owner's click. Until then Aether is read-only for agents.

## Entry point and sign-in (ADR-0008, ADR-0010, ADR-0011)

- **Hosts.** `https://nexus.cryptophys.work` is the only public origin. The Cerebrum Console is mounted at `/console/`, through the Workers route `nexus.cryptophys.work/console*`. The old hostnames `console.cryptophys.work` and `home.cryptophys.work` are retired (owner 2026-11-13, ADR-0010 amendment): one `retire-worker.yml` run detaches both custom domains (then they no longer resolve) and deletes `cryptophys-home`. Until that run, `console.` still redirects to the mount (`LEGACY_HOSTS`).
- **Sign-in.** Cloudflare Access is the only login. The identity providers are Google, Microsoft (OIDC) and one-time PIN (kept for now by owner decision, 2026-11-08). There is one Access application, `cryptophys-cloud-platform`, so there is one AUD and one 8-hour session.
- **Roles.** Configured identities come from `OPERATOR_IDENTITIES` and `APPROVER_IDENTITIES` (the owners). Accounts live in D1 `platform_accounts`:
  - `admin`: viewer, operator or approver;
  - `user`: Nexus only.

  Every Worker checks roles itself through `control-plane-shared/src/access.ts`.
- **Writes that shape production** (a recovery plan by hand, a service record, a desired version) need the approver role for a person (`requireApproverOrServiceOperator`, 2026-11-08). The deploy workflows' service token keeps recording versions and its verification plan, which is marked `synthetic` and hidden from the Console list.
- **Console sign-out.**
  - Sign out goes to `/cdn-cgi/access/logout`.
  - Switch account goes to `/console/switch-account`.
  - A Nexus-only account that opens the Console gets the access page.

## Workers

| Worker | Role | Cron (UTC minutes) |
|---|---|---|
| `cryptophys-console` | Backend-for-frontend with no authority of its own: the caller's JWT, a 68-route allow-list, CSP, CSRF | — |
| `cryptophys-platform-api` | Overview for the Console | — |
| `cryptophys-platform-registry` | Service registry, desired versions, accounts, Access group sync | — |
| `cryptophys-policy-engine` | Policy decisions (deploy, recovery, consensus.execute, agent syscalls) | — |
| `cryptophys-audit-ledger` | Hash-chained audit events | — |
| `cryptophys-recovery-manager` | Recovery plans and execution; daily D1 backup to R2 | :13 |
| `cryptophys-drift-detector` | Desired-versus-observed versions and health; reports once per episode | every 15 min |
| `cryptophys-deployment-orchestrator` | Deploy requests, the deployments list (Console Pipelines), native rollback (Deployments API), ledger reconcile | :02/:10/:17/:25/:32/:40/:47/:55 |
| `cryptophys-ai-kernel` | Agent registry, syscall gate, Supervisor, Auditor, consensus (ADR-0009), owner notices, knowledge | :07/:22/:37/:52 |
| `cryptophys-forge` | ADR-0012: source on Artifacts, Forge checks in Dynamic Workers, type-check reported by Workers Builds | :04/:19/:34/:49 |
| `cryptophys-forge-typecheck` | Workers Builds stub for the type-check and the Console UI build (`workers/forge-typecheck`, TypeScript 7): no route, no bindings, not in the registry | — |
| `cryptophys-home` | Retired 2026-11-13 (ADR-0010 amendment): source removed, registry row `disabled` (0055, never probed, never drift); the Worker is deleted by `retire-worker.yml` | — |
| `cryptophys-signal-engine` | Disabled (TP-018) | — |

**Observed only (health, not version):** four `xauusd-*` Workers and `cryptophys-aether`.

**Internal calls** use RPC service bindings (`HealthRpc`, `DriftRpc`, `RegistryRpc`, `DeployRpc`, `AgentRpc`). There are no shared secrets between Workers.

## Data

- **D1 `cryptophys-control-plane`.** One database for every service. Migrations live in `workers/control-plane-migrations/`, numbered from 0001; each Worker's readiness lists the ones it needs.
  - Migrations are applied **only by the Control Plane deploy**, so a commit with a new migration deploys the Control Plane first.
  - Every service requires `REQUIRED_MIGRATIONS` (`control-plane-shared/src/readiness.ts`). The Forge also requires 0031–0033 and 0035.
- **Drift observations on change (owner, resource audit decision 1, 2026-11-14, migration 0061).** The Drift Detector records a `drift_observations` row only when a service's state changes (drifted, desired and observed hash, sorted reasons); the same state on a later run raises the row's `streak` to 2 once. Persistent drift is "the newest row drifted and its streak is 2 or the row before it drifted" (`control-plane-shared/src/drift-state.ts`). `service_registry.updated_at`, set by every run, is the heartbeat: staleness, verification freshness and the Console's "last observed" use it. `drift.observation` is audited only for a run that changed a state or published a report.
- **Retention.** `drift_observations` keeps 90 days and `agent_syscall_consumptions` 7 days (owner, 2026-11-05). `forge_builds` keeps 100 days and `forge_build_collections` 30 days (the Workers Builds API itself keeps 90). `forge_dependency_audits` and `forge_dependency_findings` (G5, migration 0051) keep 90 days. `forge_git_backups` (gate 8, migration 0054) keeps 90 days, except rows whose bundle is still in R2. Other tables are kept.
- **Forge bundles (G2a, 2026-11-12).** The R2 bucket `cryptophys-forge-bundles` holds the Worker modules and a manifest of every passed main commit, for 14 days (`workers/forge/src/bundles.ts`).
- **Backups.** The R2 bucket `cryptophys-d1-backups` gets a daily backup written by the Recovery Manager, with a 90-day lifecycle. D1 Time Travel is also available. A restore is critical (owner).
- **Repository backup (ADR-0012 gate 8, §5m, 2026-11-13).** Once per UTC day per head of main, the Forge clones `cryptophys/platform` over Git smart HTTP. It writes the result as a git bundle to `cryptophys-forge-bundles` at `git-backups/platform/<UTC date>-<main sha>.bundle`, with its SHA-256 in D1 and in the object's metadata. It keeps the newest bundle of each of the last 30 days (`GIT_BACKUP_RETAINED_DAYS`).
  - `GET /v1/forge/git-backup` and the Console Code page show the backups. A backup that has not succeeded for 48 hours is shown on the Console only, never sent as an owner notice.
  - Restore: `git bundle verify <file>`, then `git clone <file> platform-restore`. A restore is critical (owner).

## The living platform (ADR-0013)

- **DNA.** Every Worker declares itself in `workers/<dir>/organism.json`: service, deploy unit, Access, rollback, drift probe, hosted agents (voter or not), AI engines. CI fails when a static list (deploy units, drift probes, Access, rollback, council, kernel agents, vote bindings, engines, names) disagrees with the DNA.
- **Census (phase 2).** The Forge compares the DNA of each main commit with `service_registry`, `agents` (and their seats) and `engines` (`forge_organism_census`, retaken every 30 min). Differences become the owner notice `organism` and appear on the Console Agents page. Findings the Supervisor registers by itself (an unregistered engine or agent) send one email when they appear and one when all are registered, not one per registration (owner 2026-11-12).
- **Self-registration (phase 3).** The Supervisor turns census findings into consensus proposals, one per cycle:
  - `register_agent` and `register_engine` are routine: consensus only.
  - `register_privileged_agent` (a capability above tier 1, or `consensus.propose`) and `admit_voter` (a council seat, one per Worker) are critical: consensus plus the owner's click, in mode `deploy` or `critical` (owner 2026-11-13).
  - The kernel takes the gene from the census, never from the proposal, so only merged DNA can register. Tier 3, unknown and fund-movement capabilities are never registered; a trading capability registers only as privileged (the owner's click).
  - A new seat must vote through a reviewed vote binding; without one it is refused. A seat the DNA no longer asks for is reported, never removed by an agent.

## Organs as cells (ADR-0015)

- Accepted 2026-11-14. The AI Neuron is the only core; every other organ becomes an event-driven cell (a Durable Object actor) that pushes snapshots to the Console and writes D1 only on change. D1 is the ledger of facts; telemetry goes to Analytics Engine; long memory goes to R2.
- Not built yet. Platform phases, each in shadow first: (1) push hub for the Console plus the Cache API, (2) the Supervisor's snapshot in its DO, (3) telemetry to Analytics Engine, (4) retention with an R2 archive. The resource audit's P0 fixes come first.

## Telos (ADR-0016)

- Accepted 2026-11-14 ("setuju"). The organism gets a living vision in two layers: a core (mission, identity, constitution) that only the owner changes, and a growth layer of goals with measurable KPIs.
- **T0 is built.**
  - `organism/vision.json` holds the owner's draft, validated by `control-plane-shared/src/vision.ts` (`organism.vision.v1`) in CI.
  - Both files are guard paths (reason `vision_core`), so a change to either is `merge_owner_change`.
  - The AI Kernel bundles the vision and serves it read-only at `GET /v1/vision`; a change to the vision redeploys the Control Plane unit.
  - The Console's Vision page (`#/vision`) shows it. A KPI without a measured baseline or a set target reads "not measured yet".
- **Not built yet:** T1 (the daily self-model), T2 (the Strategist in shadow), T3 (intents to the evolver and the experience ledger), T4 (vision growth) and T5 (morphogenesis).

## Autonomy (ADR-0007, ADR-0009)

- **Current state.** Consensus mode is `deploy` (owner, 2026-11-07). The kill switch is on.
- **Routine actions.** Agents propose. The council votes: the enabled agents holding a seat (`agents.voter`, ADR-0013). Migration 0041 seeded the nine founding seats; new ones come only through `admit_voter`. The Policy Engine has a veto.
- **Limits.** One executed action per action and target per hour, and ten deploys or rollbacks per 24 hours by default (owner 2026-11-10, was six); the council then set `daily-deploy-limit` to its bound of 20, and on 2026-11-12 the owner raised the bound to 40 and the value to 40. Deploys run only at SAFE minutes.
- **Council-adjustable policy (owner 2026-11-10).** The council may change two Policy Engine parameters by consensus alone (`set_policy_parameter`, routine): `daily-deploy-limit` (1–40) and `target-actions-per-hour` (1–3). The hard bounds live in `control-plane-shared/src/policy-params.ts`; a stored value outside them is clamped. Each change is written with a `policy.parameter_changed` audit event. Everything else in the Policy Engine stays code: no trading or funds, the owner click for critical actions, the kill switch, mode shadow and Access.
- **Critical actions.** Auth and Access, the Policy Engine, the consensus rules and the kill switch, secrets, and destructive migrations need an owner click.
- **Critical reports (owner 2026-11-13).** Every voter rejects routine actions while a critical agent report of the last 24 hours is open. An approver who is a person can acknowledge a handled critical report: `POST /v1/reports/{id}/acknowledge` on the AI Kernel, with the phrase `ACKNOWLEDGE {id13}` and a reason of 10–500 characters, from the Console Owner or Cognition page. An acknowledged report no longer counts as open (`counts.critical`; `counts.critical_acknowledged` counts the acknowledged ones), and the owner notice closes with it. Unacknowledged ones block as before, and warnings and info cannot be acknowledged. Each acknowledgement is written with a `report.acknowledged` audit event (migration 0053) and is idempotent. Before 0053 is applied, nothing counts as acknowledged (ADR-0009 amendment 2026-11-13).
- **Workers AI.** It uses the free tier, capped at 250 requests a day. AI only drafts; every decision is deterministic.
- **Digital metabolism (power mode, #263, #264, #265).** The Supervisor reads deal results from XAUUSD (read only; nothing places orders or moves funds) and the infrastructure burn, then sets `metabolism_controls.power_mode`. Owner rules (2026-11-10):
  - **Survival** (market closed, a drawdown over $100 in 24 h, or under 7 days of runway) throttles only AI spending: `memory.remember`, `knowledge.propose` and AI budgets at 25 %. It never throttles `consensus.propose`, so deploys, rollbacks and suspensions keep working.
  - **Growth** (doubled AI budgets) applies only when the owner sets `power_mode_override = growth`. The Supervisor only reports "growth eligible".
  - Every automatic mode change is written with a `metabolism.power_mode_changed` event in the audit chain.
- **Cloudflare usage and billable cost (Console: Organism and Metabolism pages).** `GET /v1/usage` on the Platform API reads the GraphQL Analytics API and Billable Usage API against the Workers Free limits (Workers 100k requests/day, D1 5M rows read and 100k written/day, Workers AI 10k neurons/day, KV 100k reads and 1k writes/day) and billable product overages (Regular Twitch Neurons, Container Memory, Container Disk). It supports `CF_ANALYTICS_TOKEN` / `CF_BILLING_TOKEN` and `CF_ACCOUNT_ID`. When billable costs are observed, automated throttling intents (`INTENT_CONSERVE_AI_NEURONS`, `INTENT_REDUCE_CONTAINER_RUNTIME`) are emitted to the AI Kernel Supervisor and Deployment Orchestrator, triggering survival power mode to throttle execution limits and maintain Cloudflare Free Tier operation.
- **Workers Builds minutes (owner 2026-11-12).** The deploy limit above is the platform's own safety limit, not a Cloudflare quota: Cloudflare sets no daily deploy limit for Workers (only rollback to the last 100 versions), and deploys run on GitHub Actions, so they use no build minutes. Only Workers Builds does: the type-check and Console UI build of each main commit (`cryptophys-forge-typecheck`), each change request (`cryptophys-forge-typecheck-cr`), and any other Worker on the account connected to Workers Builds.
  - Allowance: 3,000 build minutes a month and 1 build at a time on Workers Free; 6,000 and 6 on Workers Paid (the account's plan). The platform holds itself to the free-tier 3,000 (`control-plane-shared/src/build-usage.ts`).
  - Measured, not estimated: once an hour the Forge lists every Worker's builds and Previews' builds through the Workers Builds API (read only, `CF_BUILDS_API_TOKEN`) and keeps each finished build's duration, rounded up to whole minutes (migration 0049, `workers/forge/src/build-usage.ts`). A build without a start and a stop is shown as unmeasured.
  - `GET /v1/forge/build-usage`; the Console Code page shows the month, the projection and the minutes per Worker. The owner notice `build_minutes` opens when the measured or projected month reaches 80 % of the budget, and changes once per 10 % step. The month is the UTC calendar month; Cloudflare's billing cycle may differ.
- **CI gate for consensus deploys (until 2026-11-12; since G1 the gate is the Forge's `ready`, ADR-0012 §5e).** The gate requires a green push run of `Validate Control Plane Workers` on the main commit, every other push run green, and a green combined status. Renaming a required workflow silently stops deploys: from 2026-11-08 to 2026-11-09 the gate still required the removed `Validate` workflow, and no consensus deploy ran (fixed in #251). A test now requires every name the gate needs to be an existing workflow.

## Source, CI and deploy (ADR-0012)

| Step | Today | After phase 4–5 |
|---|---|---|
| Source of truth | GitHub `cryptophys-adm/cryptophys-cloud-platform` (`main`) | Artifacts `cryptophys/platform` |
| Mirror | `mirror-to-forge.yml` on every push (also reports pull request outcomes to the Forge) | — |
| Deploy decisions | **The Forge decides (G1, 2026-11-12):** main's head, readiness (the Forge checks) and the pending units come from the Forge's records (`forge-gate.ts`); the GitHub workflow still performs the deploy and requires GitHub's main to equal the Forge's head | deploy from Forge bundles (G2) |
| Change requests (shadow) | `forge-change-request.yml` after CI on each same-repository PR: head to `cr/<n>`, registered as `gh-<n>`; Forge verdict vs GitHub outcome, merge parity towards 10 (ADR-0012 §5d). **G3a (2026-11-12):** the Forge can fast-forward a branch over Git smart HTTP (`workers/forge/src/merge.ts`), proven by the approver-only spike `POST /v1/forge/merge-spike` on the scratch repo `merge-spike`; it never writes `platform` before G6 (ADR-0012 §5h). **G4 (2026-11-12):** contributors push `cr/`, `claude/` or `agent/` branches to the work repo `platform-work` (forked by the approver-only `POST /v1/forge/work-repo`); each tick registers them as `fg-<slug>` (source `forge`), `blocked` unless based on main, type-check `not_configured`, so never `would_merge` yet (ADR-0012 §5j, migration 0052) | Forge merges |
| CI | GitHub Actions (`validate-control-plane.yml` for every PR and main push, `forge-runner-parity.yml`) | Forge checks |
| Forge checks | Each new `main` commit: tests, bundles of every Worker, secret scan, plus the Workers Builds type-check and Console UI build; `ready` when all pass; `GET /v1/forge/checks`; parity with GitHub CI towards 20 | merge gate (phase 4 requires `ready`) |
| Deploy | `ops-dispatch.yml` (request files in `ops/requests/`), then `deploy-*.yml` (wait for SAFE minute, deploy, verify live, roll back on failure). **G2b (2026-11-12):** a code-only consensus deploy (same wrangler.toml and migrations as the running version, one module, no assets) is uploaded by the Orchestrator from the Forge's bundles and deployed natively once `CF_DEPLOY_TOKEN` is set; anything else stays on the workflow (ADR-0012 §5g). **G2c-1:** the native path also applies additive D1 migrations for the Control Plane (recorded in `d1_migrations` as wrangler does), uploads multi-module Workers and runs recovery redeploys (§5k). **G2c-2:** a wrangler.toml change, or `[limits]`, is eligible through a configuration plan checked against the active version, verified after upload before traffic; cron and observability changes are applied after the live check. **G2c-2 step 6:** the Console's static assets are eligible once the Forge has stored the commit's Console build (every file matching, `[assets]` unchanged, no inline script in `index.html`) and the script list, read with `CF_DEPLOY_TOKEN`, reports the route `nexus.cryptophys.work/console*`; the assets are uploaded before the version, or kept when the build is unchanged. Step 7, the build script that posts the build to the Forge, is merged (#312), but the Forge in production (e6c0372) does not serve `POST /v1/forge/console-dist` until its next deploy, so the Console still deploys through `deploy-console.yml`, as do changes the plan refuses (§5l) | Orchestrator: Scripts API upload and Deployments API |
| Dependabot and secret scanning | **G5 (2026-11-12):** the Forge's secret scan of every checked commit replaces secret scanning; a daily npm advisory audit of main's lockfiles (`GET /v1/forge/dependency-audit`, Console Code page, owner notice `dependencies`) replaces Dependabot's alerts. Upgrade pull requests are not replaced yet (ADR-0012 §5i) | the same |
| Rollback | Native in the Orchestrator (`CF_DEPLOY_TOKEN`); `rollback-worker.yml` until the native path has run | native |
| Access | `provision-access.yml` (ops request). **Gate 9 (2026-11-13):** with the owner's `CF_ACCESS_TOKEN` on the Orchestrator, the Supervisor compares the Access application hourly with the workflow's definition and proposes `change_access` (critical) listing the changes. After the owner's click the Orchestrator applies exactly that plan (`native-access.ts`, ADR-0012 §5o): a new Worker gets a private stub first, the result is read back, and operator emails and the CI token are never changed by it. Not yet run live | native |
| Worker retirement | Owner-approved consensus `retire_worker`. **Gate 10 (2026-11-13):** with `CF_DEPLOY_TOKEN` the Orchestrator retires the Worker itself (`native-retire.ts`, ADR-0012 §5n). It reads the workflow's gates from the Forge's bundles for main, detaches the custom domains, deletes without `force` and verifies. It uses `retire-worker.yml` when that token may not read something (401/403) or is unset, and for ops requests. Not yet run live | native |

**Owner notices** run as a cron Worker in the AI Kernel (:22/:52). Owner 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"; ADR-0009 amendment):
- **The owner is contacted only for approvals and critical items** (`OWNER_CHANNEL_TOPICS`). These go to the owner's Telegram only (owner 2026-11-13, "tetap telegram saja": `OWNER_NOTICE_CHANNELS = "telegram"`; the email binding from `alerts@notify.cryptophys.work` stays configured but unused), with a link to the Owner page:
  - **Alert channels (owner 2026-11-13, Console → account menu → Alerts; migration 0056):** the Telegram destinations are managed in the Console without a deploy. Approvers can add a bot token plus a chat id, enable or disable a channel, choose its topics (any notice topic, including console-only ones), send a test, or delete it. The seed `alc_default` is the xauusd bot (`OWNER_TELEGRAM`); it can be disabled but not deleted. Bot tokens are kept in the AI Kernel's `AlertVault` Durable Object and are never written to D1, returned, logged or audited; a row keeps only the last four characters. A failed send is retried only on the channels that failed, at most 3 times per notice state (`MAX_DELIVERY_RETRIES`).
  - `owner_attention`: draft recovery plans, critical proposals in `pending_owner`, knowledge proposals that need the owner;
  - `critical_reports`: open critical reports of the last 24 hours;
  - `production_unhandled`: a production problem no agent is handling. That is the AI Kernel or Drift Detector itself persistently drifted or unhealthy; observations stale or missing for 45 minutes; a persistent drift with agents off, or with no recovery plan and no deploy or rollback under way (after a 30-minute grace for the Supervisor); a recovery plan failed or expired in 24 hours; a critical runtime npm advisory; or the Workers Builds budget used up.
  - `drift`, `organism`, `build_minutes` (80%) and `dependencies` (high) are console-only: audited and shown at `GET /v1/notices` with `channel: "console"`, never emailed or sent to Telegram.
- **One panel: the Console's Owner page (`#/owner`, first in the nav).** It reads `GET /v1/owner/inbox` on the AI Kernel (operator-readable, read-only) and shows three sections:
  - "Waiting for your approval", with each item's existing approve or reject action for approvers;
  - "Open critical reports", with acknowledge for approvers;
  - "Production problems no agent is handling", with evidence links.

  Operators see it read-only. When all three are empty it says "Nothing needs you".
- **Answered (owner 2026-11-13, "Tombol muncul di mode deploy"):** critical proposals reach `pending_owner` in mode `deploy` as well as `critical`, so in today's mode `deploy` an organism finding that needs the owner (a council seat, a privileged agent) and every other critical action wait for the owner's click on the Owner page (ADR-0009).

## Backlog that changes this page

| Item | Phase |
|---|---|
| Worker secrets to Secrets Store | ADR-0012 phase 4 |
| Deploy from the Forge, shadowed over 10 deploys | phase 4 |
| GitHub archived | phase 5 |
| Evolution loop: autonomous merge (E1), the evolver agent (E2), fitness and revert (E3), memory and Console (E4); no shadow phase, guard paths autonomous under unanimous consensus (owner 2026-11-12); code model `gpt-oss` on Workers AI only, one evolution in flight and at most one started per 4 h, each running to merge and deploy (owner 2026-11-13) | ADR-0014, accepted and deferred until ADR-0012 phase 5 (owner 2026-11-12); merges on the Forge, no GitHub App |

See `docs/RETROSPECTIVE-2026-11-08.md` §7 for the order of work.
