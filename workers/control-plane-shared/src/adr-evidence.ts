// The ADR Steward, step 2 (docs/design/ADR-STEWARD.md §3, §4.4, §11 row 2; owner 2026-11-16, "ya semua, sesuai
// rekomendasimu"): the predicate evaluator and the named readings.
//
// A manifest (adr-progress.ts, adr.progress.v1) names how each phase is measured. This module measures it: every
// predicate kind is one fixed, parameterized, read-only query here, and the manifest supplies only values. Nothing
// here writes, and nothing is wired to a Worker yet: the kernel's `adr.observe` handler calls it in step 3.
//
// Pure over two injected dependencies:
//   - `db`: a small D1-like reader, `prepare(sql).bind(...).first()/all()`. Every query is a SELECT with a LIMIT on
//     an index of the real migrations (workers/control-plane-migrations), checked by test/adr-evidence.test.ts;
//   - `readFile(path)`: the repository text the document predicates quote (doc_asserted, doc_claim, and the vision
//     for `vision_valid`). The kernel supplies bundled text; the tests read the repository.
//
// One phase evaluates to one of:
//   proven             machine evidence holds (an audit event, a migration, a vote, a row);
//   doc_asserted       only a quoted document says so (the quote is checked against the file);
//   external_asserted  a dated claim about something the platform cannot read (another repository, a branch);
//   open               measurable, but the evidence does not hold yet; its reason is the blocker;
//   not_measurable_yet nothing can measure it yet, so it can never read as done;
//   unknown            a source could not be read. The Steward keeps the phase's last stored state then (§3), and
//                      the document is marked stale with that source.
// Each result carries evidence refs in the HAIC form `ev:platform/<source>/<id>[@<as_of>][#<field>]`
// (docs/design/HAIC-H0-H1.md §4.6; ADR-STEWARD Q9).

import { adrManifestProblems, ADR_READINGS, type AdrManifest, type AdrPhase, type AdrPredicate } from "./adr-progress.ts";
import { DEPLOY_UNITS } from "./deploy-units.ts";
import { visionProblems } from "./vision.ts";

// ---------------------------------------------------------------------------------------------------- interfaces

/** The read-only part of a D1 binding this module uses. A D1Database satisfies it. */
export interface AdrEvidenceStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface AdrEvidenceDb {
  prepare(sql: string): { bind(...values: unknown[]): AdrEvidenceStatement };
}

export interface AdrEvidenceDeps {
  db: AdrEvidenceDb;
  /** Repository text by repository-relative path; null when the file does not exist. Without it, document predicates are unknown. */
  readFile?: (path: string) => string | null | Promise<string | null>;
  /**
   * The Orchestrator's `github_fallback` field (`/ready`, deployment-orchestrator/src/index.ts). No read-only RPC
   * serves it yet (§3), so without this dependency `orchestrator_github_fallback_absent` is not_measurable_yet.
   */
  githubFallback?: () => Promise<string | null>;
  /** Evaluation time in ms; defaults to Date.now(). */
  now?: number;
}

export const ADR_EVIDENCE_STATES = ["proven", "doc_asserted", "external_asserted", "open", "not_measurable_yet", "unknown"] as const;
export type AdrEvidenceState = (typeof ADR_EVIDENCE_STATES)[number];
const COMPLETE: readonly AdrEvidenceState[] = ["proven", "doc_asserted", "external_asserted"];
export const isComplete = (s: AdrEvidenceState) => COMPLETE.includes(s);

export interface PendingOwner { proposal_id: string; action: string; target: string; created_at: string }

export interface AdrEvidenceResult {
  state: AdrEvidenceState;
  /** When the evidence holds from (an event's time, a row's time, an external claim's date); null when not proven or undated. */
  at: string | null;
  refs: string[];
  /** Why it is not complete (the blocker), or a short note; null when nothing needs saying. */
  reason: string | null;
  /** A live check can turn open again (census, readings, windows, documents); a past event cannot (§3). */
  live: boolean;
  /** An open quiet_window: the earliest time it can be proven. */
  earliest?: string;
  /** An unknown state: the source that could not be read. */
  sources?: string[];
  /** An open consensus_executed: matching proposals that wait for the owner's click. */
  pending_owner?: PendingOwner[];
}

export class AdrEvidenceRefused extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`predicate refused: ${problems.slice(0, 5).join("; ")}`);
    this.name = "AdrEvidenceRefused";
    this.problems = problems;
  }
}

class SourceError extends Error {
  readonly source: string;
  constructor(source: string, cause: unknown) {
    super(`${source}: ${String((cause as Error)?.message ?? cause).slice(0, 200)}`);
    this.source = source;
  }
}

// ---------------------------------------------------------------------------------------------------- validation

/** The observer_vitals columns a vitals threshold may read (a fixed list: a column name is never taken from a manifest). */
export const VITAL_COLUMNS = [
  "requests", "errors", "rows_read", "rows_written", "neurons", "cpu_p50_ms", "cpu_p99_ms", "wall_p50_ms", "wall_p99_ms",
  "exceeded_cpu", "exceeded_memory", "exceptions",
] as const;
/** The `kind` values of each Observer table (migration 0063 CHECK constraints). */
const OBSERVER_KINDS: Record<string, readonly string[]> = {
  findings: ["anomaly", "early_warning", "inventory", "capability"],
  runs: ["senses", "inventory"],
  vitals: ["worker", "d1", "kv", "do", "ai"],
};
const UNIT_NAMES: readonly string[] = DEPLOY_UNITS.map((u) => u.unit);

/** What the evaluator needs beyond the schema (adr-progress.ts): the names it maps to tables, columns and units. */
function evaluatorLeafProblems(p: AdrPredicate, at: string, out: string[]): void {
  if (Array.isArray(p.of)) { p.of.forEach((q, i) => evaluatorLeafProblems(q, `${at}.of[${i}]`, out)); return; }
  switch (p.kind) {
    case "merged_and_deployed":
      if (!UNIT_NAMES.includes(p.unit as string)) out.push(`${at}.unit: must be one of ${UNIT_NAMES.join(", ")}`);
      break;
    case "observer": {
      const kinds = OBSERVER_KINDS[p.source as string] ?? [];
      if ("kind_filter" in p && !kinds.includes(p.kind_filter as string)) out.push(`${at}.kind_filter: must be one of ${kinds.join(", ")} for ${String(p.source)}`);
      if (p.source === "runs" && !("kind_filter" in p)) out.push(`${at}.kind_filter: required for runs`);
      if (p.source === "runs" && ("worker" in p || "subject" in p || "metric" in p)) out.push(`${at}: runs take only kind_filter, since and expect`);
      if (p.source === "vitals" && !("subject" in p) && !("worker" in p)) out.push(`${at}.subject: required for vitals`);
      if (p.source === "vitals" && "metric" in p) out.push(`${at}.metric: a vitals threshold is kpi_threshold`);
      if (p.source === "findings" && "subject" in p) out.push(`${at}.subject: findings are filtered by worker`);
      break;
    }
    case "kpi_threshold":
      if (p.source === "observer_vitals") {
        if (!(VITAL_COLUMNS as readonly unknown[]).includes(p.metric)) out.push(`${at}.metric: must be one of ${VITAL_COLUMNS.join(", ")}`);
        if (!("subject" in p)) out.push(`${at}.subject: required for observer_vitals`);
        if ("kind_filter" in p && !OBSERVER_KINDS.vitals.includes(p.kind_filter as string)) out.push(`${at}.kind_filter: must be one of ${OBSERVER_KINDS.vitals.join(", ")}`);
      }
      break;
  }
}

/** Every problem of a manifest for evaluation: the schema's (adrManifestProblems) and the evaluator's own. */
export function adrEvidenceProblems(m: unknown, fileName?: string): string[] {
  const out = adrManifestProblems(m, fileName);
  if (out.length) return out;
  (m as AdrManifest).phases.forEach((ph, i) => evaluatorLeafProblems(ph.evidence, `phases[${i}].evidence`, out));
  return out;
}

/** Every problem of one predicate tree, checked as the evidence of a probe manifest so the schema rules apply in full. */
export function predicateProblems(p: unknown): string[] {
  const probe = { schema: "adr.progress.v1", adr: "0000", title: "probe", adr_file: null, lifecycle: "planned", lifecycle_note: "probe", phases: [{ id: "P", title: "probe", evidence: p }] };
  return adrEvidenceProblems(probe).map((x) => x.replace(/^phases\[0\]\.evidence/, "predicate"));
}

// ---------------------------------------------------------------------------------------------------- helpers

const ISO_SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** A stored time as ISO-8601 UTC: d1_migrations writes CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS"), the rest write ISO. */
export function isoTime(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const s = ISO_SPACE.test(v) ? v.replace(" ", "T") + "Z" : v;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);
const sooner = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);
const HOUR_MS = 3_600_000;
/**
 * The anchor of a sequence's first item: before every stored time, so an event leaf is read oldest first and the
 * first chain is found. It is never shown in a reason.
 */
const FIRST = "0000-01-01T00:00:00.000Z";
const afterText = (after: string | null) => (after && after !== FIRST ? ` after ${after}` : "");
/** "2026-11-17T14:12Z": the minute, for blockers. */
export const minuteUtc = (iso: string) => iso.slice(0, 16) + "Z";

/** An evidence ref: `ev:platform/<source>/<id>[@<as_of>][#<field>]` (HAIC §4.6). */
export function evRef(source: string, id: string, asOf?: string | null, field?: string): string {
  return `ev:platform/${source}/${id}${asOf ? `@${asOf}` : ""}${field ? `#${field}` : ""}`;
}
export const EV_REF = /^ev:platform\/[a-z0-9_.-]+\/[^\s@#]+(@[^\s@#]+)?(#[^\s@#]+)?$/;

const res = (state: AdrEvidenceState, o: Partial<AdrEvidenceResult> = {}): AdrEvidenceResult =>
  ({ state, at: null, refs: [], reason: null, live: true, ...o });
const open = (reason: string, o: Partial<AdrEvidenceResult> = {}) => res("open", { reason, ...o });
const proven = (at: string | null, refs: string[], live: boolean, o: Partial<AdrEvidenceResult> = {}) => res("proven", { at, refs, live, ...o });

/** A read-only SELECT that ends with a LIMIT: anything else is a programming error, refused before it reaches D1. */
const READ_ONLY = /^\s*SELECT\s/i;
const BOUNDED = /\sLIMIT\s+(\?|\d+)\s*$/i;
const WRITES = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|PRAGMA|VACUUM)\b/i;

// The rank of a state for the combinators: complete states above open ones, proof above assertion.
const RANK: Record<AdrEvidenceState, number> = { proven: 5, doc_asserted: 4, external_asserted: 3, open: 2, not_measurable_yet: 1, unknown: 0 };

// ---------------------------------------------------------------------------------------------------- the context

type Leaf = (p: AdrPredicate, after: string | null) => Promise<AdrEvidenceResult>;

/**
 * One evaluation pass. It caches each leaf's result and each file's text, so a predicate that several phases or ADRs
 * share (merge_change, forge_work_cr_merged) is read once per pass.
 */
export class AdrEvidenceContext {
  readonly now: number;
  readonly nowIso: string;
  private readonly deps: AdrEvidenceDeps;
  private readonly leafCache = new Map<string, Promise<AdrEvidenceResult>>();
  private readonly fileCache = new Map<string, Promise<string | null>>();

  constructor(deps: AdrEvidenceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now();
    this.nowIso = new Date(this.now).toISOString();
  }

  private async rows<T>(source: string, sql: string, args: unknown[]): Promise<T[]> {
    if (!READ_ONLY.test(sql) || !BOUNDED.test(sql) || WRITES.test(sql) || sql.includes(";")) throw new Error(`adr-evidence: refused query ${sql.slice(0, 80)}`);
    try {
      return (await this.deps.db.prepare(sql).bind(...args).all<T>()).results ?? [];
    } catch (e) {
      throw new SourceError(source, e);
    }
  }
  private async row<T>(source: string, sql: string, args: unknown[]): Promise<T | null> {
    return (await this.rows<T>(source, sql, args))[0] ?? null;
  }

  /** The file's text, or null when it does not exist. Throws a SourceError when no reader is supplied or it fails. */
  async file(path: string): Promise<string | null> {
    const read = this.deps.readFile;
    if (!read) throw new SourceError(`repo:${path}`, "no repository reader");
    let p = this.fileCache.get(path);
    if (!p) {
      p = Promise.resolve().then(() => read(path));
      this.fileCache.set(path, p);
    }
    try { return await p; } catch (e) { throw new SourceError(`repo:${path}`, e); }
  }

  /** Evaluate a predicate tree. Refuses an unknown kind or invalid fields before any query (AdrEvidenceRefused). */
  async evaluate(p: AdrPredicate, after: string | null = null): Promise<AdrEvidenceResult> {
    const problems = predicateProblems(p);
    if (problems.length) throw new AdrEvidenceRefused(problems);
    return this.node(p, after);
  }

  /** A predicate already validated (a manifest's evidence). */
  async node(p: AdrPredicate, after: string | null): Promise<AdrEvidenceResult> {
    switch (p.kind) {
      case "all_of": return this.allOf(p.of ?? [], after);
      case "any_of": return this.anyOf(p.of ?? [], after);
      case "sequence": return this.sequence(p.of ?? [], after);
    }
    const leaf = this.leaves[p.kind];
    if (!leaf) throw new AdrEvidenceRefused([`predicate.kind: unknown kind ${JSON.stringify(p.kind)}`]);
    const key = JSON.stringify([p, after]);
    let r = this.leafCache.get(key);
    if (!r) {
      r = leaf(p, after).catch((e) => {
        if (e instanceof SourceError) return res("unknown", { reason: `${e.source} could not be read`, sources: [e.source] });
        throw e;
      });
      this.leafCache.set(key, r);
    }
    return r;
  }

  // ------------------------------------------------------------------ combinators

  private async allOf(of: AdrPredicate[], after: string | null): Promise<AdrEvidenceResult> {
    const rs: AdrEvidenceResult[] = [];
    for (const q of of) rs.push(await this.node(q, after));
    const refs = rs.flatMap((r) => r.refs);
    const pending = rs.flatMap((r) => r.pending_owner ?? []);
    const extra = (o: Partial<AdrEvidenceResult>) => ({ ...o, ...(pending.length ? { pending_owner: pending } : {}) });
    const unmet = rs.filter((r) => r.state === "open" || r.state === "not_measurable_yet");
    if (unmet.length) {
      // The weakest unmet state decides (not_measurable_yet below open: it cannot become proven by evidence alone).
      const state = unmet.some((r) => r.state === "not_measurable_yet") ? "not_measurable_yet" : "open";
      const earliest = unmet.reduce<string | null>((e, r) => later(e, r.earliest ?? null), null);
      return res(state, extra({ refs, reason: joinReasons(unmet), ...(earliest ? { earliest } : {}) }));
    }
    const unknown = rs.filter((r) => r.state === "unknown");
    if (unknown.length) return res("unknown", extra({ refs, reason: joinReasons(unknown), sources: unknown.flatMap((r) => r.sources ?? []) }));
    const state = rs.reduce<AdrEvidenceState>((s, r) => (RANK[r.state] < RANK[s] ? r.state : s), "proven");
    const at = rs.reduce<string | null>((a, r) => later(a, r.at), null);
    return res(state, extra({ at, refs, live: rs.some((r) => r.live), reason: joinReasons(rs.filter((r) => r.state !== "proven")) }));
  }

  private async anyOf(of: AdrPredicate[], after: string | null): Promise<AdrEvidenceResult> {
    const rs: AdrEvidenceResult[] = [];
    for (const q of of) rs.push(await this.node(q, after));
    const pending = rs.flatMap((r) => r.pending_owner ?? []);
    const extra = (o: Partial<AdrEvidenceResult>) => ({ ...o, ...(pending.length ? { pending_owner: pending } : {}) });
    const met = rs.filter((r) => isComplete(r.state));
    if (met.length) {
      const best = Math.max(...met.map((r) => RANK[r.state]));
      const top = met.filter((r) => RANK[r.state] === best);
      // A past event over a live check, then the earliest: proof that cannot flip back is preferred.
      const pick = [...top].sort((a, b) => Number(a.live) - Number(b.live) || String(a.at ?? "~").localeCompare(String(b.at ?? "~")))[0];
      return res(pick.state, { at: pick.at, refs: top.flatMap((r) => r.refs), live: pick.live, reason: pick.reason });
    }
    const unknown = rs.filter((r) => r.state === "unknown");
    if (unknown.length) return res("unknown", extra({ reason: joinReasons(unknown), sources: unknown.flatMap((r) => r.sources ?? []) }));
    const state = rs.some((r) => r.state === "open") ? "open" : "not_measurable_yet";
    const earliest = rs.reduce<string | null>((e, r) => sooner(e, r.earliest ?? null), null);
    return res(state, extra({ refs: rs.flatMap((r) => r.refs), reason: joinReasons(rs, " or "), ...(earliest ? { earliest } : {}) }));
  }

  /**
   * Proven when every item holds and each event happened after the one before (for example: approved, then
   * retired). An event item is looked up after the previous event's time, so the first matching chain is found; a
   * live item (a reading) only has to hold now.
   */
  private async sequence(of: AdrPredicate[], after: string | null): Promise<AdrEvidenceResult> {
    const rs: AdrEvidenceResult[] = [];
    let anchor = after ?? FIRST;
    for (let i = 0; i < of.length; i++) {
      const r = await this.node(of[i], anchor);
      rs.push(r);
      if (!isComplete(r.state)) {
        const reason = `step ${i + 1} of ${of.length}: ${r.reason ?? r.state}`;
        return res(r.state, { reason, refs: rs.flatMap((x) => x.refs), ...(r.earliest ? { earliest: r.earliest } : {}), ...(r.sources ? { sources: r.sources } : {}), ...(r.pending_owner ? { pending_owner: r.pending_owner } : {}) });
      }
      if (!r.live && r.at) anchor = r.at;
    }
    const state = rs.reduce<AdrEvidenceState>((s, r) => (RANK[r.state] < RANK[s] ? r.state : s), "proven");
    return res(state, { at: anchor === FIRST ? null : anchor, refs: rs.flatMap((r) => r.refs), live: rs.some((r) => r.live), reason: joinReasons(rs.filter((r) => r.state !== "proven")) });
  }

  // ------------------------------------------------------------------ leaves

  private readonly leaves: Record<string, Leaf> = {
    migration_applied: async (p, after) => {
      const name = String(p.name);
      const r = await this.row<{ name: string; applied_at: string }>("d1_migrations", "SELECT name, applied_at FROM d1_migrations WHERE name = ? LIMIT 1", [name]);
      if (!r) return open(`migration ${name} is not applied`, { live: false });
      const at = isoTime(r.applied_at);
      if (after && at && at <= after) return open(`migration ${name} was applied before the previous step${afterText(after)}`, { live: false });
      return proven(at, [evRef("d1_migrations", name, at)], false);
    },

    audit_event: async (p, after) => {
      const type = String(p.event_type);
      const n = typeof p.min_count === "number" ? p.min_count : 1;
      const where = ["event_type = ?"];
      const args: unknown[] = [type];
      if (typeof p.since === "string") { where.push("created_at >= ?"); args.push(p.since); }
      if (after) { where.push("created_at > ?"); args.push(after); }
      const payload = (p.payload ?? {}) as Record<string, string | number | boolean>;
      for (const [path, value] of Object.entries(payload)) { where.push("json_extract(payload_json, ?) = ?"); args.push(path, typeof value === "boolean" ? (value ? 1 : 0) : value); }
      const rows = await this.rows<{ event_id: string; created_at: string }>("audit_events",
        `SELECT event_id, created_at FROM audit_events WHERE ${where.join(" AND ")} ORDER BY created_at ${after ? "ASC" : "DESC"} LIMIT ?`, [...args, n]);
      const cond = `${Object.keys(payload).length ? ` with ${Object.entries(payload).map(([k, v]) => `${k} = ${v}`).join(", ")}` : ""}${typeof p.since === "string" ? ` since ${p.since}` : ""}${afterText(after)}`;
      if (rows.length < n) return open(n === 1 ? `no ${type} event${cond}` : `${rows.length} of ${n} ${type} events${cond}`, { live: false, refs: rows.map((r) => evRef("audit", r.event_id, isoTime(r.created_at))) });
      const at = isoTime(after ? rows[n - 1].created_at : rows[0].created_at);
      return proven(at, rows.slice(0, 3).map((r) => evRef("audit", r.event_id, isoTime(r.created_at))), false);
    },

    quiet_window: async (p) => {
      const hours = Number(p.hours);
      const success = String(p.success_type);
      let fail: { event_id: string; created_at: string; event_type: string } | null = null;
      for (const t of p.fail_types as string[]) {
        const r = await this.row<{ event_id: string; created_at: string }>("audit_events",
          "SELECT event_id, created_at FROM audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1", [t]);
        if (r && (!fail || r.created_at > fail.created_at)) fail = { ...r, event_type: t };
      }
      // The clean window starts at the newest failure, or, when there was none, at the first success.
      const ok = fail
        ? await this.row<{ event_id: string; created_at: string }>("audit_events",
          "SELECT event_id, created_at FROM audit_events WHERE event_type = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1", [success, fail.created_at])
        : await this.row<{ event_id: string; created_at: string }>("audit_events",
          "SELECT event_id, created_at FROM audit_events WHERE event_type = ? ORDER BY created_at ASC LIMIT 1", [success]);
      const failAt = fail ? isoTime(fail.created_at) : null;
      const refs = [...(ok ? [evRef("audit", ok.event_id, isoTime(ok.created_at))] : []), ...(fail ? [evRef("audit", fail.event_id, failAt)] : [])];
      if (!ok) return open(fail ? `no ${success} since ${fail.event_type} at ${failAt}` : `no ${success} yet`, { refs });
      const start = Date.parse(failAt ?? isoTime(ok.created_at) ?? "");
      if (!Number.isFinite(start)) return open("the window's start time is not readable", { refs });
      const earliest = new Date(start + hours * HOUR_MS).toISOString();
      if (this.nowIso < earliest) {
        const why = fail ? `${fail.event_type} at ${failAt}, less than ${hours} h ago` : `the first ${success} is less than ${hours} h old`;
        return open(why, { refs, earliest });
      }
      return proven(later(earliest, isoTime(ok.created_at)), refs, true);
    },

    deploy_step: async (p, after) => {
      const where = ["d.status = 'succeeded'"];
      const args: unknown[] = [];
      if (typeof p.since === "string") { where.push("d.created_at >= ?"); args.push(p.since); }
      if (after) { where.push("d.created_at > ?"); args.push(after); }
      where.push("json_valid(d.details_json)");
      if (typeof p.executor === "string") { where.push("json_extract(d.details_json, '$.executor') = ?"); args.push(p.executor); }
      // An exact step or an exact suffix (substr, never LIKE: ADR-0015 §7).
      if (typeof p.step === "string") { where.push("EXISTS (SELECT 1 FROM json_each(d.details_json, '$.outcome.steps') s WHERE s.value = ?)"); args.push(p.step); }
      else { const sfx = String(p.step_suffix); where.push("EXISTS (SELECT 1 FROM json_each(d.details_json, '$.outcome.steps') s WHERE substr(s.value, -?) = ?)"); args.push(sfx.length, sfx); }
      const r = await this.row<{ request_id: string; updated_at: string }>("deployment_requests",
        `SELECT d.request_id, d.updated_at FROM deployment_requests d WHERE ${where.join(" AND ")} ORDER BY d.created_at ${after ? "ASC" : "DESC"} LIMIT 1`, args);
      const step = typeof p.step === "string" ? `step ${p.step}` : `a step ending ${String(p.step_suffix)}`;
      if (!r) return open(`no succeeded deploy${typeof p.executor === "string" ? ` by ${p.executor}` : ""} has ${step}${afterText(after)}`, { live: false });
      const at = isoTime(r.updated_at);
      return proven(at, [evRef("deployment", r.request_id, at, "outcome.steps")], false);
    },

    merged_and_deployed: async (p, after) => {
      const unit = DEPLOY_UNITS.find((u) => u.unit === p.unit)!;
      const cr = typeof p.cr_id === "string"
        ? await this.row<{ cr_id: string; status: string; outcome_at: string | null }>("forge_change_requests",
          "SELECT cr_id, status, outcome_at FROM forge_change_requests WHERE cr_id = ? LIMIT 1", [p.cr_id])
        : await this.row<{ cr_id: string; status: string; outcome_at: string | null }>("forge_change_requests",
          "SELECT cr_id, status, outcome_at FROM forge_change_requests WHERE status = 'merged' AND source_branch = ? ORDER BY updated_at DESC LIMIT 1", [p.branch]);
      const label = typeof p.cr_id === "string" ? `change request ${p.cr_id}` : `branch ${String(p.branch)}`;
      if (!cr || cr.status !== "merged" || !cr.outcome_at) return open(`${label} is not merged`, { live: false, ...(cr ? { refs: [evRef("forge.change", cr.cr_id, null, "status")] } : {}) });
      const mergedAt = isoTime(cr.outcome_at)!;
      if (after && mergedAt <= after) return open(`${label} was merged before the previous step${afterText(after)}`, { live: false });
      const services = unit.services as readonly string[];
      const d = await this.row<{ request_id: string; service_id: string; created_at: string }>("deployment_requests",
        `SELECT request_id, service_id, created_at FROM deployment_requests WHERE status = 'succeeded' AND created_at > ? AND service_id IN (${services.map(() => "?").join(", ")}) ORDER BY created_at ASC LIMIT 1`,
        [cr.outcome_at, ...services]);
      const mergeRef = evRef("forge.change", cr.cr_id, mergedAt);
      if (!d) return open(`${label} is merged; no succeeded deploy of ${unit.unit} since`, { live: false, refs: [mergeRef] });
      const at = isoTime(d.created_at);
      return proven(at, [mergeRef, evRef("deployment", d.request_id, at)], false);
    },

    census_clean: async (p) => {
      const maxAge = typeof p.max_age_h === "number" ? p.max_age_h : 1;
      const r = await this.row<{ main_sha: string; status: string; taken_at: string }>("forge_organism_census",
        "SELECT main_sha, status, taken_at FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1", []);
      if (!r) return open("no organism census is recorded");
      const at = isoTime(r.taken_at);
      const refs = [evRef("forge.census", r.main_sha, at, "status")];
      if (r.status !== "consistent") return open(`the newest census (${r.main_sha.slice(0, 12)}) is ${r.status}`, { refs });
      if (!at || this.now - Date.parse(at) > maxAge * HOUR_MS) return open(`the newest census is older than ${maxAge} h`, { refs });
      return proven(at, refs, true);
    },

    observer: async (p) => {
      const expect = p.expect === "none" ? "none" : "some";
      const since = typeof p.since === "string" ? p.since : null;
      let hit: { ref: string; at: string | null } | null = null;
      let what: string;
      if (p.source === "findings") {
        const where: string[] = [];
        const args: unknown[] = [];
        if (typeof p.kind_filter === "string") { where.push("kind = ?"); args.push(p.kind_filter); }
        where.push("created_at >= ?"); args.push(since ?? "");
        if (typeof p.worker === "string") { where.push("worker = ?"); args.push(p.worker); }
        if (typeof p.metric === "string") { where.push("metric = ?"); args.push(p.metric); }
        const r = await this.row<{ finding_id: string; created_at: string }>("observer_findings",
          `SELECT finding_id, created_at FROM observer_findings WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 1`, args);
        if (r) hit = { ref: evRef("observer.finding", r.finding_id, isoTime(r.created_at)), at: isoTime(r.created_at) };
        what = `an Observer ${typeof p.kind_filter === "string" ? `${p.kind_filter} ` : ""}finding${typeof p.worker === "string" ? ` on ${p.worker}` : ""}${typeof p.metric === "string" ? ` for ${p.metric}` : ""}`;
      } else if (p.source === "runs") {
        const r = await this.row<{ run_id: string; ran_at: string }>("observer_runs",
          "SELECT run_id, ran_at FROM observer_runs WHERE kind = ? AND ran_at >= ? AND status = 'ok' ORDER BY ran_at DESC LIMIT 1", [p.kind_filter, since ?? ""]);
        if (r) hit = { ref: evRef("observer.run", r.run_id, isoTime(r.ran_at)), at: isoTime(r.ran_at) };
        what = `a successful Observer ${String(p.kind_filter)} run`;
      } else {
        const subject = String(p.subject ?? p.worker);
        const kindSql = typeof p.kind_filter === "string" ? " AND kind = ?" : "";
        const r = await this.row<{ hour: string }>("observer_vitals",
          `SELECT hour FROM observer_vitals WHERE subject = ? AND hour >= ?${kindSql} ORDER BY hour DESC LIMIT 1`,
          [subject, since ?? "", ...(kindSql ? [p.kind_filter] : [])]);
        if (r) hit = { ref: evRef("observer.vitals", subject, isoTime(r.hour)), at: isoTime(r.hour) };
        what = `Observer vitals for ${subject}`;
      }
      const window = since ? ` since ${since}` : "";
      if (expect === "some") return hit ? proven(hit.at, [hit.ref], p.source === "vitals") : open(`no ${what}${window}`, { live: p.source === "vitals" });
      return hit ? open(`${what}${window} exists`, { refs: [hit.ref] }) : proven(this.nowIso, [], true, { reason: `no ${what}${window}` });
    },

    kpi_threshold: async (p) => {
      const since = new Date(this.now - Number(p.max_age_h) * HOUR_MS).toISOString();
      const metric = String(p.metric);
      let value: number | null = null;
      let ref: string | null = null;
      let at: string | null = null;
      if (p.source === "report_metric") {
        const rows = await this.rows<{ report_id: string; body_json: string; created_at: string }>("agent_reports",
          "SELECT report_id, body_json, created_at FROM agent_reports WHERE agent_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 20", [p.agent_id, since]);
        for (const r of rows) {
          let body: unknown;
          try { body = JSON.parse(r.body_json); } catch { continue; }
          const b = body as { schema?: unknown; metrics?: unknown };
          if (b?.schema !== p.body_schema || !Array.isArray(b.metrics)) continue;
          const m = (b.metrics as Record<string, unknown>[]).find((x) => x && (x.metric ?? x.name) === metric);
          at = isoTime(r.created_at);
          ref = evRef("report", r.report_id, at, `metrics.${metric}`);
          value = typeof m?.value === "number" && Number.isFinite(m.value) ? m.value : null;
          break;
        }
        if (!ref) return open(`no ${String(p.body_schema)} report by ${String(p.agent_id)} in the last ${String(p.max_age_h)} h`);
      } else {
        // The column comes from VITAL_COLUMNS (checked by adrEvidenceProblems), never from the manifest's text.
        const col = VITAL_COLUMNS.find((c) => c === metric)!;
        const kindSql = typeof p.kind_filter === "string" ? " AND kind = ?" : "";
        const r = await this.row<{ hour: string; value: number | null }>("observer_vitals",
          `SELECT hour, ${col} AS value FROM observer_vitals WHERE subject = ? AND hour >= ?${kindSql} ORDER BY hour DESC LIMIT 1`,
          [p.subject, since, ...(kindSql ? [p.kind_filter] : [])]);
        if (!r) return open(`no Observer vitals for ${String(p.subject)} in the last ${String(p.max_age_h)} h`);
        at = isoTime(r.hour);
        ref = evRef("observer.vitals", String(p.subject), at, col);
        value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
      }
      const target = Number(p.value);
      if (value === null) return open(`${metric} has no value`, { refs: [ref] });
      const holds = p.op === ">=" ? value >= target : p.op === "<=" ? value <= target : value === target;
      return holds ? proven(at, [ref], true, { reason: `${metric} = ${value}` }) : open(`${metric} = ${value}, needs ${String(p.op)} ${target}`, { refs: [ref] });
    },

    consensus_executed: async (p, after) => {
      const action = String(p.action);
      const where = ["p.action = ?", "p.status = 'executed'"];
      const args: unknown[] = [action];
      if (typeof p.target === "string") { where.push("p.target = ?"); args.push(p.target); }
      if (typeof p.since === "string") { where.push("p.decided_at >= ?"); args.push(p.since); }
      if (after) { where.push("p.decided_at > ?"); args.push(after); }
      const join = p.owner_approved === true ? " JOIN consensus_owner_decisions o ON o.proposal_id = p.proposal_id AND o.decision = 'approve'" : "";
      const r = await this.row<{ proposal_id: string; decided_at: string }>("consensus_proposals",
        `SELECT p.proposal_id, p.decided_at FROM consensus_proposals p${join} WHERE ${where.join(" AND ")} ORDER BY p.decided_at ${after ? "ASC" : "DESC"} LIMIT 1`, args);
      if (r) { const at = isoTime(r.decided_at); return proven(at, [evRef("consensus", r.proposal_id, at)], false); }
      const pend = typeof p.target === "string"
        ? await this.rows<PendingOwner>("consensus_proposals",
          "SELECT proposal_id, action, target, created_at FROM consensus_proposals WHERE action = ? AND target = ? AND status = 'pending_owner' ORDER BY created_at DESC LIMIT 3", [action, p.target])
        : await this.rows<PendingOwner>("consensus_proposals",
          "SELECT proposal_id, action, target, created_at FROM consensus_proposals WHERE status = 'pending_owner' AND action = ? ORDER BY created_at DESC LIMIT 3", [action]);
      const what = `no executed ${action}${typeof p.target === "string" ? ` on ${p.target}` : ""}${p.owner_approved === true ? " approved by the owner" : ""}${typeof p.since === "string" ? ` since ${p.since}` : ""}${afterText(after)}`;
      return open(what, { live: false, refs: pend.map((x) => evRef("consensus", x.proposal_id, isoTime(x.created_at), "status")), ...(pend.length ? { pending_owner: pend.map((x) => ({ ...x })) } : {}) });
    },

    agent_registered: async (p) => {
      const want = typeof p.status === "string" ? p.status : "enabled";
      const r = await this.row<{ agent_id: string; status: string; updated_at: string }>("agents", "SELECT agent_id, status, updated_at FROM agents WHERE agent_id = ? LIMIT 1", [p.agent_id]);
      if (!r) return open(`agent ${String(p.agent_id)} is not registered`);
      const at = isoTime(r.updated_at);
      const refs = [evRef("agent", r.agent_id, at, "status")];
      return r.status === want ? proven(at, refs, true) : open(`agent ${r.agent_id} is ${r.status}, not ${want}`, { refs });
    },

    reading: async (p, after) => {
      const name = p.name as (typeof ADR_READINGS)[number];
      return this.readings[name](after);
    },

    doc_asserted: async (p) => {
      const ref = String(p.ref);
      const text = await this.file(ref);
      if (text === null) return open(`${ref} does not exist`);
      if (!text.includes(String(p.quote))) return open(`the quote is not in ${ref}`);
      return res("doc_asserted", { refs: [evRef("doc", ref, null, "quote")], reason: `stated in ${ref}` });
    },

    external_asserted: async (p) => res("external_asserted", {
      at: isoTime(p.as_of) ?? String(p.as_of), refs: [evRef(`external.${String(p.source).replace(/[^a-z0-9_.-]/g, "-")}`, encodeURIComponent(String(p.ref)), String(p.as_of))],
      reason: `stated by ${String(p.source)} as of ${String(p.as_of)}`,
    }),

    not_measurable_yet: async (p) => res("not_measurable_yet", { reason: String(p.reason) }),
  };

  // ------------------------------------------------------------------ the named readings (§3)

  /** Each named reading: a short query on an existing table. A new reading is added here and in ADR_READINGS. */
  readonly readings: Record<(typeof ADR_READINGS)[number], (after: string | null) => Promise<AdrEvidenceResult>> = {
    forge_merge_path: async () => {
      const r = await this.row<{ value: string; updated_at: string }>("forge_controls", "SELECT value, updated_at FROM forge_controls WHERE control = 'merge_path' LIMIT 1", []);
      if (!r) return open("forge_controls has no merge_path row");
      const at = isoTime(r.updated_at);
      const refs = [evRef("forge.control", "merge_path", at, "value")];
      return r.value === "forge" ? proven(at, refs, true) : open(`the merge path is ${r.value}`, { refs });
    },

    forge_work_cr_merged: async (after) => {
      const r = after
        ? await this.row<{ cr_id: string; outcome_at: string | null }>("forge_change_requests",
          "SELECT cr_id, outcome_at FROM forge_change_requests WHERE source = 'forge' AND status = 'merged' AND outcome_at > ? ORDER BY outcome_at ASC LIMIT 1", [after])
        : await this.row<{ cr_id: string; outcome_at: string | null }>("forge_change_requests",
          "SELECT cr_id, outcome_at FROM forge_change_requests WHERE source = 'forge' AND status = 'merged' ORDER BY outcome_at ASC LIMIT 1", []);
      if (!r) return open(`no change request from platform-work is merged${afterText(after)}`, { live: false });
      const at = isoTime(r.outcome_at);
      return proven(at, [evRef("forge.change", r.cr_id, at, "status")], false);
    },

    git_backup_verified_48h: async () => {
      // The newest verification, as control-plane-shared/src/git-backup.ts reads it (index on verified_at).
      const r = await this.row<{ run_id: string; verified_at: string; verify_status: string | null }>("forge_git_backups",
        "SELECT run_id, verified_at, verify_status FROM forge_git_backups WHERE verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1", []);
      if (!r) return open("no git backup has been verified");
      const at = isoTime(r.verified_at);
      const refs = [evRef("forge.git_backup", r.run_id, at, "verify_status")];
      if (r.verify_status !== "verified") return open(`the newest verification is ${r.verify_status ?? "unset"}`, { refs });
      if (!at || this.now - Date.parse(at) > 48 * HOUR_MS) return open("the newest verified git backup is older than 48 h", { refs });
      return proven(at, refs, true);
    },

    dependency_audit_fresh_48h: async () => {
      // The newest completed audit (status 'ok': a failed run audited nothing) in the last 48 h, by the ran_at index.
      const r = await this.row<{ run_id: string; ran_at: string }>("forge_dependency_audits",
        "SELECT run_id, ran_at FROM forge_dependency_audits WHERE ran_at >= ? AND status = 'ok' ORDER BY ran_at DESC LIMIT 1", [new Date(this.now - 48 * HOUR_MS).toISOString()]);
      if (!r) return open("no dependency audit completed in the last 48 h");
      const at = isoTime(r.ran_at);
      return proven(at, [evRef("forge.dependency_audit", r.run_id, at)], true);
    },

    vision_valid: async () => {
      // No D1: the vision the kernel bundles, checked as ai-kernel/src/vision-view.ts checks it.
      const path = "organism/vision.json";
      const text = await this.file(path);
      if (text === null) return open(`${path} does not exist`);
      let v: unknown;
      try { v = JSON.parse(text); } catch { return open(`${path} is not JSON`); }
      const problems = visionProblems(v);
      const refs = [evRef("doc", path, null, "status")];
      return problems.length ? open(`the vision is invalid: ${problems[0]}`, { refs }) : proven(null, refs, true);
    },

    drift_in_sync_all: async () => {
      // Every service not disabled, by its newest observation (the (service_id, observed_at) index, as drift-state.ts).
      const services = await this.rows<{ service_id: string }>("service_registry",
        "SELECT service_id FROM service_registry WHERE status != 'disabled' ORDER BY service_id LIMIT 100", []);
      if (!services.length) return open("no service is registered");
      const refs: string[] = [];
      const drifted: string[] = [];
      const unseen: string[] = [];
      let at: string | null = null;
      for (const s of services) {
        const o = await this.row<{ observation_id: string; drifted: number; observed_at: string }>("drift_observations",
          "SELECT observation_id, drifted, observed_at FROM drift_observations WHERE service_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1", [s.service_id]);
        if (!o) { unseen.push(s.service_id); continue; }
        const t = isoTime(o.observed_at);
        refs.push(evRef("drift", o.observation_id, t, "drifted"));
        if (o.drifted !== 0) drifted.push(s.service_id); else at = later(at, t);
      }
      if (drifted.length || unseen.length) {
        return open([drifted.length ? `drifted: ${drifted.join(", ")}` : "", unseen.length ? `never observed: ${unseen.join(", ")}` : ""].filter(Boolean).join("; "), { refs });
      }
      return proven(at, refs, true);
    },

    adr_index_live: async () => {
      const r = await this.row<{ status: string; updated_at: string }>("agents", "SELECT status, updated_at FROM agents WHERE agent_id = 'adr-steward' LIMIT 1", []);
      if (!r) return open("the ADR Steward is not registered");
      const refs = [evRef("agent", "adr-steward", isoTime(r.updated_at), "status")];
      if (r.status !== "enabled") return open(`the ADR Steward is ${r.status}`, { refs });
      // The adr_progress table comes with step 3 (§4.6); until it is migrated its rows cannot be counted.
      return res("not_measurable_yet", { refs, reason: "adr_progress is not migrated yet (ADR Steward step 3)" });
    },

    orchestrator_github_fallback_absent: async () => {
      const read = this.deps.githubFallback;
      if (!read) return res("not_measurable_yet", { reason: "no read-only DeployRpc method serves the Orchestrator's github_fallback yet" });
      let v: string | null;
      try { v = await read(); } catch (e) { throw new SourceError("deployment-orchestrator:/ready", e); }
      const refs = [evRef("deployment-orchestrator", "ready", this.nowIso, "github_fallback")];
      return v === "absent" ? proven(this.nowIso, refs, true) : open(`the Orchestrator's github_fallback is ${v ?? "not reported"}`, { refs });
    },
  };
}

function joinReasons(rs: AdrEvidenceResult[], sep = "; "): string | null {
  const out: string[] = [];
  for (const r of rs) if (r.reason && !out.includes(r.reason)) out.push(r.reason);
  return out.length ? out.join(sep) : null;
}

// ---------------------------------------------------------------------------------------------------- one predicate

/** Evaluate one predicate tree on its own. An unknown kind or invalid field is refused before any query. */
export async function evaluatePredicate(p: AdrPredicate, deps: AdrEvidenceDeps): Promise<AdrEvidenceResult> {
  return new AdrEvidenceContext(deps).evaluate(p);
}

// ---------------------------------------------------------------------------------------------------- per ADR (§4.4)

export type AdrStatus = "not_started" | "in_progress" | "done" | "superseded" | "held" | "planned";
export type AdrDrift = "doc_behind" | "doc_ahead";

export interface AdrPhaseEvaluation {
  id: string;
  group: string | null;
  title: string;
  weight: number;
  state: AdrEvidenceState;
  reason: string | null;
  refs: string[];
  at: string | null;
  live: boolean;
  earliest: string | null;
  depends_on: string[];
  /** This phase's blockers, when it is not complete (§4.4 step 5.4). */
  blockers: string[];
  built: boolean;
  doc_claim: { state: string; ref: string; quote_found: boolean | null } | null;
  /** §4.8: machine proof the document has not caught up with, or a document ahead of open evidence. */
  drift: AdrDrift | null;
  next: string | null;
  note: string | null;
  pending_owner: PendingOwner[];
}

export interface AdrOwnerAction { phase: string; text: string; href: string | null; outside_platform: boolean; proposal_id: string | null }

export interface AdrEvaluation {
  schema: "adr.evaluation.v1";
  adr: string;
  valid: true;
  title: string;
  lifecycle: AdrManifest["lifecycle"];
  deferred: boolean;
  superseded_by: string | null;
  scope: string;
  status: AdrStatus;
  phases_total: number;
  /** X of "X of Y": proven plus asserted. */
  phases_complete: number;
  phases_proven: number;
  phases_asserted: number;
  phases_doc_asserted: number;
  phases_external_asserted: number;
  /** Weighted (proven + asserted) / weighted total, and weighted proven / weighted total, as whole numbers. */
  percent: number;
  percent_proven: number;
  phases: AdrPhaseEvaluation[];
  /** The phases that are not complete, in manifest order, each with its blockers. */
  open: { phase: string; state: AdrEvidenceState; reason: string | null; blockers: string[] }[];
  blockers: string[];
  next_step: { phase: string; text: string } | null;
  owner_actions: AdrOwnerAction[];
  drift: { phase: string; kind: AdrDrift; doc_ref: string; doc_state: string; computed_state: AdrEvidenceState; refs: string[] }[];
  /** A source could not be read: the Steward keeps those phases' stored states (§3). */
  stale: boolean;
  stale_sources: string[];
  evaluated_at: string;
}

export interface AdrInvalid { schema: "adr.evaluation.v1"; adr: string | null; valid: false; status: "invalid"; problems: string[] }

type Evaluated = { m: AdrManifest; phases: { ph: AdrPhase; r: AdrEvidenceResult; claim: boolean | null }[] };

async function evaluatePhases(m: AdrManifest, ctx: AdrEvidenceContext): Promise<Evaluated> {
  const phases: Evaluated["phases"] = [];
  for (const ph of m.phases) {
    const r = await ctx.node(ph.evidence, null);
    let claim: boolean | null = null;
    if (ph.doc_claim) {
      try { const t = await ctx.file(ph.doc_claim.ref); claim = t !== null && t.includes(ph.doc_claim.quote); } catch { claim = null; }
    }
    phases.push({ ph, r, claim });
  }
  return { m, phases };
}

function summarize(e: Evaluated, complete: (dep: string) => boolean | null, nowIso: string): AdrEvaluation {
  const { m } = e;
  const dep = (d: string) => (d.includes(":") ? d : `${m.adr}:${d}`);
  const phases: AdrPhaseEvaluation[] = e.phases.map(({ ph, r, claim }) => {
    const done = isComplete(r.state);
    const blockers: string[] = [];
    if (!done) {
      blockers.push(`${ph.id}: ${r.reason ?? r.state}`);
      for (const p of r.pending_owner ?? []) blockers.push(`${ph.id}: waits for the owner's click (${p.proposal_id})`);
      for (const d of ph.depends_on ?? []) {
        const c = complete(dep(d));
        if (c !== true) blockers.push(`${ph.id}: depends on ${d}${c === null ? " (not evaluated)" : ""}`);
      }
      if (r.earliest) blockers.push(`${ph.id}: earliest ${minuteUtc(r.earliest)}`);
    }
    let drift: AdrDrift | null = null;
    if (ph.doc_claim) {
      if (r.state === "proven" && ph.doc_claim.state !== "done") drift = "doc_behind";
      else if (ph.doc_claim.state === "done" && (r.state === "open" || r.state === "not_measurable_yet")) drift = "doc_ahead";
    }
    return {
      id: ph.id, group: ph.group ?? null, title: ph.title, weight: ph.weight ?? 1, state: r.state, reason: r.reason, refs: r.refs, at: r.at,
      live: r.live, earliest: r.earliest ?? null, depends_on: ph.depends_on ?? [], blockers, built: Array.isArray(ph.built) && ph.built.length > 0,
      doc_claim: ph.doc_claim ? { state: ph.doc_claim.state, ref: ph.doc_claim.ref, quote_found: claim } : null, drift,
      next: ph.next ?? null, note: ph.note ?? null, pending_owner: r.pending_owner ?? [],
    };
  });
  const count = (f: (p: AdrPhaseEvaluation) => boolean) => phases.filter(f).length;
  const weight = (f: (p: AdrPhaseEvaluation) => boolean) => phases.filter(f).reduce((n, p) => n + p.weight, 0);
  const total = weight(() => true);
  const proven = count((p) => p.state === "proven");
  const docA = count((p) => p.state === "doc_asserted");
  const extA = count((p) => p.state === "external_asserted");
  const completeN = proven + docA + extA;
  const pct = (w: number) => (total ? Math.round((100 * w) / total) : 0);
  const lifecycleStatus: AdrStatus | null = m.lifecycle === "superseded" || m.lifecycle === "held" || m.lifecycle === "planned" ? m.lifecycle : null;
  const status: AdrStatus = lifecycleStatus ?? (phases.length > 0 && completeN === phases.length ? "done" : completeN === 0 ? "not_started" : "in_progress");
  const openPhases = phases.filter((p) => !isComplete(p.state));
  const nextPhase = openPhases.find((p) => p.depends_on.every((d) => complete(dep(d)) === true));
  const ownerActions: AdrOwnerAction[] = [];
  for (const p of openPhases) {
    const ph = m.phases.find((x) => x.id === p.id)!;
    for (const x of p.pending_owner) ownerActions.push({ phase: p.id, text: `Approve ${x.action} on ${x.target}`, href: "#/consensus", outside_platform: false, proposal_id: x.proposal_id });
    if (ph.owner_action) ownerActions.push({ phase: p.id, text: ph.owner_action.text, href: ph.owner_action.href ?? null, outside_platform: ph.owner_action.outside_platform === true, proposal_id: null });
  }
  const unknownSources = [...new Set(e.phases.flatMap(({ r }) => (r.state === "unknown" ? r.sources ?? [] : [])))];
  return {
    schema: "adr.evaluation.v1", adr: m.adr, valid: true, title: m.title, lifecycle: m.lifecycle, deferred: m.lifecycle === "deferred",
    superseded_by: m.superseded_by ?? null, scope: m.scope ?? "platform", status,
    phases_total: phases.length, phases_complete: completeN, phases_proven: proven, phases_asserted: docA + extA,
    phases_doc_asserted: docA, phases_external_asserted: extA,
    percent: pct(weight((p) => isComplete(p.state))), percent_proven: pct(weight((p) => p.state === "proven")),
    phases,
    open: openPhases.map((p) => ({ phase: p.id, state: p.state, reason: p.reason, blockers: p.blockers })),
    blockers: openPhases.flatMap((p) => p.blockers),
    next_step: nextPhase ? { phase: nextPhase.id, text: nextPhase.next ?? nextPhase.title } : null,
    owner_actions: ownerActions,
    drift: phases.filter((p) => p.drift).map((p) => ({ phase: p.id, kind: p.drift!, doc_ref: p.doc_claim!.ref, doc_state: p.doc_claim!.state, computed_state: p.state, refs: p.refs })),
    stale: unknownSources.length > 0 || phases.some((p) => p.state === "unknown"),
    stale_sources: unknownSources,
    evaluated_at: nowIso,
  };
}

/**
 * Evaluate every manifest in one pass (§4.4 step 5): each phase's state, then each ADR's status, counts, percent,
 * open items with their blockers, next step and owner actions. A dependency on another ADR's phase ("0016:T1")
 * resolves against the manifests of the same call. An invalid manifest is reported with its problems and never
 * computed (no query is made for it).
 */
export async function evaluateAdrManifests(manifests: readonly unknown[], deps: AdrEvidenceDeps): Promise<(AdrEvaluation | AdrInvalid)[]> {
  const ctx = new AdrEvidenceContext(deps);
  const done: (Evaluated | AdrInvalid)[] = [];
  for (const raw of manifests) {
    const problems = adrEvidenceProblems(raw);
    if (problems.length) {
      const id = typeof (raw as { adr?: unknown })?.adr === "string" ? (raw as { adr: string }).adr : null;
      done.push({ schema: "adr.evaluation.v1", adr: id, valid: false, status: "invalid", problems });
      continue;
    }
    done.push(await evaluatePhases(raw as AdrManifest, ctx));
  }
  const states = new Map<string, boolean>();
  for (const d of done) if ("m" in d) for (const { ph, r } of d.phases) states.set(`${d.m.adr}:${ph.id}`, isComplete(r.state));
  const complete = (key: string) => states.get(key) ?? null;
  return done.map((d) => ("m" in d ? summarize(d, complete, ctx.nowIso) : d));
}

/** Evaluate one manifest (a dependency on another ADR reads "not evaluated"). */
export async function evaluateAdrManifest(manifest: unknown, deps: AdrEvidenceDeps): Promise<AdrEvaluation | AdrInvalid> {
  return (await evaluateAdrManifests([manifest], deps))[0];
}
