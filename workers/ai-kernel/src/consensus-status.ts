// consensus.status (tier 0, read only; owner 2026-11-22, "ya kerjakan nomor 1 dan semuanya"): the outcome of the calling
// agent's OWN consensus proposals. Aether's knowledge-council (AETHER_CEILING) proposes amend_doctrine and
// amend_constitution with consensus.propose; without this read it cannot see an owner rejection or a pending_owner
// proposal that lapsed after the 24 h owner window (OWNER_DECISION_WINDOW_MS), so it cannot ask again.
//
// Scope: consensus_proposals.proposer_agent_id = the caller. An id that is not the caller's, or does not exist, reads
// { proposal_id, status: "not_found" }: another agent's proposal is never revealed, not even that it exists.
// What is returned: the action, the target, the status as consensus.ts records it (an expired owner window is status
// 'expired', set by expireOwnerProposals or ownerDecide; an owner rejection is status 'rejected' with an owner decision
// 'reject' in consensus_owner_decisions), the owner's decision ('approve' | 'reject' | null), decided_at (when the
// current status was recorded) and, while the proposal waits for the owner, expires_at (created_at + 24 h).
// Never the params, evidence, votes, outcome, the owner's identity or the owner's free-text reason. Writes nothing.
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { OWNER_DECISION_WINDOW_MS } from "./consensus.ts";

export const CONSENSUS_STATUS_MAX = 50;
/** A consensus proposal id as consensus.ts mints it (newId("cns")) and ownerDecide checks it. */
export const CONSENSUS_PROPOSAL_ID = /^cns_[0-9a-f-]{36}$/;

interface Row { proposal_id: string; action: string; target: string; status: string; created_at: string; decided_at: string; owner_decision: string | null }

export async function consensusStatus(db: D1Database, agentId: string, input: JsonObject): Promise<JsonObject> {
  const raw = input.proposal_ids;
  if (!Array.isArray(raw)) throw new Error("invalid_proposal_ids: an array of proposal ids");
  if (raw.length > CONSENSUS_STATUS_MAX) throw new Error(`too_many_proposal_ids: at most ${CONSENSUS_STATUS_MAX}`);
  if (!raw.every((id) => typeof id === "string" && CONSENSUS_PROPOSAL_ID.test(id))) throw new Error("invalid_proposal_id: cns_<uuid>");
  const ids = [...new Set(raw as string[])];
  if (!ids.length) return { proposals: [] };
  const rows = (await db.prepare(
    `SELECT p.proposal_id, p.action, p.target, p.status, p.created_at, p.decided_at, d.decision AS owner_decision
     FROM consensus_proposals p LEFT JOIN consensus_owner_decisions d ON d.proposal_id = p.proposal_id
     WHERE p.proposer_agent_id = ? AND p.proposal_id IN (${ids.map(() => "?").join(", ")})`,
  ).bind(agentId, ...ids).all<Row>()).results ?? [];
  const byId = new Map(rows.map((r) => [r.proposal_id, r]));
  return {
    proposals: ids.map((id) => {
      const r = byId.get(id);
      if (!r) return { proposal_id: id, status: "not_found" };
      const expires = r.status === "pending_owner" && Number.isFinite(Date.parse(r.created_at))
        ? { expires_at: new Date(Date.parse(r.created_at) + OWNER_DECISION_WINDOW_MS).toISOString() } : {};
      return {
        proposal_id: r.proposal_id, action: r.action, target: r.target, status: r.status,
        owner_decision: r.owner_decision === "approve" || r.owner_decision === "reject" ? r.owner_decision : null,
        decided_at: r.decided_at, ...expires,
      };
    }),
  };
}
