// HAIC H0b (ADR-0017 H0, docs/design/HAIC-H0-H1.md §2.2–2.4; design approved by the owner 2026-11-16): one ranked list
// of everything that waits on the owner. Pure and deterministic: no AI call, no table, no clock but the `now` given.
//
//   score = 100 × U × B × A × D        (sorted descending; ties: oldest first, then item_id)
//   U  urgency       critical 1.0 · high 0.7 · normal 0.4 · low 0.2
//   B  what it blocks 1 + Σ w(b), capped at 6: trading_safety 3 · cutover_gate 2 · deploys 2 · merges 1.5 · learning 0.5
//   A  age           1 + min(age_h / 24, 1)
//   D  deadline      remaining ≤ 1 h: 3 · ≤ 6 h: 2 · ≤ 24 h: 1.5 · later or none: 1
//
// U and blocks() come from the static tables below, keyed by the item kind. The weights live here, next to their test
// (owner-inbox-rank-h0b.test.ts); they are not council-adjustable parameters. GET /v1/owner/inbox serves the result as
// `items[]` with `ranking` (owner-inbox.ts), additively: the owner-inbox.v1 sections stay as they are.
import { CONSENSUS_ACTIONS } from "./consensus-rules.ts";
import { TRADING_CAPABILITY } from "./capabilities.ts";
import { describeAction, serviceName } from "./plain.ts";

export const RANK_FORMULA = "owner-inbox.rank.v1";
export type Urgency = "critical" | "high" | "normal" | "low";
export type Block = "trading_safety" | "cutover_gate" | "deploys" | "merges" | "learning";
export const URGENCY_WEIGHT: Readonly<Record<Urgency, number>> = { critical: 1.0, high: 0.7, normal: 0.4, low: 0.2 };
export const BLOCK_WEIGHT: Readonly<Record<Block, number>> = { trading_safety: 3, cutover_gate: 2, deploys: 2, merges: 1.5, learning: 0.5 };
export const BLOCK_CAP = 6;
export const AGE_FULL_H = 24;
/** Remaining time (hours) up to which the deadline factor applies, nearest first; later or no deadline is 1. */
export const DEADLINE_STEPS: readonly (readonly [number, number])[] = [[1, 3], [6, 2], [24, 1.5]];

interface Kind { urgency: Urgency; blocks: readonly Block[] }
const k = (urgency: Urgency, ...blocks: Block[]): Kind => ({ urgency, blocks });

/**
 * Critical consensus actions waiting in pending_owner (§2.2 table). Every critical action of CONSENSUS_ACTIONS has an
 * entry (a test enforces it); an action matching TRADING_CAPABILITY is trading safety whatever its name.
 * Not in the design's table, chosen here: restore_d1_bookmark (high, deploys: production data waits on it) and
 * rotate_secret and register_principal (normal, nothing waits on them).
 */
export const CONSENSUS_KINDS: Readonly<Record<string, Kind>> = {
  merge_owner_change: k("high", "merges", "deploys"),
  change_access: k("high", "cutover_gate", "deploys"),
  retire_worker: k("high", "cutover_gate", "deploys"),
  deploy_destructive_migration: k("high", "cutover_gate", "deploys"),
  agents_enable: k("critical", "trading_safety"),
  restore_d1_bookmark: k("high", "deploys"),
  register_privileged_agent: k("normal"),
  update_privileged_agent_capabilities: k("normal"),
  admit_voter: k("normal"),
  retire_agent: k("normal"),
  amend_constitution: k("normal"),
  register_principal: k("normal"),
  rotate_secret: k("normal"),
};
const TRADING_KIND = k("critical", "trading_safety");
/** An action this table does not know yet (a new critical action) still lists, as normal and blocking nothing. */
const UNKNOWN_CONSENSUS_KIND = k("normal");

/** Production problems no agent is handling (owner-inbox.ts unhandledProblems(), 15 codes). */
export const PROBLEM_KINDS: Readonly<Record<string, Kind>> = {
  executor_deploy_failed: k("critical", "deploys", "cutover_gate"),
  self_unhealthy: k("critical", "deploys"),
  deploys_stalled: k("critical", "deploys"),
  deploy_no_path: k("critical", "deploys"),
  out_of_band_deploy: k("critical", "deploys"),
  git_backup_unverified: k("high", "cutover_gate", "deploys"),
  drift_unhandled: k("high", "deploys"),
  observations_stale: k("high", "deploys"),
  recovery_failed: k("high", "deploys"),
  critical_advisory: k("high", "deploys"),
  build_minutes_exhausted: k("high", "deploys"),
  identity_source_invalid: k("high", "deploys"),
  break_glass_deployed: k("normal", "deploys"),
  // AIR1 (2026-11-25): Beam turned itself off (a paid sign or a contributor retention header); Workers AI answers meanwhile.
  model_router_stopped: k("high"),
  // CB2a (2026-11-28): the Forge left a council ledger file or overlay setting out of the council repository (it failed
  // the check: not on the allowlist, out of bounds, a forbidden key, a price-like number or a secret). Nothing waits on it.
  council_sync_refused: k("normal"),
};
export const CRITICAL_REPORT_KIND = k("critical", "deploys", "merges");
export const RECOVERY_PLAN_KIND = k("high", "deploys");
export const KNOWLEDGE_KIND = k("low", "learning");
/** HAIC H1.5c (§2.2 table, last row): a council waiting for the owner's pick. Nothing waits on it; it expires after 72 h. */
export const COUNCIL_KIND = k("normal");
/** HAIC H1.5d (Q9): a council an agent proposed, waiting for the owner to begin it. Nothing waits on it; 7-day window. */
export const COUNCIL_PROPOSAL_KIND = k("low");
/** HAIC H2: a typed proposal draft waiting for the owner's confirmation. Nothing waits on it; 7-day window. */
export const TYPED_PROPOSAL_KIND = k("normal");
/** HAIC H4: a group a regression lowered (high: what it held back now waits for clicks) and one ready to be raised (low). */
export const AUTONOMY_LOWERED_KIND = k("high");
export const AUTONOMY_RAISE_KIND = k("low");

/** Known reversibility of a critical action once executed (null: not stated; the UI shows "—"). */
const REVERSIBLE: Readonly<Record<string, boolean>> = {
  merge_owner_change: true, change_access: true, amend_constitution: true, agents_enable: true, admit_voter: true,
  register_privileged_agent: true, register_principal: true,
  // Review 2026-11-22: a privileged capability the update removes cannot be given back by any consensus action.
  update_privileged_agent_capabilities: false,
  retire_worker: false, retire_agent: false, deploy_destructive_migration: false, restore_d1_bookmark: false, rotate_secret: false,
};

// The inputs: the shapes ownerInbox() already reads (owner-inbox.ts), only the fields the ranking uses.
export interface RankInput {
  approvals: {
    recovery_plans: { plan_id: string; service_id: string; title: string | null; created_by?: string; created_at: string; approve_by: string | null }[];
    consensus: { proposal_id: string; action: string; target: string; proposer_agent_id?: string; created_at: string; expires_at: string; approvals: number; eligible: number }[];
    knowledge: { proposal_id: string; item_id: string; item_version: number; kind: string; proposer_agent_id?: string; created_at: string; expires_at: string }[];
  };
  critical_reports: { report_id: string; agent_id: string; subject: string; created_at: string }[];
  production_problems: { code: string; subject: string; detail: string; since: string | null; link: string }[];
  /** HAIC H1.5c: councils in awaiting_owner whose window is still open (owner-inbox.ts councilsAwaitingOwner). */
  councils?: { session_id: string; topic: string; since: string | null; deadline: string }[];
  /** HAIC H1.5d: councils agents proposed (state proposed) whose window is still open (owner-inbox.ts councilProposals). */
  council_proposals?: { session_id: string; topic: string; proposed_by: string; trigger_kind: string; refs: string[]; since: string; deadline: string }[];
  /** HAIC H2: typed proposal drafts waiting for the owner (ai-kernel/src/proposals.ts draftsAwaitingOwner). */
  typed_proposals?: { proposal_id: string; kind: string; title: string; since: string; deadline: string; origin_source: string }[];
  /** HAIC H4: the autonomy dial's notices (ai-kernel/src/autonomy.ts autonomyNotices). */
  autonomy?: { group: string; label: string; kind: "lowered" | "raise_ready"; level: string; to: string | null; detail: string; since: string }[];
}

export interface InboxItem {
  item_id: string;
  source: "consensus" | "recovery_plan" | "knowledge" | "critical_report" | "production_problem" | "council" | "proposal" | "autonomy";
  kind: string;
  what: string;
  metric: { name: string; value: number; of: number; unit: string } | null;
  evidence_refs: string[];
  risk: { class: "critical" | "routine"; reversible: boolean | null; blast_radius: "service" | "agent" | "platform" | "change" } | null;
  blocks: Block[];
  deadline: string | null;
  created_at: string | null;
  urgency: Urgency;
  score: number;
  score_parts: { U: number; B: number; A: number; D: number };
  action: { kind: "approve_reject" | "approve_disable" | "acknowledge" | "pick" | "start" | "confirm" | "set_level" | "none"; route: string | null; approver_only: boolean };
  /** The Console page that holds the evidence (a hash route), for a production problem or a council; otherwise null. */
  page: string | null;
  deep_link: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The four factors of one item at `now`. Unreadable times count as no age and no deadline. */
export function scoreParts(urgency: Urgency, blocks: readonly Block[], createdAt: string | null, deadline: string | null, now: number) {
  const U = URGENCY_WEIGHT[urgency];
  const B = Math.min(BLOCK_CAP, 1 + blocks.reduce((n, b) => n + BLOCK_WEIGHT[b], 0));
  const created = Date.parse(String(createdAt ?? ""));
  const ageH = Number.isFinite(created) ? Math.max(0, (now - created) / 3_600_000) : 0;
  const A = 1 + Math.min(ageH / AGE_FULL_H, 1);
  const due = Date.parse(String(deadline ?? ""));
  let D = 1;
  if (Number.isFinite(due)) {
    const remainingH = (due - now) / 3_600_000;
    for (const [h, factor] of DEADLINE_STEPS) if (remainingH <= h) { D = factor; break; }
  }
  return { U, B, A, D, score: Math.round(100 * U * B * A * D) };
}

function item(base: Omit<InboxItem, "score" | "score_parts" | "urgency" | "blocks" | "deep_link">, kind: Kind, now: number): InboxItem {
  const p = scoreParts(kind.urgency, kind.blocks, base.created_at, base.deadline, now);
  return {
    ...base, urgency: kind.urgency, blocks: [...kind.blocks], score: p.score,
    score_parts: { U: p.U, B: round2(p.B), A: round2(p.A), D: p.D },
    deep_link: `#/owner/${encodeURIComponent(base.item_id).replace(/%3A/g, ":")}`,
  };
}

export function consensusKind(action: string): Kind {
  if (TRADING_CAPABILITY.test(action)) return TRADING_KIND;
  return CONSENSUS_KINDS[action] ?? UNKNOWN_CONSENSUS_KIND;
}

/** Every item that waits on the owner, ranked by score (highest first). */
export function rankInbox(input: RankInput, now = Date.now()): InboxItem[] {
  const out: InboxItem[] = [];
  for (const c of input.approvals.consensus) {
    const def = CONSENSUS_ACTIONS[c.action];
    out.push(item({
      item_id: `consensus:${c.proposal_id}`, source: "consensus", kind: c.action,
      what: `Critical action: ${describeAction(c.action, c.target)}${c.proposer_agent_id ? ` (proposed by ${c.proposer_agent_id})` : ""}`.slice(0, 200),
      metric: { name: "approvals", value: Number(c.approvals) || 0, of: Number(c.eligible) || 0, unit: "votes" },
      evidence_refs: [`ev:platform/consensus/${c.proposal_id}`, ...(def?.target === "change" ? [`ev:platform/forge.change/${c.target}`] : [])],
      risk: { class: "critical", reversible: REVERSIBLE[c.action] ?? null, blast_radius: def?.target ?? "platform" },
      deadline: c.expires_at, created_at: c.created_at,
      action: { kind: "approve_reject", route: "kernel.consensus_approve", approver_only: true }, page: null,
    }, consensusKind(c.action), now));
  }
  for (const r of input.critical_reports) {
    out.push(item({
      item_id: `critical_report:${r.report_id}`, source: "critical_report", kind: "critical_report",
      what: `${r.agent_id}: ${r.subject}`.slice(0, 200), metric: null,
      evidence_refs: [`ev:platform/report/${r.report_id}`], risk: null, deadline: null, created_at: r.created_at,
      action: { kind: "acknowledge", route: "kernel.report_acknowledge", approver_only: true }, page: null,
    }, CRITICAL_REPORT_KIND, now));
  }
  for (const p of input.approvals.recovery_plans) {
    out.push(item({
      item_id: `recovery_plan:${p.plan_id}`, source: "recovery_plan", kind: "recovery_plan",
      what: `Recovery plan for ${serviceName(p.service_id)}${p.created_by ? ` (by ${p.created_by})` : ""}`.slice(0, 200), metric: null,
      evidence_refs: [`ev:platform/recovery_plan/${p.plan_id}`], risk: null, deadline: p.approve_by, created_at: p.created_at,
      action: { kind: "approve_disable", route: "recovery.approve", approver_only: true }, page: null,
    }, RECOVERY_PLAN_KIND, now));
  }
  for (const q of input.approvals.knowledge) {
    out.push(item({
      item_id: `knowledge:${q.proposal_id}`, source: "knowledge", kind: q.kind,
      what: `Knowledge proposal ${q.item_id}@${q.item_version} (${q.kind.replace(/_/g, " ")}${q.proposer_agent_id ? `, by ${q.proposer_agent_id}` : ""})`.slice(0, 200), metric: null,
      evidence_refs: [`ev:platform/knowledge/${q.proposal_id}`], risk: null, deadline: q.expires_at, created_at: q.created_at,
      action: { kind: "approve_reject", route: "kernel.knowledge_approve", approver_only: true }, page: null,
    }, KNOWLEDGE_KIND, now));
  }
  for (const p of input.production_problems) {
    out.push(item({
      item_id: `production_problem:${p.code}:${p.subject}`, source: "production_problem", kind: p.code,
      // A production problem's detail is its evidence in words (the reason, the plan's skips): kept longer.
      what: p.detail.slice(0, 400), metric: null,
      evidence_refs: [`ev:platform/production_problem/${p.code}:${p.subject}`], risk: null, deadline: null, created_at: p.since,
      action: { kind: "none", route: null, approver_only: false }, page: p.link,
    }, PROBLEM_KINDS[p.code] ?? k("high", "deploys"), now));
  }
  for (const c of input.councils ?? []) {
    out.push(item({
      item_id: `council:${c.session_id}`, source: "council", kind: "council_awaiting_pick",
      what: `Council waits for your pick: ${c.topic}`.slice(0, 200), metric: null,
      evidence_refs: [`ev:platform/council/${c.session_id}`], risk: null, deadline: c.deadline, created_at: c.since,
      // The pick is made on the council's page, where its options, claims and dissent are shown (Cerebrum only, Q6).
      action: { kind: "pick", route: "kernel.council_pick", approver_only: true }, page: `#/councils/${c.session_id}`,
    }, COUNCIL_KIND, now));
  }
  for (const c of input.council_proposals ?? []) {
    out.push(item({
      item_id: `council:${c.session_id}`, source: "council", kind: "council_proposed",
      what: `Council proposed by ${c.proposed_by.replace(/^agent:/, "")}: ${c.topic}`.slice(0, 200), metric: null,
      evidence_refs: [`ev:platform/council/${c.session_id}`, ...c.refs.slice(0, 4)], risk: null, deadline: c.deadline, created_at: c.since,
      // Q9: only the owner begins a proposed council, on its page, where its evidence is shown.
      action: { kind: "start", route: "kernel.council_begin", approver_only: true }, page: `#/councils/${c.session_id}`,
    }, COUNCIL_PROPOSAL_KIND, now));
  }
  for (const p of input.typed_proposals ?? []) {
    out.push(item({
      item_id: `proposal:${p.proposal_id}`, source: "proposal", kind: "typed_proposal_draft",
      what: `Confirm or reject: ${p.title} (${p.kind.replace(/_/g, " ")}, from ${p.origin_source === "chat" ? "the chat" : "a council"})`.slice(0, 200), metric: null,
      evidence_refs: [`ev:platform/proposal/${p.proposal_id}`], risk: null, deadline: p.deadline, created_at: p.since,
      action: { kind: "confirm", route: "kernel.proposal_confirm", approver_only: true }, page: `#/proposals/${p.proposal_id}`,
    }, TYPED_PROPOSAL_KIND, now));
  }
  for (const a of input.autonomy ?? []) {
    out.push(item({
      item_id: `autonomy:${a.group}:${a.kind}`, source: "autonomy", kind: a.kind === "lowered" ? "autonomy_lowered" : "autonomy_raise_ready",
      what: (a.kind === "lowered" ? `${a.label} lowered to ${a.level.replace(/_/g, " ")} after a regression: ${a.detail}` : `${a.label} is ready to rise to ${String(a.to).replace(/_/g, " ")}: ${a.detail}`).slice(0, 200), metric: null,
      evidence_refs: [`ev:platform/autonomy/${a.group}`], risk: null, deadline: null, created_at: a.since,
      action: { kind: "set_level", route: "kernel.autonomy_set", approver_only: true }, page: "#/autonomy",
    }, a.kind === "lowered" ? AUTONOMY_LOWERED_KIND : AUTONOMY_RAISE_KIND, now));
  }
  const at = (x: InboxItem) => { const t = Date.parse(String(x.created_at ?? "")); return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; };
  return out.sort((a, b) => b.score - a.score || at(a) - at(b) || (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
}

/** The `ranking` block GET /v1/owner/inbox serves next to `items[]`. */
export const RANKING = {
  formula: RANK_FORMULA,
  weights: { urgency: URGENCY_WEIGHT, blocks: BLOCK_WEIGHT, blocks_cap: BLOCK_CAP, age_full_h: AGE_FULL_H, deadline_steps_h: DEADLINE_STEPS },
} as const;
