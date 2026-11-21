// The watcher's watcher (owner 2026-11-21, control-plane-shared/src/provenance.ts): the Deployment Orchestrator checks
// what every platform Worker runs, so a replaced Orchestrator could skip the check on itself. Once an hour the
// Recovery Manager runs the same check on the Orchestrator alone, with the token it already holds for the rescue
// executor (CF_ORCHESTRATOR_DEPLOY_TOKEN, read only here). A code upload there is a CRITICAL report. Without the
// owner-set secrets it does nothing.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import { serviceName } from "../../control-plane-shared/src/plain.ts";
import { cloudflareProvenanceReader, provenanceReport, provenanceSweep, provenanceTargets, type ProvenanceReader, type ProvenanceResult } from "../../control-plane-shared/src/provenance.ts";

export interface ProvenanceWatchEnv { DB: D1Database; CF_ORCHESTRATOR_DEPLOY_TOKEN?: string; CF_ACCOUNT_ID?: string; AGENTS?: AgentRpcBinding }
export const WATCHED = "cryptophys-deployment-orchestrator";

export async function watchOrchestrator(env: ProvenanceWatchEnv, nowMs = Date.now(), reader?: ProvenanceReader): Promise<ProvenanceResult | { outcome: "not_configured" }> {
  if (!reader && !(env.CF_ORCHESTRATOR_DEPLOY_TOKEN && env.CF_ACCOUNT_ID && /^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID))) return { outcome: "not_configured" };
  const cf = reader ?? cloudflareProvenanceReader(env.CF_ORCHESTRATOR_DEPLOY_TOKEN!, env.CF_ACCOUNT_ID!);
  const result = await provenanceSweep(env.DB, cf, await provenanceTargets(env.DB, [WATCHED]), "cryptophys-recovery-manager", nowMs);
  for (const f of result.findings) {
    if (!f.recorded || f.kind === "platform") continue;
    await publishAgentReport(env.AGENTS, "recovery-manager", provenanceReport(f, serviceName(f.service_id), true));
  }
  return result;
}
