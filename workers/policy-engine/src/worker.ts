/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP traffic goes to the Access-gated handler in index.ts. Other
// platform Workers use the RPC entrypoints below through service bindings; they are not
// reachable over HTTP, so internal calls need no bearer token and no hostname exception.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { decide, parsePolicyRequest, type Env, type PolicyDecision } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";

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
