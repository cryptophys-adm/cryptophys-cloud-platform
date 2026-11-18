/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point. HTTP (API and MCP) goes to the Access-gated handler in index.ts.
// SupervisorAgent is the supervisor agent process (a SQLite-backed Durable Object); it is not
// reachable over HTTP. HealthRpc lets the Drift Detector observe this Worker.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import worker, { type Env } from "./index.ts";
import { runAuditCycle, AuditorCycleQueue } from "./auditor.ts";
import { AdrStewardCycleQueue, runAdrStewardCycle, stewardState, type StewardState } from "./adr-steward.ts";
import { runSignalCycle, SignalAnalystCycleQueue } from "./signal-analyst.ts";
import { EvolverCycleQueue, runEvolverCycle, type EvolverReport } from "./evolver.ts";
import { runCycle, SerialCycleQueue, type CycleReport } from "./supervisor.ts";
import { observe } from "./syscall.ts";
import { rpcObserve, rpcSyscall, rpcWhoami } from "./agent-rpc.ts";
import { healthBody, type HealthBody, type JsonObject } from "../../control-plane-shared/src/http.ts";
import { vaultOn } from "./alert-channels.ts";
import { ConversationError, rateTurn, readConversation, runTurn, type ConversationStore } from "./conversation.ts";

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

/**
 * ADR Steward agent process (docs/design/ADR-STEWARD.md §4): each ADR's progress from evidence, written only on change.
 * Its cursor, pass times and version id live in this object's storage, so D1 gets no heartbeat writes.
 */
export class AdrStewardAgent extends DurableObject<Env> {
  private readonly cycles = new AdrStewardCycleQueue();

  async cycle(trigger: "scheduled" | "operator"): Promise<CycleReport> {
    return this.cycles.run(() => runAdrStewardCycle(this.env, this.ctx.storage, trigger));
  }
  async status(): Promise<CycleReport | null> {
    return (await this.ctx.storage.get<CycleReport>("last_cycle")) ?? null;
  }
  async state(): Promise<StewardState> {
    return stewardState(this.ctx.storage);
  }
}

/** The evolver (ADR-0014 §11, docs/design/EVOLVER.md §5): one evolution at a time; its last cycle lives here. */
export class EvolverAgent extends DurableObject<Env> {
  private readonly cycles = new EvolverCycleQueue();

  async cycle(_trigger: "scheduled" | "operator"): Promise<EvolverReport> {
    return this.cycles.run(() => runEvolverCycle(this.env as never, this.ctx.storage));
  }
  async status(): Promise<EvolverReport | null> {
    return (await this.ctx.storage.get<EvolverReport>("last_cycle")) ?? null;
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

/**
 * HAIC H1b (docs/design/HAIC-H0-H1.md §3.1): one owner's conversation, named "<actor>:<conversation id>". Its turns live
 * in this object's storage (Q4: 90 days, then R2, later); D1 holds only ids and counts, the audit chain only hashes.
 * Turns are serialized; every call names the actor, and an object answers only the actor it was started by.
 */
export class ConversationAgent extends DurableObject<Env> {
  private readonly turns = new SerialCycleQueue();
  private get store(): ConversationStore { return this.ctx.storage as unknown as ConversationStore; }
  // A ConversationError crosses the RPC boundary as a value (a thrown class loses its fields there).
  private async settle<T>(op: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; status: number; code: string; message: string }> {
    try { return { ok: true, value: await op() }; } catch (err) {
      if (err instanceof ConversationError) return { ok: false, status: err.status, code: err.code, message: err.message };
      throw err;
    }
  }
  async turn(actor: string, conversationId: string, question: unknown) {
    return this.settle(() => this.turns.run(() => runTurn(this.env as never, this.store, { actor, conversation_id: conversationId, question })));
  }
  async read(actor: string, conversationId: string) { return this.settle(() => readConversation(this.store, actor, conversationId)); }
  async rate(actor: string, conversationId: string, turn: unknown, rating: unknown) {
    return this.settle(() => this.turns.run(() => rateTurn(this.env as never, this.store, actor, conversationId, turn, rating)));
  }
}
