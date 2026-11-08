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

### 5a. Owner notices (phase 2, implemented 2026-11-08)

The AI Kernel computes three notices from D1 at `:22` and `:52` (`ai-kernel/src/owner-notices.ts`):

- `owner_attention`: draft recovery plans and `pending_owner` proposals;
- `drift`: drifted, never-observed and stale (> 45 min) services, ignoring disabled ones;
- `critical_reports`: critical agent reports in the last 24 h.

How notices are kept and shown:

- Each change of a topic (opened, changed, closed) is one audit event (`owner.notice_*`). That is the notice state, so no table is needed.
- The Console shows the active notices on the Command page ("Needs your attention") from `GET /v1/notices`.
- **Email** goes to the people in `APPROVER_IDENTITIES`. It is sent through the kernel's `send_email` binding `OWNER_EMAIL` from `NOTIFY_FROM = alerts@notify.cryptophys.work`, and the owner onboards `notify.cryptophys.work` in Email Service → Email Sending. Onboarding a subdomain adds its own `cf-bounce` MX, SPF, DKIM and DMARC records, and leaves the mail setup of `cryptophys.work` untouched. If sending fails, the notice is retried every run until delivery succeeds.

`owner-attention.yml` and `drift-alert.yml` keep running in parallel. They are retired once email delivery is verified.

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
