// The Orchestrator's deploy provenance check (owner 2026-11-21, control-plane-shared/src/provenance.ts): twice an
// hour it reads every platform Worker's active version from Cloudflare with its own deploy token (read only here),
// records what did not come from the platform, and publishes each new finding once:
//  - a code upload on the AI Kernel or on this Worker: a CRITICAL report (the consensus brake; the owner is told at
//    once). The agents never redeploy these two themselves;
//  - a code upload on any other Worker: a warning; the Owner page lists it (out_of_band_deploy) and the Supervisor
//    plans the redeploy from the drift reason;
//  - a settings or secret change: an informational report.
// The Recovery Manager runs the same check on this Worker, so a replaced Orchestrator cannot hide itself.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import { DEPLOY_UNITS } from "../../control-plane-shared/src/deploy-units.ts";
import { serviceName } from "../../control-plane-shared/src/plain.ts";
import { cloudflareProvenanceReader, provenanceReport, provenanceSweep, provenanceTargets, type ProvenanceReader, type ProvenanceResult } from "../../control-plane-shared/src/provenance.ts";

export interface ProvenanceTickEnv { DB: D1Database; CF_DEPLOY_TOKEN?: string; CF_ACCOUNT_ID?: string; AGENTS?: AgentRpcBinding }

/** A code upload on one of these is a critical report: they are the consensus and the deploy executor. */
export const PROVENANCE_CRITICAL: readonly string[] = ["cryptophys-ai-kernel", "cryptophys-deployment-orchestrator"];
const ACTOR = "cryptophys-deployment-orchestrator";

export async function provenanceTick(env: ProvenanceTickEnv, nowMs = Date.now(), reader?: ProvenanceReader): Promise<ProvenanceResult | { outcome: "not_configured" }> {
  if (!reader && !(env.CF_DEPLOY_TOKEN && env.CF_ACCOUNT_ID && /^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID))) return { outcome: "not_configured" };
  const cf = reader ?? cloudflareProvenanceReader(env.CF_DEPLOY_TOKEN!, env.CF_ACCOUNT_ID!);
  const targets = await provenanceTargets(env.DB, DEPLOY_UNITS.flatMap((u) => [...u.services]));
  const result = await provenanceSweep(env.DB, cf, targets, ACTOR, nowMs);
  for (const f of result.findings) {
    if (!f.recorded || f.kind === "platform") continue;
    await publishAgentReport(env.AGENTS, "deployment-orchestrator", provenanceReport(f, serviceName(f.service_id), PROVENANCE_CRITICAL.includes(f.service_id)));
  }
  return result;
}
