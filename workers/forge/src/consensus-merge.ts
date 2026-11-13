// ADR-0012 G3b (owner 2026-11-13, "kejar cut-over hari ini"): the Forge merges a change request into canonical main.
//
// changeState: the facts a merge vote needs (Evidence.change), computed here from the Forge's own tables and
// repositories: the request's status, source and head, its live verdict (changeVerdict, the same as the Code page),
// canonical main's head, and whether the head contains that main.
//
// mergeForConsensus: the executor of merge_change (routine) and merge_owner_change (critical, after the owner's
// click). It never trusts the caller; in order it checks
//   1. the consensus proposal and its policy decision (verifyConsensusExecution: executing, passed, allowed in the
//      last 10 minutes, the owner's approval for the critical one, the kill switch);
//   2. that the cut-over flipped the merge path (forge_controls.merge_path = forge);
//   3. the request again: open, pushed to platform-work, the proposed head, the verdict its action needs, and a
//      head that contains canonical main;
// then copies the head into the canonical repository (cr/<cr_id>, transfer.ts; usually already there for its
// type-check) and fast-forwards main from the main it read to the head (forgeMerge, read back through the binding).
// The request is recorded merged and the merge audited (forge.merged); a refused or failed merge is audited too.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { MERGE_ACTIONS } from "../../control-plane-shared/src/consensus-rules.ts";
import { mergePath, type ChangeEvidence } from "../../control-plane-shared/src/merge-path.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { changeVerdict, type ChangeRow } from "./changes.ts";
import { checkOf } from "./checks.ts";
import { CANONICAL_REPO, forgeMerge, isAncestor, refHead, validSha, type Fetch, type MergeBinding } from "./merge.ts";
import { copyCommit, typecheckBranch } from "./transfer.ts";

const ACTOR = "system:forge-merge";
const CR_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const parseList = (v: string | null): string[] | null => { try { const a = JSON.parse(v ?? "null"); return Array.isArray(a) ? a.map(String) : null; } catch { return null; } };

export interface MergeEnv { DB: D1Database; ARTIFACTS?: MergeBinding }

export async function changeState(env: MergeEnv, crId: string, nowMs = Date.now()): Promise<ChangeEvidence | null> {
  if (!env.ARTIFACTS || !CR_ID.test(crId)) return null;
  const row = await env.DB.prepare("SELECT * FROM forge_change_requests WHERE cr_id = ?").bind(crId).first<ChangeRow>();
  if (!row) return null;
  const { verdict, reasons } = changeVerdict(row, await checkOf(env.DB, row.head_sha), parseList(row.critical), nowMs);
  const canonical = await env.ARTIFACTS.get(CANONICAL_REPO);
  let main: string | null;
  try { main = await refHead(canonical, "main"); } finally { canonical[Symbol.dispose]?.(); }
  let contains = false;
  if (main) {
    const work = await env.ARTIFACTS.get(row.repo);
    try { contains = main === row.head_sha || await isAncestor(work, main, row.head_sha); } finally { work[Symbol.dispose]?.(); }
  }
  return { cr_id: row.cr_id, status: row.status, source: row.source, head_sha: row.head_sha, verdict, reasons: reasons.slice(0, 10), main_sha: main, contains_main: contains };
}

export async function mergeForConsensus(env: MergeEnv, proposalId: string, decisionId: string, crId: string, params: Record<string, unknown>, fetchImpl: Fetch = (i, init) => fetch(i, init), nowMs = Date.now()): Promise<Record<string, unknown>> {
  if (!env.ARTIFACTS) throw new Error("artifacts_not_configured");
  const proposal = await env.DB.prepare("SELECT action FROM consensus_proposals WHERE proposal_id = ?").bind(String(proposalId)).first<{ action: string }>();
  const action = proposal?.action ?? "";
  if (!MERGE_ACTIONS.has(action)) throw new Error("not_a_merge_proposal");
  await verifyConsensusExecution(env.DB, proposalId, decisionId, action, crId, nowMs);

  const refuse = async (reason: string, extra: Record<string, unknown> = {}): Promise<never> => {
    await appendAuditEvent(env.DB, { event_type: "forge.merge_refused", actor: ACTOR, subject: crId, outcome: "refused", payload: { proposal_id: proposalId, action, reason, ...extra } });
    throw new Error(`merge_refused:${reason}`);
  };
  if ((await mergePath(env.DB)) !== "forge") return refuse("merge_path_github");
  const head = String(params.head_sha ?? "");
  if (!validSha(head)) return refuse("invalid_head");
  const state = await changeState(env, crId, nowMs);
  if (!state) return refuse("change_not_found");
  if (state.status !== "open") return refuse(`change_${state.status}`);
  if (state.source !== "forge") return refuse("not_from_platform_work");
  if (state.head_sha !== head) return refuse("head_moved", { head_sha: state.head_sha });
  const want = action === "merge_change" ? "would_merge" : "needs_owner";
  if (state.verdict !== want) return refuse(`verdict_${state.verdict}`, { reasons: state.reasons });
  if (!state.main_sha || !state.contains_main) return refuse("not_fast_forward", { main_sha: state.main_sha });

  const row = (await env.DB.prepare("SELECT repo FROM forge_change_requests WHERE cr_id = ?").bind(crId).first<{ repo: string }>())!;
  const copied = await copyCommit(env.ARTIFACTS, { source: row.repo, target: CANONICAL_REPO, sha: head, branch: typecheckBranch(crId) }, fetchImpl);
  if (!copied.ok) return refuse(`copy_failed:${copied.reason ?? copied.outcome}`);
  const merged = await forgeMerge(env.ARTIFACTS, CANONICAL_REPO, { base: state.main_sha, head, branch: "main" }, fetchImpl, { canonical: true });
  if (!merged.ok) return refuse(`merge_failed:${merged.reason ?? "unknown"}`, { from: state.main_sha, to: head });

  const now = new Date(nowMs).toISOString();
  // A Forge merge is not a GitHub merge: it never counts towards the GitHub-vs-Forge merge parity (agrees stays NULL).
  await env.DB.prepare("UPDATE forge_change_requests SET status = 'merged', verdict_at_outcome = ?, merge_sha = ?, agrees = NULL, outcome_at = ?, updated_at = ? WHERE cr_id = ? AND status = 'open'")
    .bind(state.verdict, head, now, now, crId).run();
  await appendAuditEvent(env.DB, {
    event_type: "forge.merged", actor: ACTOR, subject: crId, outcome: "merged",
    payload: { proposal_id: proposalId, action, repo: CANONICAL_REPO, branch: "main", from: state.main_sha, to: head, copy: copied.outcome },
  });
  return { merged: true, cr_id: crId, from: state.main_sha, to: head };
}
