// Minimal typing for the Workers runtime module used by the RPC entrypoints.
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected env: Env;
    protected ctx: unknown;
    constructor(ctx: unknown, env: Env);
  }
  export abstract class DurableObject<Env = unknown> {
    protected env: Env;
    protected ctx: { storage: { get<T = unknown>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> } };
    constructor(ctx: unknown, env: Env);
  }
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    protected ctx: unknown;
    constructor(ctx: unknown, env: Env);
    abstract run(event: { payload: Readonly<Params>; timestamp: Date; instanceId: string }, step: unknown): Promise<unknown>;
  }
}
