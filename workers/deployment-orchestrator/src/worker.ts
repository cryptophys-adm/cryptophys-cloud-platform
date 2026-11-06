/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point: the Access-gated HTTP handler, the DeploymentLock Durable Object,
// and the RPC health entrypoint used by the Drift Detector.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { DeploymentLock, deployForConsensus, deployForRecovery, pendingDeploys, retireForConsensus, rollbackForConsensus, rollbackForRecovery, runStatus, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";

export default worker;
export { DeploymentLock };

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/** ADR-0009 phase 3: the AI Kernel reads pending deploys and runs passed deploy_commit actions here. */
export class DeployRpc extends WorkerEntrypoint<Env> {
  async pendingDeploys() {
    return pendingDeploys(this.env);
  }
  async deployForConsensus(proposalId: string, decisionId: string, target: string, params: Record<string, unknown>) {
    return deployForConsensus(this.env, proposalId, decisionId, target, params);
  }
  async retireForConsensus(proposalId: string, decisionId: string, target: string) {
    return retireForConsensus(this.env, proposalId, decisionId, target);
  }
  /** Autonomous recovery: the Recovery Manager's lifecycle Workflow runs an approved plan's redeploy step. */
  async deployForRecovery(planId: string, decisionId: string, serviceId: string, version: string) {
    return deployForRecovery(this.env, planId, decisionId, serviceId, version);
  }
  async runStatus(workflow: string, commitSha: string) {
    return runStatus(this.env, workflow, commitSha);
  }
  /** Wave B: roll back to the previous recorded version, for a recovery step or a consensus action. */
  async rollbackForRecovery(planId: string, decisionId: string, serviceId: string) {
    return rollbackForRecovery(this.env, planId, decisionId, serviceId);
  }
  async rollbackForConsensus(proposalId: string, decisionId: string, target: string, params: Record<string, unknown>) {
    return rollbackForConsensus(this.env, proposalId, decisionId, target, params);
  }
}
