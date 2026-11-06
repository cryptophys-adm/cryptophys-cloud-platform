/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP traffic goes to the Access-gated handler in index.ts. Other
// platform Workers use the RPC entrypoints below through service bindings; they are not
// reachable over HTTP, so internal calls need no bearer token and no hostname exception.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { decide, parsePolicyRequest, type Env, type PolicyDecision } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import { castDomainVote } from "../../control-plane-shared/src/consensus-vote.ts";
import type { Evidence, Proposal, Vote } from "../../control-plane-shared/src/consensus-rules.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/** Deterministic policy decisions for other Workers (e.g. the Recovery Manager). Persisted and audited. */
export class PolicyRpc extends WorkerEntrypoint<Env> {
  async evaluate(input: Record<string, unknown>): Promise<PolicyDecision> {
    const parsed = parsePolicyRequest(input ?? {});
    if (parsed instanceof Error) throw new Error(`invalid_request: ${parsed.message}`);
    return decide(this.env, parsed);
  }
}

/**
 * Wave C (C1): this Worker's own consensus vote, from its own reads of its domain. The AI Kernel
 * calls it for every proposal; it votes only as "policy-engine".
 */
export class VoteRpc extends WorkerEntrypoint<Env> {
  async vote(voter: string, proposal: Proposal, snapshot: Evidence): Promise<Vote> {
    if (voter !== "policy-engine") throw new Error("wrong_voter");
    return castDomainVote(this.env.DB as never, voter, proposal, snapshot);
  }
}
