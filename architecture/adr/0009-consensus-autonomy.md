# ADR-0009: Consensus autonomy for the AI mesh

- **Status:** Accepted (owner decision 2026-11-06). Rollout is phased; see §6.
- **Date:** 2026-11-06
- **Owner decisions (2026-11-06):**
  - "Cryptophys adalah jaringan ai-mesh cerdas yang bekerja secara autonomous, peran owner/operator hanya klik approval untuk severity critical only, semua pekerjaan dilakukan oleh AI secara autonomous melalui consensus approval yang terdiri dari semua agent control plane." (Cryptophys is an intelligent, autonomous AI mesh. The owner only clicks approval for critical severity; all work is done by AI through consensus approval of all control-plane agents.)
  - **Scope of autonomy: "Hampir semua"** (nearly everything). Agents may execute every platform action after consensus. Only data deletion or restore and secret changes stay with the owner.
  - **Consensus rule: simple majority** of the eligible control-plane agents, plus a Policy Engine allow.
  - **Roles:** Claude (the orchestrator session) is now also the code worker and engineer. pi and agy become validators and auditors of Claude's deployments.
- **Amends:**
  - ADR-0007 §2: tier 2 now covers consensus-executed actions, and tier 3 "human" becomes the *critical* class below.
  - ADR-0005 decision 3: agents may take platform actions.
- **Unchanged:** ADR-0005's prohibition on fund movement. No agent, consensus or owner click can touch wallets or move funds. Trading (orders, brokers, exchange accounts) was prohibited too until the amendment of 2026-11-12, which makes it critical (an owner click per execution).

## Context

The platform runs on Cloudflare. Today the AI Kernel lets agents observe (tier 0) and propose (tier 1), and a person approves or runs every change. The owner's intent, carried over from the original Cryptophys AI mesh, is the reverse: agents do the work and agree among themselves, and the owner is interrupted only for critical decisions.

## Decision

### 1. Action classes

| Class | Examples | Who decides |
|---|---|---|
| **Routine** (consensus executes) | Observe drift; publish reports; rollback a Worker to a recorded healthy version; redeploy a commit; **deploy a new commit from `main` whose CI is green**; set a registry desired version; update registry metadata; suspend or resume an agent (not a kernel-hosted one); disable or enable a service in the registry; create, approve and execute recovery plans whose steps are all routine | Simple majority of eligible voters, plus a Policy Engine allow |
| **Critical** (consensus, then an owner click) | Restore or delete D1 data (`restore_d1_bookmark`, retention changes); create, rotate or delete secrets and Access tokens (`rotate_secret`); retire or delete a Worker; change Cloudflare Access; turn the global kill switch back **on** after a stop; register external agent principals | Consensus as above, **and** one owner/approver click in the Console |
| **Prohibited** | Wallets and fund movements (orders, trading and exchange accounts are critical since 2026-11-12); disabling the kill switch mechanism itself; changing the consensus rules, voter set or action classes | Nobody. Changing the rules needs a new ADR and a reviewed code change |

Anything not listed is **critical** until it is classified.

### 2. Consensus

- **Proposal.** Any eligible agent may propose an action through the syscall `consensus.propose`. The proposal carries:
  - the action;
  - the target;
  - bounded parameters;
  - evidence: report IDs, drift observations, CI run IDs.

  The kernel classifies the action (§1). A prohibited class is rejected at once.
- **Voters.** The enabled control-plane agents:
  - the seven per-Worker agents (`platform-api`, `deployment-orchestrator`, `platform-registry`, `policy-engine`, `drift-detector`, `audit-ledger`, `recovery-manager`);
  - plus `supervisor` and `auditor`.

  That is 9 at most. The proposer does not vote, and suspended agents are not eligible. XAUUSD agents never vote on platform actions.
- **Vote.** Each voter evaluates the proposal against its own Worker's evidence, through deterministic checks and optionally its AI engine. It then casts `consensus.vote` (`approve` or `reject`, with a bounded reason) within a voting window, which defaults to 15 minutes.
- **Quorum.** A proposal passes when **approvals > half of the eligible voters** at the time of the tally. Abstentions count against. A tie fails.
- **Policy gate.** A passed proposal is executed only if the Policy Engine returns `allow` for `consensus.execute` on that action. The policy re-checks:
  - the class;
  - rate limits;
  - preconditions, for example green CI for a deploy, or that a rollback target is a version recorded as healthy;
  - the global kill switch.

  The Policy Engine is a veto, not a voter.
- **Critical actions** additionally wait in the Console Approval Queue for one approver click. The click is recorded with the person's Access identity, and the separation of duties already in place applies: the approver is not the proposer.
- **Execution** runs only through the platform's existing paths:
  - the Deployment Orchestrator for deploys;
  - the Recovery Manager for recovery steps;
  - the registry and kernel APIs for the rest.

  Every proposal, vote, tally, policy decision and execution is appended to the hash-chained audit ledger.

### 3. Safety rails (not negotiable by consensus)

1. **Kill switch.** Any operator can stop every agent at once, at any time. Restarting the agents is critical (§1).
2. **Rate limits.**
   - At most 1 executed deploy or rollback per Worker per hour, and 6 per day across the platform.
   - At most 20 proposals per agent per day.
   - Repeated failures suspend the proposing agent.
3. **Automatic rollback.** A routine deploy that fails its live verification is rolled back, by consensus or by the deploy workflow's own check.
4. **Single source of truth.** Agents act only on `main` and on CI-verified commits. No agent pushes code.
5. **Prohibitions** from ADR-0005 stay absolute.

### 4. Roles

- **Claude** (orchestrator session) writes and deploys code and runs the rollout.
- **pi and agy** validate and audit Claude's deployments: they re-run the tests, review the diffs and check production against `APPROVAL.md`. They report findings; they do not merge or deploy.
- **The owner** clicks critical approvals in the Console, and can stop the mesh at any time.

## Consequences and risks (accepted by the owner)

- **Correlated errors.** The voters run on the same small Workers AI models and read the same data, so a misleading input can sway the majority together. Deterministic checks and the Policy Engine gate are the main defence.
- **Simple majority** means that 5 of 9 voters can act. A compromised account deployer can change agent code. The trust boundary stays the Cloudflare account (ADR-0007 §1.1).
- **Deploying new commits without a human** means that a green but wrong commit reaches production. The rate limits, automatic rollback and audit trail limit the damage; they do not prevent it.
- **Budget.** Votes add Workers AI and D1 usage. Voting is deterministic-first, so AI is optional per vote, which keeps it within the included quotas.

## 6. Rollout

Each phase is a reviewed PR, deployed and verified, and audited by pi and agy.

1. **Phase 1, shadow consensus.** Schema (`consensus_proposals`, `consensus_votes`), the `consensus.propose`, `consensus.vote` and tally syscalls, the classification, and the Console Approval Queue view. **Nothing executes.** Proposals and votes are recorded for 7 days, to measure agreement against what a human would have done.
2. **Phase 2, routine execution of reversible actions:** rollback, redeploy of a recorded version, observe, suspend/resume, registry updates.
3. **Phase 3, routine deploy of new green commits,** with automatic rollback.
4. **Phase 4, critical actions with the owner click.**

The owner can stop or reverse the rollout at any phase.

## Amendment 2026-11-06: phase 1 implementation (shadow consensus)

- **Migration 0023:**
  - adds the `consensus_controls` table, with `mode` set to `shadow`;
  - adds the `consensus_proposals` and `consensus_votes` tables;
  - grants `consensus.propose` (tier 1, at most 4 per hour) to the `supervisor` only.
- **Proposals.** When the supervisor sees persistent drift on a managed service, it proposes `redeploy_desired_version`. It does this next to the recovery-plan draft it already writes.
- **Votes.**
  - Each of the 9 voters, except the proposer, applies a deterministic rule from its own domain to **one evidence snapshot** that the kernel takes at proposal time: drift, registry, audit chain, open recovery plans, recent proposals, the kill switch, and critical reports.
  - Each voter also applies a common safety gate: the kill switch must be on, the audit chain valid, and no critical report open.
  - **Limitation.** The voters run inside the AI Kernel against shared D1 data; they are not separate Workers voting over RPC. This keeps phase 1 within one deploy. Moving votes into each Worker is an option before phase 3.
- **Tally.** A proposal needs a simple majority of the eligible voters. The Policy Engine then evaluates `consensus.execute` (`<action>:<target>`), checking:
  - the class;
  - that the consensus passed;
  - the kill switch;
  - one action per target per hour;
  - at most 6 deploys or rollbacks per day.
- **Statuses:** `shadow_passed`, `shadow_blocked` (passed the vote but the policy denied it) and `rejected`. **Nothing executes.** The deploy verification fails if any proposal is `executing` or `executed` while the mode is `shadow`.
- **Read API:** `GET /v1/consensus` and `GET /v1/consensus/{id}` on the kernel (operators). The Console has a Consensus screen and a Command panel; both are read-only.
- **Promotion to phase 2** needs:
  - at least 7 days in shadow;
  - every `shadow_passed` proposal matching what a person would have done, checked against the drift outcome and the recovery plans;
  - a reviewed change that sets `mode` to `routine` and adds the execution paths.

### Phase 1 deployment, 2026-11-06

**DEPLOYED AND VERIFIED** (orchestrator). Both runs used commit `e354d4e` (#150).

| Run | Result |
|---|---|
| Deploy Control Plane, run 42147738404 | Success. Migration 0023 applied. The deploy verification confirmed `GET /v1/consensus` returns `mode = "shadow"` and no proposal is `executing` or `executed`. Dispatched at 02:02 UTC, after the :00 cron. |
| Deploy Console, run 42148478950 | Success. The Consensus screen and Command panel are live through Access. |

**D1 check at 02:09 UTC:**
- `consensus_controls.mode = shadow`;
- the last migration is `0023_consensus_shadow.sql`;
- the supervisor holds `consensus.propose`;
- there are 0 proposals and 0 executed;
- 0 of 15 services drifted.

No proposals yet is expected: the supervisor proposes only on persistent drift. The 7-day shadow window for promotion to phase 2 starts **2026-11-06**, and the earliest review is **2026-11-13**. The recurring platform check (every 6 h) reports the shadow statistics.

## Amendment 2026-11-06: phase 2 execution paths (code only; production stays in shadow)

The execution code ships ahead of the promotion so that pi and agy can audit it during the shadow window. **`consensus_controls.mode` stays `shadow` in production.** Every path below is a no-op until a separate reviewed change sets the mode to `routine`, which needs the phase 1 criteria (earliest review 2026-11-13).

- **Executable in phase 2** (`PHASE2_EXECUTABLE` in `workers/ai-kernel/src/consensus.ts`): `observe_drift`, `set_desired_version`, `registry_disable_service`, `registry_enable_service`, `suspend_agent`, `resume_agent`. All are reversible by the opposite action. (`retire_agent`, added 2026-11-11, is critical: it executes in phase 4 after the owner click, ADR-0013 §3.)
- **Not executed in phase 2.** `redeploy_desired_version`, `rollback_worker_version` and `deploy_commit` pass or fail the vote as before but stay unexecuted, with the outcome "no executor in this phase". They move to phase 3 with a per-Worker deploy path and automatic rollback. Critical actions go to `pending_owner` (phase 4 adds the approval click).
- **Flow.** If the mode is not `shadow`, the class is routine, the vote passed and the Policy Engine allowed `consensus.execute`, the kernel stores the proposal as `executing`, runs it, then sets `executed` or `failed` with the outcome, and appends `consensus.executed` to the audit chain.
- **Owning paths:**
  - suspend and resume go through the kernel's own `setAgentStatus`; kernel-hosted agents are refused;
  - registry actions go to the Platform Registry over a new RPC entrypoint, `RegistryRpc.applyConsensus`;
  - drift observation goes to the Drift Detector over a new RPC entrypoint, `DriftRpc.observeForConsensus`.
- **Defence in depth.** Each executing path calls `verifyConsensusExecution` (`control-plane-shared/src/consensus-exec.ts`) in its own code. It refuses unless:
  - the mode is not `shadow`;
  - the proposal is `executing`, passed, and names exactly this action and target;
  - its Policy Engine decision is an `allow` for `consensus.execute` on `<action>:<target>`, is the proposal's own decision, and is at most 10 minutes old;
  - the kill switch is on.

  An executed proposal cannot be replayed. Every change is attributed to the actor `consensus:<proposal id>`.
- **Deploy order.** The Drift Detector now deploys before the AI Kernel, so that `DriftRpc` exists when the kernel binds to it.
- **Tests:** `test/consensus-phase2.test.ts` (7 criteria): shadow never executes; suspend/resume and registry actions execute in routine mode; deploys and critical actions do not; executor failures are recorded as `failed`; the target Workers refuse malformed ids, swapped actions or targets, foreign, stale or replayed decisions, the kill switch and shadow mode.

### Phase 2 code deployment, 2026-11-06

**DEPLOYED AND VERIFIED** (orchestrator). The mode is unchanged.

| Run | Result |
|---|---|
| Deploy Console, run 42176545976 | Success at `4004864` (#152, the Dependabot fix for the build toolchain). Dispatched at 06:46 UTC, after the :45 cron. |
| Deploy Control Plane, run 42178110823 | Success at `e293b4a` (#153). The Drift Detector deployed before the AI Kernel. The deploy verification confirmed the mode is `shadow` and no proposal is executing or executed. Dispatched at 07:01 UTC, after the :00 cron. |

**D1 check at 07:03 UTC:**
- `consensus_controls.mode = shadow`;
- the last migration is `0023_consensus_shadow.sql` (phase 2 adds none);
- there are 0 proposals and 0 executing, executed or failed;
- the kill switch is on;
- 6 control-plane services have the desired version `e293b4a`;
- the 07:02 drift run shows 0 drifted.

The promotion to `routine` still waits for the 7-day shadow review (earliest 2026-11-13).

## Amendment 2026-11-06: phase 3 code (consensus deploys and automatic rollback; production stays in shadow)

The phase 3 code ships ahead of its promotion, for audit by pi and agy. **`consensus_controls.mode` stays `shadow`.**

- **Modes.**
  - `shadow` executes nothing.
  - `routine` executes the phase 2 set.
  - `deploy` (and later `critical`) adds `deploy_commit`.

  `redeploy_desired_version` and `rollback_worker_version` stay unexecuted. A redeploy of an older commit cannot pass the deploy workflows' "SHA must be current main" gate, and the rollback of a bad deploy is done by the workflow itself (below).
- **Deploy units** (`DEPLOY_UNITS` in the Deployment Orchestrator). Each unit is one production workflow with a fixed set of Workers and source paths:
  - control plane: six Workers, plus the migrations and the shared library;
  - Console;
  - Home;
  - Platform API;
  - Deployment Orchestrator.

  Every unit also counts `workers/control-plane-shared/src/`. XAUUSD Workers are never deployed by platform consensus.
- **Proposals.** Each supervisor cycle asks the orchestrator's new `DeployRpc.pendingDeploys()` which units have files changed on a CI-green `main` since the registry desired version. "CI-green" means every push-event validation workflow on the commit succeeded. The supervisor then proposes `deploy_commit` once per unit and commit, `{commit_sha, unit, workflow}`. The check reads GitHub (ref, runs, compare) with the orchestrator's existing token; when a lookup fails, the unit is skipped. No new secret.
- **Execution** (`DeployRpc.deployForConsensus`). The orchestrator:
  1. re-verifies the proposal, as in phase 2 (`verifyConsensusExecution`);
  2. requires the commit to be current `main` with green CI;
  3. claims a per-workflow-and-commit Durable Object lock;
  4. records a `deployment_requests` row (`requested_by = consensus:<id>`, `approval_id` = the proposal);
  5. dispatches the unit's workflow on `main` with `DEPLOY`;
  6. appends `deployment.dispatched` to the audit chain.

  The workflow keeps every gate it already has: the production Environment, the SHA check, tests, Access, and live verification. The Policy Engine limits still apply: one action per target per hour and 6 deploys per day.
- **Automatic rollback (§3.3).** `deploy-control-plane`, `deploy-console`, `deploy-home`, `deploy-platform-api` and `deploy-deployment-orchestrator` now record each Worker's active deployment before deploying (`.github/scripts/worker-rollback.sh capture`). If any later step fails, the workflow creates a new deployment that serves the captured versions again (`restore`). The rollback:
  - restores only the Workers that the deploy changed;
  - fails the step loudly when Cloudflare refuses it (for example across a Durable Object migration).

  D1 migrations are not rolled back: they are forward-only, the pre-migration Time Travel bookmark is printed, and a data restore stays critical. After a rollback, the registry may still name the failed commit, so drift reports the mismatch until a good commit is deployed. This applies to every deploy, not only consensus ones.
- **Deploy order for this change:** the Deployment Orchestrator first (it adds `DeployRpc`), then the control plane (the kernel binds `DEPLOY`).
- **Tests:**
  - `test/consensus-phase3.test.ts`, 8 criteria:
    - the mode gates;
    - the deploy-unit mapping and path rules;
    - pending detection on green and red CI;
    - the supervisor proposes once per commit and shadow dispatches nothing;
    - routine mode does not deploy;
    - deploy mode dispatches once, with audit, and refuses a replay;
    - a stale `main` or red CI fails without dispatching;
    - the workflow wiring.
  - `.github/scripts/worker-rollback.test.sh` (hermetic).
- **Validator hardening (2026-11-06, commits pushed by the audit role):**
  - **CI gate.** A consensus deploy now requires:
    - the combined commit status;
    - both push validations on `main` (`Validate` and `Validate Control Plane Workers`), present and green.

    Missing, pending, skipped, truncated or non-`main` evidence fails closed.
  - **Unit paths** are whole directories, so manifests, lockfiles and bundler config count.
  - **Order.** When the Deployment Orchestrator is pending, it is the only unit proposed in that cycle; the others follow once its version is recorded.
  - **Rollback** also runs when a deploy run is cancelled.
  - The orchestrator re-reviewed the changes and updated the phase 3 test to the orchestrator-first rule. 211/211 tests pass.

### Phase 3 code deployment, 2026-11-06

**DEPLOYED AND VERIFIED** (orchestrator). The mode is unchanged.

| Run | Result |
|---|---|
| Deploy Deployment Orchestrator, runs 42179772191 (`86509fd`) and 42181714607 (`fc443cd`) | Success. The new capture step read the live Cloudflare deployments; no rollback was needed. |
| Deploy Control Plane, run 42182183884 (`fc443cd`) | **Failed verification, then rolled back automatically.** The supervisor cycle that the deploy verification triggers made three shadow `deploy_commit` proposals in one cycle (Console, Home, Platform API; each `shadow_passed`, 8 of 8 votes). That cycle exceeded the 30-second probe timeout. The new rollback step restored all six Workers to their captured versions within 6 seconds. This was the first production use of §3.3. |
| Deploy Control Plane, run 42183060692 (`fc443cd`) | Success. The three proposals already existed, so the cycle did not repeat them. |

**D1 check at 07:48 UTC:**
- the mode is `shadow`;
- there are 3 proposals, all `shadow_passed`;
- 0 are executing, executed or failed, and there are 0 consensus deployment requests;
- the kill switch is on;
- 0 services are drifted;
- there are 0 critical reports.

**Follow-up.** The supervisor now makes at most one `deploy_commit` proposal per cycle (`MAX_DEPLOY_PROPOSALS_PER_CYCLE = 1`); the other units follow in the next cycles.
- **Second rollback, then the fix (07:53 UTC).** Control-plane run 42183552848 at `903bb8c` failed the same probe and was rolled back automatically again. A single proposal took about 25 seconds, and the kernel's scheduled cycle at :52 ran on the same Durable Object at the same time. The fix: **deploy proposals are made only in scheduled cycles**. An operator wake, which the deploy verification calls, now records "deploy proposals run in scheduled cycles only" (test 11).
- **Operational rule.** Deploys are dispatched outside both the drift cron minutes (:00/:15/:30/:45) and the kernel cron minutes (:07/:22/:37/:52).
- **Fix deployed.** Control-plane run 42184714573 at `3a1cd76` succeeded; it was dispatched at 08:01 UTC, between the :00 and :07 crons. **D1 at 08:04 UTC:**
  - the mode is `shadow`;
  - 4 proposals: 3 `shadow_passed` and 1 `shadow_blocked` (Console at `903bb8c`, denied by the one-per-target-per-hour policy limit);
  - 0 executed and 0 consensus deployment requests;
  - the kill switch is on;
  - 0 drifted services, and the 6 control-plane services are at `3a1cd76`;
  - 0 critical reports.

  Phase 3 code is complete. Promotion to `routine` and then to `deploy` waits for the shadow review (earliest 2026-11-13).

## Amendment 2026-11-06: phase 4 code (owner click for critical actions; production stays in shadow)

The phase 4 code ships ahead of its promotion, for audit by pi and agy. **`consensus_controls.mode` stays `shadow`.**

- **Reaching the owner.** A critical proposal reaches the owner (status `pending_owner`) only in mode `critical`, after a simple majority and a Policy Engine allow. In `shadow`, `routine` and `deploy` it is only recorded.
- **The click.** `POST /v1/consensus/{id}/approve` or `/reject` on the AI Kernel. The rules:
  - **Who:** the caller must be in `APPROVER_IDENTITIES` and must be a person (an email identity); Access service tokens, including CI, are refused.
  - **One decision:** migration 0024 adds `consensus_owner_decisions`, keyed by the proposal, so a second click or a replay is impossible.
  - **Window:** 24 hours. The scheduled supervisor cycle marks older proposals `expired`, and the agents must propose again.
  - **Mode:** if the mode has left `critical`, approval is refused.
- **Execution after approval.**
  1. The kernel asks the Policy Engine again (`stage: execute`). The new `owner_approved` check reads the owner decision row.
  2. The kernel executes through the owning path. That path re-runs `verifyConsensusExecution`, which now also requires the owner approval row for critical proposals.
  3. Every click and execution is audited under the person's identity.
- **Executors:**
  - `register_principal`: the kernel's own principal registry (`params.access_identity`).
  - `retire_worker`: the Deployment Orchestrator (`DeployRpc.retireForConsensus`) dispatches the existing Retire Worker workflow (`DELETE`). It does so only for a Worker that is disabled in the registry and is not an active deploy unit. The workflow keeps its own gates: the owner-curated `RETIRABLE` list, source gone from `main`, and the production Environment. D1 is never touched.
  - `retire_agent` (owner 2026-11-11, ADR-0013 §3): the kernel deletes an agent that no row refers to, or suspends it with a `retired:` reason. It refuses kernel agents, council seats and the exempt XAUUSD host. The supervisor proposes it for an agent idle 14 days.
- **Manual only:** `restore_d1_bookmark`, `rotate_secret`, `change_access` and `agents_enable`. They need credentials no Worker holds, or already have a direct approver control. The Console shows them in the queue with "carry it out by its runbook, then reject this proposal to close it", and the approve call returns `manual_only`.
- **Proposals:** the supervisor proposes one critical action automatically, `retire_agent` for an idle agent (2026-11-11); no other. When a supervisor rule or an agent proposes one in mode `critical`, it appears in the queue.
- **Console.** The Consensus screen has an **Owner Approval Queue**, with Approve and Reject buttons for approvers. Both use typed confirmations (`APPROVE <id13>`, `REJECT <id13>`). Two allow-list rows were added (37 in total), and the route table has 38 ids.
- **Deploy order:** the control plane first (it applies migration 0024, which every service's readiness now requires), then the Deployment Orchestrator (it adds `retireForConsensus`), then the Console.
- **Tests:** `test/consensus-phase4.test.ts`, 9 criteria:
  - the migration;
  - mode gating;
  - approve executes, with a fresh policy decision and an audit record;
  - reject;
  - person-only, the 24-hour expiry and manual-only actions;
  - mode change and the shared check;
  - retire guards and the dispatch;
  - HTTP approver-only;
  - expiry by the scheduled cycle.

  221 of 221 tests pass.

### Phase 4 code deployment, 2026-11-06

**DEPLOYED AND VERIFIED** (orchestrator), at `6450a7e` (#162). The mode is unchanged.

| Run | Result |
|---|---|
| Deploy Control Plane, run 42189109049 | Success. Migration 0024 applied. Dispatched at 08:38 UTC. |
| Deploy Deployment Orchestrator, run 42190053863 | Success (`retireForConsensus`). Dispatched at 08:46 UTC. |
| Deploy Console, run 42190181441 | Success (Owner Approval Queue). Dispatched at 08:47 UTC. |

**D1 check at 08:49 UTC:**
- the mode is `shadow`;
- the last migration is `0024_consensus_owner_approval.sql`;
- there are 0 owner decisions;
- there are 4 proposals, none pending or executed, and 0 consensus deployment requests;
- the kill switch is on;
- 0 services are drifted, and there are 0 critical reports.

All four phases are now coded and deployed behind the mode gate. The rollout continues by promotion only:
- `routine`: earliest review 2026-11-13, per the phase 1 criteria;
- then `deploy`;
- then `critical`.

Each promotion is a separate reviewed change, audited by pi and agy.

## Amendment 2026-11-06: autonomous recovery execution after the approval click

**Owner decision (2026-11-06):** "kenapa setelah approve, owner masih harus start and execution sampai finish? harusnya bisa autonomous setelah approved, cukup tunjukan progress pipeline dan semua running background by AI." (Why must the owner still start and finish execution after approving? After approval it should be autonomous; just show the pipeline progress, with everything running in the background by AI.)

- **One click.** The owner's approval is the only human step in a recovery plan. The plan's lifecycle Workflow (ADR-0006) no longer waits for a person to start or finish. When the plan becomes `approved`, the Workflow runs it (`workers/recovery-manager/src/autonomous.ts`):
  1. **Policy Engine** `recovery.execute`, with the subject `ai:recovery-manager`. The separation-of-duties and approval checks are unchanged. A deny or an outage fails the plan, and nothing runs.
  2. **Each step** runs through its owning path, and re-checks the live state first:
     - `redeploy_commit`: if the latest drift observation shows the service in sync, the step is **skipped**. A stale plan therefore never deploys an old commit. Otherwise the Deployment Orchestrator's `DeployRpc.deployForRecovery` dispatches the service's deploy workflow. The orchestrator first verifies three things: the plan is executing; the plan's own `recovery.execute` allow is at most 2 hours old; and the plan version is the current `main` with green CI. The Workflow then polls `runStatus` every 30 seconds, for up to 20 minutes. A failed deploy run has already rolled itself back (§3.3).
     - `disable_service` updates the registry, attributed to `recovery:<plan>`.
     - `manual` steps are notes for people and are covered by verification.
     - `rollback_worker_version`, `restore_d1_bookmark` and `rotate_secret` are **blocked**: they need credentials no Worker holds, so the owner carries them out by runbook.
  3. **Verification:** a fresh drift observation must show the service in sync and healthy. The Workflow waits up to 30 minutes for one.
  4. **Finish:** the plan is `completed` or `failed`. The finish is audited as `recovery.execution_finished` by `ai:recovery-manager`, and an agent report is published.

  A failed or blocked stage cancels the stages after it.
- **Pipeline.** Progress is stored in `last_execution_json.pipeline`. The Console's recovery page shows the stages, their status, durations, details and the deploy-run link. It polls every 4 seconds while the plan runs. The Start and Finish buttons are gone. Plans that a person started by hand before this change keep a Finish button, so they can be closed.
- **Unchanged:**
  - approval stays human, and an approver can never approve their own plan;
  - the lifecycle windows (72 h approval, 24 h execution) and the overdue alarm still apply;
  - the manual `executions` API remains for legacy plans;
  - this is independent of the consensus mode, because a person approved the plan.
- **Tests:** `test/recovery-autonomous.test.ts`, 8 criteria:
  - the full run, with the audit trail and the deploy dispatch;
  - a stale plan is skipped;
  - an old commit fails safely, and later stages are cancelled;
  - a failed deploy run fails the plan;
  - blocked steps, and `disable_service`;
  - a policy outage, and the orchestrator refusing a forged decision;
  - the legacy manual path;
  - the Console pipeline.

  229 of 229 tests pass.
- **Deploy order:**
  1. the Deployment Orchestrator (`deployForRecovery`, `runStatus`);
  2. the control plane (the Recovery Manager binds `DEPLOY`, and its readiness requires that binding);
  3. the Console.

## Amendment 2026-11-06: Wave A reliability (owner-approved plan "A, B, C")

- **A1, incremental audit verification.** Migration 0025 adds `audit_checkpoints`.
  - A full verification (Audit Ledger `/v1/verify`, the auditor, deploy verification) re-anchors the checkpoint.
  - Consensus evidence uses `verifyAuditChainIncremental`. It re-hashes the checkpointed event, verifies only newer events, and advances the checkpoint.
  - It falls back to a full pass when there is no checkpoint.
  - Tampering with the checkpointed event or any newer event is still detected, and a failed check never advances the checkpoint.
  - This removes the main cost of the roughly 25-second proposals.
- **A2, retries for the Access API.** The Access API calls in `resolve-access.sh`, `find-service-token.sh` and `provision-access.yml` retry transient errors: 5 retries, 10 seconds apart. On 2026-11-06 a single 503 had stopped three deploys.
- **A3, cron-window guard.** Every production deploy workflow runs `.github/scripts/wait-cron-window.sh` right before it deploys. The deploy starts only at a minute where no drift cron (:00/:15/:30/:45) or kernel cron (:07/:22/:37/:52) falls in the next 4 minutes or the previous minute. The guard covers every dispatch path: ops requests, consensus, autonomous recovery and people.
- **A4, deployment ledger.** The Deployment Orchestrator now has a cron at :11 and :41. It records each open `deployment_requests` row as `succeeded` or `failed` from its GitHub Actions run, fails requests that are stale after 3 hours, and audits `deployment.reconciled`.
- **Tests:** `test/wave-a-reliability.test.ts` (6) and `wait-cron-window.test.sh`. 235 of 235 tests pass.

## Amendment 2026-11-06: Wave B (rollback, owner notifications, shadow agreement)

- **B1, rollback to the previous recorded version.**
  - The new `.github/workflows/rollback-worker.yml` deploys an *existing* Worker version, found by its version tag. It runs under the cron guard, captures the current version, verifies the rolled-back version live through Access, records it as desired, and restores the captured version on failure. It requires `main` and the confirmation `ROLLBACK`.
  - The Deployment Orchestrator dispatches it for a recovery step (`rollbackForRecovery`) or a consensus action (`rollbackForConsensus`). Recovery steps get the same plan-and-decision checks as a redeploy. Consensus actions are re-verified as usual, and the proposed version must be the previous recorded one.
  - The target is always the version the registry recorded before the current one, taken from the audit trail.
  - `rollback_worker_version` now executes in mode `deploy`, and as a step of an approved recovery plan. In both cases the step is skipped when the service is already in sync.
- **B2, owner notifications.** `.github/workflows/owner-attention.yml` runs at :26 and :56. When recovery plans wait in draft or critical proposals wait in `pending_owner`, it opens or updates the issue "Owner approval needed", mentioning `@cryptophys-adm`, with links into the Console. It closes the issue when nothing waits. No new secret is needed.
- **B3, shadow agreement report.** `GET /v1/consensus/report?days=7` on the kernel, also shown in the Console's Consensus screen, scores every proposal against what people did afterwards:
  - `deploy_commit`: the registry recorded the commit within 24 hours;
  - redeploy or rollback: the service was back in sync within 2 hours;
  - other actions: a non-agent audit event on the target within 24 hours.

  Each proposal is classified as agree, false positive or false negative. This is the evidence for promotion out of shadow, reviewed no earlier than 2026-11-13.
- **Tests:** `test/wave-b-agreement.test.ts` (7) and `owner-attention.test.sh`. 248 of 248 tests pass.

## Amendment 2026-11-06: Wave C (supervisor rule, D1 backup, UI render in CI)

- **C2, suspending noisy agents.** In each scheduled cycle, the supervisor proposes `suspend_agent` for an agent outside the kernel that had 5 or more denied or failed syscalls in the last hour. This implements §3.2: repeated failures suspend the agent. There is at most one such proposal per cycle, and at most one per agent in 6 hours. The voters' rules still apply, and in `shadow` it is only recorded.
- **C3, nightly D1 backup.** `.github/workflows/d1-backup.yml` runs at 02:41 UTC. It exports `cryptophys-control-plane` with the existing D1 token, gzips it, records the size and sha256, and uploads it to the private R2 bucket `cryptophys-d1-backups`. Objects expire after 90 days. Backups are never stored as public workflow artifacts. **R2 is not yet enabled on the account.** Until the owner enables it in the dashboard (it is included in Workers Paid), each run ends with a warning that names the action.
  - *Amendment 2026-11-07 (owner: "fallback build internal cloudflare saja jika action github tidak bisa").* The owner enabled R2, but both GitHub tokens are refused for R2 (code 10000). The bucket was created through the operator's Cloudflare connection. A Cloudflare-native fallback now runs in the Recovery Manager (`src/backup.ts`, cron `13 * * * *`, R2 binding `BACKUPS`). It needs no API-token permission. Each hour it checks the bucket and, only when no backup is newer than 24 hours, writes a gzip SQL dump: schema, rows, then indexes, triggers and views. The key format is the same as the Action's (`control-plane/<UTC stamp>.sql.gz`), and the object metadata records `source`, `sha256`, `tables` and `rows`. Each write is audited as `backup.d1_written`. A working GitHub Action therefore stays the primary, and the fallback never duplicates it. The fallback never deletes anything. Retention (the 90-day lifecycle rule) is set by the Action once a token has R2 rights, or by the owner in the dashboard. Restore stays an owner decision.
  - *Amendment 2026-11-07, rate limits (owner: "perbaiki limit").* The Policy Engine's `target_rate_limit` (1 per action and target per hour) and `platform_daily_limit` (6 deploys or rollbacks per 24 hours) counted `shadow_passed` records in every mode. In mode deploy, the first real `deploy_commit` (13261d1, 8 of 8 approvals) was therefore denied by six shadow records from the day before, none of which had deployed anything. The checks now count only `executing` and `executed` once the mode executes. In shadow mode, shadow records still stand in for real actions, so the simulation stays faithful. The limits themselves are unchanged.
  - *Amendment 2026-11-07, validator finding #179.* A D1 Backup run that cannot write is now red, not a green skip. Only "R2 not enabled" (10042) remains a warning. An authentication refusal (10000) tries the other token, and every other error fails. The refused token is identified by its non-secret token ID.
  - *Amendment 2026-11-07, backup primary (owner: "B, karena kedepannya kita tidak bergantung Github").* Both GitHub tokens stayed refused for R2 (code 10000, token IDs `273bbc74…` and `cddd817f…`) although the owner reported granting R2 rights. The Recovery Manager's Cloudflare-native backup is now the **primary** daily backup. The first one was written 2026-11-07 02:14 UTC: `control-plane/2026-11-07T021355Z.sql.gz`, 692 KB, 27 tables, 13,680 rows. `d1-backup.yml` no longer has a schedule; it stays for an on-demand copy. A failed native backup is audited as `backup.d1_failed`. Retention (90 days) is an owner decision: an R2 lifecycle rule in the dashboard, or an explicitly approved deletion in the Worker.
  - *Amendment 2026-11-07, retention (owner chose option 1).* The owner added the R2 object lifecycle rule `expire-90d` (prefix `control-plane/`, delete 90 days after upload) to `cryptophys-d1-backups` in the dashboard, next to the bucket's default multipart-abort rule. Cloudflare deletes expired backups itself and no code deletes anything. D1 Time Travel still covers the last 30 days in place. The first autonomous `deploy_commit` (d9e4241, control plane, proposal `cns_701497e3`) executed the same day: 7 of 8 approvals, Policy allow, deploy run 42331386758 succeeded, and the ledger was reconciled as `succeeded` at 03:11 UTC.
- **C4, UI render in CI.** Validate Control Plane Workers renders every Console screen (12 routes) under the `/console/` mount, at 390 px and 1440 px, in Chromium (Playwright 1.63.0, a pinned dev dependency). It fails on page errors, failed requests, inline scripts, horizontal scroll or blank pages.
- **C1** (moving the votes into each Worker over RPC) follows as a separate change.
- **Tests:** `test/wave-c.test.ts`. 250 of 250 tests pass.
## Amendment 2026-11-06: Wave C, C1 (votes cast by each Worker over RPC)

This closes the phase 1 limitation, under which the voters ran inside the AI Kernel on a single snapshot.

- **The rules are shared.** The voting rules moved to `control-plane-shared/src/consensus-rules.ts`: pure functions with no I/O.
- **Each Worker votes.** The seven control-plane Workers each expose `VoteRpc.vote(voter, proposal, snapshot)`: Platform API, Deployment Orchestrator, Platform Registry, Policy Engine, Drift Detector, Audit Ledger and Recovery Manager. A Worker votes only as itself. Before applying its rule, it re-reads the facts it owns (`consensus-vote.ts`):
  - the Platform Registry reads the registry row;
  - the Drift Detector reads the last two observations;
  - the Policy Engine reads recent proposals for the same action and target;
  - the Audit Ledger runs an incremental chain verification;
  - the Recovery Manager reads the plans that are executing;
  - every Worker reads the kill switch.

  The kernel's snapshot is only a starting point.
- **The kernel tallies.** It calls the seven bindings in parallel. The kernel-hosted voters, supervisor and auditor, vote in the kernel.
  - A Worker that does not answer within 8 seconds, or answers out of shape, **abstains**, which counts against the proposal.
  - A Worker without a binding falls back to the kernel's rule.
  - Each proposal's evidence records `votes_via` (rpc, kernel, unreachable).
- **Deploy order:** Platform API and Deployment Orchestrator first, then the control plane. The control plane deploys the AI Kernel last, so every `VoteRpc` exists before the kernel binds to it.
- **Tests:** `test/wave-c1-votes.test.ts` (4).

## Amendment 2026-11-06: owner override, promotion to `deploy`

**Owner decision (2026-11-06), "Align + promote to deploy now".** The owner waives the 7-day shadow window of §6 and promotes the consensus to mode `deploy`. In mode `deploy`, agents execute these passed actions themselves:
- reversible routine actions: suspend and resume agents, registry changes, drift observation;
- deploys of CI-green `main` commits, and rollbacks to the previous recorded version.

The following still applies:
- the safety rails of §3: kill switch; one action per target per hour; 6 deploys or rollbacks per day; automatic rollback;
- the Policy Engine veto;
- re-verification by each target Worker.

Critical actions are only recorded until the mode is `critical`. The risk is accepted by the owner.

- **How the mode changes.** `POST /v1/consensus/mode` on the kernel, from the Console's Consensus screen.
  - **Raising** the mode needs an approver who is a person, with a typed confirmation `RAISE MODE`.
  - **Lowering** to `shadow` is an emergency brake that any operator may pull (`SHADOW`).
  - Every change is audited as `consensus.mode_changed`.

  Migrations never change the mode. Agents cannot change it, and the voters, rules and classes remain unchangeable (§1).
- **Deploy verification** now accepts any known mode, and fails when an execution has been `executing` for more than 30 minutes.
- **Tests:** `test/consensus-mode.test.ts` (3). 257 of 257 tests pass.

## Amendment 2026-11-10: council-adjustable policy parameters

Owner: "naikkan ke 10, buatkan PR, dan Policy Engine boleh dimodifikasi oleh cerebrum council"; asked how far, the owner chose "Parameter, consensus saja".

- The daily limit of executed deploys and rollbacks rises from 6 to 10. One executed action per action and target per hour stays.
- §1's "changing the rules is prohibited" is narrowed for two numeric parameters only. The council changes them with the routine consensus action `set_policy_parameter`, without an owner click:
  - `daily-deploy-limit`: default 10, hard bounds 1–20;
  - `target-actions-per-hour`: default 1, hard bounds 1–3.
- The hard bounds live in reviewed code (`control-plane-shared/src/policy-params.ts`), never in the database. A stored value outside them is clamped. Every vote rejects a value outside them, and the executor refuses it.
- Each change is written together with a `policy.parameter_changed` audit event.
- Everything else stays code and outside the council's reach: no trading or funds, the owner click for critical actions, the kill switch, mode shadow, Access, and the list of adjustable parameters itself.

## Amendment 2026-11-12: daily deploy bound raised to 40

Owner: "naikkan batas deploy harian". The limit already stood at its hard bound of 20, so moving the platform off GitHub (ADR-0012) waited hours for deploy slots: every Forge change has to be deployed before the next change can be checked by it.

- The hard bound of `daily-deploy-limit` rises from 1–20 to **1–40** (`control-plane-shared/src/policy-params.ts`). The default stays 10.
- Migration 0050 rebuilds `policy_parameters` with the table bound `value BETWEEN 1 AND 40` (it was 1–20) and keeps every row. The owner's value of **40** is then written in production with the owner as `updated_by`; fresh databases keep the seeded 10.
- Unchanged: one executed action per action and target per hour, deploys only at SAFE minutes, the Policy Engine veto, the owner click for critical actions, and the council's right to change the value by consensus, now within 1–40.

## Amendment 2026-11-12: trading allowed with the owner's click; fund movement still prohibited

Owner 2026-11-12: "larangan trading harus dicabut karena kita sudah masuk fase production". Asked which layers to lift, the owner chose "Trading boleh, dana tidak": trading is allowed, and every trading execution needs the owner's click; fund movement stays prohibited outright.

- **Fund movement stays prohibited**: wallets, withdrawals, transfers, deposits, payouts, signing transactions, swaps, MEV.
  - No agent, vote or owner click can do it.
  - `PROHIBITED_CAPABILITY` (`control-plane-shared/src/capabilities.ts`) now holds only these.
  - The Policy Engine vetoes any consensus resource that names them (`not_prohibited`).
- **Trading is allowed**: orders, brokers, exchange accounts (`TRADING_CAPABILITY`).
  - A trading consensus action is always **critical**: consensus, then one owner click. `classify` raises it to critical whatever its declared class. The Policy Engine vetoes a trading action of any other class (`trading_is_critical`).
  - A trading capability must be tier 2 or above (`trading_capability_privileged`). Registering one is privileged, so it needs the owner's click (`privilegedCapabilities`).
- **Only the action names trading.** The Policy Engine reads the action's name, not the target's, so a resource such as `register_engine:xauusd-ai-trading-assistant` is no trading action. This is what kept the XAUUSD AI tasks out of the engines registry (ADR-0013 §6). They now register by consensus like main's.
- **Nothing trades yet.**
  - The catalog has no trading capability, and `CONSENSUS_ACTIONS` has no trading action.
  - Either arrives only through a reviewed code change, and then only as critical.
  - Omega (the xauusd repository) keeps its own controls: the owner's settings and the EA's gates.
- **Unchanged:** the Console still never claims the platform moves funds (`console-truthfulness.test.ts` T1). The knowledge validator's rules for learned knowledge are not changed by this amendment.
- **Tests:** `trading-0009.test.ts` F1–F3. The updated tests are `ai-kernel.test.ts` (syscall checks), `consensus-phase1.test.ts` 5 and `organism-external-0013.test.ts` X4.

## Amendment 2026-11-13: an approver acknowledges a critical report

Owner 2026-11-13, asked how to release the brake held by one handled critical report: "Tambah tombol 'acknowledge'" (add an acknowledge button). The report was `rpt_4c0738b9-…` ("Deploy of control-plane at 8cc865b9d77b failed", 2026-11-12 23:25 UTC). Its cause was fixed and live, and production was unchanged. Even so, every voter rejected routine actions for 24 hours, autonomous deploys and engine registrations included, and nothing could close the report.

- **What counts as open.** The baseline rule is unchanged: "a critical report is open in the last 24 h", threshold `> 0` (`control-plane-shared/src/consensus-rules.ts`). A critical report now counts as open only while no approver has acknowledged it.
  - `observe()` (`ai-kernel/src/syscall.ts`) leaves acknowledged reports out of `counts.critical`, `latest_critical`, `critical_fingerprint` and `latest_attention`. It adds `counts.critical_acknowledged`, the number acknowledged in the window.
  - The evidence the voters read (`critical_reports_24h`) follows `counts.critical`. The owner notice `critical_reports` also counts open reports only, so it closes once every one is acknowledged.
  - An unacknowledged critical report blocks exactly as before.
- **Who.** Only an approver who is a person can acknowledge: `POST /v1/reports/{rpt_id}/acknowledge` on the AI Kernel, checked with `requireApprover`. Operators, service tokens and agents get 403, and no agent or consensus action can acknowledge.
  - The body is `{ confirm: "ACKNOWLEDGE {id13}", reason }`. `{id13}` follows the Console convention: the first 13 characters without a trailing separator, so `ACKNOWLEDGE rpt_4c0738b9`.
  - `reason` must be 10–500 characters.
  - Only a report of severity `critical` can be acknowledged: a warning or info gets 409 `not_critical`, because those never block. An unknown report gets 404.
- **Audit and idempotency.** The acknowledgement (migration 0053, `agent_report_acknowledgements`, one row per report, reason bounded by a CHECK) and its `report.acknowledged` audit event commit in one D1 batch (`appendAuditEventWithMutation`).
  - The event's subject is `report:<id>` and its actor is the approver. Its payload holds report_id, agent_id, kind, subject and reason.
  - A repeat returns the existing acknowledgement with 200 and writes no second event. A concurrent duplicate fails its audit insert, so it commits nothing.
- **Fails closed.**
  - Before migration 0053 is applied, nothing reads as acknowledged, and every critical report keeps counting.
  - The brake no longer opens when the reports query fails. Before this amendment, a failed query read as zero critical reports and lifted the brake. The consensus evidence now counts one open critical report when the overview is missing, has `error`, or has no numeric critical count (`openCriticalReports` in `ai-kernel/src/consensus.ts`).
- **Console.** The Cognition page lists the critical reports from `GET /v1/reports`, which now carries `acknowledgement: {acknowledged_by, reason, acknowledged_at} | null`. For an approver, each unacknowledged report has a required reason field and an "Acknowledge…" action with the typed phrase. Everyone sees "Acknowledged by … at …". The Console's allow-list grows to 60 rows.
- **Unchanged.**
  - The rule text, the threshold, the 24-hour window and the voters.
  - The kill switch and the audit-chain check of the baseline. An acknowledged report of an invalid chain does not lift the `audit_valid` check.
  - The report itself, which is never edited or deleted.
  - The overview's own fallback (`error: "reports_unavailable"`, counts 0), which only the dashboards display; the brake reads it as one open report (above).
- **Tests.** `report-acknowledge.test.ts` (A1–A7) and the 0053 block of `test_migrations.py`. The updated tests are `reports-overview-tp015.test.ts` (the new counter) and `console-tp023`/`console-tp024` (route counts).

## Amendment 2026-11-13: one owner panel; the owner is contacted only for approvals and critical reports

Owner 2026-11-13: "Pastikan semua loop ini apakah juga perlu Human Ai Interaction Panel? Batasi User/Owner hanya untuk critical dan permintaan approval only." (Check whether each of these loops needs a human–AI interaction panel. Limit the user/owner to critical items and approval requests only.) Every loop that needs a person now surfaces in one Console panel, and the owner is contacted only for (1) critical reports and (2) approval requests.

- **The human-in-the-loop items in the code today, and where they land.**
  - *Waiting for your approval* (owner notice `owner_attention`):
    - recovery plans in `draft` (Recovery Manager; approve, or disable; the author cannot approve their own plan);
    - critical consensus proposals in `pending_owner` (§ phase 4; approve when the platform has an executor and the mode is `critical`, otherwise carry out by runbook and reject; 24-hour window);
    - learned-knowledge proposals in `pending` (TP-028; approve for shadow testing, or reject; 14-day window).
  - *Open critical reports* (owner notice `critical_reports`): unacknowledged critical agent reports of the last 24 hours. Each blocks routine consensus until an approver acknowledges it (amendment above).
  - *Owner-initiated controls, not requests:* raising the consensus mode, turning agents back on after the kill switch, resuming a suspended agent, registering or revoking a principal, creating a recovery plan by hand, service records and desired versions, accounts, the Forge spikes. They stay on their pages; nothing asks the owner for them, so they are not in the panel.
- **The owner channel.** `OWNER_CHANNEL_TOPICS = ["owner_attention", "critical_reports"]` (`ai-kernel/src/owner-notices.ts`). Only these are emailed to `APPROVER_IDENTITIES` and sent to the owner's Telegram; until now only `owner_attention` went to Telegram, and every topic was emailed.
  - `drift`, `organism`, `build_minutes`, `dependencies`, and any topic added later, are console-only. They are still computed at :22 and :52, still recorded with the same `owner.notice_opened|changed|closed` audit events (delivery `console_only`, never retried), and still served by `GET /v1/notices`. Each notice there now carries `channel: "owner" | "console"`, and the response lists `owner_channel_topics`. The Command page shows the channel next to each notice.
  - A closed owner-channel notice still sends one "Resolved" message.
  - Every owner email and Telegram message links to the Owner page (`…/console/#/owner`), not to a per-kind page; the lines no longer carry per-item links.
- **The Owner page (`#/owner`, first in the Console nav).** It reads one endpoint, `GET /v1/owner/inbox` on the AI Kernel (`ai-kernel/src/owner-inbox.ts`): operator-readable, read-only (no expiry sweep, no write), one allow-listed GET (the Console's allow-list grows to 61 rows, the UI route table to 62). The owner notices read the same functions (`pendingApprovals`, `openCriticalReportRows`), so an email, a Telegram message and the panel list the same items.
  - Two sections only: "Waiting for your approval" (plans, critical proposals with the consensus mode and whether the platform can execute them, knowledge proposals) and "Open critical reports" (the Cognition page's list, `CriticalReportList` in `CriticalReports.tsx`, with acknowledge for approvers). When both are empty it says "Nothing needs you".
  - Every action reuses its existing approver-only route and typed phrase (`recovery.approve`, `recovery.disable`, `kernel.consensus_approve|reject`, `kernel.knowledge_approve|reject`, `kernel.report_acknowledge`); the servers check the role again. Operators and viewers see the page read-only. Disabling a plan, which operators may do on the Recovery page, is shown here to approvers only.
  - One secondary line links to the pages that show the console-only notices; the page has no other counts or alerts.
- **Why dropping the drift, organism, build-minute and dependency emails is safe for production.** A broken service is handled by the agents, and when the handling needs a person it becomes an approval, which is on the owner channel:
  1. The Drift Detector observes every registered service every 15 minutes. A drifted or unhealthy service seen twice in a row is persistent (`ai-kernel/src/syscall.ts:83`).
  2. For a persistent drift of a managed service with no open agent plan, the Supervisor proposes a recovery plan (`ai-kernel/src/supervisor.ts:233–251`, syscall `recovery.propose`, tier 1, "a human approver must approve it", `control-plane-shared/src/capabilities.ts:27`). The Recovery Manager stores it in `draft` (`recovery-manager/src/index.ts:132` `proposeFromAgent`, `:159` the insert). A draft plan opens `owner_attention`, so the owner is emailed and messaged.
  3. In parallel the Supervisor proposes `redeploy_desired_version` to consensus (`supervisor.ts:254–261`); in mode `deploy` it executes without the owner. A failed native deploy or rollback publishes a critical report (`deployment-orchestrator/src/index.ts:875`), which is on the owner channel. An approved plan whose execution never finishes publishes a critical report (`recovery-manager/src/lifecycle.ts:84–85`). An invalid audit chain does too (`audit-ledger/src/index.ts:127`, `ai-kernel/src/auditor.ts:226`).
- **Cases where something broken reaches the owner through neither an approval nor a critical report** (found in the code; reported, not changed by this amendment):
  1. *The AI Kernel itself.* The Supervisor skips its own Worker (`supervisor.ts:233`, `s.service_id === SERVICE`), and the Drift Detector's report is a warning (`drift-detector/src/index.ts:254–255`). A drifted or unhealthy `cryptophys-ai-kernel` gets no plan and no critical report; it was reached only by the `drift` email. (When the kernel is down, no notice runs at all, as before.)
  2. *A stopped Drift Detector.* Stale, missing or invalid observations are lines of the `drift` notice only. The Supervisor's evidence treats a stale in-sync observation as in sync, and the Drift Detector reports itself healthy (`drift-detector/src/index.ts:204–205`). No plan, no critical report.
  3. *Agents off (kill switch) or a refused `recovery.propose`.* The Supervisor does not run, or the proposal is denied or the Recovery Manager is unreachable (`supervisor.ts:218`, `:246`). The drift persists with no plan and no critical report. The kill switch is a person's decision; the refused proposal is retried each cycle.
  4. *A failed or expired recovery.* An autonomous recovery that fails publishes a warning (`recovery-manager/src/autonomous.ts:265–266`), and an expired plan a warning (`lifecycle.ts:100–101`). The Supervisor proposes again only after its 24-hour cooldown (`supervisor.ts:32`, `:238`), so a broken service can wait up to 24 hours before a new approval reaches the owner.
  5. *Not production outages, but no longer emailed:* organism findings that need the owner (a council seat, a privileged agent) become critical proposals, which reach `pending_owner` only in mode `critical` (`ai-kernel/src/consensus.ts:214`); in today's mode `deploy` they are recorded as `shadow_passed` and the owner is not asked. High or critical npm advisories and a Workers Builds month near or over budget have no approval or critical path either. All of them stay visible in the Console.
- **What still contacts the owner outside the two topics.** Nothing in this repository's Workers: the owner notices are the only sender (`send_email` binding `OWNER_EMAIL`, Service Binding `OWNER_TELEGRAM`). Outside it: GitHub's own notifications (workflow runs, pull requests), Cloudflare's account emails, and whatever the xauusd Worker's Telegram bot sends on its own (another repository).
- **Unchanged.** The topics, their fingerprints and audit events; the Console pages that show the console-only notices; every approval and acknowledgement rule.
- **Tests.** `owner-notices-0012.test.ts` (O9 now asserts no email or Telegram for `organism`; O11 the four console-only topics, audited, channel `console`, never delivered or retried; O12 `critical_reports` by email and Telegram with the Owner page link and a Resolved message; O2 and O10 the Owner page link), `owner-inbox.test.ts` (I1 the endpoint and its parity with the notices, I2 the Console wiring), `forge-build-usage` U4 and `forge-dependency-audit-g5` G5-6 (channel `console`), `console-tp023`/`console-tp024` (route counts), and the render smoke (the Owner page as approver, operator and empty).
