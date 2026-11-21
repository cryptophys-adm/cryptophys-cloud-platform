// The Orchestrator's deploy provenance check (owner 2026-11-21, control-plane-shared/src/provenance.ts): twice an
// hour it reads every platform Worker's active version from Cloudflare with its own deploy token (read only here),
// records what did not come from the platform, and publishes each new finding once:
//  - a code upload on the AI Kernel or on this Worker: a CRITICAL report (the consensus brake; the owner is told at
//    once). The agents never redeploy these two themselves;
//  - a code upload on any other Worker: a warning; the Owner page lists it (out_of_band_deploy) and the Supervisor
//    plans the redeploy from the drift reason;
//  - a settings or secret change: an informational report.
// The Recovery Manager runs the same check on this Worker, so a replaced Orchestrator cannot hide itself.
//
// The alarm outside the kernel (owner 2026-11-21, "setuju"): every report above is published through the AI Kernel
// (reports.publish), and the Owner page is the kernel's too. A kernel that was replaced could drop them. So a new code
// upload on the kernel is also sent straight to the owner's Telegram over this Worker's own OWNER_TELEGRAM binding,
// once per version, and audited (deployment.out_of_band_notified, sent or failed with the reason).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import { DEPLOY_UNITS } from "../../control-plane-shared/src/deploy-units.ts";
import { serviceName } from "../../control-plane-shared/src/plain.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { cloudflareProvenanceReader, provenanceReport, provenanceSweep, provenanceTargets, type ProvenanceFinding, type ProvenanceReader, type ProvenanceResult } from "../../control-plane-shared/src/provenance.ts";

/** The xauusd AI Worker's OwnerNotifier (the bot the kernel's default alert channel uses). */
export interface OwnerTelegram { notify(input: { change: string; title: string; lines: string[]; link: string }): Promise<{ sent?: boolean; reason?: string }> }
export interface ProvenanceTickEnv { DB: D1Database; CF_DEPLOY_TOKEN?: string; CF_ACCOUNT_ID?: string; AGENTS?: AgentRpcBinding; OWNER_TELEGRAM?: OwnerTelegram }

/** A code upload on these is sent to the owner's Telegram by this Worker itself: the kernel cannot vouch for itself. */
export const PROVENANCE_DIRECT: readonly string[] = ["cryptophys-ai-kernel"];
export const OOB_NOTIFIED = "deployment.out_of_band_notified";
const OWNER_PAGE = "https://nexus.cryptophys.work/console/#/owner";

/** The direct alarm for one finding. Never throws; the outcome is audited. */
export async function notifyOwnerDirect(env: Pick<ProvenanceTickEnv, "DB" | "OWNER_TELEGRAM">, f: ProvenanceFinding): Promise<string> {
  const name = serviceName(f.service_id);
  let outcome: string;
  if (typeof env.OWNER_TELEGRAM?.notify !== "function") outcome = "failed: owner_telegram_not_bound";
  else {
    try {
      const r = await env.OWNER_TELEGRAM.notify({
        change: "opened",
        title: `${name} runs code the platform did not deploy`,
        lines: [
          `Version ${f.version_id.slice(0, 8)} became active at ${f.deployed_at ?? "an unknown time"}${f.source ? ` by ${f.source}` : ""}, outside the consensus deploy (expected ${f.desired_version}).`,
          ...(f.bindings_added.length ? [`Bindings added: ${f.bindings_added.join(", ")}`.slice(0, 300)] : []),
          ...(f.bindings_removed.length ? [`Bindings removed: ${f.bindings_removed.join(", ")}`.slice(0, 300)] : []),
          "This message comes from the Deployment Orchestrator, not from the AI Kernel. If it was not you, treat the account's credentials as exposed.",
        ],
        link: OWNER_PAGE,
      });
      outcome = r?.sent === true ? "sent" : `failed: ${String(r?.reason ?? "not sent").replace(/[^\x20-\x7e]/g, "?").slice(0, 120)}`;
    } catch (err) {
      outcome = `failed: ${String((err as Error)?.message ?? err).replace(/[^\x20-\x7e]/g, "?").slice(0, 120)}`;
    }
  }
  await appendAuditEvent(env.DB, { event_type: OOB_NOTIFIED, actor: ACTOR, subject: f.service_id, outcome: outcome === "sent" ? "sent" : "failed", payload: { service_id: f.service_id, version_id: f.version_id, channel: "owner_telegram", result: outcome } }).catch(() => undefined);
  return outcome;
}

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
    if (f.kind === "code_upload" && PROVENANCE_DIRECT.includes(f.service_id)) await notifyOwnerDirect(env, f);
  }
  return result;
}
