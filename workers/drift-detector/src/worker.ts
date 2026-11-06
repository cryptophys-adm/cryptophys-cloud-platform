/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP traffic goes to the Access-gated handler in index.ts; other
// platform Workers reach this one only through the RPC entrypoint below (service binding
// with entrypoint = "HealthRpc"), which is not reachable over HTTP.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { observeForConsensus, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/** ADR-0009 phase 2: the AI Kernel runs a passed observe_drift action here; it is re-verified. */
export class DriftRpc extends WorkerEntrypoint<Env> {
  async observeForConsensus(proposalId: string, decisionId: string) {
    return observeForConsensus(this.env, proposalId, decisionId);
  }
}
