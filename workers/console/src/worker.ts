/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point: the Access-gated HTTP handler and the RPC health entrypoint used by
// the Drift Detector (service binding with entrypoint = "HealthRpc").
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { consoleHealth, type Env } from "./index.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<ReturnType<typeof consoleHealth>> {
    return consoleHealth(this.env);
  }
}
