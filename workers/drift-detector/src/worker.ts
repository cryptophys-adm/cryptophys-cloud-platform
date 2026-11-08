/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP traffic goes to the Access-gated handler in index.ts; other
// platform Workers reach this one only through the RPC entrypoint below (service binding
// with entrypoint = "HealthRpc"), which is not reachable over HTTP.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { observeForConsensus, probeService, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import { castDomainVote } from "../../control-plane-shared/src/consensus-vote.ts";
import type { Evidence, Proposal, Vote } from "../../control-plane-shared/src/consensus-rules.ts";

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
  /** ADR-0012 phase 2: read-only health and version of one platform Worker (rollback verification). */
  async probeService(serviceId: string) {
    return probeService(this.env, serviceId);
  }
}

/**
 * Wave C (C1): this Worker's own consensus vote, from its own reads of its domain. The AI Kernel
 * calls it for every proposal; it votes only as "drift-detector".
 */
export class VoteRpc extends WorkerEntrypoint<Env> {
  async vote(voter: string, proposal: Proposal, snapshot: Evidence): Promise<Vote> {
    if (voter !== "drift-detector") throw new Error("wrong_voter");
    return castDomainVote(this.env.DB as never, voter, proposal, snapshot);
  }
}
