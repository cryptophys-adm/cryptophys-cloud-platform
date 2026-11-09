/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP traffic goes to the Access-gated handler in index.ts; other
// platform Workers reach this one only through the RPC entrypoint below (service binding
// with entrypoint = "HealthRpc"), which is not reachable over HTTP.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { applyConsensus, recordRollback, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import { castDomainVote } from "../../control-plane-shared/src/consensus-vote.ts";
import { resolveSecrets } from "../../control-plane-shared/src/secrets.ts";
import type { Evidence, Proposal, Vote } from "../../control-plane-shared/src/consensus-rules.ts";

/** Secrets that may come from Cloudflare Secrets Store (ADR-0012 §4): binding ACCESS_GROUPS_TOKEN_STORE. */
export const STORE_SECRETS = ["ACCESS_GROUPS_TOKEN"] as const;
const resolved = (env: Env) => resolveSecrets(env, STORE_SECRETS);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return worker.fetch(request, await resolved(env));
  },
};

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/** ADR-0009 phase 2: the AI Kernel applies passed consensus actions here; applyConsensus re-verifies them. */
export class RegistryRpc extends WorkerEntrypoint<Env> {
  async applyConsensus(proposalId: string, decisionId: string, action: string, target: string, params: Record<string, unknown>) {
    return applyConsensus(await resolved(this.env), proposalId, decisionId, action, target, params);
  }
  /** ADR-0012 phase 2: the Orchestrator's native rollback records the version it verified live. */
  async recordRollback(requestId: string) {
    return recordRollback(this.env, requestId);
  }
}

/**
 * Wave C (C1): this Worker's own consensus vote, from its own reads of its domain. The AI Kernel
 * calls it for every proposal; it votes only as "platform-registry".
 */
export class VoteRpc extends WorkerEntrypoint<Env> {
  async vote(voter: string, proposal: Proposal, snapshot: Evidence): Promise<Vote> {
    if (voter !== "platform-registry") throw new Error("wrong_voter");
    return castDomainVote(this.env.DB as never, voter, proposal, snapshot);
  }
}
