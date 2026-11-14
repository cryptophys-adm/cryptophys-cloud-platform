/**
 * Wave C, C1: a control-plane Worker casts its own consensus vote (VoteRpc.vote) from its own
 * reads of its domain, instead of the AI Kernel applying every rule to one shared snapshot. The
 * kernel's snapshot is a starting point only: the facts each voter owns are re-read here, by
 * that Worker's code, at vote time.
 *   platform-registry  -> the target's registry row
 *   drift-detector     -> the target's last two drift observations (persistent: drift-state.ts)
 *   policy-engine      -> recent proposals for the same action and target
 *   audit-ledger       -> the audit chain (incremental verification)
 *   recovery-manager   -> recovery plans that are executing
 * Every voter re-reads the kill switch. Rules themselves are the shared consensus-rules.ts.
 */
import type { D1Database } from "./types.ts";
import { verifyAuditChainIncremental } from "./audit.ts";
import { LAST_TWO_OBSERVATIONS_SQL, isPersistentDrift } from "./drift-state.ts";
import { VOTERS, castVote, type Evidence, type Proposal, type Vote, type Voter } from "./consensus-rules.ts";

export async function castDomainVote(db: D1Database, voter: Voter, proposal: Proposal, snapshot: Evidence, now = Date.now()): Promise<Vote> {
  if (!(VOTERS as readonly string[]).includes(voter)) throw new Error("unknown_voter");
  const e: Evidence = structuredClone(snapshot);
  const ks = await db.prepare("SELECT value FROM kernel_controls WHERE control = 'agents_enabled'").first<{ value: string }>();
  e.agents_enabled = ks?.value === "1";
  const t = proposal.target;
  switch (voter) {
    case "platform-registry": {
      const row = await db.prepare("SELECT status, desired_version FROM service_registry WHERE service_id = ?").bind(t).first<{ status: string; desired_version: string | null }>();
      if (row) e.registry[t] = row; else delete e.registry[t];
      break;
    }
    case "drift-detector": {
      const obs = await db.prepare(LAST_TWO_OBSERVATIONS_SQL).bind(t).all<{ drifted: number; streak: number; evidence_json: string; observed_at: string }>();
      if (obs.results.length) {
        const latest = obs.results[0];
        const ev = (() => { try { return JSON.parse(latest.evidence_json || "{}"); } catch { return {}; } })() as Record<string, any>;
        e.services[t] = {
          service_id: t,
          drifted: latest.drifted === 1,
          persistent: isPersistentDrift(obs.results),
          desired_version: ev.desired_version ?? e.services[t]?.desired_version ?? null,
          observed_version: ev.probe?.version_tag ?? e.services[t]?.observed_version ?? null,
        };
      } else {
        delete e.services[t];
      }
      break;
    }
    case "policy-engine": {
      const same = await db.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = ? AND target = ? AND created_at >= ?")
        .bind(proposal.action, t, new Date(now - 6 * 3_600_000).toISOString()).first<{ n: number }>();
      e.recent_same = same?.n ?? 0;
      break;
    }
    case "audit-ledger":
      e.audit_valid = (await verifyAuditChainIncremental(db)).valid;
      break;
    case "recovery-manager": {
      const plans = await db.prepare("SELECT service_id FROM recovery_plans WHERE status = 'executing'").all<{ service_id: string }>();
      e.executing_plan_targets = plans.results.map((p) => p.service_id);
      break;
    }
    default:
      break;
  }
  return castVote(voter, proposal, e);
}
