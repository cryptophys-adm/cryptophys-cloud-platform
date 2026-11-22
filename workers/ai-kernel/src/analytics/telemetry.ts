// The AI Kernel's telemetry calls (ADR-0015 decision 6, phase 3; owner 2026-11-22). The only place that names the
// kernel's Analytics Engine bindings: callers pass their env and a fixed set of values, never a request payload.
// Telemetry never decides anything and never breaks a caller: every function here swallows its own errors.
import { recordAgentSyscall, recordControlPlaneJob, type SyscallOutcome } from "./datasets.ts";
import type { AnalyticsEngineBinding } from "./writer.ts";

export const KERNEL_SERVICE = "cryptophys-ai-kernel";

export interface TelemetryEnv {
  /** Dataset cryptophys_control_plane (workers/ai-kernel/wrangler.toml). */
  ANALYTICS_CONTROL_PLANE?: AnalyticsEngineBinding;
  /** Dataset cryptophys_agent_runtime. */
  ANALYTICS_AGENT_RUNTIME?: AnalyticsEngineBinding;
  /** Client-side sample rate in (0, 1]; "1" writes every event. */
  ANALYTICS_SAMPLE_RATE?: string;
  CF_VERSION_METADATA?: { tag?: string | null };
}

const asTelemetry = (env: object): TelemetryEnv => env as TelemetryEnv;

export function sampleRateOf(env: TelemetryEnv): number {
  const parsed = Number(env.ANALYTICS_SAMPLE_RATE);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 1);
}

const versionOf = (env: TelemetryEnv): string | null => env.CF_VERSION_METADATA?.tag || null;

/** One point for a finished cron job of the kernel's tick. */
export function recordCronJob(envIn: object, job: string, outcome: "ok" | "failed", durationMs: number): void {
  try {
    const env = asTelemetry(envIn);
    recordControlPlaneJob(env.ANALYTICS_CONTROL_PLANE, { service: KERNEL_SERVICE, action: "cron_job", subject: job, outcome, durationMs, deployVersion: versionOf(env) }, { sampleRate: sampleRateOf(env) });
  } catch { /* telemetry never breaks the tick */ }
}

/** Time a cron job: the same promise comes back (its value or its rejection), and one point is written when it settles. */
export function trackJob<T>(env: object, job: string, work: Promise<T>, now: () => number = Date.now): Promise<T> {
  const started = now();
  return work.then(
    (value) => { recordCronJob(env, job, "ok", now() - started); return value; },
    (err: unknown) => { recordCronJob(env, job, "failed", now() - started); throw err; },
  );
}

/** One point for an agent syscall, after its outcome is known. */
export function recordSyscall(envIn: object, agentId: string, capability: string, tier: number, outcome: SyscallOutcome, latencyMs: number): void {
  try {
    const env = asTelemetry(envIn);
    recordAgentSyscall(env.ANALYTICS_AGENT_RUNTIME, { agentId, capability, tier, outcome, latencyMs, deployVersion: versionOf(env) }, { sampleRate: sampleRateOf(env) });
  } catch { /* telemetry never breaks a syscall */ }
}
