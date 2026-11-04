/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP traffic goes to the Access-gated handler in index.ts; other
// platform Workers reach this one only through the RPC entrypoint below (service binding
// with entrypoint = "HealthRpc"), which is not reachable over HTTP. SignalIngestWorkflow runs
// the scheduled ingestion (ADR-0006); it is not reachable over HTTP either.
import { WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
import worker, { ingest, type Env, type IngestParams } from "./index.ts";
import { runIngest } from "./ingest-workflow.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import type { WorkflowStepLike } from "../../control-plane-shared/src/types.ts";
import { verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/**
 * Tier 2 syscall target for the AI Kernel (ADR-0007): one extra ingestion pass. Writes are
 * idempotent (INSERT OR IGNORE on closed candles), so the action is reversible by nature.
 */
export class SignalRpc extends WorkerEntrypoint<Env> {
  async reingest(agentId: string, decisionId: string) {
    if (!/^[a-z0-9-]{2,40}$/.test(agentId)) throw new Error("invalid_request: agent_id");
    await verifySyscallDecision(this.env.DB, decisionId, agentId, "signals.reingest");
    const run = await ingest(this.env, Date.now(), "agent");
    return { run_id: run.run_id, series: run.series.length, failed: run.failed };
  }
}

export class SignalIngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  async run(event: { payload: Readonly<IngestParams>; instanceId: string }, step: unknown) {
    return runIngest(this.env, event.payload, event.instanceId, step as WorkflowStepLike);
  }
}
