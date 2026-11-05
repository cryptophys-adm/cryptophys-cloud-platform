/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP (API and MCP) goes to the Access-gated handler in index.ts.
// SupervisorAgent is the supervisor agent process (a SQLite-backed Durable Object); it is not
// reachable over HTTP. HealthRpc lets the Drift Detector observe this Worker.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import worker, { type Env } from "./index.ts";
import { runAuditCycle, AuditorCycleQueue } from "./auditor.ts";
import { runSignalCycle, SignalAnalystCycleQueue } from "./signal-analyst.ts";
import { runCycle, SerialCycleQueue, type CycleReport } from "./supervisor.ts";
import { observe, syscall } from "./syscall.ts";
import { CAPABILITIES, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { healthBody, type HealthBody, type JsonObject } from "../../control-plane-shared/src/http.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/** Read-only kernel view for the Platform API gateway (GET /v1/overview) and RPC agent entrypoints for in-account Workers. */
export class KernelRpc extends WorkerEntrypoint<Env> {
  async overview() {
    return observe(this.env);
  }

  async agentWhoami(agentId: string): Promise<JsonObject> {
    const agent = await getAgent(this.env.DB, agentId);
    if (!agent) return { error: "agent_not_registered" };
    const capabilities = JSON.parse(agent.capabilities_json) as string[];
    return {
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      host_worker: agent.host_worker,
      status: agent.status,
      tier_max: agent.tier_max,
      access_identity: `rpc:${agent.host_worker}`,
      capabilities: capabilities.map((c) => ({ capability: c, tier: CAPABILITIES[c]?.tier ?? null })),
    };
  }

  async agentObserve(agentId: string, capability: string, input: JsonObject = {}): Promise<JsonObject> {
    const cap = Object.hasOwn(CAPABILITIES, capability) ? CAPABILITIES[capability] : undefined;
    if (!cap || cap.tier !== 0) {
      return { outcome: "denied", capability, reason: "agent_observe_requires_tier_0" };
    }
    return (await syscall(this.env, agentId, capability, input)) as unknown as JsonObject;
  }

  async agentSyscall(agentId: string, capability: string, input: JsonObject = {}): Promise<JsonObject> {
    const agent = await getAgent(this.env.DB, agentId);
    if (!agent) return { outcome: "denied", capability, reason: "agent_not_registered" };
    if (agent.tier_max > 1) return { outcome: "denied", capability, reason: "external_tier_limit" };
    return (await syscall(this.env, agentId, capability, input)) as unknown as JsonObject;
  }
}

/** One agent process: cycles are serialized by the Durable Object, memory is its own storage. */
export class SupervisorAgent extends DurableObject<Env> {
  private readonly cycles = new SerialCycleQueue();

  async cycle(trigger: "scheduled" | "operator"): Promise<CycleReport> {
    return this.cycles.run(() => runCycle(this.env, this.ctx.storage, trigger));
  }
  async status(): Promise<CycleReport | null> {
    return (await this.ctx.storage.get<CycleReport>("last_cycle")) ?? null;
  }
}

/** Signal Analyst agent process (TP-006): hourly advisory signal digest. */
export class SignalAnalystAgent extends DurableObject<Env> {
  private readonly cycles = new SignalAnalystCycleQueue();

  async cycle(trigger: "scheduled" | "operator"): Promise<CycleReport> {
    return this.cycles.run(() => runSignalCycle(this.env, this.ctx.storage, trigger));
  }
  async status(): Promise<CycleReport | null> {
    return (await this.ctx.storage.get<CycleReport>("last_cycle")) ?? null;
  }
}

/** Platform Auditor agent process (TP-007): hourly audit hash chain & 24h governance verification. */
export class AuditorAgent extends DurableObject<Env> {
  private readonly cycles = new AuditorCycleQueue();

  async cycle(trigger: "scheduled" | "operator"): Promise<CycleReport> {
    return this.cycles.run(() => runAuditCycle(this.env, this.ctx.storage, trigger));
  }
  async status(): Promise<CycleReport | null> {
    return (await this.ctx.storage.get<CycleReport>("last_cycle")) ?? null;
  }
}
