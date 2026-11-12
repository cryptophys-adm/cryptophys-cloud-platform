# ADR-0014: The evolution loop: the platform writes, merges and deploys its own improvements

- **Status:** Accepted, **deferred** (owner, 2026-11-12: "tunda hingga berhasil lepas dari github", postpone until the platform is off GitHub). Building starts after ADR-0012 phase 5, the cut-over to Artifacts. It also needs the model and the AI Gateway budget (Q2).
- **Owner direction (2026-11-12):** "kekuatan organism ini adalah otak yang terus berkembang dan melakukan evolusi melalui auto-deployment untuk menyesuaikan dan terus meningkatkan kemampuan diri" (the organism's strength is a brain that keeps growing and evolves through auto-deployment, to adapt and keep improving its own abilities).
- **Owner decisions (2026-11-12):** "tidak perlu shadow bisa langsung production dan merge dilakukan semua autonomous" (no shadow phase; straight to production; every merge is autonomous).
  1. **No shadow phase.** Each step goes live in production when it is built.
  2. **Merges are autonomous.** Neither the owner nor the orchestrator merges a pull request that the loop may merge.
- **Owner answers to this draft (2026-11-12):**
  - **Q1, guard paths: fully autonomous.** A change to the platform's own guards merges by consensus too, with no owner click (§3).
  - **Q2, code model: a stronger model through AI Gateway**, with a daily token budget the owner sets.
  - **Q4, quotas: 2 open evolution pull requests, 3 merged per 24 h, at most 400 changed lines per change.**
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
   - a change request on the Forge whose description holds the intent, the evidence and the expected effect.

   It writes code and tests together. A behaviour change without a new or changed test is refused (step 3).
3. **Verify.** The Forge's checks must pass on the change request's head: tests, bundles, type-check, Console build and secret scan.

   The Forge computes its guard-path reasons and test guard as for every change request.
4. **Decide.** The Supervisor proposes **`merge_change`**.
   - The council votes and the Policy Engine may veto.
   - A change that touches a guard path needs a unanimous council and meets the other conditions of §3; a change that §3 refuses is vetoed.
5. **Merge.** On an executed `merge_change`, the Forge merges on Artifacts (§5), checking that the head SHA still equals the one that was verified.
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
| Policy Engine | veto (limits, guard-path conditions, §3 refusals, freeze) | — |
| Deployment Orchestrator | the merge itself (head SHA re-checked), then the existing deploy path | merge a head that was not verified |

`merge_change` also covers pull requests the orchestrator or a person opens. Once this is built, the orchestrator no longer merges by hand: it opens the pull request and the loop merges it.

### 3. Guard paths: autonomous, under stricter conditions (owner 2026-11-12)

The owner chose to let changes to the platform's own guards merge by consensus too, with no owner click. The guard paths are:

- Today's `CRITICAL_PATHS`:
  - auth and Access;
  - the Policy Engine;
  - the consensus rules and the kill switch;
  - secrets;
  - ADR-0009 and ADR-0012;
  - the type-check harness.
- Destructive migrations.
- **Added by this ADR:**
  - ADR-0014 itself;
  - the evolution limits file (`control-plane-shared/src/evolution-limits.ts`);
  - the `evolver` agent's registration and capabilities;
  - `.github/workflows/` and `.github/scripts/`.

An evolution that could rewrite the Policy Engine or the consensus rules could remove every other limit in one merge. So a guard-path change is not a click, but it meets four stricter conditions:

1. **Unanimous council.** Every eligible seat approves; one rejection or abstention blocks it.
2. **At most one guard-path merge per 24 h**, and never two guard paths in one change.
3. **A 24-hour fitness window** instead of 60 minutes, with automatic revert.
4. **The owner is told** of each guard-path merge by email, Telegram and the Console. The owner can still pull the brake: the kill switch, or mode `shadow`.

**What stays refused: no vote can merge these, guard path or not.**
- A diff that removes or weakens a test assertion (the Forge's test guard). Tests may only be added or strengthened.
- A diff that weakens Access or authentication, disables TLS, or lowers a hard bound below its value in the merged code before it.
- Fund movement, in any form (ADR-0009 amendment 2026-11-12). A trading *action* stays critical (the owner's click) whatever the code says. A code change that would let a trading action run without that click is refused.
- Writes to `main` other than the Forge's own merge. Only the Forge holds a token that can write `main`, and it writes only a change whose checks passed.

These refusals are enforced in three places that one merge cannot change at the same time:
- the Policy Engine's veto, as merged before the change;
- the Forge's verdict;
- the deploy gate: the Policy Engine refuses to deploy a SHA that the Forge did not merge after passing checks.

### 4. Hard limits

These live in reviewed code (`evolution-limits.ts`), a guard path (§3). An evolution may change them only under §3's conditions, and may never raise them above the values the owner set in Q4 without the owner.

| Limit | Value |
|---|---|
| Open evolution pull requests at a time | 2 |
| Evolutions merged per 24 h | 3 (reverts do not count) |
| Diff size | at most 400 changed lines and 20 files; larger work is split into several intents |
| Per Worker | one evolution in flight |
| Quiet conditions | no merge while a deploy runs, a service is drifted, a critical report is open, or the kill switch is on |
| Freeze | after 2 unfit evolutions in a row, or any failed revert; only the owner lifts it (`consensus_controls.evolution = on`) |
| Model budget | the evolver's tokens per day are capped at the owner's AI Gateway budget and counted in the Metabolism page |
| Guard-path merges | one per 24 h, unanimous council, 24-hour fitness window (§3) |

**Never, by any evolution, vote or click** (ADR-0009, AGENTS.md):
- move funds;
- disable TLS;
- weaken Access or authentication;
- bypass the Forge's checks or its merge gate;
- delete data or secrets;
- remove or skip tests to get green.

### 5. Merge path: the Forge, never GitHub (owner 2026-11-12)

The owner asked why GitHub was still in the loop. Building the loop on GitHub would add a new GitHub dependency, a GitHub App with a write key, just as the platform leaves GitHub. So this ADR is deferred until ADR-0012 phase 5.

- After phase 5, `merge_change` merges on the Forge, in the Artifacts repository `cryptophys/platform`, with the head SHA checked again.
- The gate is the Forge's own checks, nothing on GitHub.
- The evolver pushes to `evo/*` branches of the Forge's work repository (`platform-work`, ADR-0012 §1) with a short-lived, branch-scoped token that the Forge issues.
- No GitHub credential exists in this design.

### 6. No shadow phase: what replaces it

The owner chose to go straight to production. The safety that a shadow phase would have given comes instead from five things:

- **The Forge's full checks** on every change request, and the deploy gate that refuses a SHA the Forge did not merge.
- **Small diffs and daily quotas** (§4).
- **Fitness measurement with automatic rollback and revert** (§1, step 7).
- **The freeze** after two unfit evolutions.
- **The guard-path conditions and the refusals** (§3).

### 7. Build order (each step live in production when merged)

1. **E1: autonomous merge.**
   - `merge_change` and `revert_change` consensus actions, and the Forge's merge on Artifacts with a head-SHA check. This shares its merge with ADR-0012 phase 4, which builds it first.
   - From E1 on, every pull request (the orchestrator's included) is merged by consensus.
2. **E2: the evolver.**
   - The agent, its tier-2 capability `code.propose` (push to `evo/*` and open pull requests only), the `evolutions` table and the intents.
   - First intent sources: census findings and recurring probe errors.
3. **E3: fitness.**
   - Guard and target metrics, the 60-minute window, automatic revert, and the freeze.
4. **E4: memory and the Console.**
   - Evolution history, outcomes and fitness on a Console "Evolution" page.
   - The owner notice `evolution` (frozen, or waiting for the owner's click).

### 8. Owner decisions and what is still open

- **Q1. Guard paths:** fully autonomous, under §3's conditions (owner, 2026-11-12).
- **Q2. Code model:** a stronger model through AI Gateway (owner, 2026-11-12).
  - Still open: the model and the daily token budget, both the owner's. Until a budget is set, the evolver writes nothing.
- **Q3. The GitHub App:** dropped (owner, 2026-11-12). The loop merges on the Forge after ADR-0012 phase 5 (§5), so it needs no GitHub credential.
- **Q4. Quotas:** 2 open, 3 merged per 24 h, 400 changed lines per change (owner, 2026-11-12).

## Consequences

- **Gained.** The platform can turn a measured need into a verified, merged, deployed and measured change without a person in the loop. Every step is in the audit chain, and a change that does not make it fitter is undone automatically.
- **The orchestrator's role changes.** It writes pull requests; consensus merges them.
- **Risks, and their mitigations.**

| Risk | Mitigation |
|---|---|
| A wrong change passes both test suites | fitness measurement, revert, freeze |
| The model writes plausible but useless code | target metric must move; 7-day memory of failed approaches |
| Cost runs away | token budget, daily quotas, Metabolism page |
| The loop weakens its own guards | unanimous council, one guard-path merge a day, 24-hour fitness window, the refusals of §3 enforced in three places, the owner's brake |

- **Not changed.** The Forge's checks and merge gate, the kill switch, and the prohibition on moving funds. Auth and Access, the Policy Engine and the consensus rules may now evolve, by unanimous consensus, but never be weakened (§3).

## Alternatives considered

- **Shadow first** (the evolver writes, the council votes, a person merges, until parity): this was the safer path; the owner rejected it on 2026-11-12.
- **A person merges every evolution**: the owner rejected it on 2026-11-12 ("merge dilakukan semua autonomous").
- **Evolve configuration only** (parameters and DNA, no code): too narrow for "terus meningkatkan kemampuan diri".
- **Building the loop on GitHub now, with a GitHub App**: rejected by the owner on 2026-11-12 ("tunda hingga berhasil lepas dari github"). It would add a GitHub write credential just as the platform leaves GitHub.
