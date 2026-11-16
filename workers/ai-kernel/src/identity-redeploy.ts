// The Supervisor's half of the redeploy for identities (owner 2026-11-16, "1. Ya"; the design is in
// control-plane-shared/src/identity-redeploy.ts). In a scheduled cycle, after main's pending deploys, it asks the
// Deployment Orchestrator which units' active Workers carry another identity value than the owner-saved row gives, and
// proposes a routine deploy_commit of such a unit at its running commit, once per unit and identity revision.
//
// It respects everything a deploy proposal respects: one deploy proposal per cycle (shared with main's deploys), the
// daily deploy limit, one executed deploy_commit per target an hour, the brake (nothing is proposed while a critical
// report is open; a proposal the council rejected only because the brake held is proposed again once it is off), and
// the consensus.propose window (4 an hour). A unit main is about to deploy anyway is left to that deploy, which writes
// the same lists. A row that is not owner-saved (absent, seed, invalid, unreadable) gives no unit at all.
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { IDENTITY_REDEPLOY } from "../../control-plane-shared/src/identity-redeploy.ts";
import type { SyscallEnv, SyscallResult } from "./syscall.ts";

export interface IdentityRedeployContext {
  /** Units main's pending deploys list this cycle (their deploy writes the lists anyway). */
  pendingUnits: readonly string[];
  /** Deploy proposals still allowed this cycle (MAX_DEPLOY_PROPOSALS_PER_CYCLE minus those already made). */
  capacity: number;
  dailyFull: boolean;
  brakeOff: boolean;
  /** The statuses that count as "ran" for the rate limits, as the Policy Engine counts them: `('executing','executed')`... */
  ran: string;
  now: number;
  propose: (input: JsonObject) => Promise<SyscallResult | null>;
  findings: JsonObject[];
  actions: SyscallResult[];
}

/** Proposes at most `ctx.capacity` identity redeploys; returns how many it proposed. */
export async function proposeIdentityRedeploys(env: SyscallEnv, ctx: IdentityRedeployContext): Promise<number> {
  if (!env.DEPLOY?.identityDrift || ctx.capacity <= 0 || ctx.dailyFull) return 0;
  if (!ctx.brakeOff) {
    ctx.findings.push({ kind: "identity", action: "none", why: "identity redeploys are not checked while a critical report is open (the council would reject them)" });
    return 0;
  }
  const drift = await env.DEPLOY.identityDrift();
  if (!drift.ok) {
    ctx.findings.push({ kind: "identity", action: "none", why: `identity drift unavailable: ${String(drift.reason).slice(0, 120)}` });
    return 0;
  }
  if (drift.source !== "owner" || drift.revision === null) {
    // Only an invalid row is worth a finding: absent and seed are the normal state before an owner saves a list.
    if (drift.source === "invalid" || drift.source === "unreadable") {
      ctx.findings.push({ kind: "identity", action: "none", why: `the identity list is ${drift.source} (${String(drift.reason ?? "").slice(0, 100)}): nothing is redeployed from it` });
    }
    return 0;
  }
  const revision = drift.revision;
  const hourAgo = new Date(ctx.now - 3_600_000).toISOString();
  let proposed = 0;
  for (const u of drift.units) {
    if (ctx.pendingUnits.includes(u.unit)) {
      ctx.findings.push({ kind: "identity", service_id: u.target, action: "none", why: `main's pending deploy of ${u.unit} writes identity revision ${revision}` });
      continue;
    }
    // One per unit and revision: proposed again only after a policy veto (an hour later) or a rejection the brake alone
    // caused (the brake is off here). Any other outcome, a failed deploy included, stays final for the revision.
    const seen = await env.DB.prepare(
      `SELECT 1 AS x FROM consensus_proposals WHERE action = 'deploy_commit' AND target = ? AND json_extract(params_json, '$.redeploy') = ?
         AND json_extract(params_json, '$.identity_revision') = ?
         AND (status <> 'shadow_blocked' OR created_at >= ?)
         AND NOT (status = 'rejected' AND COALESCE(json_extract(evidence_json, '$.critical_reports_24h'), 0) > 0) LIMIT 1`,
    ).bind(u.target, IDENTITY_REDEPLOY, revision, hourAgo).first();
    if (seen) continue;
    const recent = await env.DB.prepare(
      `SELECT 1 AS x FROM consensus_proposals WHERE action = 'deploy_commit' AND target = ? AND status IN ${ctx.ran} AND decided_at >= ? LIMIT 1`,
    ).bind(u.target, hourAgo).first();
    if (recent) {
      ctx.findings.push({ kind: "identity", service_id: u.target, action: "none", why: "this service was deployed in the last hour; its identity redeploy waits" });
      continue;
    }
    if (proposed >= ctx.capacity) {
      ctx.findings.push({ kind: "identity", service_id: u.target, action: "none", why: "deferred to the next cycle (one deploy proposal per cycle)" });
      continue;
    }
    const names = [...new Set(Object.values(u.changed).flat())].sort();
    const r = await ctx.propose({
      action: "deploy_commit", target: u.target,
      params: {
        commit_sha: u.commit_sha, unit: u.unit, workflow: u.workflow, redeploy: IDENTITY_REDEPLOY, identity_revision: revision,
        reason: `identity lists revision ${revision}: ${names.join(", ")} differ on ${Object.keys(u.changed).length} Worker(s); redeploy at the running commit ${u.commit_sha.slice(0, 12)}`.slice(0, 200),
      },
    });
    if (!r) break;
    proposed += 1;
    ctx.actions.push(r);
    ctx.findings.push({ kind: "identity", service_id: u.target, action: "consensus.propose", outcome: r.outcome, why: `identity revision ${revision} at ${u.commit_sha.slice(0, 12)}: ${names.join(", ")}`.slice(0, 300) });
  }
  return proposed;
}
