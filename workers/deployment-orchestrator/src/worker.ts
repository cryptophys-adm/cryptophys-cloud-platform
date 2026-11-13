/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point: the Access-gated HTTP handler, the DeploymentLock Durable Object,
// and the RPC health entrypoint used by the Drift Detector.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { accessForConsensus, accessPlanSummary, DeploymentLock, deployForConsensus, deployForRecovery, pendingDeploys, requestStatus, retireForConsensus, rollbackForConsensus, rollbackForRecovery, runStatus, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import { castDomainVote } from "../../control-plane-shared/src/consensus-vote.ts";
import { resolveSecrets } from "../../control-plane-shared/src/secrets.ts";
import type { Evidence, Proposal, Vote } from "../../control-plane-shared/src/consensus-rules.ts";

/** Secrets that may come from Cloudflare Secrets Store (ADR-0012 §4): bindings GH_ACTIONS_TOKEN_STORE, CF_DEPLOY_TOKEN_STORE. */
export const STORE_SECRETS = ["GH_ACTIONS_TOKEN", "CF_DEPLOY_TOKEN"] as const;
const resolved = (env: Env) => resolveSecrets(env, STORE_SECRETS);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return worker.fetch(request, await resolved(env));
  },
  async scheduled(event: Parameters<typeof worker.scheduled>[0], env: Env, ctx: Parameters<typeof worker.scheduled>[2]): Promise<void> {
    return worker.scheduled(event, await resolved(env), ctx);
  },
};
export { DeploymentLock };

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/** ADR-0009 phase 3: the AI Kernel reads pending deploys and runs passed deploy_commit actions here. */
export class DeployRpc extends WorkerEntrypoint<Env> {
  async pendingDeploys() {
    return pendingDeploys(await resolved(this.env));
  }
  async deployForConsensus(proposalId: string, decisionId: string, target: string, params: Record<string, unknown>) {
    return deployForConsensus(await resolved(this.env), proposalId, decisionId, target, params);
  }
  /** ADR-0012 G6 gate 9: the Access plan, read only (for the Supervisor). */
  async accessPlan() {
    return accessPlanSummary(await resolved(this.env));
  }
  /** ADR-0012 G6 gate 9: an owner-approved change_access. */
  async accessForConsensus(proposalId: string, decisionId: string, digest: string) {
    return accessForConsensus(await resolved(this.env), proposalId, decisionId, digest);
  }
  async retireForConsensus(proposalId: string, decisionId: string, target: string) {
    return retireForConsensus(await resolved(this.env), proposalId, decisionId, target);
  }
  /** Autonomous recovery: the Recovery Manager's lifecycle Workflow runs an approved plan's redeploy step. */
  async deployForRecovery(planId: string, decisionId: string, serviceId: string, version: string) {
    return deployForRecovery(await resolved(this.env), planId, decisionId, serviceId, version);
  }
  async runStatus(workflow: string, commitSha: string) {
    return runStatus(await resolved(this.env), workflow, commitSha);
  }
  /** ADR-0012 G2c-1: a native deploy or rollback the recovery step queued, followed by request id. */
  async requestStatus(requestId: string) {
    return requestStatus(await resolved(this.env), requestId);
  }
  /** Wave B: roll back to the previous recorded version, for a recovery step or a consensus action. */
  async rollbackForRecovery(planId: string, decisionId: string, serviceId: string) {
    return rollbackForRecovery(await resolved(this.env), planId, decisionId, serviceId);
  }
  async rollbackForConsensus(proposalId: string, decisionId: string, target: string, params: Record<string, unknown>) {
    return rollbackForConsensus(await resolved(this.env), proposalId, decisionId, target, params);
  }
}

/**
 * Wave C (C1): this Worker's own consensus vote, from its own reads of its domain. The AI Kernel
 * calls it for every proposal; it votes only as "deployment-orchestrator".
 */
export class VoteRpc extends WorkerEntrypoint<Env> {
  async vote(voter: string, proposal: Proposal, snapshot: Evidence): Promise<Vote> {
    if (voter !== "deployment-orchestrator") throw new Error("wrong_voter");
    return castDomainVote(this.env.DB as never, voter, proposal, snapshot);
  }
}
