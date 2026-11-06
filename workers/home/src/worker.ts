/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { homeHealth, type Env } from "./index.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<ReturnType<typeof homeHealth>> {
    return homeHealth(this.env);
  }
}
