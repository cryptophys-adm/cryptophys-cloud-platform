/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// The Durable Object in front of the type-check Container (ADR-0012 §5c; wrangler.toml [[containers]]).
// Its logic lives in typecheck.ts (forwardTypecheck) so tests can run it without the Workers runtime.
import { DurableObject } from "cloudflare:workers";
import { forwardTypecheck, type ContainerApi } from "./typecheck.ts";

export class TypecheckContainer extends DurableObject<unknown> {
  async fetch(request: Request): Promise<Response> {
    return forwardTypecheck((this.ctx as unknown as { container?: ContainerApi }).container, request);
  }
}
