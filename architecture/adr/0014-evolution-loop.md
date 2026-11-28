# ADR-0014: The evolution loop: the platform writes, merges and deploys its own improvements

- **Status:** Accepted. Building starts now (owner, 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik", activate the evolver now, together with the return path; §11). It was deferred on 2026-11-12 ("tunda hingga berhasil lepas dari github", postpone until the platform is off GitHub) until ADR-0012 phase 5; the model and the cadence were decided in the amendment of 2026-11-13.
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
| Tunes its own limits | `set_policy_parameter` within hard bounds | `daily-deploy-limit` 40 |
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
| Evolutions in flight | **1** (owner 2026-11-13). A new evolution starts only when the previous one is merged and deployed (or closed, reverted or frozen) **and** at least 4 hours after the previous one started |
| Evolutions started per 4 h | **1** (owner 2026-11-13), so at most 6 per 24 h; reverts do not count and do not start a new cycle |
| Diff size | at most 400 changed lines and 20 files; larger work is split into several intents |
| Per Worker | one evolution in flight |
| Quiet conditions | no merge while a deploy runs, a service is drifted, a critical report is open, or the kill switch is on |
| Freeze | after 2 unfit evolutions in a row, or any failed revert; only the owner lifts it (`consensus_controls.evolution = on`) |
| Model | `gpt-oss` only, on Workers AI (`@cf/openai/gpt-oss-120b`; the id is checked against the Workers AI catalog when the evolver is built). No other model writes code; a missing or failing model stops the cycle, it never falls back to another model |
| Model budget | the evolver's Workers AI usage is counted in the Metabolism page; the 4-hour cadence bounds it |
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
- **Q2. Code model:** `gpt-oss` on Workers AI only (owner, 2026-11-13: "terkait pemilihan model untuk coding tetapkan sama menggunakan gpt-oss saja"). This replaces the 2026-11-12 answer (a stronger model through AI Gateway); no AI Gateway budget is needed.
- **Q3. The GitHub App:** dropped (owner, 2026-11-12). The loop merges on the Forge after ADR-0012 phase 5 (§5), so it needs no GitHub credential.
- **Q4. Quotas:** one evolution at a time, at most one started per 4 hours, each cycle running to merge and deploy before the next starts (owner, 2026-11-13: "batasi ketat hanya per 4H siklus pekerjaannya sampai merge/deploy auto sebelum mengerjakan request lain hanya 1 pekerjaan per 4H"). This replaces "2 open, 3 merged per 24 h" (2026-11-12). The diff limit (400 changed lines, 20 files) is unchanged.

### 9. Amendment 2026-11-13: model and cadence

Owner, 2026-11-13: "terkait pemilihan model untuk coding tetapkan sama menggunakan gpt-oss saja, tapi batasi ketat hanya per 4H siklus pekerjaannya sampai merge/deploy auto sebelum mengerjakan request lain hanya 1 pekerjaan per 4H".

- **Model.** The evolver writes code with `gpt-oss` on Workers AI only. There is no fallback model: when the model is unavailable or its answer fails validation, the cycle stops and is recorded, and the next cycle waits for its 4-hour slot.
- **One cycle at a time.** A cycle is one evolution from intent to pull request, checks, consensus merge on the Forge, native deploy and the fitness window. Only one cycle is in flight. A new cycle starts only when the previous one has ended (merged and deployed, closed, reverted or frozen) and at least 4 hours have passed since the previous cycle started. Requests that arrive meanwhile queue as intents; they never start a parallel cycle.
- **Enforced in code.** `evolution-limits.ts` (a guard path, §3) holds `MAX_IN_FLIGHT = 1` and `MIN_START_INTERVAL_HOURS = 4`. An evolution may not raise them (§4); only the owner can.
- **Unchanged.** The diff limit (400 changed lines, 20 files), one evolution per Worker, the quiet conditions, the freeze, guard-path merges once per 24 h with a unanimous council, and the deferral until ADR-0012 phase 5.
- **Scope.** This governs the platform's own evolver. It does not change how the orchestrator session (Claude Code) works on the owner's requests.

### 10. Amendment 2026-11-13 (evening): AI decides; the organism knows itself and grows

Owner, 2026-11-13, after eleven XAUUSD AI engines stayed in the DNA but unregistered for a day:
- "bahkan system sendiri tidak mengenali kalau masih ada agent/worker/engine yang belum diketahui dan didaftarkan";
- "itu karena sebagian engine masih bergantung kepada hardcoded bukan agentic ai dan memanfaatkan ai to ai protocol";
- "mulai sekarang Ai harus memutuskan", with the choice **"AI memutuskan, pengaman tetap"** (AI decides; the safeguards stay rigid);
- on the organism ("dari 1 sel yang akan menjadi jutaan sel ... membentuk organ-organ baru"): "setuju, tambahkan E5".

The census had seen the eleven engines every 15 minutes. What failed was a fixed rule: their proposals were rejected only because the brake held, and a 24-hour cooldown then kept them waiting long after the brake was off. A reasoning agent would have read why it was rejected and asked again.

**A. Agentic decisions (amends ADR-0007 §3 "AI never decides whether to act").**

The platform gets two layers.

| Layer | What it does | Who |
|---|---|---|
| **Nerves (agentic)** | Senses, diagnoses ("why is this stuck?"), proposes, casts council votes with reasons, chooses what to evolve, and talks to other agents | Workers AI agents over an agent-to-agent protocol |
| **Bones (deterministic)** | Bounds every decision and cannot be talked out of it | The code paths below |

The bones stay exactly as they are; an AI decision never passes them:
- the Policy Engine's checks and hard bounds, and its veto;
- the brake (an open critical report), the kill switch and the consensus mode;
- the Forge's checks, guard paths and test guard;
- the owner's click for critical actions;
- no fund movement, ever (ADR-0009).

Build order:
1. **A1, agentic votes.** Each council seat's vote is reasoned by its agent over the same evidence, with its reasons recorded. The deterministic rules run first and keep their veto: an agent may reject what the rules allow, never approve what they refuse.
2. **A2, diagnosis.** An agent reads what is stuck (registrations, deploys, merges, failed ticks) with its history and proposes the way out, which then goes through consensus.
3. **A3, agent-to-agent protocol.** Agents exchange typed messages through the AI Kernel (MCP tools and RPC), and a council deliberation is a transcript, not one function call per seat. Every message is audited; no message carries authority by itself.

**B. E0, self-inventory (before E2).**

The census compares the DNA with the registry only. E0 compares it with what really exists in the Cloudflare account:
- Workers (Scripts API), D1 databases, R2 buckets, Durable Object namespaces, routes and custom domains;
- every Worker with no DNA (`undeclared_worker`), every DNA organ with no Worker (`missing_worker`), and every agent or engine registered nowhere else.

Each finding becomes an intent: register, declare in DNA (an evolution), or retire. On 2026-11-13 the account had 18 Workers and the DNA 18 organs, but no code checked it.

**C. E5, morphogenesis (after E2 and E3).**

The organism grows new organs, not only repairs the ones it has.
- **Stem cell.** A template organ in the Forge: a Worker with its DNA, `HealthRpc`, readiness, a vote entrypoint and tests.
- **Morphogens.** Measured growth signals: an organ above its load or error budget, a capability asked for repeatedly with no organ to serve it, a recurring error no existing organ can fix.
- **Birth.** An evolution may add a new Worker directory with its `wrangler.toml` and `organism.json`. This is a germline change: the owner clicks (`merge_owner_change`). The census registers the organ by consensus, and gate 9's private stub and Access update give it a body.
- **Selection.** An organ that adds no measured value within its trial period is proposed for retirement (apoptosis).
- **Nutrients.** Growth is bounded by the Metabolism budget and the account's Worker limits.

The build order becomes E1 (done 2026-11-13), E0, E2, E3, E4, A1–A3 alongside, then E5.

### 11. Amendment 2026-11-17: the deferral lifted; council tasks and the return path

Owner, 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik" (activate the evolver now, together with the return path). The orchestrator relayed it; the owner confirmed it directly in the platform session, with the answers below. The build is `docs/design/EVOLVER.md`.

- **The deferral is lifted.** Canonical main has lived on the Forge since the cut-over, and E1 merges there. So §5's reason for waiting (no GitHub write credential) already holds. Building E2 starts now, in the order of the design's §9.
- **A new intent source: the council.**
  - A `repository_task` that the owner accepted in Nexus reaches the platform as a `typed_proposal.v1` report from `xauusd-moderator`, with `executor: "cryptophys"`.
  - The kernel records it as an evolution intent, and Cerebrum's inbox lists it.
  - E0's inventory findings and the census's unsettled findings are intents too.
- **External repositories wait.** A task for a repository other than the platform's waits as `waiting_external` until ADR-0018 X1/X2 exist (owner, 2026-11-17: "Tunggu ADR-0018 X1/X2"). The evolver never writes to another repository, and the platform still deploys no external organ.
- **The return path.**
  - `council.decisions.read` is a tier 1, read-only capability under an xauusd-specific ceiling (`docs/design/HAIC-H0-H1.md` §5).
  - xauusd pulls the state of each proposal it handed off: queued, waiting, proposed, merged, deployed, closed or refused. Cerebrum never calls into xauusd.
- **Unchanged.**
  - §4 and §9's cadence: one evolution in flight and at most one started per 4 hours. The owner first chose "10 CR/hari, 5 terbuka", then kept the 4-hour cycle ("Tetap 1 per 4 jam"), since fitness and revert (E3) are not built.
  - §3, guard paths under unanimous consensus with no owner click ("Tetap §3 lama"). Until E3 is built, the evolver proposes routine paths only (`evolution-limits.ts`), so §3 does not yet come into play.
  - The model (`gpt-oss` on Workers AI only), the diff limits, the quiet conditions, the freeze and every refusal of §3.
- **New.**
  - **A kill switch for the evolver alone**, `evolver_controls.mode` (`on` or `off`). Only the owner turns it on; any operator may turn it off as a brake. The platform kill switch and mode `shadow` stop it as well.
  - **At most 3 AI calls per cycle.**
  - **Until E3 is built**, a deployed evolution is recorded as deployed but unmeasured. The deploy's health check and automatic rollback stay its protection.

### 12. Amendment 2026-11-28: external council tasks are worked, kept fresh and archived (Issue #327 C2)

Owner, 2026-11-28, in the platform session: "Ya Kerjakan", confirming Issue #327 C2 and C3 with the direction "jadikan autonomous hasil council dikirim ke cerebrum untuk ditindak lanjut, call for council, owner hanya approved atau reject topic dan harus selalu segar ada umur kadaluarsa dan ada arsip beserta statusnya" (make it autonomous: the council's result goes to Cerebrum to be followed up; the owner only approves or rejects the topic; always fresh, with an expiry, and an archive with its status). This narrows §11's "External repositories wait".

- **Who chooses.** A council task is valid when the owner chose it (`chosen_by: "owner:<actor>"`, as before), or when the council chose it inside a topic the owner approved: `chosen_by: "council"` with `topic_approved_by: "owner:<actor>"` and the `session_id` of that council session. The owner's part is the topic.
- **queued_external.** A task for a repository that has its own worker (`EXTERNAL_ASSIGNEES`: the xauusd repository's is `xauusd-worker`) is recorded `waiting_external` with that assignee: `queued_external`. The return path says `queued_external`. Any other external repository still waits unassigned. The state CHECK of migration 0077 is not rebuilt; migration 0092 adds `assignee`, `expires_at` and `close_code` only. `close_code` says why an intent ended, machine-readable: `owner_closed`, `expired`, `refused` or `completed`. `state_reason` stays the human text.
- **Progress, not execution.** The worker builds the task in its own repository, under that repository's own rules. `POST /v1/evolution/intents/{id}/progress` records each step: `in_progress`, `proposed` (a pull request), `merged`, `deployed`, `closed`, or `refused` with a reason. The caller is the owner, or a listed Access service token on an assigned intent. A service may set `in_progress`, `proposed`, `merged` and `refused` only, and a ref only in its own repository. `deployed` comes from deploy evidence and `closed` from the owner or a measurement. Each step is one batch: the intent, one return-path update, one audit event. The platform executes nothing for it: no `evolutions_v2` row and no Forge change request. ADR-0018 X1/X2 (the Forge building or deploying an external organ) stay held. The evolver's own intents never move this way.
- **Always fresh.** An external intent whose worker is the next actor (`queued_external` and `in_progress`) is closed as expired after 7 days without a real change, and returned to the council through the return path. Every real step resets the 7 days; a replay does not. `proposed` waits on review or the owner's merge, so it does not expire; past 7 days it shows as stale. `merged` and `deployed` wait on a deploy and a measurement, so they do not expire either.
- **Prerequisite on the xauusd side.** Before any council-chosen intent can exist (xauusd's CFC_MODE `auto`), xauusd's return path must accept the states `queued_external` and `expired` and `refs.close_code`. Until then it drops an unknown state and its cursor moves past it. xauusd adds this as the first step of CFC-A.
- **Next actor.** One pure function names who acts next, and the API exposes it: queued_external and in_progress → the assignee; proposed → owner/orchestrator; merged and deployed → the owner for an external intent (nobody else records deployed or closed for another repository yet), deploy and measurement for the platform's own; closed and refused → none.
- **Archive.** Every intent keeps its full history in the audit trail on `intent:<id>`, with one event per step: recorded, progress, expired, closed. The Console's Proposals page shows it (Issue #327 C3): External intents, with each open intent's state, last update, next actor and the owner's step buttons, and the Archive, with every intent's state, close code, next actor and full history (`GET /v1/evolution/intents/{id}`).

### 13. Amendment 2026-11-28: the council repository (CB, option B)

Owner, 2026-11-28, to the coordinator: "sementara B dulu, setelah xauusd settle dan bisa dilepas ketergantungan dari github, artinya improvements sisa minor baru semua akan dihandle cerebrum" (B for now; once xauusd has settled and can be freed from its GitHub dependency, the remaining minor improvements will all be handled by Cerebrum). Confirmed by the owner in the platform session: "comfirmed".

- **A data repository.** The Forge keeps a second Artifacts repository, `council` (namespace `cryptophys`), with no executable code: no Worker, no deploy unit, nothing the census compares. `ledger/<topic>/<session_id>/<proposal_id>.json` (`council_ledger.v1`) holds one file per council proposal, the owner-chosen ones included, and one `session.json` per council session (its topic, question, summary and options, never a value; from xauusd's awaiting_owner report), and every status transition is one commit: xauusd's own states and the platform's return path, with `close_code` and the pull request or commit ref. Never a price, a level, a lot or a secret.
- **The Forge writes it (CB1).** The tick step `councilSync` (`forge/src/council-sync.ts`) rebuilds each touched proposal's file from D1 and checks the commit before main moves: only ledger paths with safe segments, the schema, no forbidden key, no price-like number, no secret, within size (`checkCouncilCommit`). A refused file is left out and audited, and the others are written. The write path is pinned to `council` by a constant; it is not the evolver's path (`evolution.ts`), and it never writes `platform` or `platform-work`.
- **Settings the council owns (CB2).** `policy/overlay.json` (key, value, from, session, proposal, state shadow, live or reverted) and `policy/allowlist.json`, mirrored from the `council_owned_keys` block of xauusd's `organism.json`. The allowlist changes only by a change request the owner merges in `council`. Risk per trade, live arming, the profile ceiling, hashed or protected engines and Pine SSOT are never on it. xauusd reports verdicts as `council_policy_verdict.v1`; a revert, from a verdict or from 14 days in shadow without one, is a revert commit. CB2a builds the overlay from xauusd's `policy_parameter` proposals and their verdicts, each entry checked against main's allowlist (absent: nothing is council-owned) and a fixed denylist; an entry that fails is left out and listed in the owner's inbox (`council_sync_refused`). CB2b is the owner's gate: when xauusd's `council_owned_keys` differs from main's allowlist, the Forge writes the new file to branch `allowlist/<head12>` of `council` and a pending row (migration 0093); the Supervisor proposes the critical action `merge_council_allowlist` (keys and bounds only; the autonomy dial never raises it above owner_click), and after the owner's click the Forge fast-forwards `council` main only while it is still the change's base.
- **Readers (CB3).** xauusd's AI Worker reads `policy/` and `ledger/` (the Forge entrypoint `CouncilPolicyRpc`), and Aether reads `ledger/` only (`CouncilLedgerRpc`), at main, read only: the entrypoint a binding names is the scope, never a value in the request. Their binding lines are their repositories' changes. xauusd never writes.
- **Later (planned, not built).** Once xauusd is settled and independent of GitHub, ADR-0018 X1/X2 reopen for xauusd: its code moves to the Forge, and the remaining improvements go through Cerebrum. Until then the Dynamic Workers budget hold of 2026-11-25 stays.

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
