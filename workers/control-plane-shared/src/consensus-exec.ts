/**
 * Defence in depth for consensus execution (ADR-0009 phase 2). A Worker that applies a
 * consensus action (Registry, Drift Detector) re-checks, in its own code, that:
 *  - the proposal exists, is in status 'executing', and names exactly this action and target;
 *  - the consensus mode is not 'shadow';
 *  - the Policy Engine recorded an allow for consensus.execute on "<action>:<target>" in the
 *    last 10 minutes, and that decision is the proposal's own policy decision.
 * The kernel cannot make a Worker act on a proposal that did not pass, and a replayed or
 * stale decision is refused.
 */
import type { D1Database } from "./types.ts";

export const CONSENSUS_EXECUTION_WINDOW_MS = 10 * 60_000;

export async function verifyConsensusExecution(
  db: D1Database, proposalId: unknown, decisionId: unknown, action: string, target: string, now = Date.now(),
): Promise<void> {
  if (typeof proposalId !== "string" || !/^cns_[0-9a-f-]{36}$/.test(proposalId)) throw new Error("consensus_proposal_required");
  if (typeof decisionId !== "string" || !/^dec_[0-9a-f-]{36}$/.test(decisionId)) throw new Error("consensus_decision_required");
  const mode = await db.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").first<{ value: string }>();
  if (!mode || mode.value === "shadow") throw new Error("consensus_shadow_mode");
  const p = await db.prepare(
    "SELECT action, target, status, passed, policy_decision_id, policy_decision FROM consensus_proposals WHERE proposal_id = ?",
  ).bind(proposalId).first<{ action: string; target: string; status: string; passed: number; policy_decision_id: string | null; policy_decision: string | null }>();
  if (!p || p.action !== action || p.target !== target || p.status !== "executing" || p.passed !== 1
    || p.policy_decision !== "allow" || p.policy_decision_id !== decisionId) {
    throw new Error("consensus_not_executable");
  }
  const d = await db.prepare("SELECT action, resource, decision, created_at FROM policy_decisions WHERE decision_id = ?")
    .bind(decisionId).first<{ action: string; resource: string; decision: string; created_at: string }>();
  const age = d ? now - Date.parse(d.created_at) : Number.NaN;
  if (!d || d.decision !== "allow" || d.action !== "consensus.execute" || d.resource !== `${action}:${target}`
    || !Number.isFinite(age) || age < 0 || age > CONSENSUS_EXECUTION_WINDOW_MS) {
    throw new Error("consensus_decision_invalid");
  }
  const ks = await db.prepare("SELECT value FROM kernel_controls WHERE control = 'agents_enabled'").first<{ value: string }>();
  if (ks?.value !== "1") throw new Error("consensus_kill_switch");
}
