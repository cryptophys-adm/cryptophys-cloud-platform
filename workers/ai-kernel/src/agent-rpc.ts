// In-account agent RPC (TP-011). A Worker in this account reaches its own agents over a
// Service Binding to the AgentRpc entrypoint, without any shared secret or service token.
//
// Identity: Service Bindings do not identify the caller, so the caller's Worker name is pinned
// in the binding itself (`props = { host_worker = "<worker>" }` in the caller's wrangler.toml),
// and the runtime delivers it as ctx.props. The trust boundary is the Cloudflare account and
// identities authorized to change/deploy the caller Worker configuration; this is not attestation
// against a malicious account deployer. A Worker can act only as agents whose agents.host_worker
// equals its pinned host_worker.
// Agents with tier_max > 1 (supervisor) are never reachable this way.
import { syscall, type SyscallEnv } from "./syscall.ts";
import { KERNEL_HOST } from "./kernel.ts";
import { CAPABILITIES, getAgent, type AgentRow } from "../../control-plane-shared/src/capabilities.ts";
import type { JsonObject } from "../../control-plane-shared/src/http.ts";

export const AGENT_RPC_TIER_MAX = 1;

/** Reads the pinned caller identity from the binding props; anything malformed is rejected. */
export function callerHostWorker(props: unknown): string | null {
  if (!props || typeof props !== "object") return null;
  const host = (props as { host_worker?: unknown }).host_worker;
  return typeof host === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(host) ? host : null;
}

type Resolved = { agent: AgentRow } | { error: string };

async function resolve(env: SyscallEnv, props: unknown, agentId: string): Promise<Resolved> {
  const host = callerHostWorker(props);
  if (!host) return { error: "caller_identity_missing" };
  if (typeof agentId !== "string" || !agentId) return { error: "agent_not_registered" };
  const agent = await getAgent(env.DB, agentId);
  if (!agent) return { error: "agent_not_registered" };
  if (agent.host_worker === KERNEL_HOST) return { error: "kernel_agent_internal" };
  if (agent.host_worker !== host) return { error: "agent_not_hosted_by_caller" };
  if (agent.tier_max > AGENT_RPC_TIER_MAX) return { error: "external_tier_limit" };
  return { agent };
}

export async function rpcWhoami(env: SyscallEnv, props: unknown, agentId: string): Promise<JsonObject> {
  const r = await resolve(env, props, agentId);
  if ("error" in r) return { error: r.error };
  const { agent } = r;
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

export async function rpcObserve(env: SyscallEnv, props: unknown, agentId: string, capability: string, input: JsonObject = {}): Promise<JsonObject> {
  const cap = Object.hasOwn(CAPABILITIES, capability) ? CAPABILITIES[capability] : undefined;
  if (!cap || cap.tier !== 0) return { outcome: "denied", capability, reason: "agent_observe_requires_tier_0" };
  return rpcSyscall(env, props, agentId, capability, input);
}

export async function rpcSyscall(env: SyscallEnv, props: unknown, agentId: string, capability: string, input: JsonObject = {}): Promise<JsonObject> {
  const r = await resolve(env, props, agentId);
  if ("error" in r) return { outcome: "denied", capability, reason: r.error };
  // syscall() still applies grants, prohibitions, suspension, kill switch, rate limit and Policy Engine.
  return (await syscall(env, r.agent.agent_id, capability, input)) as unknown as JsonObject;
}
