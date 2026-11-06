/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP traffic goes to the Access-gated handler in index.ts; other
// platform Workers reach this one only through the RPC entrypoint below (service binding
// with entrypoint = "HealthRpc"), which is not reachable over HTTP. RecoveryPlanWorkflow is
// the per-plan lifecycle Workflow (ADR-0006); it is not reachable over HTTP either.
import { WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
import worker, { proposeFromAgent, type Env } from "./index.ts";
import { runLifecycle, type LifecycleParams } from "./lifecycle.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import type { WorkflowStepLike } from "../../control-plane-shared/src/types.ts";
import { verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";
import { castDomainVote } from "../../control-plane-shared/src/consensus-vote.ts";
import type { Evidence, Proposal, Vote } from "../../control-plane-shared/src/consensus-rules.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/**
 * Tier 1 syscall target for the AI Kernel (ADR-0007): an agent may only create a draft plan.
 * Bound only by cryptophys-ai-kernel, after the Policy Engine allowed recovery.propose.
 */
export class RecoveryRpc extends WorkerEntrypoint<Env> {
  async propose(agentId: string, decisionId: string, input: Record<string, unknown>) {
    await verifySyscallDecision(this.env.DB, decisionId, agentId, "recovery.propose");
    return proposeFromAgent(this.env, agentId, input ?? {});
  }
}

export class RecoveryPlanWorkflow extends WorkflowEntrypoint<Env, LifecycleParams> {
  async run(event: { payload: Readonly<LifecycleParams>; instanceId: string }, step: unknown) {
    return runLifecycle(this.env, event.payload.plan_id, event.instanceId, step as WorkflowStepLike);
  }
}

/**
 * Wave C (C1): this Worker's own consensus vote, from its own reads of its domain. The AI Kernel
 * calls it for every proposal; it votes only as "recovery-manager".
 */
export class VoteRpc extends WorkerEntrypoint<Env> {
  async vote(voter: string, proposal: Proposal, snapshot: Evidence): Promise<Vote> {
    if (voter !== "recovery-manager") throw new Error("wrong_voter");
    return castDomainVote(this.env.DB as never, voter, proposal, snapshot);
  }
}
