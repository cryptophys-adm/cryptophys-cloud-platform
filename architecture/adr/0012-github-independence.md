# ADR-0012: Leave GitHub — Cloudflare-native source, CI and deploy (the Forge)

- **Status:** Proposed (owner direction 2026-11-08). Each phase in §5 starts only after the owner accepts it.
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
- **Workers Builds** can build and deploy a Worker directly from an Artifacts repository ("host source code, run builds, test changes with Worker Previews, and deploy Workers entirely within Cloudflare"). The build command, the deploy command (default `npx wrangler deploy`) and the path are configurable, and pushes to other branches create Previews. Workers Builds is a **managed Cloudflare service**: we do not run or configure any container.
- **Dynamic Workers (Worker Loader)** run code in an isolate, with outbound network blocked if wanted.
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

1. **Checks.** A Workers Builds project connected to `platform-work` runs the repository's own checks for every branch push:
   - install;
   - type-check;
   - `npm test` (all control-plane tests);
   - migration tests;
   - dry-run bundles;
   - Console render smoke.

   Results arrive as Workers Builds events through Queues. **A change request with any failing or missing check cannot merge.** Tests are never skipped.
2. **Forge guards.** These are deterministic and run in a Dynamic Worker with no network:
   - **secret scan:** token and private-key patterns, high-entropy strings, replacing GitHub secret scanning;
   - **dependency audit:** `npm audit` output from the Build, replacing Dependabot alerts;
   - **policy:** no edits to tests that remove assertions without a recorded owner decision, and no trading code.
3. **AI review.** Every change request is reviewed on Workers AI by the existing auditor roles (pi and agy remain validators). Each reviewer gives a vote with reasons. The reviewers advise; a majority reject blocks the merge until it is resolved.
4. **Merge decision.** Every merge to `main` needs the **owner's approval** (typed confirmation in the Console). Agents do not merge code into `main`. Code changes stay a critical decision, as merges are today.
5. **Merge.** The Forge fast-forwards (or makes a merge commit on) canonical `main` with the approved head SHA and writes `forge.merged` atomically with its audit event. If the base moved, the change request goes back to checks.

The Console gets a **Code** section (`#/code`): change requests, diff, checks, reviews, approve/reject, and the commit history of `main`.

### 3. Build and deploy (replaces GitHub Actions deploy and Argo)

- Every production Worker gets a Workers Builds connection to the canonical repository, with its own path. The **deploy command is `npx wrangler versions upload`**, which uploads a new version without sending it traffic. So a push to `main` builds versions but **never changes production**.
- The ADR-0009 flow is unchanged:
  1. Agents propose `deploy_commit` for the new `main` SHA.
  2. Consensus passes and the Policy Engine allows it.
  3. The Orchestrator promotes the uploaded version for that SHA to 100% through the **Workers Deployments API**.
  4. The Orchestrator then verifies through the Drift Detector.
- The policy checks for a deploy become:
  - `ci_green` means the Forge's checks for that SHA passed;
  - `commit_sha_valid` and "current `main`" are read from Artifacts;
  - **the SHA was merged by the Forge.**
- **Rollback** = Deployments API to the previous recorded version. There is no build and no GitHub, and it works even when Builds is down. *This is phase 2 and the first thing that leaves GitHub.*
- **D1 migrations.** The Orchestrator applies the new migrations of an approved SHA through the D1 binding, before the control-plane units. It reads the files from Artifacts by path at that SHA and checks them against `d1_migrations`. The rule "new migration deploys the control plane first and alone" stays.
- **Retire a Worker** = Workers Scripts API from the Orchestrator. This stays a critical action.
- **Smoke checks** move from GitHub scripts to the Orchestrator and Drift Detector, through Service Bindings.

### 4. Credentials (replaces the GitHub `production` Environment)

| Credential | Holder | Scope |
|---|---|---|
| Deploy token | Worker secret on the Orchestrator | Workers Scripts **Edit**, account `cryptophys` (versions, deployments, retire) |
| Build token | Workers Builds (Cloudflare-managed build token) | build and upload only |
| Artifacts | binding on the Forge (no token); repo-scoped short-TTL tokens for contributors | `platform-work` write; canonical read |
| Access service token `cryptophys-ci` | not needed once GitHub workflows are gone | revoke after cut-over (owner) |

The owner creates every credential. None is created by an agent or stored in the repository.

### 5. Phases

| Phase | What | GitHub after the phase |
|---|---|---|
| **0. Decide** | Owner accepts this ADR and the §6 decisions. | unchanged |
| **1. Mirror and Forge read-only** | Create the `cryptophys` namespace; import the repository; `cryptophys-forge` Worker (read-only: commits, files, mirror freshness); Console `#/code` read-only. Spike: fast-forward/merge from a Worker into Artifacts. | source of truth |
| **2. Rollback and alerts off GitHub** | Orchestrator rollback via the Deployments API. Owner-attention and drift alerts from a Worker cron to the Console inbox (and email, if the owner wants it). `rollback-worker.yml`, `drift-alert.yml` and `owner-attention.yml` are retired. | source of truth; deploys only |
| **3. Checks and review in Cloudflare** | Workers Builds on `platform-work` runs the checks; Forge guards; AI review; change requests in the Console. Run them **in parallel** with GitHub Actions on the same commits until they agree on ≥ 20 consecutive commits. | source of truth |
| **4. Deploy from Cloudflare** | Builds connections with `versions upload`; Orchestrator promotion, migrations and smoke checks. Shadow first: the Forge path computes the deploy and the GitHub path executes it, until they agree on ≥ 10 deploys. Then the Forge path executes. | mirror |
| **5. Cut over** | Canonical = Artifacts. Contributors (Claude, pi, agy) push to `platform-work`. `GH_ACTIONS_TOKEN` is revoked. GitHub becomes a read-only push mirror of `main`, or is archived. Deleting the GitHub repository is the owner's decision and is not planned. | read-only mirror or archived |
| **6. Other repositories** | `cryptophys-adm/aether` and `cryptophys-adm/xauusd-ai-trading-assistant` follow the same pattern only after the owner decides, and their own owners/validators do the work there. | per repository |

Every phase keeps all tests green, keeps Access as is, and leaves the brake (mode `shadow`, kill switch) working throughout.

### 6. Owner decisions needed before phase 1

1. **Workers Builds as the build runner.** It is a managed Cloudflare service. We do not run containers, but Cloudflare runs our build in its own build environment. The alternative is running the tests in Dynamic Workers. That needs the test harness ported from Node (`node:test`, `node:sqlite`) to workerd, which is a large change and gives weaker parity. **Recommendation: Workers Builds.**
2. **Merges to `main` stay owner-approved** (as today), rather than becoming an agent consensus action. **Recommendation: owner-approved.**
3. **What happens to the GitHub repository after cut-over:** read-only mirror (recommended, for disaster recovery) or archive.
4. **Data location of the Artifacts namespace:** unrestricted (default), `eu` or `us`. It cannot be changed later.

## Consequences

- No GitHub on the deploy, rollback or alert path after phase 4, and on no path after phase 5.
- Rollback becomes faster (no build) and independent of every build system.
- New Cloudflare cost: Artifacts operations and storage, plus Workers Builds minutes. Both are small at this repository's size and commit rate.
- We depend on two beta products (Artifacts, Workers Builds). Mitigations:
  - the GitHub mirror until phase 5;
  - R2 backup of the repository (daily `git bundle` written by the Forge, next to the D1 backups);
  - rollback that does not need either product.
- We lose GitHub's review UI, Dependabot and secret scanning. The Console Code section, the Build-time `npm audit` and the Forge secret scan replace them. They must exist before phase 5.
- Contributors' tooling changes. Claude Code sessions, pi and agy need network access to the Artifacts host and a repo-scoped token, which the owner grants through each tool's own environment settings.

## Alternatives considered

- **Keep GitHub, harden it** (the narrower options of 2026-11-08). Rejected by the owner.
- **`@cloudflare/ci` SDK.** It requires a Container binding, so ADR-0005 rejects it.
- **A Git server implemented in our own Worker** (objects in R2, refs in a Durable Object). This is possible, but Artifacts already provides Git storage on Cloudflare. Writing our own adds risk with no benefit; it could be reconsidered if Artifacts is withdrawn.
- **GitLab or another external forge.** It only moves the dependency to another vendor.
