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
- **Workers Builds** can build and deploy a Worker from an Artifacts repository. It is a managed Cloudflare build environment. The owner approved a **main-only** use for the TypeScript type-check and Console UI build (§5c); pull-request branches must not run there with the CI service token (§5d).
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
- **Canonical-main writer by phase.** During GitHub-source phases 1–3 and the phase-4 shadow period, `.github/workflows/mirror-to-forge.yml` is the temporary migration exception: after a push to GitHub `main`, GitHub Actions mirrors that exact SHA to Artifacts `main` using a short-lived write token minted by the Forge. The workflow force-updates the Artifacts ref to keep it identical to GitHub `main`; this is source synchronization, not a Worker deployment. The exception ends at the phase-4 merge cut-over, after the Forge reaches 10 consecutive merge-parity agreements and begins writing canonical `main`; from then on GitHub is only a mirror. Phase 5 completes the operational cut-over by moving contributors to `platform-work`, revoking `GH_ACTIONS_TOKEN`, and archiving GitHub. People and agents get repo-scoped write tokens for the work repository only, with a short TTL, minted by the Forge after an Access-authenticated request.
- **Target event model.** The Forge is intended to subscribe to push events on both repositories. **Current implementation status (2026-11-10):** the deployed Worker has a `scheduled()` entry point; `workers/forge/wrangler.toml` runs it every 15 minutes (`4,19,34,49`), and `forgeTick()` polls Artifacts `main` and open change-request heads. No push-event webhook or Queue consumer is wired in the current Worker. Treat event subscription as target behavior, not as a deployed freshness guarantee.
  - **Authorized mirror exception (phases 1–3 and phase-4 shadow).** While GitHub remains the source of truth, the only permitted non-Forge write to canonical `main` is the exact-SHA push from `mirror-to-forge.yml` using the short-lived, repo-scoped token minted by the Forge for the CI service token. This is expected source synchronization, not an incident or a deployment.
  - Any other push to canonical `main` that the Forge did not make is an **incident**. The Forge records it, alerts, refuses to deploy that SHA, and asks the owner to restore (critical). At the phase-4 merge cut-over, the mirror exception ends; only the Forge may write canonical `main`. Phase 5 archives GitHub and revokes its token.
  - Production is protected by the deploy gate (§3) even if the repository is not.
- Bootstrap: one-time `import` of the GitHub repository with its full history. While GitHub is still the source (phases 1–3 and phase-4 shadow), the Forge keeps the import fresh.

### 2. Change requests, checks and review (replaces pull requests)

The new Worker `cryptophys-forge` keeps change requests in D1. Each change request records the work branch, head SHA, base SHA, status, checks, reviews, the owner decision and audit events. A change request moves through these steps:

1. **Checks: Forge tests, migration tests and bundles run in Dynamic Workers; the TypeScript type-check and Console UI build use the main-only Workers Builds exception** (§5c, §6.1). On every branch push, a Workflow in the Forge does the following:
   1. It reads the tree at the head SHA from Artifacts.
   2. It installs dependencies from an R2 package cache. The cache is keyed by the lockfile hash and filled from the npm registry only by the Forge.
   3. It runs Forge test and bundle steps in fresh Dynamic Workers with outbound network blocked:
      - **tests**: the existing `node:test` files run under a small `node:test`-compatible runner. The `node:sqlite` harness (`harness.ts`) is replaced by a Durable Object Facet SQLite database with the real migrations applied. Files the tests read come from the tree at that SHA;
      - **migration tests** and **bundle builds** with `@cloudflare/worker-bundler`, one per Worker, as the dry run;
      - **Console render smoke** runs on Browser Run. The Console UI build itself runs in the main-only Workers Builds project (§5c).

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
  - **Consequence (Dynamic Worker).** The full type-check does not fit in a Dynamic Worker without weakening it. The owner later approved Workers Builds for the trusted `main` build (§5c below). GitHub Actions continues to type-check pull requests; Forge change-request type-checks remain `pending` until a secretless build/report design is approved. Phase 5 waits for that decision.
- **Type-check on Workers Builds (owner decision 2026-11-08, evening).** Asked where the type-check should run, the owner first chose a Cloudflare Container (#236). Its deploy failed on the Containers API (the deploy token has no Containers permission) and Cloudflare refused the rollback across the Durable Object migration, so the Worker ran at `66a4859` with no Container and the step recorded `error`, never a pass. Asked again with the measurements of two alternatives, the owner chose **Workers Builds from the Artifacts repository**; the Container was withdrawn (#237). The alternatives, measured:

  | Option | Evidence | Verdict |
  |---|---|---|
  | Browser Run (the compiler in headless Chromium) | 279 files, 0 errors, 2.3 s, 167 MB heap; an injected error reported | Works; kept as the fallback |
  | Workers Builds from Artifacts | Supported by Cloudflare (Oct 2026); 4 vCPU, 8 GB, 6,000 min/month included | **Chosen** |
  | Cloudflare Container | Worked in CI; needs a token permission and an ADR-0005 exception | Withdrawn |

  - **Project.** `workers/forge-typecheck/` is the Builds project (root directory). Its build command `node typecheck-and-report.mjs` installs the locked toolchain in `control-plane-shared` and runs `tsc --noEmit -p workers/control-plane-tsconfig.json`. The project is restricted to the canonical Artifacts `main` branch; pull-request/change-request branches are not run by this secret-bearing build. Its deploy command deploys a stub Worker with no route, no `workers.dev` URL and no bindings, because Workers Builds deploys a Worker.
  - **Report.** The trusted `main` build reports `{commit, conclusion, build_id, branch, files, errors, diagnostics, toolchain}` to `POST /v1/forge/typecheck-report` with the CI service token. This operator-level credential is never exposed to change-request branch code. Diagnostics are text only. The Forge stores one row per commit (`forge_typecheck_reports`, migration 0035), audits `forge.typecheck_reported`, and folds the result into its check of that commit: the `typecheck` step, and a failure fails the check. Until a report arrives the step reads `pending`.
  - **Setup (owner, dashboard).** Connect the Artifacts repository `cryptophys/platform` to a Worker `cryptophys-forge-typecheck`, root `workers/forge-typecheck`, with `FORGE_URL` and the existing CI service token as build secrets. Restrict this secret-bearing project to the canonical `main` branch. Do not enable preview builds or expose these secrets to change-request branches (§5d). `workers/forge-typecheck/README.md` has the steps.
  - **Consequence.** The type-check leaves GitHub without a Container. The stub deploy is the one deploy that is not governed by consensus; it is not a production service and is not in the registry.
  - **Proven (2026-11-09).** The owner connected the Builds project. Build `d5b0391f` reported `success` (0 errors; TypeScript 5.9.3) for `5e228b8` at 05:03 UTC, and the Forge check of that commit passed with `typecheck: passed` (379 tests, 12 bundles, secrets clean). Two lessons, both fixed in code: Workers Builds may leave `WORKERS_CI_COMMIT_SHA` empty, so the build reads the commit from the checkout (#238); and `fetch` follows an Access redirect to the sign-in page, so the report now uses `redirect: "manual"` and accepts only a JSON 200 naming the commit (#240). The CI service token's credentials go in **build variables and secrets**, not in the Worker's runtime secrets.
  - **TypeScript 7 (owner, 2026-11-09).** Every package moved from TypeScript 5.9.3 to 7.0.2, the native compiler (Dependabot #233 widened to all packages). The control-plane project checks in about 0.6 s instead of tens of seconds. One source change: TypeScript 6+ checks side-effect imports by default, so the Console UI declares `*.css` (`workers/console/ui/src/css.d.ts`). The Workers Builds type-check installs the same lockfile, so its reports name TypeScript 7.0.2.
  - **Console build (2026-11-09).** The same main-only Workers Builds run builds the Console UI (`npm run build` in `workers/console/ui`: its own `tsc --noEmit`, then Vite) and reports it as `console_build` with the type-check (migration 0036). A failed Console build fails the step and the check, as it fails GitHub CI. For a trusted `main` commit, the checks list gives `ready` only when tests and bundles passed, no secret was found, types passed and the Console built. Change-request heads remain `pending` on type-check until a secretless build/report design is approved. The Console Code page shows `UI build ok` and `ready` for the main commit. The Chromium render smoke stays on GitHub for now; Workers Builds has no browser.
- **Next.**
  - Phase 4: a change request requires all branch-safe Forge checks and the owner-only review/decision rules. Its type-check remains `pending` until the owner approves a secretless build/report path; GitHub Actions continues to type-check every pull request in the meantime.
  - Use the Forge bundles for deploys, then the Console assets built on the main-only Workers Builds project.
  - Run branch tests, migrations, bundles and guards in Dynamic Workers; do not run untrusted branch code in the secret-bearing Workers Builds project.

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
  - **Deviation from §1.** During the shadow phase the `cr/` branches live in `platform`, not in `platform-work`, so the Forge can read them from Artifacts. They are not built by Workers Builds; preview builds remain disabled while that project holds the CI service token. They move to `platform-work` at cut-over.
  - **Preview builds withdrawn (2026-11-09, security).** Preview builds of `cr/<number>` never triggered from the Artifacts repository. They must not be used with the build secrets anyway: a build runs the branch's own code, so a change request could read the CI service token. GitHub never exposes production secrets to pull request code, and that stays true here. The owner turned preview builds off. Change request type-checks need a build with no secrets whose result the Forge reads itself with a read-only Workers Builds token held by the Forge. That design waits for the owner.
- **4.2 Deploy plan (shadow).**
  - The deploy units and their ordering rules move to `control-plane-shared/src/deploy-units.ts`. The rules are: a new migration deploys the Control Plane first and alone; the orchestrator deploys before the others; the plan fails closed when the Control Plane is unavailable. The Orchestrator's behaviour is unchanged.
  - Each Forge cron tick computes the plan for main's head from the Artifacts repository, using a tree diff from each unit's desired version. It records the plan under the registry fingerprint, which is every unit's desired versions.
  - The Orchestrator's `pendingDeploys`, which reads the GitHub compare API, records its plan for the same commit and fingerprint. The recording never blocks a deploy decision.
  - Whichever records second sets `agrees` (`forge_deploy_plans`, migration 0038).
  - **Plan parity:** consecutive agreements, target 10. Once it reaches the target, deploy decisions can stop depending on GitHub to say what changed. Executing deploys from Forge bundles through the Workers Versions API comes after that and needs `CF_DEPLOY_TOKEN` on the Orchestrator (§4).
  - The Console Code page shows the plans (route `forge.deploy_plans`, read-only).

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

### 6. Owner decisions (2026-11-08)

1. **Build runner: Dynamic Workers for Forge tests, migrations and bundles; main-only Workers Builds exception for TypeScript type-check and Console UI build.** The 2026-11-08 Dynamic Workers decision rejected Containers and a managed test runner for Forge execution. The owner later approved Workers Builds for the trusted `main` type-check and Console UI build (§5c). Preview builds for change requests are withdrawn because their code would receive the operator-level CI service token; a secretless design is pending (§5d).
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
- **Workers Builds for all checks or untrusted branches.** Rejected. Dynamic Workers remain responsible for Forge tests, migrations and bundles. The owner approved only the main-only type-check and Console UI build exception (§5c); no preview build may receive the CI service token (§5d).
- **Owner-approved merges.** The owner chose agent consensus. Critical paths stay with the owner (§2.4).
- **A Git server implemented in our own Worker** (objects in R2, refs in a Durable Object). This is possible, but Artifacts already provides Git storage on Cloudflare. Writing our own adds risk with no benefit; it could be reconsidered if Artifacts is withdrawn.
- **GitLab or another external forge.** It only moves the dependency to another vendor.
