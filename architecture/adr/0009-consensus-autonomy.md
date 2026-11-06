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
