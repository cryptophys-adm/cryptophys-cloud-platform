/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP (API and MCP) goes to the Access-gated handler in index.ts.
// SupervisorAgent is the supervisor agent process (a SQLite-backed Durable Object); it is not
// reachable over HTTP. HealthRpc lets the Drift Detector observe this Worker.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import worker, { type Env } from "./index.ts";
import { runAuditCycle, AuditorCycleQueue } from "./auditor.ts";
import { runSignalCycle, SignalAnalystCycleQueue } from "./signal-analyst.ts";
import { runCycle, SerialCycleQueue, type CycleReport } from "./supervisor.ts";
import { observe } from "./syscall.ts";
import { rpcObserve, rpcSyscall, rpcWhoami } from "./agent-rpc.ts";
import { healthBody, type HealthBody, type JsonObject } from "../../control-plane-shared/src/http.ts";
import { vaultOn } from "./alert-channels.ts";

export default worker;

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env);
  }
}

/** Read-only kernel view for the Platform API gateway (GET /v1/overview). */
export class KernelRpc extends WorkerEntrypoint<Env> {
  async overview() {
    return observe(this.env);
  }
}

/**
 * In-account agent RPC (TP-011, no service token). The caller's Worker name is pinned in its
 * Service Binding (`props = { host_worker = "..." }`); it may act only as agents it hosts, tier_max <= 1.
 */
export class AgentRpc extends WorkerEntrypoint<Env> {
  private get props(): unknown {
    return (this.ctx as { props?: unknown } | undefined)?.props;
  }
  async whoami(agentId: string): Promise<JsonObject> {
    return rpcWhoami(this.env, this.props, agentId);
  }
  async observe(agentId: string, capability: string, input: JsonObject = {}): Promise<JsonObject> {
    return rpcObserve(this.env, this.props, agentId, capability, input);
  }
  async syscall(agentId: string, capability: string, input: JsonObject = {}): Promise<JsonObject> {
    return rpcSyscall(this.env, this.props, agentId, capability, input);
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

/**
 * Owner 2026-11-13 (Alerts page): the Telegram bot tokens of the owner's alert channels. Only this Worker holds the
 * binding (no route, no other Worker), so a token never sits in the shared D1 and is never returned by an API.
 */
export class AlertVault extends DurableObject<Env> {
  async put(channelId: string, token: string): Promise<void> { return vaultOn(this.ctx.storage as never).put(channelId, token); }
  async get(channelId: string): Promise<string | null> { return vaultOn(this.ctx.storage as never).get(channelId); }
  async delete(channelId: string): Promise<void> { return vaultOn(this.ctx.storage as never).delete(channelId); }
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
