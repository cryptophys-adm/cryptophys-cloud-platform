// ADR-0014 §11 (owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik"), docs/design/EVOLVER.md §4, step V2:
// the evolution intake. On every kernel cron tick (:07, :22, :37, :52) it records needs as evolution intents. It never
// acts: it writes no code, proposes nothing to consensus and changes no other table.
//
// Council intents (§4.1). A repository_task that the owner accepted in Nexus reaches the platform as an agent report
// (reports.publish, kind xauusd_digest, body.schema typed_proposal.v1). It is recorded once per proposal_id when its
// agent is registered with host_worker = a service of the xauusd origin. Triage is deterministic:
//   - kind repository_task, executor cryptophys, state handoff_pending or handed_off (xauusd #430), origin.side nexus, chosen_by an owner: valid;
//   - the platform repository → queued; any other repository → waiting_external (owner 2026-11-17: "Tunggu ADR-0018
//     X1/X2"); a missing title or spec, or a spec over SPEC_MAX bytes → rejected (invalid_spec);
//   - ADR-0018 X1 amendment 2026-11-28 (Issue #327; owner: "Ya Kerjakan"): a repository with a worker in
//     EXTERNAL_ASSIGNEES (xauusd → xauusd-worker) is queued_external: waiting_external with that assignee and an
//     expires_at of now + 7 days (FRESH_MS); its return-path row says queued_external. The worker (or the owner) moves it
//     with POST /v1/evolution/intents/{id}/progress (evolution-progress.ts); no Forge change request (X2 stays held);
//   - chosen_by is an owner ("owner:<actor>"), or "council" (the council chose inside a topic the owner approved):
//     then topic_approved_by is "owner:<actor>" and session_id names the owner-approved council session (the same id
//     as origin.council when that is given); otherwise rejected (not_chosen_by_owner, topic_not_owner_approved);
//   - any other kind or state (a policy_parameter is xauusd's own; a later state update) is not an intent: ignored.
// Each council intent's state goes to evolution_updates_v2 (migration 0077), the return path that council.decisions.read serves (V3).
// The body's price fields are never stored (the kernel drops them as signals.observe does).
//
// Platform intents (§4.2). An Observer inventory finding that no registration can settle (undeclared_worker,
// missing_worker, undeclared_resource) on a subject no external organ owns (organ name prefixes) becomes one intent per
// subject, source inventory, queued. A finding that recurs while its intent exists adds its id to the evidence.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { EXTERNAL_ORIGINS } from "../../control-plane-shared/src/organism.ts";
import { ORGAN_NAME_PREFIXES } from "../../control-plane-shared/src/observer-inventory.ts";

export const INTAKE_ACTOR = "agent:supervisor";
export const COUNCIL_ORIGIN = "xauusd";
/** The Workers whose agents may hand a council task off: the xauusd origin's services. */
export const COUNCIL_HOSTS: readonly string[] = EXTERNAL_ORIGINS.find((o) => o.origin === COUNCIL_ORIGIN)?.services ?? [];
export const COUNCIL_SCHEMA = "typed_proposal.v1";
/** The hand-off states of an owner-accepted task: handoff_pending until xauusd #430, handed_off since. */
export const HANDOFF_STATES: readonly string[] = Object.freeze(["handoff_pending", "handed_off"]);
/** The names the platform repository goes by: the canonical Forge repository and its GitHub mirror. */
export const PLATFORM_REPOS: readonly string[] = Object.freeze(["cryptophys/platform", "cryptophys-adm/cryptophys-cloud-platform"]);
export const PLATFORM_REPO = "platform";
export const SPEC_MAX = 8192;
/** ADR-0018 X1 amendment 2026-11-28: the external repositories whose council tasks a worker of theirs builds. */
export const EXTERNAL_ASSIGNEES: Readonly<Record<string, string>> = Object.freeze({ "cryptophys-adm/xauusd-ai-trading-assistant": "xauusd-worker" });
/** An external intent with no progress for this long returns to the council (owner: "harus selalu segar"). */
export const FRESH_MS = 7 * 86_400_000;
export const QUEUED_EXTERNAL = "queued_external";
/** The worker that builds a repository's council tasks, or null (nobody: the owner assigns or closes). */
export function assigneeOf(repo: string): string | null {
  const key = Object.keys(EXTERNAL_ASSIGNEES).find((k) => k.toLowerCase() === repo.toLowerCase());
  return key ? EXTERNAL_ASSIGNEES[key] : null;
}
/** The repository a worker builds in (its progress refs must be there), or null. */
export function repoOfAssignee(assignee: string): string | null {
  return Object.entries(EXTERNAL_ASSIGNEES).find(([, a]) => a === assignee)?.[0] ?? null;
}
export const TITLE_MAX = 300;
export const MAX_EVIDENCE_REFS = 12;
/** Reports scanned per tick: the last 7 days, at most SCAN_LIMIT, so a missed tick loses nothing. */
export const SCAN_MS = 7 * 86_400_000;
const SCAN_LIMIT = 200;
export const INVENTORY_METRICS = ["undeclared_worker", "missing_worker", "undeclared_resource"] as const;
const PRICE_KEY = /^(price|prices|entry|entry_price|sl|tp|stop|stop_loss|take_profit|bid|ask|level|levels)$/i;
const ID = /^[A-Za-z0-9._:-]{1,120}$/;

export type IntentState = "queued" | "waiting_external" | "rejected";
export interface CouncilTriage {
  proposal_id: string | null;
  state: IntentState;
  reason: string | null;
  /** The worker assigned (queued_external), or null. */
  assignee: string | null;
  target_repo: string;
  title: string;
  spec: string;
  origin: Record<string, unknown>;
  evidence_refs: string[];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const parse = (s: string): Record<string, unknown> => { try { return obj(JSON.parse(s)); } catch { return {}; } };
const bytes = (s: string) => new TextEncoder().encode(s).length;
const hex12 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/** A copy of `v` without price fields, at any depth (the body never carries a price; this makes sure). */
export function withoutPrices(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.map((x) => withoutPrices(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!PRICE_KEY.test(k)) out[k] = withoutPrices(x, depth + 1);
    return out;
  }
  return v;
}

/** The repository an intent targets: "platform" for the platform's own names, the given name otherwise. */
export function targetRepoOf(repo: unknown): string {
  const r = str(repo, 200);
  if (!r || PLATFORM_REPOS.includes(r.toLowerCase())) return r ? PLATFORM_REPO : "";
  return r;
}

/**
 * Whether a typed_proposal.v1 body is a council task the intake records, and its triage. Null when the body is not an
 * intent at all (another kind, or a later state of a proposal); otherwise the intent to record.
 */
export function triageCouncilTask(body: Record<string, unknown>): CouncilTriage | null {
  if (body.schema !== COUNCIL_SCHEMA || body.kind !== "repository_task" || !HANDOFF_STATES.includes(String(body.state))) return null;
  const origin = obj(body.origin);
  const proposal_id = typeof body.proposal_id === "string" && ID.test(body.proposal_id) ? body.proposal_id : null;
  const title = str(body.title, TITLE_MAX);
  const rawSpec = typeof body.spec === "string" ? body.spec.trim() : "";
  const target_repo = targetRepoOf(origin.repo);
  const kept = withoutPrices({
    proposal_id, council: str(origin.council, 120), option_id: str(origin.option_id, 120), side: str(origin.side, 20),
    repo: str(origin.repo, 200), topic: str(origin.topic, 120), question: str(origin.question, 300),
    chosen_by: str(body.chosen_by, 200), chosen_at: str(body.chosen_at, 40),
    ...(body.chosen_by === "council" ? { topic_approved_by: str(body.topic_approved_by, 200), session_id: str(body.session_id, 120) } : {}),
    hypothesis: str(body.hypothesis, 1000), risk: str(body.risk, 1000), dissent: str(body.dissent, 300),
  }) as Record<string, unknown>;
  const evidence_refs = (Array.isArray(body.evidence_refs) ? body.evidence_refs : [])
    .filter((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 300).slice(0, MAX_EVIDENCE_REFS);
  const base = { proposal_id, assignee: null, target_repo: target_repo || "unknown", title: title || "(untitled council task)", spec: rawSpec.slice(0, SPEC_MAX), origin: kept, evidence_refs };
  const reject = (reason: string): CouncilTriage => ({ ...base, state: "rejected", reason });
  if (!proposal_id) return reject("invalid_proposal_id");
  if (body.executor !== "cryptophys") return reject("executor_not_cryptophys");
  if (origin.side !== "nexus") return reject("not_from_nexus");
  if (body.chosen_by === "council") {
    const sid = body.session_id;
    if (typeof body.topic_approved_by !== "string" || !/^owner:.{1,190}$/.test(body.topic_approved_by)
      || typeof sid !== "string" || !ID.test(sid) || (typeof origin.council === "string" && origin.council && origin.council !== sid)) {
      return reject("topic_not_owner_approved");
    }
  } else if (typeof body.chosen_by !== "string" || !body.chosen_by.startsWith("owner:")) return reject("not_chosen_by_owner");
  if (!title || !rawSpec || bytes(rawSpec) > SPEC_MAX) return reject("invalid_spec");
  if (!target_repo) return reject("no_repository");
  if (target_repo !== PLATFORM_REPO) {
    const assignee = assigneeOf(target_repo);
    return assignee ? { ...base, assignee, state: "waiting_external", reason: QUEUED_EXTERNAL } : { ...base, state: "waiting_external", reason: "adr_0018_x1_x2" };
  }
  return { ...base, state: "queued", reason: null };
}

interface ReportRow { report_id: string; agent_id: string; body_json: string; created_at: string }
export interface IntakeResult { intent_id: string; source: "council" | "inventory"; source_ref: string; state: string; reason: string | null; outcome: "recorded" | "evidence_added" }

async function audit(db: D1Database, intent_id: string, outcome: string, payload: Record<string, unknown>) {
  await appendAuditEvent(db, { event_type: "evolution.intent_recorded", actor: INTAKE_ACTOR, subject: `intent:${intent_id}`, outcome, payload: { intent_id, ...payload } });
}

/** Record the council tasks handed off in the scan window that are not recorded yet. */
export async function intakeCouncil(db: D1Database, now = Date.now()): Promise<IntakeResult[]> {
  if (!COUNCIL_HOSTS.length) return [];
  const q = COUNCIL_HOSTS.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT r.report_id, r.agent_id, r.body_json, r.created_at FROM agent_reports r
     JOIN agents a ON a.agent_id = r.agent_id
     WHERE r.created_at >= ? AND a.host_worker IN (${q}) AND r.kind = 'xauusd_digest'
       AND json_extract(r.body_json, '$.schema') = ? AND json_extract(r.body_json, '$.kind') = 'repository_task'
       AND json_extract(r.body_json, '$.state') IN ('handoff_pending', 'handed_off')
       AND NOT EXISTS (SELECT 1 FROM evolution_intents_v2 i WHERE i.source = 'council'
         AND i.source_ref IN (json_extract(r.body_json, '$.proposal_id'), 'report:' || r.report_id))
     ORDER BY r.created_at, r.rowid LIMIT ${SCAN_LIMIT}`,
  ).bind(new Date(now - SCAN_MS).toISOString(), ...COUNCIL_HOSTS, COUNCIL_SCHEMA).all<ReportRow>();
  const out: IntakeResult[] = [];
  const at = new Date(now).toISOString();
  for (const r of rows.results) {
    const t = triageCouncilTask(parse(r.body_json));
    if (!t) continue;
    const source_ref = t.proposal_id ?? `report:${r.report_id}`;
    const intent_id = `int_${hex12()}`;
    const origin = { ...t.origin, origin: COUNCIL_ORIGIN, report_id: r.report_id, agent_id: r.agent_id };
    // queued_external (an assignee) carries its freshness; any other intent has none (NULL never expires).
    const expires_at = t.assignee ? new Date(now + FRESH_MS).toISOString() : null;
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO evolution_intents_v2 (intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, evolution_id, created_at, updated_at${t.assignee ? ", assignee, expires_at" : ""})
       VALUES (?, 'council', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?${t.assignee ? ", ?, ?" : ""})`,
    ).bind(intent_id, source_ref, JSON.stringify(origin), t.target_repo, t.title, t.spec, JSON.stringify(t.evidence_refs), t.state, t.reason, at, at, ...(t.assignee ? [t.assignee, expires_at] : [])).run();
    if (!inserted.meta?.changes) continue; // the same proposal in two reports of one batch: recorded once
    // The return path names queued_external for an assigned task (the intent's own state is waiting_external).
    const label = t.assignee ? QUEUED_EXTERNAL : t.state;
    if (t.proposal_id) {
      await db.prepare("INSERT INTO evolution_updates_v2 (update_id, intent_id, origin, proposal_id, state, reason, refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(`evu_${crypto.randomUUID()}`, intent_id, COUNCIL_ORIGIN, t.proposal_id, label, t.assignee ? `assigned to ${t.assignee}` : t.reason, JSON.stringify(t.assignee ? { intent_id, assignee: t.assignee } : { intent_id }), at).run();
    }
    await audit(db, intent_id, label, { source: "council", source_ref, report_id: r.report_id, agent_id: r.agent_id, target_repo: t.target_repo, state: t.state, reason: t.reason, assignee: t.assignee, expires_at, chosen_by: t.origin.chosen_by ?? null });
    out.push({ intent_id, source: "council", source_ref, state: label, reason: t.reason, outcome: "recorded" });
  }
  return out;
}

const externallyOwned = (subject: string) => {
  const name = subject.includes(":") ? subject.slice(subject.indexOf(":") + 1) : subject;
  return ORGAN_NAME_PREFIXES.some((p) => name.startsWith(p.prefix)) || EXTERNAL_ORIGINS.some((o) => o.services.includes(name));
};

interface FindingRow { finding_id: string; worker: string; metric: string; detail: string }

/** Record the platform's own inventory findings of the last day as intents, one per subject. */
export async function intakeInventory(db: D1Database, now = Date.now()): Promise<IntakeResult[]> {
  const q = INVENTORY_METRICS.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT finding_id, worker, metric, detail FROM observer_findings WHERE kind = 'inventory' AND metric IN (${q}) AND created_at >= ?
     ORDER BY created_at, rowid LIMIT ${SCAN_LIMIT}`,
  ).bind(...INVENTORY_METRICS, new Date(now - 86_400_000).toISOString()).all<FindingRow>();
  const out: IntakeResult[] = [];
  const at = new Date(now).toISOString();
  for (const f of rows.results) {
    if (externallyOwned(f.worker)) continue;
    const source_ref = `${f.metric}:${f.worker}`.slice(0, 200);
    const ref = `ev:platform/observer.finding/${f.finding_id}`;
    const existing = await db.prepare("SELECT intent_id, evidence_refs_json FROM evolution_intents_v2 WHERE source = 'inventory' AND source_ref = ?")
      .bind(source_ref).first<{ intent_id: string; evidence_refs_json: string }>();
    if (existing) {
      let refs: string[] = [];
      try { const v = JSON.parse(existing.evidence_refs_json); if (Array.isArray(v)) refs = v.filter((x) => typeof x === "string"); } catch { /* replaced below */ }
      if (refs.includes(ref)) continue;
      const next = [...refs, ref].slice(-MAX_EVIDENCE_REFS);
      await db.prepare("UPDATE evolution_intents_v2 SET evidence_refs_json = ?, updated_at = ? WHERE intent_id = ?").bind(JSON.stringify(next), at, existing.intent_id).run();
      out.push({ intent_id: existing.intent_id, source: "inventory", source_ref, state: "unchanged", reason: null, outcome: "evidence_added" });
      continue;
    }
    const intent_id = `int_${hex12()}`;
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO evolution_intents_v2 (intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, evolution_id, created_at, updated_at)
       VALUES (?, 'inventory', ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?)`,
    ).bind(intent_id, source_ref, JSON.stringify({ metric: f.metric, subject: f.worker }), PLATFORM_REPO,
      `${f.metric.replace(/_/g, " ")}: ${f.worker}`.slice(0, TITLE_MAX), f.detail.slice(0, SPEC_MAX), JSON.stringify([ref]), at, at).run();
    if (!inserted.meta?.changes) continue;
    await audit(db, intent_id, "queued", { source: "inventory", source_ref, finding_id: f.finding_id, target_repo: PLATFORM_REPO, state: "queued", reason: null });
    out.push({ intent_id, source: "inventory", source_ref, state: "queued", reason: null, outcome: "recorded" });
  }
  return out;
}

/** One intake pass: council tasks, then inventory findings. Before migration 0076 (no table) it does nothing. */
export async function intakeEvolutionIntents(db: D1Database, now = Date.now()): Promise<IntakeResult[]> {
  try {
    await db.prepare("SELECT 1 FROM evolution_intents_v2 LIMIT 1").first();
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return [];
    throw err;
  }
  return [...await intakeCouncil(db, now), ...await intakeInventory(db, now)];
}
