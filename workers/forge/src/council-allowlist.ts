// CB2b (2026-11-28; owner "sementara B dulu", ADR-0014 §13; the coordinator's design: the Supervisor proposes from a
// Forge-written pending row, as for merge_change): the council repository's policy/allowlist.json changes only by the
// owner's click.
//
//   1. councilAllowlistTick (a Forge tick step): when xauusd's organism.json council_owned_keys (read through
//      EXT_ORGANISM_XAUUSD.dna()) differs from council main's allowlist, it writes the new file as one commit on main's
//      head to branch allowlist/<head12> of `council` (never main) and records a pending row in
//      council_allowlist_changes (migration 0093), with a summary of keys and bounds only. An older pending row is
//      superseded. Nothing is proposed here.
//   2. The Supervisor proposes merge_council_allowlist (critical: the owner's click; the autonomy dial never raises it).
//   3. mergeCouncilAllowlist (MergeRpc), after verifyConsensusExecution: fast-forward council main from base_sha to
//      head_sha only while main is still base_sha (CAS); the row becomes merged, or refused with the reason.
// Pinned to COUNCIL_REPO, as council-sync.ts; tokens per call with a short TTL, never logged or returned.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import {
  ALLOWLIST_PATH, COUNCIL_REPO, allowlistFromDna, allowlistSummary, allowlistText, parseAllowlist,
} from "../../control-plane-shared/src/council-repo.ts";
import { buildTree, commitObject, councilRepo, enc, gitObject, packOf, readAt, type CouncilBinding, type GitObject } from "./council-sync.ts";
import { fastForward, refHead, trustedRemoteFor, ZERO_SHA, type Fetch } from "./merge.ts";

export const ALLOWLIST_ACTION = "merge_council_allowlist";
export const ALLOWLIST_ACTOR = "system:forge-council";
const TOKEN_TTL_S = 120;
const CHANGE_ID = /^cal-[0-9a-f]{12}$/;
const SHA40 = /^[0-9a-f]{40}$/;

export interface AllowlistEnv { DB: D1Database; ARTIFACTS?: CouncilBinding; EXT_ORGANISM_XAUUSD?: { dna(): Promise<unknown> } }
export interface AllowlistTickResult { outcome: "not_configured" | "no_block" | "no_main" | "equal" | "pending" | "proposed_branch" | "failed"; change_id?: string; reason?: string; problems?: string[] }
export interface CouncilAllowlistEvidence { change_id: string; status: string; base_sha: string; head_sha: string; main_sha: string | null }

interface Row { change_id: string; base_sha: string; head_sha: string; branch: string; summary_json: string; status: string }

export async function councilAllowlistTick(env: AllowlistEnv, nowMs = Date.now(), fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<AllowlistTickResult> {
  if (!env.ARTIFACTS || !env.EXT_ORGANISM_XAUUSD) return { outcome: "not_configured" };
  let dna: unknown;
  try { dna = await env.EXT_ORGANISM_XAUUSD.dna(); } catch { return { outcome: "failed", reason: "dna_unreadable" }; }
  const wanted = allowlistFromDna(dna);
  if (!wanted) return { outcome: "no_block" };
  const { repo } = await councilRepo(env.ARTIFACTS);
  try {
    const remote = (await repo.info())?.remote ?? "";
    if (!trustedRemoteFor(remote, COUNCIL_REPO)) return { outcome: "failed", reason: "untrusted_remote" };
    const head = await refHead(repo, "main").catch(() => null);
    if (!head) return { outcome: "no_main" }; // the ledger's first commit creates main
    const tree = (await repo.readCommit(head))?.treeHash ?? null;
    if (!tree) return { outcome: "failed", reason: "main_unreadable" };
    const current = await readAt(repo, tree, ALLOWLIST_PATH);
    const next = allowlistText(wanted.allowlist);
    const at = new Date(nowMs).toISOString();
    const pending = (await env.DB.prepare("SELECT change_id, base_sha, head_sha, branch, summary_json, status FROM council_allowlist_changes WHERE status = 'pending' ORDER BY created_at").all<Row>()).results;
    if (current === next) {
      for (const p of pending) await env.DB.prepare("UPDATE council_allowlist_changes SET status = 'superseded', updated_at = ? WHERE change_id = ? AND status = 'pending'").bind(at, p.change_id).run();
      return { outcome: "equal" };
    }
    // The same change already waits for the owner (same base, same file): nothing new.
    const blob = await gitObject("blob", enc.encode(next));
    for (const p of pending) {
      if (p.base_sha === head && JSON.parse(p.summary_json).blob === blob.sha) return { outcome: "pending", change_id: p.change_id };
    }
    const objects: GitObject[] = [blob];
    const newTree = await buildTree(repo, tree, new Map([[ALLOWLIST_PATH, blob.sha]]), objects);
    const summary = allowlistSummary(parseAllowlist(current).allowlist, wanted.allowlist);
    const commit = await commitObject(newTree, head, `council: the allowlist from xauusd's organism.json (${summary.added.length} added, ${summary.changed.length} changed, ${summary.removed.length} removed)`,
      "Waits for the owner's click (merge_council_allowlist).", nowMs);
    objects.push(commit);
    const branch = `allowlist/${commit.sha.slice(0, 12)}`;
    const token = (await repo.createToken("write", TOKEN_TTL_S)).plaintext;
    const pushed = await fastForward({ remote, token, branch, from: ZERO_SHA, to: commit.sha, fetchImpl, pack: await packOf(objects) });
    if (!pushed.ok) return { outcome: "failed", reason: pushed.reason };
    const change_id = `cal-${commit.sha.slice(0, 12)}`;
    for (const p of pending) await env.DB.prepare("UPDATE council_allowlist_changes SET status = 'superseded', updated_at = ? WHERE change_id = ? AND status = 'pending'").bind(at, p.change_id).run();
    await env.DB.prepare("INSERT OR IGNORE INTO council_allowlist_changes (change_id, base_sha, head_sha, branch, summary_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
      .bind(change_id, head, commit.sha, branch, JSON.stringify({ ...summary, blob: blob.sha, refused_keys: wanted.problems.length }), at, at).run();
    await appendAuditEvent(env.DB, { event_type: "forge.council_allowlist_proposed", actor: ALLOWLIST_ACTOR, subject: change_id, outcome: "pending", payload: { change_id, base_sha: head, head_sha: commit.sha, branch, added: summary.added, changed: summary.changed, removed: summary.removed } });
    return { outcome: "proposed_branch", change_id, ...(wanted.problems.length ? { problems: wanted.problems } : {}) };
  } finally {
    repo[Symbol.dispose]?.();
  }
}

/** The evidence a merge_council_allowlist vote reads: the row and council main now. */
export async function councilAllowlistState(env: AllowlistEnv, changeId: string): Promise<CouncilAllowlistEvidence | null> {
  if (!CHANGE_ID.test(changeId) || !env.ARTIFACTS) return null;
  const row = await env.DB.prepare("SELECT change_id, base_sha, head_sha, branch, summary_json, status FROM council_allowlist_changes WHERE change_id = ?").bind(changeId).first<Row>();
  if (!row) return null;
  const { repo } = await councilRepo(env.ARTIFACTS);
  try {
    return { change_id: row.change_id, status: row.status, base_sha: row.base_sha, head_sha: row.head_sha, main_sha: await refHead(repo, "main").catch(() => null) };
  } finally {
    repo[Symbol.dispose]?.();
  }
}

/** The executor of merge_council_allowlist, after the owner's click: council main from base to head, CAS only. */
export async function mergeCouncilAllowlist(env: AllowlistEnv, proposalId: string, decisionId: string, changeId: string, params: Record<string, unknown>, fetchImpl: Fetch = (i, init) => fetch(i, init), nowMs = Date.now()): Promise<Record<string, unknown>> {
  if (!env.ARTIFACTS) throw new Error("artifacts_not_configured");
  if (!CHANGE_ID.test(changeId)) throw new Error("invalid_change_id");
  await verifyConsensusExecution(env.DB, proposalId, decisionId, ALLOWLIST_ACTION, changeId, nowMs);
  const at = new Date(nowMs).toISOString();
  const refuse = async (reason: string): Promise<never> => {
    await env.DB.prepare("UPDATE council_allowlist_changes SET status = 'refused', updated_at = ? WHERE change_id = ? AND status = 'pending'").bind(at, changeId).run();
    await appendAuditEvent(env.DB, { event_type: "forge.council_allowlist_refused", actor: ALLOWLIST_ACTOR, subject: changeId, outcome: "refused", payload: { proposal_id: proposalId, reason } });
    throw new Error(`council_allowlist_refused:${reason}`);
  };
  const state = await councilAllowlistState(env, changeId);
  if (!state) return refuse("change_not_found");
  if (state.status !== "pending") return refuse(`change_${state.status}`);
  if (String(params.head_sha ?? "") !== state.head_sha || String(params.base_sha ?? "") !== state.base_sha) return refuse("params_do_not_match");
  if (!SHA40.test(state.base_sha) || !SHA40.test(state.head_sha)) return refuse("invalid_sha");
  if (state.main_sha !== state.base_sha) return refuse("main_moved");
  const { repo } = await councilRepo(env.ARTIFACTS);
  try {
    const remote = (await repo.info())?.remote ?? "";
    if (!trustedRemoteFor(remote, COUNCIL_REPO)) return refuse("untrusted_remote");
    const token = (await repo.createToken("write", TOKEN_TTL_S)).plaintext;
    // The head's objects are on the allowlist branch already: the push moves the ref only (an empty pack).
    const pushed = await fastForward({ remote, token, branch: "main", from: state.base_sha, to: state.head_sha, fetchImpl });
    if (!pushed.ok) return refuse(`push_failed:${pushed.reason ?? "unknown"}`);
  } finally {
    repo[Symbol.dispose]?.();
  }
  await env.DB.prepare("UPDATE council_allowlist_changes SET status = 'merged', updated_at = ? WHERE change_id = ? AND status = 'pending'").bind(at, changeId).run();
  await appendAuditEvent(env.DB, { event_type: "forge.council_allowlist_merged", actor: ALLOWLIST_ACTOR, subject: changeId, outcome: "merged", payload: { proposal_id: proposalId, from: state.base_sha, to: state.head_sha } });
  return { merged: true, change_id: changeId, from: state.base_sha, to: state.head_sha };
}
