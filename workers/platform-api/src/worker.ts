/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point: the Access-gated HTTP handler and the RPC health entrypoint used by
// the Drift Detector (service binding with entrypoint = "HealthRpc").
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { platformHealth, type Env } from "./index.ts";
import { castDomainVote } from "../../control-plane-shared/src/consensus-vote.ts";
import type { Evidence, Proposal, Vote } from "../../control-plane-shared/src/consensus-rules.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<ReturnType<typeof platformHealth>> {
    return platformHealth(this.env);
  }
}

/**
 * Wave C (C1): this Worker's own consensus vote, from its own reads of its domain. The AI Kernel
 * calls it for every proposal; it votes only as "platform-api".
 */
export class VoteRpc extends WorkerEntrypoint<Env> {
  async vote(voter: string, proposal: Proposal, snapshot: Evidence): Promise<Vote> {
    if (voter !== "platform-api") throw new Error("wrong_voter");
    return castDomainVote(this.env.DB as never, voter, proposal, snapshot);
  }
}
