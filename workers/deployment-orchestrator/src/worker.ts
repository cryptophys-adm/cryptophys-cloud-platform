/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point: the Access-gated HTTP handler, the DeploymentLock Durable Object,
// and the RPC health entrypoint used by the Drift Detector.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { DeploymentLock, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";

export default worker;
export { DeploymentLock };

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}
