// The AI Kernel's two Analytics Engine datasets (ADR-0015 decision 6, phase 3; owner 2026-11-22). Ported from the
// owner's VPS work (6bb8306) with three changes, each required by ADR-0015 decision 6 or by the platform's rules:
//   - only the platform's datasets: the VPS copy also declared three xauusd datasets (signal entries, stops, outcomes).
//     A trading organ's prices and decisions never enter anything the platform writes;
//   - no field for decisions, proposals or votes ("audit, money, trades, decisions and proposals never go there"): the
//     VPS layout of cryptophys_control_plane carried policy_id, decision, votes_for and votes_against;
//   - a schema version in blob1, so the 43 heartbeat rows the VPS build wrote on 2026-11-21 (another layout) are told apart.
// Positions are the schema: append new fields at the end of a list, never reorder; a different layout is a new version.
import { assertSchema, type DatasetSchema } from "./schema.ts";
import { writePoint, type AnalyticsEngineBinding, type WriteOptions } from "./writer.ts";

export const CONTROL_PLANE_SCHEMA_VERSION = "cp.v2";
export const AGENT_RUNTIME_SCHEMA_VERSION = "ar.v2";

/** One point per control-plane job run: a cron job of the kernel's tick, how long it took and how it ended. */
export const CONTROL_PLANE: DatasetSchema = {
  dataset: "cryptophys_control_plane",
  index: { name: "service", maxBytes: 96 },
  blobs: ["schema", "action", "subject", "outcome", "deploy_version"],
  doubles: ["duration_ms", "count", "sample_weight"],
  weightField: "sample_weight",
  description: "One point per control-plane job run (a cron job of the kernel's tick): duration and outcome. A trend, not a record: the ledger stays in D1.",
};

/** One point per agent syscall: which capability, at which tier, how it ended and how long it took. */
export const AGENT_RUNTIME: DatasetSchema = {
  dataset: "cryptophys_agent_runtime",
  index: { name: "agent_id", maxBytes: 96 },
  blobs: ["schema", "event", "capability", "outcome", "deploy_version"],
  doubles: ["tier", "latency_ms", "tokens", "sample_weight"],
  weightField: "sample_weight",
  description: "One point per agent syscall: capability, tier, outcome and latency. Answers hot spots and denial rates per agent.",
};

export const ALL_DATASETS: readonly DatasetSchema[] = [CONTROL_PLANE, AGENT_RUNTIME];
for (const schema of ALL_DATASETS) assertSchema(schema);

export type JobOutcome = "ok" | "failed";
export interface ControlPlaneJob {
  service: string;
  action: "cron_job";
  /** The job's name, a fixed string from code (never a request value). */
  subject: string;
  outcome: JobOutcome;
  durationMs: number;
  deployVersion?: string | null;
}

export function recordControlPlaneJob(binding: AnalyticsEngineBinding | undefined, input: ControlPlaneJob, options?: WriteOptions): boolean {
  return writePoint(binding, CONTROL_PLANE, {
    service: input.service, schema: CONTROL_PLANE_SCHEMA_VERSION, action: input.action, subject: input.subject, outcome: input.outcome,
    deploy_version: input.deployVersion ?? "unknown", duration_ms: input.durationMs, count: 1,
  }, options);
}

export type SyscallOutcome = "succeeded" | "denied" | "failed";
export interface AgentSyscall {
  agentId: string;
  capability: string;
  tier: number;
  outcome: SyscallOutcome;
  latencyMs: number;
  deployVersion?: string | null;
}

export function recordAgentSyscall(binding: AnalyticsEngineBinding | undefined, input: AgentSyscall, options?: WriteOptions): boolean {
  return writePoint(binding, AGENT_RUNTIME, {
    agent_id: input.agentId, schema: AGENT_RUNTIME_SCHEMA_VERSION, event: "syscall", capability: input.capability, outcome: input.outcome,
    deploy_version: input.deployVersion ?? "unknown", tier: input.tier, latency_ms: input.latencyMs, tokens: 0,
  }, options);
}
