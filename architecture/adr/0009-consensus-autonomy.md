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
- **Unchanged:** ADR-0005's prohibition on trading. No agent, consensus or owner click can place orders, touch exchange accounts or wallets, or move funds.

## Context

The platform runs on Cloudflare. Today the AI Kernel lets agents observe (tier 0) and propose (tier 1), and a person approves or runs every change. The owner's intent, carried over from the original Cryptophys AI mesh, is the reverse: agents do the work and agree among themselves, and the owner is interrupted only for critical decisions.

## Decision

### 1. Action classes

| Class | Examples | Who decides |
|---|---|---|
| **Routine** (consensus executes) | Observe drift; publish reports; rollback a Worker to a recorded healthy version; redeploy a commit; **deploy a new commit from `main` whose CI is green**; set a registry desired version; update registry metadata; suspend or resume an agent (not a kernel-hosted one); disable or enable a service in the registry; create, approve and execute recovery plans whose steps are all routine | Simple majority of eligible voters, plus a Policy Engine allow |
| **Critical** (consensus, then an owner click) | Restore or delete D1 data (`restore_d1_bookmark`, retention changes); create, rotate or delete secrets and Access tokens (`rotate_secret`); retire or delete a Worker; change Cloudflare Access; turn the global kill switch back **on** after a stop; register external agent principals | Consensus as above, **and** one owner/approver click in the Console |
| **Prohibited** | Orders, trading, exchange accounts, wallets, fund movements; disabling the kill switch mechanism itself; changing the consensus rules, voter set or action classes | Nobody. Changing the rules needs a new ADR and a reviewed code change |

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

- **Executable in phase 2** (`PHASE2_EXECUTABLE` in `workers/ai-kernel/src/consensus.ts`): `observe_drift`, `set_desired_version`, `registry_disable_service`, `registry_enable_service`, `suspend_agent`, `resume_agent`. All are reversible by the opposite action.
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
- **Manual only:** `restore_d1_bookmark`, `rotate_secret`, `change_access` and `agents_enable`. They need credentials no Worker holds, or already have a direct approver control. The Console shows them in the queue with "carry it out by its runbook, then reject this proposal to close it", and the approve call returns `manual_only`.
- **Proposals:** the supervisor proposes no critical action automatically yet. When a supervisor rule or an agent proposes one in mode `critical`, it appears in the queue.
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
