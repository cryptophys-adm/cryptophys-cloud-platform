# ADR-0014: The evolution loop: the platform writes, merges and deploys its own improvements

- **Status:** Proposed (draft for the owner's review, 2026-11-12). Nothing here is built yet.
- **Owner direction (2026-11-12):** "kekuatan organism ini adalah otak yang terus berkembang dan melakukan evolusi melalui auto-deployment untuk menyesuaikan dan terus meningkatkan kemampuan diri" (the organism's strength is a brain that keeps growing and evolves through auto-deployment, to adapt and keep improving its own abilities).
- **Owner decisions (2026-11-12):** "tidak perlu shadow bisa langsung production dan merge dilakukan semua autonomous" (no shadow phase; straight to production; every merge is autonomous).
  1. **No shadow phase.** Each step goes live in production when it is built.
  2. **Merges are autonomous.** Neither the owner nor the orchestrator merges a pull request that the loop may merge.
- **Builds on:**
  - ADR-0007 (AI Worker OS, tiers);
  - ADR-0009 (consensus, the owner's click, the Policy Engine);
  - ADR-0012 (the Forge: checks, change requests, deploy plan);
  - ADR-0013 (DNA, census, self-registration).

## Context

**What the organism already does by itself (measured, 2026-11-12).**

| Ability | How | Evidence |
|---|---|---|
| Knows itself | Forge census of the DNA every 30 min | 18 organs, 23 agents, 34 engines |
| Grows organs | Supervisor proposes registrations; council votes | 5 XAUUSD engines registered on 2026-11-12, one an hour |
| Deploys itself | `deploy_commit` by consensus after CI | 3 deploys on 2026-11-12, all verified live |
| Heals itself | automatic rollback; recovery plans | ADR-0009 phase 3 |
| Tunes its own limits | `set_policy_parameter` within hard bounds | `daily-deploy-limit` 20 |
| Watches its own costs | power mode; Workers Builds minutes | #300 |

**What it cannot do.**
- **It cannot write code.** Every ability above executes only code that a person or the orchestrator wrote, reviewed and merged.
- **It cannot decide whether a change made it better.** A deploy is judged only on whether it is healthy, not on whether it improved anything.

Evolution needs both. The organism has to propose, write, verify, merge and deploy a change, and then measure whether that change made it fitter.

**Verification already available.**
- **Forge checks**, on every change request:
  - the full test suite in workerd;
  - a bundle of every Worker;
  - the type-check and Console UI build on Workers Builds;
  - a secret scan.
- **Owner-only reasons**: the Forge computes these for every change request (`workers/forge/src/changes.ts`, `CRITICAL_PATHS`). Its test guard also flags a removed or weakened assertion.

**Parity so far (Forge vs GitHub).**

| Parity | Result |
|---|---|
| Deploy plan | 78 of 78 |
| Checks | 34 of 34 |
| Merge verdict | 5 of 10 |

## Decision

### 1. The loop

Every evolution runs one loop.

1. **Sense.** A need comes from measured signals only:
   - a census finding the Supervisor cannot settle by registration;
   - an error, a failed or slow probe that recurs;
   - a cost signal (Workers AI neurons, build minutes, D1 rows);
   - a failing Forge check on main;
   - an agent report, or the owner's request through the Console.

   Each need is recorded as an **evolution intent** with its evidence, in a new table `evolutions`.
2. **Write.** The new agent **`evolver`** turns one intent into one change:
   - a patch on a branch `evo/<id>`;
   - a pull request whose body holds the intent, the evidence and the expected effect.

   It writes code and tests together. A behaviour change without a new or changed test is refused (step 3).
3. **Verify.** Both sets of checks must pass on the pull request's head:
   - **GitHub's required checks**: branch protection is unchanged and never bypassed;
   - **the Forge's checks**: tests, bundles, type-check, Console build and secret scan.

   The Forge's owner-only reasons are computed as for every change request.
4. **Decide.** The Supervisor proposes **`merge_change`**.
   - The council votes and the Policy Engine may veto.
   - A change that touches an owner-only path is critical (§3).
5. **Merge.** On an executed `merge_change`, the Deployment Orchestrator squash-merges through the GitHub API (§5), checking that the head SHA still equals the one that was verified.
6. **Deploy.** This is the existing path: `deploy_commit` by consensus, in the order of the Forge's deploy plan, with automatic rollback.
7. **Measure fitness.** For 60 minutes after the deploy, the Supervisor compares the evolution's target metric and a fixed set of guard metrics with the 24 hours before.
   - Guard metrics: probe errors, latency, AI failures, test count, Workers AI neurons and build minutes.
   - A worse guard metric, or a target metric that did not move, makes the evolution **unfit**. The rollback and a **`revert_change`** pull request go through the same loop, with priority.
8. **Remember.** The outcome is written to the evolution, to the audit chain and to memory (`memory.remember`).
   - An unfit approach to the same intent is not tried again for 7 days.
   - Two unfit evolutions in a row **freeze** the loop (§4) and open an owner notice.

### 2. Who does what

| Role | What it may do | What it may not do |
|---|---|---|
| `evolver` (new agent, tier 2) | read the repository; push only to `evo/*` branches; open pull requests; `memory.recall` | merge, deploy, read secrets, touch any other branch, change its own registration or capabilities |
| Supervisor | sense, record intents, propose `merge_change` and `revert_change`, measure fitness | write code |
| Council | vote on `merge_change` and `revert_change` | — |
| Policy Engine | veto (limits, owner-only paths, freeze) | — |
| Deployment Orchestrator | the merge itself (head SHA re-checked), then the existing deploy path | merge a head that was not verified |

`merge_change` also covers pull requests the orchestrator or a person opens. Once this is built, the orchestrator no longer merges by hand: it opens the pull request and the loop merges it.

### 3. Owner-only paths: the owner's click, unless the owner decides otherwise

An evolution that could rewrite the Policy Engine, the consensus rules or its own limits could remove every other limit in one merge. So a change touching any of the following stays **critical**: consensus plus the owner's click, per ADR-0009.

- Today's `CRITICAL_PATHS`:
  - auth and Access;
  - the Policy Engine;
  - the consensus rules and the kill switch;
  - secrets;
  - ADR-0009 and ADR-0012;
  - the type-check harness.
- Destructive migrations.
- Removed or weakened test assertions.
- **Added by this ADR:**
  - ADR-0014 itself;
  - the evolution limits file (`control-plane-shared/src/evolution-limits.ts`);
  - the `evolver` agent's registration and capabilities;
  - `.github/workflows/` and `.github/scripts/`;
  - branch protection.
- Anything that names trading (ADR-0009 amendment 2026-11-12: a trading action is always critical).

**Open question for the owner (Q1).** The owner asked that "merge dilakukan semua autonomous". This draft reads that as every change request outside these paths, which is almost every change. Making the owner-only paths autonomous too would let one bad merge disable the Policy Engine that checks every later merge. The recommendation is to keep the click there; the owner decides.

### 4. Hard limits

These live in reviewed code (`evolution-limits.ts`) and are owner-only, like the Policy Engine's hard bounds.

| Limit | Value |
|---|---|
| Open evolution pull requests at a time | 2 |
| Evolutions merged per 24 h | 3 (reverts do not count) |
| Diff size | at most 400 changed lines and 20 files; larger work is split into several intents |
| Per Worker | one evolution in flight |
| Quiet conditions | no merge while a deploy runs, a service is drifted, a critical report is open, or the kill switch is on |
| Freeze | after 2 unfit evolutions in a row, or any failed revert; only the owner lifts it (`consensus_controls.evolution = on`) |
| Model budget | the evolver's tokens per day are capped (Q2) and counted in the Metabolism page |

**Never, by any evolution, vote or click** (ADR-0009, AGENTS.md):
- move funds;
- disable TLS;
- weaken Access or authentication;
- bypass branch protection or required checks;
- delete data or secrets;
- remove or skip tests to get green.

### 5. Merge path and credentials

GitHub stays the source of truth until ADR-0012 phase 5. The Orchestrator merges through the GitHub API with a **GitHub App** installed on this repository only:
- permissions: contents write, pull requests write, checks read;
- no administration permission, so it cannot change branch protection.

The App's private key is an owner action (Q3). It goes into the Secrets Store (ADR-0012 phase 4.3) and is never printed or committed. After phase 5, the same `merge_change` merges on the Forge (Artifacts) instead.

### 6. No shadow phase: what replaces it

The owner chose to go straight to production. The safety that a shadow phase would have given comes instead from five things:

- **Dual verification.** Both GitHub's required checks and the Forge's checks must pass. Merge-verdict parity (5 of 10) is therefore no longer a gate; a disagreement simply blocks the merge.
- **Small diffs and daily quotas** (§4).
- **Fitness measurement with automatic rollback and revert** (§1, step 7).
- **The freeze** after two unfit evolutions.
- **The owner-only paths** (§3).

### 7. Build order (each step live in production when merged)

1. **E1: autonomous merge.**
   - `merge_change` and `revert_change` consensus actions, the Orchestrator's merge with a head-SHA check, and the GitHub App.
   - From E1 on, every pull request (the orchestrator's included) is merged by consensus.
2. **E2: the evolver.**
   - The agent, its tier-2 capability `code.propose` (push to `evo/*` and open pull requests only), the `evolutions` table and the intents.
   - First intent sources: census findings and recurring probe errors.
3. **E3: fitness.**
   - Guard and target metrics, the 60-minute window, automatic revert, and the freeze.
4. **E4: memory and the Console.**
   - Evolution history, outcomes and fitness on a Console "Evolution" page.
   - The owner notice `evolution` (frozen, or waiting for the owner's click).

### 8. Open questions for the owner

- **Q1. Owner-only paths (§3).** Keep the owner's click (recommended), or make them autonomous too?
- **Q2. The code model.** Writing correct code and tests needs a stronger model than the Workers AI free tier (250 requests a day, 10,000 neurons). There are two choices:
  - a stronger model through AI Gateway, with a daily token budget the owner sets;
  - Workers AI only, which means small, mechanical evolutions.

  Either way, the loop counts every token against its budget.
- **Q3. The GitHub App.** The owner creates it (dashboard steps will be provided) and shares only its id. Its key goes into the Secrets Store by the owner's own hand.
- **Q4. Quotas.** Are 2 open, 3 merged per day and 400 lines per change the right starting limits?

## Consequences

- **Gained.** The platform can turn a measured need into a verified, merged, deployed and measured change without a person in the loop. Every step is in the audit chain, and a change that does not make it fitter is undone automatically.
- **The orchestrator's role changes.** It writes pull requests; consensus merges them.
- **Risks, and their mitigations.**

| Risk | Mitigation |
|---|---|
| A wrong change passes both test suites | fitness measurement, revert, freeze |
| The model writes plausible but useless code | target metric must move; 7-day memory of failed approaches |
| Cost runs away | token budget, daily quotas, Metabolism page |
| The loop weakens its own guards | owner-only paths (§3), test guard, invariants that no vote can change |

- **Not changed.** Auth and Access, branch protection, required checks, the Policy Engine's veto, the kill switch, and the prohibition on moving funds.

## Alternatives considered

- **Shadow first** (the evolver writes, the council votes, a person merges, until parity): this was the safer path; the owner rejected it on 2026-11-12.
- **A person merges every evolution**: the owner rejected it on 2026-11-12 ("merge dilakukan semua autonomous").
- **Evolve configuration only** (parameters and DNA, no code): too narrow for "terus meningkatkan kemampuan diri".
- **Merging directly on Artifacts now**: this waits for ADR-0012 phase 5. Until then GitHub's branch protection is the outer guard.
