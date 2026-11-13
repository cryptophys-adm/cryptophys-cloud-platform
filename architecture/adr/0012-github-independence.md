# ADR-0012: Leave GitHub — Cloudflare-native source, CI and deploy (the Forge)

- **Status:** Accepted (owner, 2026-11-08). The owner's §6 decisions are recorded below. The phases in §5 run in order, and each switch waits for its agreement threshold.
- **Date:** 2026-11-08
- **Owner direction (2026-11-08):** "kita harus sepenuhnya lepas dari Github, jika perlu kita buat engine repo sendiri berbasis Ai Worker seperti design asli cryptophys." (We must leave GitHub completely. If needed, build our own repository engine on AI Workers, as in the original Cryptophys design.) This repeats the owner's earlier choice (2026-11-07, D1 backups): "kedepannya kita tidak bergantung Github".
- **Supersedes when complete:**
  - ADR-0001 "GitHub as the source of truth".
  - BASELINE rule 3 and the deployment line ("GitHub Actions `workflow_dispatch` … protected `production` environment").
  - ADR-0005 decision table rows "Tekton/Harbor/Gitea/Argo CD → GitHub + GitHub Actions + Wrangler" and "Vault/ESO → Worker secrets from the GitHub `production` Environment".
- **Unchanged:**
  - Cloudflare only. No containers that we run (ADR-0005 decision 1).
  - Advisory only. Trading stays prohibited.
  - ADR-0009 consensus. Agents still decide routine deploys and rollbacks. The owner still decides critical actions. Nothing deploys merely because code was pushed.

## Context

Decisions, observation and data already run on Cloudflare: AI Kernel, consensus, Policy Engine, Drift Detector, Audit Ledger, D1, and R2 backups. GitHub is still on the critical path for everything that changes code in production. Verified in `workers/deployment-orchestrator/src/index.ts`:

| Function | Today |
|---|---|
| Source of truth, branches, review | GitHub repo and pull requests |
| CI (`ci_green`) | GitHub Actions `validate*.yml`; the Orchestrator asks the GitHub API |
| Build and deploy | The Orchestrator dispatches `deploy-*.yml`; GitHub runs Wrangler with GitHub Environment secrets |
| Rollback | The Orchestrator dispatches `rollback-worker.yml` |
| Retire a Worker | `retire-worker.yml` |
| Owner notifications | Scheduled `drift-alert.yml` / `owner-attention.yml` open GitHub issues |
| Deploy credentials | `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_*` in the GitHub `production` Environment |
| Agents' write path | `GH_ACTIONS_TOKEN` on the Orchestrator |

If GitHub or that token fails, the agents can still decide, but they cannot deploy, and above all they **cannot roll back**. Running services keep running.

The original Cryptophys estate (ADR-0005 inventory) had its own forge: Gitea (source), Tekton (pipelines, `guardian`, `webhook-receiver`) and Argo CD/Flux (reconcile). They were retired in favour of GitHub because nothing equivalent existed on Cloudflare at the time. That has changed (checked in the Cloudflare docs, 2026-11-08):

- **Artifacts** (open beta since 2026-10-01; Workers Paid; billing from 2026-11-12) is Git-compatible repository storage. It offers:
  - a Workers binding (create, fork, inspect commits, read files by path, mint repo-scoped tokens);
  - a REST API;
  - the standard Git protocol over HTTPS;
  - push/clone/fetch events to Queues.

  Limits are 1 GB per repository, and this repository is about 14 MB. Pricing is the first 10,000 operations and 1 GB per month, then $0.15 per 1,000 operations and $0.50 per GB-month.
- **Workers Builds** can build and deploy a Worker from an Artifacts repository. It is a managed Cloudflare build environment. **The owner chose not to use it** (§6.1).
- **Dynamic Workers (Worker Loader)** run code in an isolate, with outbound network blocked if wanted. They also offer:
  - **Durable Object Facets**, which give that isolate its own SQLite database;
  - `@cloudflare/worker-bundler`, which bundles TypeScript and npm dependencies at runtime.
- **Browser Run** is a managed headless browser binding (for the Console render smoke).
- **Workers Scripts API** uploads a Worker version (multipart modules and static assets) without sending it traffic.
- **Workers Deployments API** switches traffic between already-uploaded Worker versions, without a build.
- The `@cloudflare/ci` SDK exists, but it requires a Container binding that we would run. **It is rejected** (ADR-0005 decision 1).

## Decision

Build **the Forge**: a Cloudflare-native replacement for Gitea + Tekton + Argo, run by the AI mesh. Migrate to it in phases (§5), keeping GitHub as a mirror until the cut-over is proven.

### 1. Source: Artifacts

- The namespace is `cryptophys`.
  - Canonical repository: `cryptophys/platform`, branch `main`.
  - Work repository: `cryptophys/platform-work`, holding all branches by people and agents.
- **Only the Forge Worker writes `main` of the canonical repository.** People and agents get repo-scoped write tokens for the work repository only, with a short TTL, minted by the Forge after an Access-authenticated request.
- The Forge subscribes to push events on both repositories.
  - A push to canonical `main` that the Forge did not make is an **incident**. The Forge records it, alerts, refuses to deploy that SHA, and asks the owner to restore (critical).
  - Production is protected by the deploy gate (§3) even if the repository is not.
- Bootstrap: one-time `import` of the GitHub repository with its full history. While GitHub is still the source (phases 1–3), the Forge keeps the import fresh.

### 2. Change requests, checks and review (replaces pull requests)

The new Worker `cryptophys-forge` keeps change requests in D1. Each change request records the work branch, head SHA, base SHA, status, checks, reviews, the owner decision and audit events. A change request moves through these steps:

1. **Checks: the Forge runner, Dynamic Workers only** (owner, §6.1). On every branch push, a Workflow in the Forge does the following:
   1. It reads the tree at the head SHA from Artifacts.
   2. It installs dependencies from an R2 package cache. The cache is keyed by the lockfile hash and filled from the npm registry only by the Forge.
   3. It runs each step in a fresh Dynamic Worker with outbound network blocked:
      - **type-check** with the TypeScript compiler (pure JavaScript);
      - **tests**: the existing `node:test` files run under a small `node:test`-compatible runner. The `node:sqlite` harness (`harness.ts`) is replaced by a Durable Object Facet SQLite database with the real migrations applied. Files the tests read come from the tree at that SHA;
      - **migration tests** and **bundle builds** with `@cloudflare/worker-bundler`, one per Worker, as the dry run;
      - **Console build**: React, Tailwind and PostCSS bundled in the isolate. The **render smoke** runs on Browser Run.

   Results are recorded per SHA in D1. **A change request with any failing or missing check cannot merge.** Tests are never skipped or weakened to fit the runner. A test that cannot run there yet keeps running on GitHub until it is ported, and phase 3 is not done until every test runs in the Forge.
2. **Forge guards.** These are deterministic and run in a Dynamic Worker with no network:
   - **secret scan:** token and private-key patterns, high-entropy strings, replacing GitHub secret scanning;
   - **dependency audit:** `npm audit` output from the Build, replacing Dependabot alerts;
   - **policy:** no edits to tests that remove assertions without a recorded owner decision, and no trading code.
3. **AI review.** Every change request is reviewed on Workers AI by the existing auditor roles (pi and agy remain validators). Each reviewer gives a vote with reasons. The reviewers advise; a majority reject blocks the merge until it is resolved.
4. **Merge decision: agent consensus** (owner, §6.2). `merge_change` becomes an ADR-0009 action. The Policy Engine allows it only when all of the following hold:
   - every check is green;
   - the guards pass;
   - the AI review has no majority reject;
   - the base is current.

   Its class is **routine**. It is **critical** (owner click) when the change touches:
   - authentication and Access (`access.ts`, Access workflows or config);
   - the Policy Engine, the consensus rules or thresholds, or the kill switch;
   - secrets handling;
   - a migration that drops or rewrites data;
   - this ADR or ADR-0009.

   These paths stay with the owner because the standing rules forbid weakening auth, Access or tests without the owner.
5. **Merge.** The Forge fast-forwards (or makes a merge commit on) canonical `main` with the approved head SHA and writes `forge.merged` atomically with its audit event. If the base moved, the change request goes back to checks.

A merged SHA is not deployed by the merge itself. Deploys stay separate consensus actions (§3), with the existing limits: 1 per target per hour, 6 per 24 h.

The Console gets a **Code** section (`#/code`): change requests, diff, checks, reviews, approve/reject, and the commit history of `main`.

### 3. Build and deploy (replaces GitHub Actions deploy and Argo)

- **Build.** After a merge, the Forge runner bundles every changed Worker at that SHA (`@cloudflare/worker-bundler`; the Console UI as static assets). The Orchestrator then uploads each bundle through the **Workers Scripts API as a new version without traffic**, tagged with the SHA. So a merge builds versions but **never changes production**.
- The ADR-0009 flow is unchanged:
  1. Agents propose `deploy_commit` for the new `main` SHA.
  2. Consensus passes and the Policy Engine allows it.
  3. The Orchestrator promotes the uploaded version for that SHA to 100% through the **Workers Deployments API**.
  4. The Orchestrator then verifies through the Drift Detector.
- The policy checks for a deploy become:
  - `ci_green` means the Forge's checks for that SHA passed;
  - `commit_sha_valid` and "current `main`" are read from Artifacts;
  - **the SHA was merged by the Forge.**
- **Rollback** = Deployments API to the previous recorded version. There is no build and no GitHub. *This is phase 2 and the first thing that leaves GitHub.*
  - **Implemented 2026-11-08** (`deployment-orchestrator/src/native-rollback.ts`). Consensus and recovery rollbacks are queued in `deployment_requests` and executed by the Orchestrator's cron, only at SAFE minutes.
  - Each execution:
    1. captures the active deployment;
    2. deploys the tagged version at 100%;
    3. verifies it live through the Drift Detector's read-only `probeService`;
    4. records the desired version through the Registry's `recordRollback`, which accepts only a running native rollback request of the last hour;
    5. restores the captured deployment on any failure, and raises a critical report.
  - The path is active once the owner sets the Worker secret `CF_DEPLOY_TOKEN`. Until then, `rollback-worker.yml` stays the path, and it is retired after the native path has run.
- **D1 migrations.** The Orchestrator applies the new migrations of an approved SHA through the D1 binding, before the control-plane units. It reads the files from Artifacts by path at that SHA and checks them against `d1_migrations`. The rule "new migration deploys the control plane first and alone" stays.
- **Retire a Worker** = Workers Scripts API from the Orchestrator. This stays a critical action.
- **Smoke checks** move from GitHub scripts to the Orchestrator and Drift Detector, through Service Bindings.

### 4. Credentials (replaces the GitHub `production` Environment)

| Credential | Holder | Scope |
|---|---|---|
| Deploy token | Worker secret on the Orchestrator | Workers Scripts **Edit**, account `cryptophys` (versions, deployments, retire) |
| Upload uses the same deploy token | Orchestrator only | the Forge runner never holds a Cloudflare token; its isolates have no network |
| Artifacts | binding on the Forge (no token); repo-scoped short-TTL tokens for contributors | `platform-work` write; canonical read |
| Access service token `cryptophys-ci` | not needed once GitHub workflows are gone | revoke after cut-over (owner) |

The owner creates every credential. None is created by an agent or stored in the repository.

**Backlog for phase 4: Cloudflare Secrets Store** (owner, 2026-11-08: "masukan ke backlog ini akan masuk fase berikutnya").

- **What moves.** The Worker secrets move to account-level secrets in Secrets Store, bound with `[[secrets_store_secrets]]` and read with `await env.X.get()`:
  - `CF_DEPLOY_TOKEN` and `GH_ACTIONS_TOKEN` on the Orchestrator;
  - `ACCESS_GROUPS_TOKEN` on the Platform Registry.
- **Why.** The secrets are kept in one place and scoped to Workers. Their values cannot be read back by the API or the dashboard. Secrets Store has its own admin and deployer roles, and an audit log.
- **Code (done 2026-11-09, `control-plane-shared/src/secrets.ts`).** The code accepts both forms during the move: a plain Worker secret `NAME`, or a Secrets Store binding `NAME_STORE`.
  - The Orchestrator and Platform Registry entry points (`fetch`, `scheduled` and every RPC method) resolve `NAME_STORE` into `env.NAME` once per invocation, so the code that reads `env.NAME` is unchanged.
  - The store binding wins when it answers. A failing or empty store falls back to the Worker secret, so the switch can be reversed until the old secrets are deleted.
  - The bindings are added to `wrangler.toml` once the store ID is known, as `[[secrets_store_secrets]] binding = "GH_ACTIONS_TOKEN_STORE", store_id = "<id>", secret_name = "GH_ACTIONS_TOKEN"`. Do the same for `CF_DEPLOY_TOKEN_STORE` and `ACCESS_GROUPS_TOKEN_STORE`.
- **Owner steps.**
  1. Create the store.
  2. Enter the three secrets with the `workers` scope.
  3. Give the deploy tokens **Account Secrets Store Edit**, which deploying a Worker with this binding requires.
  4. Share the store ID, which is not a secret.
  5. Delete the old Worker secrets after verification.
- **Limits.** Secrets Store is in beta: one store per account, 100 secrets.
- **Not covered.** It does not replace the GitHub Actions secrets: runners cannot read Secrets Store values. Those leave with GitHub at phase 5.

### 5. Phases

| Phase | What | GitHub after the phase |
|---|---|---|
| **0. Decide** | Owner accepts this ADR and the §6 decisions. | unchanged |
| **1. Mirror and Forge read-only** | Create the `cryptophys` namespace; import the repository; `cryptophys-forge` Worker (read-only: commits, files, mirror freshness); Console `#/code` read-only. Spike: fast-forward/merge from a Worker into Artifacts. | source of truth |
| **2. Rollback and alerts off GitHub** | Orchestrator rollback via the Deployments API. Owner-attention and drift alerts from a Worker cron to the Console inbox (and email, if the owner wants it). `rollback-worker.yml`, `drift-alert.yml` and `owner-attention.yml` are retired. | source of truth; deploys only |
| **3. Checks and review in Cloudflare** | The Forge runner: test-harness port (`node:test` runner, D1 harness on a Facet SQLite database), type-check, bundles, Console build and render smoke; Forge guards; AI review; change requests in the Console. Run them **in parallel** with GitHub Actions on the same commits until they agree on ≥ 20 consecutive commits. | source of truth |
| **4. Deploy and merge from Cloudflare** | Forge bundles plus Scripts API version upload; Orchestrator promotion, migrations and smoke checks; `merge_change` by consensus. Shadow first: the Forge path computes the deploy and the GitHub path executes it, until they agree on ≥ 10 deploys (bundle hash or behaviour equal). Then the Forge path executes. | mirror |
| **5. Cut over** | Canonical = Artifacts. Contributors (Claude, pi, agy) push to `platform-work`. `GH_ACTIONS_TOKEN` is revoked. **The GitHub repository is archived** (owner, §6.3). It is not deleted. The R2 git bundles are the off-Artifacts copy. | archived |
| **6. Other repositories** | `cryptophys-adm/aether` and `cryptophys-adm/xauusd-ai-trading-assistant` follow the same pattern only after the owner decides, and their own owners/validators do the work there. | per repository |

Every phase keeps all tests green, keeps Access as is, and leaves the brake (mode `shadow`, kill switch) working throughout.

### 5b. Phase 1 progress (2026-11-08)

- **1a (this change).** The new `cryptophys-forge` Worker (`workers/forge`) uses the Artifacts binding (namespace `cryptophys`, repo `platform`). It provides:
  - a one-time import of the public GitHub repository;
  - read-only status and history of `main`;
  - a 10-minute write token that only the CI service token can get.

  `mirror-to-forge.yml` pushes `main` to the Forge after every push, so GitHub and the Forge hold the same SHAs while GitHub remains the source of truth. Deployment is by `deploy-forge.yml`, after Provision Access has added the Worker to the platform Access application.
- **1a live (2026-11-08).** The import is at `09a2533`, and the mirror has been running since `3dbbead`.
- **1b, part 1 (this change).** The Forge is in the Platform Registry (migration 0030) and the Drift Detector (`SVC_FORGE`). It is an Orchestrator deploy unit (`deploy-forge.yml`, paths `workers/forge/`), and it is in the Rollback Worker allow-list. `deploy-forge.yml` records its desired version.
- **1b (next).**
  - Add the Console `#/code` page.
  - Back up the repository with a daily `git bundle` to R2.
  - Spike the Forge-side merge (ADR §2.5).

### 5c. Phase 3 progress (2026-11-08)

- **Spike passed.** The control-plane suite runs in **workerd** through `tools/forge-runner`, with **all 329 tests passing** and the same per-file counts as Node.
  - The shims replace `node:test`, `node:sqlite` (sql.js), `node:fs` (a snapshot of the repository) and `node:os`/`node:child_process`.
  - Test modules are deferred to request time, because workerd's clock reads 0 at module evaluation.
- **Forge bundler (closes the last gap).** esbuild-wasm 0.28.2 runs inside the isolate and reads the repository snapshot.
  - It bundles the `main` named in a Worker's `wrangler.toml`, as ESM with `node:` and `cloudflare:` imports external.
  - The TP-025 dry-run test bundles `workers/home` through `globalThis.__FORGE_BUNDLE`. In Node CI it still runs `wrangler deploy --dry-run`, unchanged.
  - Measured in workerd: initialization 0.18 s; Home 22 KB in 0.35 s; Forge 22 KB in 0.11 s; AI Kernel 179 KB in 0.44 s.
- **Harness change.** `FakeD1.batch` now runs batches one at a time, as D1 does. Under workerd's faster `crypto.subtle`, concurrent batches had interleaved.
- **Forge checks (the runner moved into the Forge).** The suite now runs **on Cloudflare** for each new commit of `main` in the Artifacts repo (`workers/forge/src/checks.ts`, `runner/`).
  1. **Snapshot.** The commit's tree is read through the Artifacts binding (`readCommit`/`readTree`/`readBlob`). It contains text files only, with no `node_modules`/`dist`, no symlinks or submodules, and no file of 2 MB or more. Today that is 424 files, 2.7 MB.
  2. **Bundle.** esbuild-wasm runs in the Forge isolate: the test files, plus sql.js once per isolate. Measured: 43 files in about 5 s of CPU, with 31 MB of wasm memory.
  3. **Run.** Each Dynamic Worker (Worker Loader) runs up to 8 files: 6 Workers per run, under the 32 Worker invocations one request may make.
     - The test Workers have no network access (`globalOutbound: null`) and a 60 s CPU limit each.
     - TP-025 calls back to the Forge's `ForgeBundler` entrypoint (`ctx.exports`, with the commit as props), because the test Workers have no esbuild.
  4. **Record.** One row per commit in D1 `forge_check_runs` (migration 0031), plus the audit event `forge.checks_completed`. Operators read the runs at `GET /v1/forge/checks`.
  - **Schedule.** A cron at `:04/:19/:34/:49` checks at most one commit per tick: the oldest unchecked one among the newest 5 on `main`. A run still `running` after 30 minutes is retried.
  - **Same code locally.** `tools/forge-runner/run.mjs` runs this same checks code in local workerd. The only stand-in is the Artifacts repo, built from the working tree. Result: 329/329 in 38 s.
  - **Informational until parity.** Forge checks are not in the deploy gate until they agree with GitHub CI on 20 consecutive commits of `main`.
  - **Live since 2026-11-08 09:19 UTC.** The first run checked `8588e21` on Cloudflare: 43 files, 321 passed and 1 failed, in 43 s. The failure was expected. That commit predates the Forge bundler, so its TP-025 still called `npx wrangler`.
  - **Parity record.**
    - `forge-ci-report.yml` runs after "Validate Control Plane Workers" finishes on a push to `main`. It reports the conclusion to `POST /v1/forge/ci-report`, with the CI service token only.
    - Reports land in D1 `forge_ci_reports` (migration 0032).
    - `GET /v1/forge/checks` puts GitHub's conclusion next to each Forge check. It also counts consecutive agreements, newest first. A Forge `error` is never an agreement.
    - The Console Code page shows the checks and the `parity N/20` count.
- **Bundles and the secret scan (2026-11-08).** Each Forge check now has three steps (migration 0033).
  - **Tests.** As above.
  - **Bundles.** Every `workers/<name>/wrangler.toml` in the commit is bundled with esbuild-wasm. This is CI's `wrangler deploy --dry-run` loop: today 11 of 11.
    - The Worker's `[[rules]]` apply as Wrangler applies them: the glob is matched against the import specifier, and Text or Data imports load as text or bytes.
    - `.wasm` and `node_modules` imports stay external and are recorded. A snapshot has no `node_modules`, and Wrangler keeps them as separate modules.
  - **Secret scan (Forge guard, §2.2).** Well-known credential formats: private keys, GitHub, AWS, Slack, Google, OpenAI, Anthropic, Stripe live and Artifacts tokens, and JWTs. A finding records the rule, path and line, never the matched text.
  - **How the result reads.** `status` covers tests and bundles, which GitHub CI also runs, so the two stay comparable. The scan is reported apart as `guard_status`.
  - **Phase 4.** The merge gate requires both `status` and `guard_status`.
- **Parity CI.** `forge-runner-parity.yml` runs `tools/forge-runner` next to the Node suite on every PR and push.
- **Type-check in an isolate: measured, does not fit (2026-11-08).** A Workers isolate has 128 MB of memory. The type-check needs more, even split.
  - TypeScript 5.9 (`control-plane-tsconfig.json`, 276 files). Heap retained after `getPreEmitDiagnostics`, after GC:

    | Program | Heap |
    |---|---|
    | the whole project | 190 MB |
    | Worker sources only, no tests | 152 MB |
    | the AI Kernel alone | 131 MB |
    | one empty file with the same libs (`ES2022`, `DOM`, `@types/node`) | 109 MB |
    | the compiler module alone | 20 MB |

  - Dropping `DOM` (157 MB, 29 errors) or `@types/node` (143 MB, 176 errors) neither fits nor keeps the same check.
  - TypeScript 7.0.2 (the native compiler) checks the project clean in 0.34 s, using 116 MB heap and 145 MB RSS. It ships only native binaries per platform, with no WebAssembly build.
  - **Consequence.** The type-check cannot be a Forge check today without weakening it. It stays on GitHub Actions until a compiler fits in an isolate, or the owner chooses another runner. Phase 5 (archiving GitHub) waits for that decision.
- **Type-check on Workers Builds (owner decision 2026-11-08, evening).** Asked where the type-check should run, the owner first chose a Cloudflare Container (#236). Its deploy failed on the Containers API (the deploy token has no Containers permission) and Cloudflare refused the rollback across the Durable Object migration, so the Worker ran at `66a4859` with no Container and the step recorded `error`, never a pass. Asked again with the measurements of two alternatives, the owner chose **Workers Builds from the Artifacts repository**; the Container was withdrawn (#237). The alternatives, measured:

  | Option | Evidence | Verdict |
  |---|---|---|
  | Browser Run (the compiler in headless Chromium) | 279 files, 0 errors, 2.3 s, 167 MB heap; an injected error reported | Works; kept as the fallback |
  | Workers Builds from Artifacts | Supported by Cloudflare (Oct 2026); 4 vCPU, 8 GB, 6,000 min/month included | **Chosen** |
  | Cloudflare Container | Worked in CI; needs a token permission and an ADR-0005 exception | Withdrawn |

  - **Project.** `workers/forge-typecheck/` is the Builds project (root directory). Its build command `node typecheck-and-report.mjs` installs the locked toolchain in `control-plane-shared` and runs `tsc --noEmit -p workers/control-plane-tsconfig.json`; its deploy command deploys a stub Worker with no route, no `workers.dev` URL and no bindings, because Workers Builds deploys a Worker.
  - **Report.** The build reports `{commit, conclusion, build_id, branch, files, errors, diagnostics, toolchain}` to `POST /v1/forge/typecheck-report` with the CI service token. Diagnostics are text only. The Forge stores one row per commit (`forge_typecheck_reports`, migration 0035), audits `forge.typecheck_reported`, and folds the result into its check of that commit: the `typecheck` step, and a failure fails the check. Until a report arrives the step reads `pending`.
  - **Setup (owner, dashboard).** Connect the Artifacts repository `cryptophys/platform` to a Worker `cryptophys-forge-typecheck`, root `workers/forge-typecheck`, with `FORGE_URL` and the existing CI service token as build secrets. `workers/forge-typecheck/README.md` has the steps. Preview builds on other branches give phase 4 its branch checks.
  - **Consequence.** The type-check leaves GitHub without a Container. The stub deploy is the one deploy that is not governed by consensus; it is not a production service and is not in the registry.
  - **Proven (2026-11-09).** The owner connected the Builds project. Build `d5b0391f` reported `success` (0 errors; TypeScript 5.9.3) for `5e228b8` at 05:03 UTC, and the Forge check of that commit passed with `typecheck: passed` (379 tests, 12 bundles, secrets clean). Two lessons, both fixed in code: Workers Builds may leave `WORKERS_CI_COMMIT_SHA` empty, so the build reads the commit from the checkout (#238); and `fetch` follows an Access redirect to the sign-in page, so the report now uses `redirect: "manual"` and accepts only a JSON 200 naming the commit (#240). The CI service token's credentials go in **build variables and secrets**, not in the Worker's runtime secrets.
  - **TypeScript 7 (owner, 2026-11-09).** Every package moved from TypeScript 5.9.3 to 7.0.2, the native compiler (Dependabot #233 widened to all packages). The control-plane project checks in about 0.6 s instead of tens of seconds. One source change: TypeScript 6+ checks side-effect imports by default, so the Console UI declares `*.css` (`workers/console/ui/src/css.d.ts`). The Workers Builds type-check installs the same lockfile, so its reports name TypeScript 7.0.2.
  - **Console build (2026-11-09).** The same Workers Builds run builds the Console UI (`npm run build` in `workers/console/ui`: its own `tsc --noEmit`, then Vite) and reports it as `console_build` with the type-check (migration 0036). A failed Console build fails the step and the check, as it fails GitHub CI. The checks list gives each commit `ready`: tests and bundles passed, no secret, types passed and the Console built. The Console Code page shows `UI build ok` and `ready`. The Chromium render smoke stays on GitHub for now; Workers Builds has no browser.
- **Next.**
  - Phase 4: the merge gate requires `ready`.
  - Use the Forge bundles for deploys, then the Console assets built on Workers Builds.
  - Run checks for branches and proposals (phase 4).

### 5d. Phase 4 progress (2026-11-09)

The owner said "lanjutkan semua" (continue everything) on 2026-11-09. Phase 4 starts in shadow: the Forge computes, and GitHub still executes.

- **4.1 Change requests (shadow).**
  - `forge-change-request.yml` runs after GitHub CI on each same-repository pull request. Forks are ignored. The workflow runs from the default branch, so the production secrets stay behind the main-only environment rule.
  - It pushes the pull request's head to the Artifacts branch `cr/<number>` and registers change request `gh-<number>` with the merge base, title, author and GitHub CI conclusion. Nothing from the pull request runs.
  - The Forge computes the changed paths with a tree diff and the owner-only reasons of §2.4:
    - auth and Access files;
    - the Policy Engine;
    - the consensus rules and the kill switch (`consensus-*.ts`);
    - secrets handling;
    - a migration that rewrites or drops data, or edits an applied migration;
    - ADR-0009 and ADR-0012;
    - fewer assertions in a test, or a removed test (the §2.2 policy guard).
  - The cron checks open change request heads first, then commits of `main`.
  - The verdict is one of:
    - `pending`: the check, type-check or Console build has not reported yet;
    - `blocked`: something failed;
    - `needs_owner`: everything passed, but the change touches an owner-only path;
    - `would_merge`: everything passed and the change is routine.
  - `mirror-to-forge.yml` reports GitHub's outcome:
    - the pull request a `main` commit merged, read from its `(#N)` subject;
    - recently closed pull requests that were not merged.

    It also deletes their `cr/` branches. The verdict at that moment is frozen next to the outcome.
  - **Merge parity:** a GitHub merge agrees when the Forge would have merged it or asked the owner. It disagrees when the Forge had blocked it. A `pending` verdict counts as "Forge late" and is not compared. The bar for the Forge to merge by itself is 10 consecutive agreements.
  - The Console Code page shows the change requests (route `forge.changes`, read-only).
  - **Deviation from §1.** During the shadow phase the `cr/` branches live in `platform`, not in `platform-work`, so that the existing Workers Builds project type-checks them as preview builds. They move to `platform-work` at cut-over.
  - **Preview builds withdrawn (2026-11-09, security).** Preview builds of `cr/<number>` never triggered from the Artifacts repository. They must not be used with the build secrets anyway: a build runs the branch's own code, so a change request could read the CI service token. GitHub never exposes production secrets to pull request code, and that stays true here. The owner turned preview builds off. Change request type-checks need a build with no secrets whose result the Forge reads itself with a read-only Workers Builds token held by the Forge. That design waits for the owner.
- **4.2 Deploy plan (shadow).**
  - The deploy units and their ordering rules move to `control-plane-shared/src/deploy-units.ts`. The rules are: a new migration deploys the Control Plane first and alone; the orchestrator deploys before the others; the plan fails closed when the Control Plane is unavailable. The Orchestrator's behaviour is unchanged.
  - Each Forge cron tick computes the plan for main's head from the Artifacts repository, using a tree diff from each unit's desired version. It records the plan under the registry fingerprint, which is every unit's desired versions.
  - The Orchestrator's `pendingDeploys`, which reads the GitHub compare API, records its plan for the same commit and fingerprint. The recording never blocks a deploy decision.
  - Whichever records second sets `agrees` (`forge_deploy_plans`, migration 0038).
  - **Plan parity:** consecutive agreements, target 10. Once it reaches the target, deploy decisions can stop depending on GitHub to say what changed. Executing deploys from Forge bundles through the Workers Versions API comes after that and needs `CF_DEPLOY_TOKEN` on the Orchestrator (§4).
  - The Console Code page shows the plans (route `forge.deploy_plans`, read-only).

### 5e. Leaving GitHub, step G1: deploy decisions read the Forge (2026-11-12)

Owner, 2026-11-12: "tunda hingga berhasil lepas dari github" (ADR-0014 waits until the platform is off GitHub), then "ya mulai G1, lanjutkan semua". The remaining steps are G1 to G6:

| Step | What |
|---|---|
| G1 | deploy decisions read the Forge |
| G2 | deploy from Forge bundles |
| G3 | merge on the Forge |
| G4 | contributors push to Artifacts |
| G5 | replacements for Dependabot and secret scanning |
| G6 | cut-over and archive |

- **The parity bars were met before the switch:** deploy plans 78 of 78 against a target of 10, and checks 34 of 34 against a target of 20.
- **Decisions.** `pendingDeploys`, consensus `deploy_commit` and recovery redeploys now decide from the Forge's records in D1 (`control-plane-shared/src/forge-gate.ts`):
  - main's head is the newest commit the Forge planned;
  - "CI green" is the Forge's `ready`: tests, bundles, no secret, type-check and Console build all passed;
  - the pending units are the Forge's plan for that head under the current registry fingerprint.
- **Removed.** The GitHub compare and CI lookups are gone from these paths, and the Orchestrator no longer records a GitHub side of the plan.
- **Fail closed.** Every missing piece of evidence leaves nothing pending:
  - no plan, or no plan yet for the current fingerprint;
  - the head not yet checked;
  - checks not ready;
  - the Forge's tables unavailable.
- **Until G2.** The unit's GitHub workflow still performs the deploy, and it deploys only GitHub's main head. So the dispatch also requires GitHub's main to equal the Forge's head (`github_main_not_mirrored`), which also catches a Forge that stopped mirroring.
- **Plan age.** A plan's age is not used as a freshness signal. The Forge records a plan only when main or the registry changes, and a unit can wait hours for a deploy slot under an unchanged plan.
- **Still on GitHub until G2.** The manual `POST /v1/deployments` path (Platform API) keeps its GitHub CI gate.

### 5f. Step G2a: the Forge keeps what it built (2026-11-12)

Owner, 2026-11-12: "lanjutkan G2 sambil menunggu deploy".

- **What is stored.** When a commit of main passes the Forge's checks with no secret found, the Forge writes to the R2 bucket `cryptophys-forge-bundles`:
  - each Worker module it bundled, as `bundles/<sha>/<worker>.mjs`;
  - a manifest, `bundles/<sha>/manifest.json`, written last so that every module it names already exists.

  This is `workers/forge/src/bundles.ts`. Bundles are kept 14 days; Workers keep their own uploaded versions for rollback.
- **The manifest, per Worker:**
  - the module's SHA-256 and size;
  - `config_sha256`, the hash of its wrangler.toml;
  - its compatibility date and flags;
  - `single_module`: false when the bundle imports files it does not inline, such as WebAssembly;
  - `assets`: whether it serves static assets.
- **Next, G2b.** The Deployment Orchestrator uploads the stored module as a Worker version tagged with the commit, keeping the running version's bindings and assets, then deploys and verifies it. This covers a Worker whose `config_sha256` equals the running version's, which is a single module and serves no changed assets. Its first step checks the uploaded version's bindings against the running ones before any traffic moves. Any other change (configuration, D1 migrations, assets, multi-module) keeps the GitHub workflow until its own step.

### 5g. Step G2b: the Orchestrator deploys code-only changes itself (2026-11-12)

- **What was built.** A consensus `deploy_commit` can now deploy a unit without GitHub Actions, from the module the Forge already built (`workers/deployment-orchestrator/src/native-deploy.ts`).
  - The Forge's manifest gained `migrations`: the sorted D1 migration file names of the commit. The schema stays `forge-bundles.v1`; a manifest without the field reads as "migrations unknown".
  - The Orchestrator has a read-only binding `BUNDLES` to `cryptophys-forge-bundles`.
  - The Platform Registry has `recordNativeDeploy`, on the same `RegistryRpc` entrypoint as `recordRollback`.
- **Eligibility.** After the G1 Forge gate (main's head, `ready`), the unit deploys natively only when all of these hold. Any other answer keeps the GitHub workflow:
  - the target commit has a manifest (else `no_bundle`) that lists its migrations (`migrations_unknown`);
  - for every Worker of the unit, in unit order:
    - it is in the target manifest (`service_not_in_bundle`);
    - it serves no static assets (`assets`) and is a single module (`multi_module`);
    - the registry knows the version it runs (`desired_version_unknown`), and the Forge's bundles hold that version's manifest, found by listing `bundles/<tag>` (`running_bundle_missing`);
    - its `config_sha256` equals the running version's, so its wrangler.toml did not change (`config_changed`);
    - the running manifest's migrations equal the target's (`new_migration`, or `migrations_unknown` for a G2a manifest).
- **Queue and execution.** These follow native rollback, with one executor loop for both:
  - The request is a `deployment_requests` row with `details.executor = "native:deploy"`, signed with an HMAC keyed by `CF_DEPLOY_TOKEN` under its own prefix.
  - It holds the same per-workflow-and-commit lock as the GitHub dispatch, so a commit is queued or dispatched, never both.
  - The Orchestrator's cron runs it at a SAFE minute under a one-time Durable Object claim; a queued deploy expires after 45 minutes. One deploy runs per cron run.
  - Before the claim, the executor checks again that the commit is still the Forge's head, still `ready`, and still eligible.
  - For each Worker, in the workflow's deploy order:
    1. capture the active deployment, which must be one version at 100%;
    2. upload the module, after checking its SHA-256 and size against the manifest, as a version tagged `workers/tag = <tag12>`. The version keeps every binding type the platform uses (`keep_bindings`) and sends none itself;
    3. deploy it at 100%;
    4. verify through the Drift Detector that it reports the tag and is healthy (the same 12 attempts as native rollback).
  - When every Worker is verified, the Registry sets `desired_version` for every Worker of the unit, with actor `native-deploy:<request>`.
- **The binding check.** `keep_bindings` copies bindings from the script's latest uploaded version, which need not be the active one. So after the upload, the new version's bindings are compared with the active version's before traffic moves:
  - the sorted `type:name` lists must be equal;
  - a digest of the full binding records as the API returns them must be equal. This catches, for example, a service binding that lost its `props`.

  Any difference stops the deploy. An uploaded version that is never deployed is harmless.
- **Failure.** On any failure, every deployment already changed is restored to its captured version, newest first. The request is failed, and the same critical report as native rollback is raised.
- **Fallback.** When native deploy is not configured, or the unit is not eligible, the GitHub dispatch runs exactly as before. The ineligibility reason is recorded in the `deployment.dispatched` audit payload (`native_deploy`). Only the GitHub path keeps the `github_main_not_mirrored` check; the native path does not call GitHub.
- **Not covered yet:**
  - The Forge's own Worker is ineligible because it is multi-module (WebAssembly).
  - The Console is ineligible because it serves assets. (Lifted by G2c-2 step 6, §5l, once the Forge stores its build.)
  - Recovery redeploys (`deployForRecovery`) stay on GitHub, because the Recovery Manager follows a deploy through the workflow run (`runStatus`).
  - A version upload does not carry wrangler.toml settings that are not bindings, such as `[limits]`. Today only the Forge has `[limits]`, and the Forge is ineligible.
- **Owner prerequisites.** These are the same as for native rollback:
  - the Orchestrator's Worker secret `CF_DEPLOY_TOKEN`, with Workers Scripts Edit;
  - `CF_ACCOUNT_ID`, which the deploy sets;
  - the `BUNDLES` binding, which the next Orchestrator deploy creates.

  Until these are set, every deploy stays on GitHub. `GET /ready` reports `native_deploy` for information; it is not a readiness gate.

### 5h. Step G3a: the Forge can merge (fast-forward) (2026-11-12)

This is the first half of G3 and the spike that phase 1 listed ("fast-forward/merge from a Worker into Artifacts").

- **The constraint.** The Artifacts Workers binding reads commits, trees and history, and mints repo-scoped tokens. It cannot create commits or move refs. Refs move only through the Git smart-HTTP protocol at the repository's `remote`, authenticated with `Authorization: Bearer <write token>`.
- **What was built** (`workers/forge/src/merge.ts`).
  - `fastForward` speaks just enough of `git-receive-pack`:
    1. ref discovery (`GET <remote>/info/refs?service=git-receive-pack`), which reads the branch and the server's capabilities;
    2. it refuses, without sending the update, unless the discovered value equals the expected old value;
    3. `POST <remote>/git-receive-pack`: one command pkt-line `<old> <new> refs/heads/<branch>` with `report-status` (and `delete-refs` for a delete), a flush, and, unless the command is a delete, an empty packfile (`PACK`, version 2, no objects, SHA-1 trailer);
    4. it reads `report-status`: `unpack ok` and `ok <ref>` are success; `ng <ref> <reason>` and unpack errors are refusals.

    The old value sent is the one just discovered, which receive-pack compares under the ref lock, so a push that lands in between fails instead of being overwritten. Redirects are not followed.
  - `isAncestor` walks parents through the binding (`readCommit`), at most 500 commits; anything unreadable or deeper answers false.
  - `forgeMerge(binding, repo, { head, base, branch })` refuses unless `base` is the branch's current head (`base_not_current`) and `head` descends from it (`not_fast_forward`). It then mints a write token with a 120 s TTL, calls `fastForward`, and reads the branch back through the binding; it must equal `head` (`verify_mismatch`).
  - The token is sent only in the header (the `?expires=` suffix is stripped). It is never logged, stored, audited or returned.
- **Why fast-forward only.** A fast-forward needs no new objects, so the Forge never builds commits, trees or packs, and the merged SHA is exactly the SHA the checks passed. receive-pack does not refuse a non-fast-forward unless the server is configured to (git's client does that), so the Forge's own ancestry check is the guard. A change request whose head does not contain the current `main` is `not_fast_forward`: the contributor updates the branch (a rebase, or a merge commit of their own), and the checks run again on the new head. Merge commits made by the Forge are not planned.
- **The spike** (`POST /v1/forge/merge-spike {confirm: "SPIKE"}`, approvers only; operators and service tokens get 403).
  - It forks `platform` once into the scratch repository `merge-spike` (`fork`, default branch only) and reuses it afterwards. While the fork is in progress it answers 202. The `import` fallback was not built: it would put a read token into the import's recorded source URL.
  - On `merge-spike` it takes main's head H and its first parent P, removes a leftover `spike` branch, creates `refs/heads/spike` at P, fast-forwards it P → H with `forgeMerge`, checks through the binding that it resolves to H, deletes it, and checks that `main` did not move. It always tries to delete the branch, even after a failed step.
  - Every push goes to the remote of `merge-spike`, which must be this account's Artifacts host and that exact path; `forgeMerge` refuses the repository `platform` (`canonical_not_enabled`).
  - The audit event `forge.merge_spike` records the outcome and every step (ref, old, new, reason), without the token.
- **Not verified against the live service.** The protocol details (capability names, the empty pack accepted for a create or an update, a `report-status` without side-band, the `delete-refs` capability) follow the Git protocol and Cloudflare's statement that Artifacts speaks standard smart HTTP. The spike is the test. If any of them is wrong, a step records `ok: false` with the reason (`capability_missing:…`, `push_http_…`, `rejected:…`, `unpack_failed:…`, `verify_mismatch`), the route answers 502, and nothing outside `merge-spike` is touched.
- **Next, G3b.** `merge_change` (§2.4) on canonical `main` waits for the cut-over (G6). While GitHub is canonical and `mirror-to-forge.yml` pushes GitHub's main to `platform`, a Forge merge would diverge from the mirror: the next mirror push would be a non-fast-forward. Until then the Forge computes its verdict (§5d) and GitHub merges.

### 5a. Owner notices (phase 2, implemented 2026-11-08)

The AI Kernel computes three notices from D1 at `:22` and `:52` (`ai-kernel/src/owner-notices.ts`):

- `owner_attention`: draft recovery plans and `pending_owner` proposals;
- `drift`: drifted, never-observed and stale (> 45 min) services, ignoring disabled ones;
- `critical_reports`: critical agent reports in the last 24 h.

How notices are kept and shown:

- Each change of a topic (opened, changed, closed) is one audit event (`owner.notice_*`). That is the notice state, so no table is needed.
- The Console shows the active notices on the Command page ("Needs your attention") from `GET /v1/notices`.
- **Email** goes to the people in `APPROVER_IDENTITIES`. It is sent through the kernel's `send_email` binding `OWNER_EMAIL` from `NOTIFY_FROM = alerts@notify.cryptophys.work`, and the owner onboards `notify.cryptophys.work` in Email Service → Email Sending. Onboarding a subdomain adds its own `cf-bounce` MX, SPF, DKIM and DMARC records, and leaves the mail setup of `cryptophys.work` untouched. If sending fails, the notice is retried every run until delivery succeeds.

`owner-attention.yml` and `drift-alert.yml` were retired on 2026-11-08, after the first owner email was delivered (audit `delivery: sent`). Their summary scripts and script tests went with them.

*Amended 2026-11-13 (owner: "Batasi User/Owner hanya untuk critical dan permintaan approval only"; ADR-0009 amendment of that date).* The topics are now seven (`organism`, `build_minutes`, `dependencies` and `production_unhandled` were added since). Only `owner_attention`, `critical_reports` and `production_unhandled` (`OWNER_CHANNEL_TOPICS`) are emailed and sent to Telegram, and all three link to the Console's Owner page (`#/owner`, read from `GET /v1/owner/inbox`). The other topics are console-only: still computed, audited and shown at `GET /v1/notices` (each notice carries `channel`), never emailed or sent to Telegram.

### 5i. Step G5: Dependabot and secret scanning off GitHub (2026-11-12)

The Consequences below require replacements for GitHub's Dependabot and secret scanning before phase 5.

- **Secret scanning was already replaced.** Every commit the Forge checks (each new commit of main and each change request head) is scanned in full by `scanSecrets` (`forge/src/runner/core.ts`):
  - It covers every text file of the snapshot, outside `node_modules`, `.git`, `dist` and `.wrangler`.
  - A finding sets `guard_status = findings`, so the commit is not `ready`: no consensus deploy takes it, and no bundle is stored.
  - A finding records the rule, the path and the line, never the matched text.
  - G5 adds one rule, `npm_token`. The rules now cover private keys and GitHub, AWS, Slack, Google, OpenAI, Anthropic, Stripe live, Artifacts and npm tokens, plus JWTs.
- **What the secret scan does not cover.** Unlike GitHub's scanning, it does not cover:
  - binary files, and files of 2 MB or more;
  - commits the Forge never checks. A tick checks the oldest unchecked of main's five newest commits, so a secret added and removed within a longer push stays in history unscanned;
  - credential formats without a fixed prefix, such as Cloudflare API tokens.

  The Forge also has no push protection: it sees a commit only once it is on main, or on a change request.
- **Dependabot's alerts, replaced** (`forge/src/dependency-audit.ts`, migration 0051):
  - **When.** A Forge tick step, `dependency_audit`, runs at most once a day per head of main, or an hour after a failed run.
  - **What it reads.** It walks main's tree in the Artifacts repository and reads every `package-lock.json`:
    - lockfileVersion 2 and 3 through the `packages` map, nested installs included;
    - version 1 through its nested `dependencies`;
    - not the root entry, `link` entries, `node_modules` or build output.
  - **What it asks.** It asks the npm registry's bulk advisory endpoint, the one `npm audit` uses (`POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`), in batches of at most 900 names. Only package names and versions are sent.
  - **The answer.** For each name, a list of advisories with `id`, `url`, `title`, `severity`, `vulnerable_versions`, `cwe` and `cvss`. The registry answers `{}` when nothing is affected.
  - **Matching.** The Forge re-checks each advisory's range against each installed version, with a small semver matcher. A prerelease is compared by full precedence, which reports more rather than less. A range it cannot read counts as affected. So a finding names the exact affected version.
  - **Where.** A finding is `runtime` when a lockfile that installs it belongs to a Worker, which is a `workers/<dir>` with a wrangler config; this includes the Console UI build under `workers/console/ui`. Any other lockfile is tooling, for example `workers/control-plane-shared`.
  - **Records.** One row per run in `forge_dependency_audits`: the head, lockfiles, packages, advisories, counts by severity, status `ok` or `failed`, and the error. One row per finding in `forge_dependency_findings`. Both are kept 90 days. A change in the set of advisories is audited (`forge.dependency_audit`). A failure is recorded and never thrown out of the tick.
- **Shown.**
  - `GET /v1/forge/dependency-audit`, operators, read only, returns the latest run, the latest successful run and its findings.
  - The Console Code page has a panel for it, and the route is on the Console's read-only allowlist.
- **Owner notice `dependencies`.**
  - It opens when the latest successful run has a high or critical advisory in a runtime lockfile, or when no run has succeeded for 72 hours.
  - The fingerprint is the sorted advisory ids, so the owner gets one email per new set of advisories, not one per run. It links to `#/code`.
- **Not replaced yet: Dependabot's upgrade pull requests.** Findings are reported, not fixed. An agent, or later the evolution loop (ADR-0014), proposes the upgrades as change requests.

### 5j. Step G4: contributors push to Artifacts (2026-11-12)

Contributors (Claude Code sessions, other agents) push their branches to the work repository `cryptophys/platform-work` instead of opening GitHub pull requests. The Forge registers each pushed branch as a change request and checks it with the same pipeline as the GitHub-sourced ones of §5d (`workers/forge/src/work-repo.ts`, migration 0052).

- **The work repository.** `POST /v1/forge/work-repo {confirm: "CREATE"}`, approvers only (operators and service tokens get 403), forks `platform` into `platform-work` with the binding's `fork` (default branch only), the same helper the G3a spike uses. It is idempotent: 202 while the fork is in progress, 200 once it is ready. It reports the repository name and its remote host, never a token; anything `fork` returns is dropped. Each outcome (`ready`, `forking`, `failed`) is audited as `forge.work_repo`. The Forge only reads `platform-work`; it never writes it.
- **Discovery.** A Forge tick step (`work_branches`, after `cr_typecheck`, only with the Artifacts binding) does the following:
  1. it mints a read token with a 120 s TTL for `platform-work` and checks that its remote is this account's Artifacts host and that exact path;
  2. it runs Git smart-HTTP ref discovery, `GET <remote>/info/refs?service=git-upload-pack` with `Authorization: Bearer <token>`, parsed by G3a's pkt-line code;
  3. it takes `refs/heads/*` except `main`, and only names matching `^(cr|claude|agent)/[A-Za-z0-9._/-]{1,80}$` that git itself accepts. Every other ref is ignored.

  Each branch becomes the change request `fg-<slug>` (the branch with `/` replaced by `-`), with `source = 'forge'`, `repo = 'platform-work'`, `number = 0` and no GitHub CI. The title is the head commit's subject, and the author is its author name, without the e-mail.
  - At most 5 branches are (re)registered per tick; the rest wait for the next tick.
  - When two branches give the same slug (`claude/a/b` and `claude/a-b`), the one registered first keeps the id. The other is reported as a collision and is not registered.
  - A head the binding cannot read yet waits for the next tick.
  - A branch that disappeared closes its change request (`status = 'closed'`), with the verdict at that moment frozen next to it (`forge.change_outcome`, reason `branch_deleted`). A branch that comes back reopens it.
  - A failed discovery (HTTP error, not smart HTTP, untrusted remote) changes nothing, and it is audited as `forge.tick_failed`.
- **The fast-forward requirement.** The base of a forge-sourced request is canonical `platform` main's head, and only if it is an ancestor of the branch head. Ancestry is read through `platform-work`, which holds the fork's objects and everything pushed since (`isAncestor`, at most 500 commits).
  - When the base is not an ancestor, or main's head is not in `platform-work` at all, the request has `blocked_reason = not_based_on_main` and its verdict is `blocked`. It is not checked. The contributor merges or rebases the current main into the branch and pushes again. This keeps the later G3b merge a fast-forward (§5h).
  - A request is evaluated again when its head changes or when main moves. So a branch that was based on the old main becomes `not_based_on_main` once main moves past it.
  - Changed paths and the owner-only reasons of §2.4 come from the same tree diff and `criticalReasons` code as GitHub-sourced requests, read from `platform-work`.
- **Checks read the right repository.** Each change request records the repository its head lives in (`repo`): `platform` for `gh-<n>` (heads pushed to `cr/<n>` of `platform`) and `platform-work` for `fg-<slug>`.
  - The change-check step picks a GitHub-sourced head first, from `platform`, exactly as before. Only when none waits does it check a forge-sourced head, from `platform-work`.
  - The bundler entrypoint falls back to `platform-work` for a commit that is not in `platform`.
  - The check run itself is keyed by commit, as before.
- **The type-check gap.** The secret-free change-request type-check (Workers Builds `cryptophys-forge-typecheck-cr`, §5d) builds `cr/<n>` branches of `platform` only. For a forge-sourced head, the type-check step is recorded as `not_configured`; a report that does exist for the same commit is kept. `cr-builds.ts` looks up GitHub-sourced requests only.
  - `verdictOf` treats `not_configured` explicitly as `pending` ("no type-check source for this head"). So **a forge-sourced request cannot reach `would_merge` until a type-check source exists for `platform-work`.** G3b needs one. One option is a Workers Builds project connected to `platform-work`, under the same no-secrets rule as `forge-typecheck-cr`; that waits for the owner.
- **Merge parity.** Forge-sourced requests are never merged by GitHub, so they never count towards the merge parity of §5d. A closed one has `agrees = NULL`.
- **How a Claude Code session pushes.** No token is in chat or in the repository.
  1. The owner creates a repo-scoped **write** token for `platform-work` in the dashboard: Storage & databases → Artifacts → cryptophys → platform-work → Tokens.
  2. The owner stores it through the session's secure credential form, for the host `<account>.artifacts.cloudflare.net` (the account's Artifacts host, the host of the repository's remote), as `Authorization: Bearer`.
  3. The session adds the remote `https://<account>.artifacts.cloudflare.net/git/cryptophys/platform-work.git` and runs a plain `git push <remote> HEAD:refs/heads/claude/<topic>`. The session's proxy injects the header.

  Before pushing, the session merges or rebases the current main, so that the branch is based on main. The Forge's next tick (:04/:19/:34/:49) registers the branch. `GET /v1/forge/changes` and the Console Code page show it with the source badge "forge".
- **Not verified against the live service.** Upload-pack ref discovery follows the Git protocol (v0/v1 advertisement, `# service=git-upload-pack`, a `HEAD` line with the capabilities, then `refs/heads/*`), like the receive-pack discovery of §5h. Two things are assumptions:
  - a read token is accepted for `info/refs?service=git-upload-pack`;
  - `fork` lists the new repository as `forking` and then `ready`.

  If discovery fails, the tick step records `work_discovery_failed:<reason>` (`discovery_http_<status>`, `discovery_not_smart_http`, `discovery_malformed`), audits it as `forge.tick_failed`, and closes nothing. If the fork never appears, the route answers 202 with `fork_not_listed`.

### 5k. Step G2c-1: migrations, multi-module Workers and recovery redeploys go native (2026-11-12)

- **What the Forge stores now.** The manifest stays `forge-bundles.v1`; every new field is optional, and a reader treats a missing one as unknown.
  - `migration_files`: each migration's `{ file, sha256 }`, with its SQL at `bundles/<sha>/migrations/<file>`. `migrations` (the names) stays.
  - Per Worker, `modules`: each file the bundle imports but does not inline, as `{ name, type, sha256, bytes }`, stored at `bundles/<sha>/<worker>/<name>`.
    - The bytes come from the package the commit's `package-lock.json` pins. The Forge fetches the tarball from the npm registry, checks the lockfile's sha512 integrity before reading it, and takes the file out of the tar (`workers/forge/src/externals.ts`). A snapshot has no `node_modules`, so this is how `npm ci` would get the same file.
    - The type follows Wrangler: a Text rule gives `text/plain`, a Data rule `application/octet-stream`, `.wasm` gives `application/wasm`, and JavaScript that reads as an ES module gives `application/javascript+module`.
    - The bundle's import of each file is renamed to `./<name>`, the name the Orchestrator uploads it under.
    - When any file cannot be resolved or typed, the Worker gets `modules_error` and no `modules`.
  - Per Worker, `limits`: whether its wrangler.toml has `[limits]`.
- **Eligibility changes** (`native-deploy.ts`). Everything else is as in §5g.
  - `limits` (new): a Worker with `[limits]` is ineligible, because a version upload does not carry it. This keeps the Forge (`cpu_ms = 300000`) on its workflow until G2c-2. (Lifted by the G2c-2 wiring, §5l: such a Worker now deploys only through the verified configuration plan.)
  - `multi_module` now means only that the manifest has no `modules`.
    - A multi-module Worker is eligible when every external file is a stored module and the bundle imports each one by its name.
    - Each module's bytes must match its sha256 and size. Otherwise it is ineligible with `module_missing`, `module_hash_mismatch` or `module_not_imported`.
  - `new_migration`: for the Control Plane unit, when both manifests have `migration_files`, a changed list is eligible if all of these hold:
    - no applied file was edited or removed (`destructive_migration`, with `file`);
    - the new files sort after the running ones (`migration_out_of_order`);
    - the D1 table `d1_migrations` lists exactly the running manifest's files (`d1_migrations_mismatch`, or `d1_migrations_unreadable`). When it already lists the target's files, nothing is applied;
    - for each new file: its SQL is in R2 and matches its sha256 (`migration_missing`, `migration_hash_mismatch`); it splits into statements (`migration_unreadable`); it does not match the Forge's `DESTRUCTIVE_SQL` (`destructive_migration`); and it has no statement a D1 batch cannot run, such as `BEGIN`, `COMMIT`, `PRAGMA` or `ATTACH` (`migration_unsupported_statement`).
  - Another unit whose migration list changed is eligible once the ledger lists exactly the target's files, so the Control Plane applied them first. Otherwise it is `new_migration`, as before.
  - A manifest without `migration_files` (G2b and older) keeps the G2b answer, `new_migration`. So the first migration after this step still goes through GitHub.
  - The shared rules are in `control-plane-shared/src/migration-rules.ts`. A test keeps `DESTRUCTIVE_SQL` and the comment stripping equal to the Forge's (`changes.ts`).
- **How a migration is applied.** This matches `wrangler d1 migrations apply`:
  - The new files are applied in filename order, before the first Worker is captured, through the Orchestrator's own `DB` binding.
  - Each file is one `DB.batch`, which D1 runs as one transaction. The batch is `INSERT INTO d1_migrations (name) VALUES (?)` followed by the file's statements.
  - This is wrangler's row: wrangler appends `INSERT INTO "d1_migrations" (name) values ('<file>')`, and `id` and `applied_at` are the column defaults of the table wrangler creates. The insert comes first, so a file that is already recorded (UNIQUE `name`) fails before any of its statements run.
  - The statements come from a splitter that knows quotes, comments and trigger bodies. A test applies every repository migration through it and gets the same schema as a plain `exec` of each file.
  - Each file is audited as `deployment.native_migration_applied` (or `deployment.native_migration_failed`). The request's outcome records `migrations_applied` and `restore_point_at`, the time before migrating, for a D1 Time Travel restore.
- **When a migration fails.** Migrations are forward-only.
  - The request stops before any Worker is captured, and the request fails.
  - The failed file's own batch is rolled back. The files before it stay applied.
  - The critical report names `migration_failed` and `migrations_applied`, and says that the owner decides whether to fix forward or restore D1.
  - A Worker that fails after the migrations were applied restores the Workers, never the schema, and the report says so.
- **Recovery redeploys.**
  - `deployForRecovery` takes the native path when the unit is eligible. It queues the same signed `native:deploy` request, with `requested_by = recovery:<plan>` and `idempotency_key = recovery:<workflow>:<sha>`, the recovery lock of the workflow path.
  - `DeployRpc.requestStatus(requestId)` reports a native request as `queued`, `in_progress` or `completed` with `success` or `failure` and the reason. The Recovery Manager follows a native redeploy, and also a native rollback, which until now had no workflow run to follow, by request id, for up to 60 minutes.
  - A retried step gets the request it queued before.
  - Otherwise the workflow is dispatched as before, with `native_deploy` (the reason) in its audit payload.
- **Not verified live.** These are assumptions, checked only against the documentation and the fake APIs in the tests:
  - that D1 rolls back a whole `batch` when one of its statements fails;
  - that D1 accepts `CREATE TRIGGER … BEGIN … END` as one prepared statement;
  - that the Versions API accepts extra multipart parts typed `application/wasm`, `text/plain`, `application/octet-stream` and `application/javascript+module`, named with `/` (for example `workers/control-plane-shared/node_modules/esbuild-wasm/esbuild.wasm`), and resolves the main module's `./<name>` import to the part of that name.

  The Forge's extraction was checked locally against the real npm tarballs of esbuild-wasm 0.28.2 and sql.js 1.13.0: each file's bytes are identical to `npm ci`'s.
- **What G2c-1 does not do.** The GitHub path validates migrations with `test_migrations.py` before applying them. The native path relies on the Forge's passed checks instead; their harness applies every migration in every test, but the Forge does not run the Python script.
- **Left for G2c-2.**
  - Configuration and binding changes (`config_changed`), and `[limits]`, which also brings the Forge onto the native path.
  - The Console's static assets (`assets`).
  - The deploy-time settings the workflows render (Access identities, `--var`).

### 5l. Step G2c-2 (modules): configuration, bindings and Console assets without GitHub (2026-11-12)

G2c-2 builds, as standalone modules with their own tests, the two pieces G2b left on GitHub: a changed wrangler.toml (`config_changed`) and the Console's static assets (`assets`). Integration steps 1–6 below are now wired (see "Wired" at the end of this section). The build script (step 7) is still open: until it posts the Console build, no commit has one stored, so the Console stays on its workflow with `console_dist_missing`.

- **What was built.**
  - `deployment-orchestrator/src/config-diff.ts`, pure functions:
    - `parseToml`: a strict TOML subset that parses every `workers/*/wrangler.toml` (tables, arrays of tables, nested `[workflows.default_retention]`, strings, numbers, booleans, multi-line inline arrays, inline tables, comments). Multi-line strings, dates, dotted keys, duplicate keys and redefined tables return null (`config_unparsed`).
    - `bindingsFromToml`: the bindings as Workers API metadata records. Supported: `[vars]` (`plain_text`), `d1_databases` (`d1`, `id`), `services` (`service`, with `entrypoint`, `environment`, `props`), `durable_objects.bindings` (`durable_object_namespace`), `r2_buckets`, `kv_namespaces`, `[ai]`, `vectorize`, `workflows` (`workflow`), `artifacts`, `worker_loaders` (`worker_loader`), `[version_metadata]`, `secrets_store_secrets`, `send_email`, `analytics_engine_datasets` (`analytics_engine`), `queues.producers` (`queue`), `[browser]` and the `[assets]` binding (`assets`). Wrangler-only fields (`database_name`, `migrations_dir`, `preview_*`) are ignored; any other field or key is refused.
    - `planConfigChange(runningToml, targetToml, activeBindings)`: the active version's full binding records with the toml diff applied. A removed binding is dropped, an added one is built from the target, a changed one is replaced. A binding the diff does not name is kept verbatim: the deploy-time `--var` values (`ACCESS_*`, `OPERATOR_IDENTITIES`, `APPROVER_IDENTITIES`, `DEPLOY_ALLOWED_IDENTITIES`, `CF_ACCOUNT_ID`) and anything else the API returns. Secrets (`secret_text`, `secret_key`) are never in the plan; they stay through `keep_bindings`.
    - `verifyPlannedBindings` and `verifyVersionSettings`: the checks after the upload, before traffic (below).
  - `deployment-orchestrator/src/assets-upload.ts`: the manifest, the upload session, the bucket uploads and the completion token for `assets: { jwt, config }`. It also reads a commit's stored Console build back from R2 (`readConsoleDist`) and checks each file's SHA-256 and size. It is a client with an injectable `fetch`, tested against a fake Workers API.
  - `forge/src/console-dist.ts` and one route line in the Forge: `POST /v1/forge/console-dist` (`confirm: "UPLOAD"`, `commit`, `files: [{ path, content_base64, content_type }]`). It accepts the CI service token only, authorized like `/v1/forge/typecheck-report`. Limits:
    - paths are relative, with no `..`, `.`, empty or absolute segment, at most 512 characters;
    - at most 25 MiB per file and 20,000 files (the Workers Free asset limits), and 36 MiB per request;
    - `index.html` is required.

    The files are written to `bundles/<sha>/console-dist/<path>`, then `bundles/<sha>/console-dist.json` last (path, sha256, size, content type). The event is audited as `forge.console_dist_stored`. A commit's build is written once: the same files again are accepted unchanged, different files get 409. These objects are pruned with the rest of `bundles/` after 14 days.
- **Placeholders.** The committed configs carry two deploy-time placeholders, rendered by `.github/scripts/render-d1-config.sh`:
  - `__CONTROL_PLANE_D1_DATABASE_ID__` in every `database_id`, which becomes the D1 id resolved by name;
  - `owner-notify-placeholder@example.invalid` in the AI Kernel's `send_email` recipients, which becomes `APPROVER_IDENTITIES`.

  The plan resolves a placeholder field from the active binding of the same type and name, and only when the field's text is the same in the running config. Otherwise the reason is `unresolved_placeholder:<placeholder>`. A new binding carrying a placeholder therefore stays on GitHub.
- **Settings that are not bindings.**
  - The version metadata always carries the full target values: `compatibility_date`, `compatibility_flags`, `limits` and `placement`.
  - `[triggers] crons` becomes a plan step: `PUT /accounts/{a}/workers/scripts/{name}/schedules`, body `[{cron}]`, with the running crons as its restore body.
  - `[observability]` becomes a plan step as well: `PATCH …/script-settings` `{observability}`. This deviates from putting it in the version metadata. Cloudflare's multipart-metadata page lists `main_module`, `assets`, `keep_assets`, `bindings`, `placement`, `compatibility_date` and `compatibility_flags` for version uploads, not `observability`, and observability is a script setting.
  - `limits` is not on that list either. So `verifyVersionSettings` requires the uploaded version's `resources.script_runtime` to show the planned `cpu_ms`; a version without it never receives traffic.
- **Every ineligibility reason** (the Worker stays on its GitHub workflow):
  - Parsing:
    - `config_unparsed`;
    - `active_bindings_unreadable`;
    - `unsupported_key:<key>`, for example `hyperdrive`, or a `[triggers]` key other than `crons`;
    - `unsupported_binding_field:<path>`;
    - `binding_unreadable:<path>`;
    - `var_not_string:<name>`;
    - `duplicate_binding_name:<name>`;
    - `compatibility_date_missing`.
  - Changes a version upload cannot apply:
    - `identity_changed` (`name`, `main`);
    - `routing_changed` (`routes`, `route`, custom domains, `workers_dev`, `preview_urls`);
    - `do_migration` (`[[migrations]]`; only a deploying script upload applies them);
    - `assets_config_changed` (the `[assets]` table, Part B below);
    - `build_rules_changed` (`[[rules]]`);
    - `previews_changed`;
    - `workflow_changed` (wrangler registers workflows separately on deploy);
    - `queue_consumer_changed`;
    - `tail_consumers_changed` and `logpush_changed` (not available on version uploads);
    - `observability_removed_or_added`.
  - Evidence that does not agree:
    - `active_binding_missing:<type:name>` (the running config declares it, but the active version lacks it);
    - `active_differs_from_config:<type:name>` (a changed or removed binding whose active record is not what the running config says, such as a `--var` override);
    - `binding_set_outside_config:<type:name>` (adding to the config a binding the active version got elsewhere);
    - `binding_name_conflict:<name>` (a config binding named like a secret);
    - `unresolved_placeholder:<placeholder>`.
- **Constructs that keep Workers ineligible today:**
  - Any change to the Forge's `[[rules]]` or to its `[[migrations]]`. The Orchestrator, the AI Kernel and the Forge have `[[migrations]]`; it is unchanged by ordinary edits.
  - Any change to the Recovery Manager's `[[workflows]]`.
  - Any route, custom-domain or `workers_dev` change: the Console, the Orchestrator and Home have routes.
  - Any `[assets]` change in the Console.
  - A new `d1_databases` binding, because of its placeholder.
- **The check after upload.** This is the same principle as G2b: the new version must bind exactly the plan, or traffic never moves.
  - The non-secret `type:name` set must be equal.
  - A record kept from the active version must be equal field for field.
  - A record built from config may differ only by the fields the API adds: a service's `environment: "production"` and a Durable Object's `namespace_id`. `uploadBindings` drops `namespace_id` from what it sends.
  - Secrets must match by type and name.
  - The settings must match too (`verifyVersionSettings`).
- **The asset hash rule (Part B).**
  - **Rule:** the first 32 hex characters of `SHA-256(base64(content) + extension)`, where the extension has no dot (Node's `path.extname(p).substring(1)`). Manifest keys are `/<path>`; `size` is the byte length.
  - **Verified:** read from Cloudflare's "Static Assets: Direct Upload" page, in its programmatic `createManifest` example, on 2026-11-12. The API itself only requires "a 32 hexadecimal character hash", stable across uploads.
  - **Where it lives:** in one function, `assetHash`, with a test against an independent `node:crypto` computation.
  - **Fail closed:**
    - a bucket that names a hash outside the manifest, or names one twice, aborts;
    - a completion token before the last bucket, or a missing or non-201 completion, aborts;
    - a stored file whose SHA-256 or size differs from `console-dist.json` aborts.
  - **The upload calls:**
    - the session (`POST …/scripts/{name}/assets-upload-session`) uses the deploy token;
    - each bucket upload (`POST …/workers/assets/upload?base64=true`, multipart, one part per hash with the file's content type) uses only the session JWT;
    - with no buckets, the session JWT is the completion token.
- **Integration steps** (1–6 done, see "Wired" below; 7 left):
  1. **Keep the configs.** `storeBundles` must also write each Worker's wrangler.toml text, for example `bundles/<sha>/config/<worker>.toml` (the `BuiltModule` already holds it). The manifest names it, so eligibility can read the running and target configs. Today the manifest holds only `config_sha256`.
  2. **Read full version records.** `CloudflareWorkers` needs a call that returns a version's full `result`: the raw `resources.bindings` and `resources.script_runtime`, not only the digest.
  3. **Eligibility.** In `nativeDeployEligible`, replace `config_changed` with `planConfigChange(running, target, activeBindings)` read at execution time. An ineligible plan keeps its reason in the `native_deploy` audit payload. The plan is computed again in the executor right before the upload, because the active bindings can change between queueing and execution.
  4. **Upload.**
     - The version metadata is `main_module`, `plan.metadata`, `bindings: uploadBindings(plan)` and `keep_bindings: plan.keep_bindings` (secrets only).
     - A Worker with assets also sends `keep_assets: true` when its assets did not change, or `assets: assetsMetadata(jwt, config)` from `AssetsUploader.upload(script, await readConsoleDist(BUNDLES, sha))` when they did. An explicit upload without either would drop the assets.
     - Then `verifyPlannedBindings` and `verifyVersionSettings` run before the deploy call, replacing the G2b digest check for config changes. The code-only path keeps the G2b check.
  5. **Order of the steps.**
     1. capture;
     2. upload (assets first);
     3. verify bindings and settings;
     4. deploy;
     5. verify live;
     6. apply `plan.steps` in order: `PUT schedules`, then `PATCH script-settings`;
     7. record the desired version.

     Schedules go after the live check because crons fire against the active deployment: new cron expressions must not reach the old code. On any failure after a step was applied, each step's `restore` body is applied first (newest first), then the captured deployment is restored. `CF_DEPLOY_TOKEN` (Workers Scripts Edit) covers schedules, script settings and asset uploads.
  6. **The Console** (done, see "Wired: step 6" below).
     - `assets` becomes eligible when `bundles/<sha>/console-dist.json` exists and the `[assets]` table is unchanged.
     - Before the upload, the native path must repeat the workflow's checks on the stored `index.html`: no inline script (CSP `script-src 'self'`).
     - The Nexus route `nexus.cryptophys.work/console*` is attached by `ensure-zone-route.sh` with a zone token the Orchestrator does not hold. So the native path verifies, read-only, that the route exists, or stays ineligible.
  7. **The build script (owner-visible change).** `workers/forge-typecheck/typecheck-and-report.mjs` is an owner-only harness path and is not edited here. When the Console build passed and `WORKERS_CI_BRANCH` is `main` (or empty for an Artifacts build of main), the script must post the dist before it posts the report:
     1. walk `workers/console/ui/dist`;
     2. for each file, take its relative `/`-separated path, its base64 content, and a content type from its extension: `.html` `text/html; charset=utf-8`, `.js` `text/javascript`, `.css` `text/css`, `.svg` `image/svg+xml`, `.json` `application/json`, `.png` `image/png`, `.woff2` `font/woff2`, else `application/octet-stream`;
     3. `POST new URL("/v1/forge/console-dist", FORGE_URL)` with the same headers as `postReport` (`content-type: application/json`, `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `redirect: "manual"`) and the body `{ confirm: "UPLOAD", commit, files }`;
     4. treat a 3xx as a refused token, and treat anything but a JSON 200 whose `commit` equals the build's commit as a failure (exit 3, as for the report).

     The Forge test `FD4` asserts the script does not post yet, so that change must update that assertion.
- **Wired: steps 1–5, for Workers without static assets (2026-11-12).** Tests: `control-plane-shared/test/native-deploy-g2c2-wire.test.ts`.
  - **Step 1, the Forge keeps the configs** (`forge/src/bundles.ts`). `storeBundles` writes each Worker's wrangler.toml, the committed source exactly as hashed into `config_sha256`, to `bundles/<sha>/config/<worker>.toml`, before the manifest. The manifest names it per Worker as `config: "config/<worker>.toml"`. The schema stays `forge-bundles.v1`: a manifest without `config` (built before this step) reads as "config unknown", and a `config` that is not exactly that path makes the manifest unreadable.
  - **Step 2, full version records** (`native-rollback.ts`). `CloudflareWorkers.version(script, id)` returns the API's whole `result` (the raw `resources.bindings` and `resources.script_runtime`); `versionBindingSet` now reads through it. `scriptSetting` makes the two script-level calls (`PUT …/schedules`, `PATCH …/script-settings`). A version upload with a plan sends `bindings`, `keep_bindings` (only `secret_text` and `secret_key`) and the target's `limits`; without a plan it is the G2b upload, unchanged.
    - The client now calls its fetcher as a plain function. Called as a method (`this.fetcher(…)`), the runtime's global `fetch` throws `Illegal invocation` in workerd (checked locally with the repository's workerd). Reproduced locally: with the default `fetch`, the native rollback and deploy calls would fail at their first API call before this fix; the tests inject plain fake fetchers, which hid it. The Console assets client (`assets-upload.ts`) had the same pattern; step 6 fixes it the same way, with a test whose fetcher throws `Illegal invocation` unless it is called as a plain function.
  - **Step 3, eligibility** (`nativeDeployEligible`). A Worker needs a configuration plan when its `config_sha256` differs from the running version's, or when either side has `[limits]` (a code-only upload would not carry them). For such a Worker, in two passes:
    1. without Cloudflare, for every Worker of the unit: both configs are named in their manifests (`config_not_stored`), present in R2 (`config_missing`) and match `config_sha256` (`config_hash_mismatch`); the R2 key is recorded in `file`. Then everything the two configs alone decide (`configRefusal`, split out of `planConfigChange` unchanged), and two fail-closed checks of this path: `limits_removed` (the running config has `[limits]`, the target has none, so the version's limits would be unknown) and `placement_unverified` (either config has `[placement]`, which is sent but never read back; no platform Worker has one);
    2. then, read only with the deploy token: the active deployment must be one version at 100% (`active_deployment_split`, `active_deployment_unreadable`), its full record readable (`active_bindings_unreadable`), and `planConfigChange(running, target, activeBindings)` must accept (any of its reasons, unchanged).

    Every reason reaches the `native_deploy` audit payload of the GitHub dispatch, as before, and a queued deploy records the plan's changes and steps in `deployment.native_deploy_queued` (`config`). Callers without a Cloudflare reader keep the G2b and G2c-1 answers (`config_changed`, or `limits`). `assets` is still checked first and unchanged.
  - **Step 4, upload and check** (`executeNativeDeploy`). Right before the upload, the executor reads both configs from R2 again (hashes checked) and plans again against the version it has just captured. A refusal there is `config_plan_refused: <reason>`, before any upload. The version is uploaded with `uploadBindings(plan)`, `keep_bindings: plan.keep_bindings` and `plan.metadata`. Then `verifyPlannedBindings` (`planned_bindings_differ: <reason> (<binding>)`) and `verifyVersionSettings` (`version_settings_differ: <reason>`) run before the deploy call. The code-only path keeps the G2b digest check.
  - **Step 5, order.** Capture, plan again, upload, verify bindings and settings, deploy, verify live, apply `plan.steps` in order (`PUT schedules`, then `PATCH script-settings`), and, after every Worker, record the desired version.
    - Each step is recorded before its call, so an ambiguous failure is restored too. Its answer must show what was sent: the schedules list equal to the crons, or the script settings containing the observability. Otherwise the deploy fails.
    - On any failure after a step was applied, each applied step's `restore` body is applied, newest first, then every changed deployment is restored to its captured version, newest first. The request fails with the same critical report as before, which also lists `settings_applied`.
  - **`[limits]`.** A Worker with `[limits]` is no longer refused for that alone. It deploys only through the plan (even with an unchanged wrangler.toml), and its version gets traffic only when `script_runtime.limits` shows the planned values (`limits_differ` otherwise). So the Forge can take the native path. Without a plan reader it is still `limits`.
  - **Still on GitHub after this step:** the Console (`assets`, until step 6 below), any change the plan refuses (above), and a change to a deploy-time `--var` value (kept verbatim from the active version, never set from here).
  - **Not verified live.** These are assumptions, checked only against Cloudflare's documentation and the fake API in the tests:
    - that a version upload accepts `bindings` together with `keep_bindings: ["secret_text", "secret_key"]` and keeps the secrets of the script's latest version;
    - that it accepts `limits` in the metadata and reports it in `resources.script_runtime.limits` (if it does not, every planned deploy of the Forge fails before traffic moves, `version_settings_differ: limits_differ`);
    - that `GET …/versions/{id}` returns the binding records in the shape a version upload takes, with only a service's `environment` and a Durable Object's `namespace_id` added (if the API adds other fields, `planned_bindings_differ` stops the deploy before traffic);
    - that `PUT …/schedules` takes a JSON array of `{ cron }` and answers `{ schedules: [{ cron, … }] }`, and that `PATCH …/script-settings` takes JSON `{ observability }` and answers with the script's `observability` (if not, the deploy fails after the live check and everything is restored);
    - that a failed eligibility read at execution time is terminal: the queued request fails (`not_eligible: active_deployment_unreadable`) with nothing changed, and a later proposal queues again.
- **Wired: step 6, the Console's static assets (2026-11-13).** Tests: `control-plane-shared/test/native-deploy-g2c2-console.test.ts`.
  - **Eligibility** (`nativeDeployEligible`, for a Worker whose manifest says `assets`). The checks run after the configuration checks, so a changed `[assets]` table is `assets_config_changed` (from the plan's checks, or when the two manifests disagree on `assets`). Then, from R2 only (`readAssetsPlan`):
    - the target's stored config gives the `[assets]` routing config (`assetsConfigFromToml`; `config_not_stored`, `config_missing`, `config_hash_mismatch`, `unsupported_assets_field:<field>`);
    - the target's Console build is stored and every file matches its sha256 and size (`readConsoleDist`): `console_dist_missing`, `console_dist_unreadable` or `console_dist_hash_mismatch`, with the R2 key in `file`;
    - the stored `index.html` passes `indexHtmlRefusal`: the workflow's own test (`grep -Eq '<script>|<script [^>]*>[^<]'`, line by line), and stricter: every `<script>` closed, with a `src` and no content, no `on…=` handler attribute, no `javascript:` URL (`index_html_missing`, `inline_script`, `inline_event_handler`, with `file`). CSP `script-src 'self'` would block each of them.
    - Last, with the deploy token, read only: the route (below).

    Callers without a Cloudflare reader that can list routes keep the G2b answer, `assets`. Every reason reaches the `native_deploy` audit payload of the GitHub dispatch, as before; a queued deploy records `assets: { <service>: { mode, running_dist, files, total_bytes } }` in `deployment.native_deploy_queued`.
  - **The route check: decision and evidence.** The workflow attaches `nexus.cryptophys.work/console*` with `CLOUDFLARE_ACCESS_API_TOKEN` (zone permissions), because the Workers deploy token cannot hold Workers Routes Edit (owner, 2026-11-06). Read from Cloudflare's API schema (`cloudflare/api-schemas`, `openapi.json`, `x-api-token-group`, fetched 2026-11-13; the same operations as the API reference at developers.cloudflare.com/api):
    - `GET /zones/{zone_id}/workers/routes` ("List Worker Routes", https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/) accepts only `Workers Routes Read` or `Workers Routes Write`, zone permissions `CF_DEPLOY_TOKEN` does not hold. Finding the zone id (`GET /zones?name=`) would also need `Zone Read`.
    - `GET /accounts/{account_id}/workers/scripts` ("List Worker Scripts", https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/) accepts `Workers Scripts Read` or `Workers Scripts Write` (among others), so `CF_DEPLOY_TOKEN` (Workers Scripts Edit) may call it. Each item carries `routes: [{ id, pattern, script }]`, "Routes associated with the Worker", documented as nullable.

    Decision: the native path reads the second call (`CloudflareWorkers.scriptRoutes`) and requires a route with the pattern `nexus.cryptophys.work/console*` whose `script` is the Console (or absent). It never creates or changes a route. Fail closed: a list that cannot be read, or that does not report the Console's routes (missing or null `routes`), is `route_unverifiable`; a list without the pattern is `route_missing:nexus.cryptophys.work/console*`. The pattern is `ZONE_ROUTES` in `native-deploy.ts`, kept equal to the workflow's `ROUTE_PATTERN` and `SCRIPT` by a test. The check runs at queue time, at execution, and again right before the assets upload.
  - **Kept or uploaded.** The running commit's stored build decides (`running_dist`): the same files (path, sha256, size, content type; equal lists give equal asset hashes) plan `keep`; a different build, or none stored (built before step 7, or pruned after 14 days), plans `upload`. Before the upload the executor decides again:
    - `keep` sends `keep_assets: true`, but only when the script's latest uploaded version is the version it just captured (`GET …/versions?per_page=1`; Cloudflare: "The first version in the list is the latest version."). `keep_assets` retains the assets "of a previously uploaded Worker version", like `keep_bindings`, so a newer, undeployed upload would lend its assets. When that is not the case, or the list cannot be read, it uploads instead (`keep_refused` in the outcome).
    - `upload` runs `AssetsUploader.upload(script, files)` on the build read and checked again, then sends `assets: assetsMetadata(jwt, config)` with the `[assets]` routing config (`not_found_handling`, `run_worker_first`). The session only asks for files Cloudflare does not hold, so an unchanged file is not sent again.
    - On a code-only upload, the assets binding is sent as `{ type: "assets", name: "ASSETS" }` (Cloudflare's direct-upload example; `assets` is not a kept type) and the G2b digest check compares the new version's bindings with the active version's. A planned configuration already carries the binding.
    - A version of a Worker with assets is never uploaded without `keep_assets` or `assets`: the executor fails with `assets_upload_missing` before the version upload, and `uploadVersion` refuses both at once, an invalid token, or a planned configuration without the assets binding (`invalid_assets_upload`).
  - **Order.** Capture, plan again (configuration), the route again, the build again (hashes, `index.html`), the assets (kept or uploaded), the version, the binding and settings checks, deploy, verify live, script settings, record. A failure before the deploy call changes nothing in production (an asset upload session or an undeployed version is harmless); after it, the restore of §5l step 5 applies. The outcome records `assets: { <service>: { mode, uploaded, buckets, keep_refused } }` and the steps `route_verified`, `assets_kept` or `assets_uploaded`.
  - **What the native path does not repeat from `deploy-console.yml`.** The workflow's smoke tests through Access after the deploy (whoami, forwarding, the allow-list, CSRF, the `/console` mount, `https://nexus.cryptophys.work/console/health`, the `console.cryptophys.work` redirect) and its `verify-worker-live.sh --require-access --custom-domain` call. The native path verifies live through the Drift Detector (the version tag and health), as for every other Worker. It does not resolve Access either: the `ACCESS_*`, `OPERATOR_IDENTITIES` and `APPROVER_IDENTITIES` values are kept from the active version (G2b, or verbatim through the plan).
  - **Not verified live.** These are assumptions, checked only against Cloudflare's documentation, its API schema and the fake API in the tests:
    - that `GET /accounts/{a}/workers/scripts` reports the zone route `nexus.cryptophys.work/console*` in the Console's `routes` for a token that holds only account-level Workers Scripts Edit. If it does not (null, missing or without the pattern), the Console stays on its workflow with `route_unverifiable` or `route_missing:…`; nothing is deployed on a guess;
    - that a version upload (`POST …/scripts/{name}/versions`) accepts `assets: { jwt, config }` and `keep_assets`. The schema of that operation lists neither (nor `limits`); the multipart-metadata page and the direct-upload page list both for "Script, Version, and Workers for Platform script upload endpoints". If it does not, the upload fails before any traffic moves;
    - that `keep_assets: true` keeps the previous version's routing config (`run_worker_first = true`, `not_found_handling`) with its files. The direct-upload page's `keep_assets` example sends no `config`, and the version record has no field to read it back. The `[assets]` table is unchanged whenever `keep` is planned. If the config were not kept, `run_worker_first` would fall back to false and assets would be served before the Console's own checks (Cloudflare Access on the hostname still applies). A live check of the first native Console deploy should request an asset without the operator role;
    - that the assets binding comes back from `GET …/versions/{id}` as `{ type: "assets", name: "ASSETS" }`, the shape sent, so the digest check passes (if not, `bindings_differ` stops the deploy before traffic).

### 6. Owner decisions (2026-11-08)

1. **Build runner: Dynamic Workers only.** No Workers Builds and no managed build environment. Every check, build and bundle runs in our own isolates. The test harness is ported to workerd (§2.1).
2. **Merges: agent consensus.** `merge_change` is a routine ADR-0009 action, except for the critical paths listed in §2.4.
3. **GitHub after cut-over: archive.** It is not mirrored and not deleted.
4. **Artifacts data location: unrestricted.**

## Consequences

- No GitHub on the deploy, rollback or alert path after phase 4, and on no path after phase 5.
- Rollback becomes faster (no build) and independent of every build system.
- New Cloudflare cost: Artifacts operations and storage, plus Workers CPU for the Forge runner and Browser Run time for the render smoke. All are small at this repository's size and commit rate.
- We depend on a beta product (Artifacts). Mitigations:
  - GitHub stays in parallel until phase 5;
  - R2 backup of the repository (daily `git bundle` written by the Forge, next to the D1 backups);
  - rollback that does not need Artifacts.
- Phase 3 is the largest piece of work: the test-harness port and the Console build in an isolate. Tests that cannot run in the Forge yet keep GitHub in the loop. The cut-over waits for them, and they are never dropped.
- We lose GitHub's review UI, Dependabot and secret scanning. The Console Code section, the Build-time `npm audit` and the Forge secret scan replace them. They must exist before phase 5.
- Contributors' tooling changes. Claude Code sessions, pi and agy need network access to the Artifacts host and a repo-scoped token, which the owner grants through each tool's own environment settings.

## Alternatives considered

- **Keep GitHub, harden it** (the narrower options of 2026-11-08). Rejected by the owner.
- **`@cloudflare/ci` SDK.** It requires a Container binding, so ADR-0005 rejects it.
- **Workers Builds.** It is managed and the fastest path, but the owner chose isolates only (§6.1).
- **Owner-approved merges.** The owner chose agent consensus. Critical paths stay with the owner (§2.4).
- **A Git server implemented in our own Worker** (objects in R2, refs in a Durable Object). This is possible, but Artifacts already provides Git storage on Cloudflare. Writing our own adds risk with no benefit; it could be reconsidered if Artifacts is withdrawn.
- **GitLab or another external forge.** It only moves the dependency to another vendor.
