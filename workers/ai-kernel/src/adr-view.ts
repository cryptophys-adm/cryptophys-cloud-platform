/**
 * The ADR Steward's read API (docs/design/ADR-STEWARD.md §5, §11 row 4; owner 2026-11-16, "ya semua, sesuai
 * rekomendasimu"): `GET /v1/adr` and `GET /v1/adr/{id}` on the AI Kernel, for the Vision page's ADR panel.
 *
 * Read-only, as `GET /v1/vision` (vision-view.ts) is: the kernel serves these after requireOperator, so operators,
 * owners and viewer accounts read them, and nothing here writes D1, the audit chain or the Durable Object.
 *  - Every value comes from what the Steward stored (`adr_progress`, `adr_progress_history`, migration 0075), from the
 *    agents table and the kill switch, or from the Steward's Durable Object state. Nothing is computed or defaulted here.
 *  - Before the first pass the table is empty: `available: true` with no rows. Without the table (migration 0075 not
 *    applied yet) the list is `available: false` with no rows (§4.9). A value that is not measured is null, never 0.
 *  - Bounded reads: the list is one query by primary key (LIMIT 200, about 20 rows); one ADR is one row by primary
 *    key and its newest 10 history rows by (adr_id, revision).
 */
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { ADR_ID } from "../../control-plane-shared/src/adr-progress.ts";
import type { AdrOwnerAction } from "../../control-plane-shared/src/adr-evidence.ts";
import { ADR_AI_DAILY_CAP, ADR_STEWARD_ID, aiUsedOn, type AdrExplanationJson, type AdrProgressDoc, type StewardState } from "./adr-steward.ts";

export const ADR_VIEW_SCHEMA = "adr.progress-view.v1";
/** §5: a plain D1 read, cached privately for a minute. */
export const ADR_CACHE_CONTROL = "private, max-age=60";
/** §5: the list shows the first three blockers; the detail shows the newest ten history entries. */
export const LIST_BLOCKERS = 3;
export const DETAIL_HISTORY = 10;
const LIST_LIMIT = 200;

/** Whether `{id}` of `GET /v1/adr/{id}` is well formed: four digits (the adr_progress CHECK). */
export const validAdrId = (id: string): boolean => ADR_ID.test(id);

/** The Durable Object's read RPC (worker.ts AdrStewardAgent.state). */
export interface AdrStewardStateStub { state(): Promise<StewardState> }
export interface AdrViewEnv {
  DB: D1Database;
  ADR_STEWARD?: { idFromName(name: string): unknown; get(id: unknown): unknown };
  CF_VERSION_METADATA?: { id?: string; tag?: string };
}

/** `enabled`, or why the Steward does not run (§4.9): suspended, the kill switch off, or not registered yet. */
export type StewardStatus = "enabled" | "suspended" | "agents_disabled" | "not_registered";

export interface AdrStewardView {
  agent_id: typeof ADR_STEWARD_ID;
  status: StewardStatus;
  last_pass_at: string | null;
  /** Every pass evaluates every bundled manifest (adr-steward.ts runAdrStewardCycle), so it equals last_pass_at. */
  last_full_pass_at: string | null;
  /** The commit this kernel runs (CF_VERSION_METADATA.tag), or null where it is not reported. */
  deployed_commit: string | null;
  /**
   * The AI explanation's use on the current UTC day and its daily cap (design step 6, §7), from the Steward's Durable
   * Object counter. Both null when that state cannot be read: not known, never 0.
   */
  ai_today: { used: number | null; cap: number | null };
}

export interface AdrListEntry {
  adr: string;
  title: string | null;
  lifecycle: string;
  deferred: boolean | null;
  /** The ADR that replaces this one, for the panel's "superseded by ADR-NNNN" (step 5); null when none is named. */
  superseded_by: string | null;
  status: string;
  phases_total: number;
  phases_proven: number;
  phases_asserted: number;
  percent: number;
  percent_proven: number;
  next_step: AdrProgressDoc["next_step"];
  blockers: string[] | null;
  owner_actions: AdrOwnerAction[] | null;
  drift_count: number | null;
  stale: boolean | null;
  revision: number;
  changed_at: string;
  explanation: AdrExplanationJson | null;
}

export interface AdrListView {
  schema: typeof ADR_VIEW_SCHEMA;
  /** False only when adr_progress cannot be found (migration 0075 not applied). An empty table is available, with no rows. */
  available: boolean;
  steward: AdrStewardView;
  adrs: AdrListEntry[];
}

export interface AdrHistoryEntry { revision: number; status: string; percent: number; created_at: string }
/** The stored adr.progress-doc.v1 body, as written, with the row's revision and time, its explanation and history. */
export type AdrDetailView = AdrProgressDoc & { revision: number; changed_at: string; explanation: AdrExplanationJson | null; history: AdrHistoryEntry[] };

interface ProgressRow {
  adr_id: string; revision: number; lifecycle: string; status: string; phases_total: number; phases_proven: number; phases_asserted: number;
  percent: number; percent_proven: number; body_json: string; explanation_json: string | null; changed_at: string;
}
const ROW_COLUMNS = "adr_id, revision, lifecycle, status, phases_total, phases_proven, phases_asserted, percent, percent_proven, body_json, explanation_json, changed_at";

const parsed = <T>(text: string | null): T | null => {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
};
const missingTable = (err: unknown) => /no such table: adr_progress/.test(String((err as Error)?.message ?? err));

async function stewardView(env: AdrViewEnv, now: number): Promise<AdrStewardView> {
  const agent = await getAgent(env.DB, ADR_STEWARD_ID);
  const status: StewardStatus = !agent ? "not_registered" : !(await agentsEnabled(env.DB)) ? "agents_disabled" : agent.status !== "enabled" ? "suspended" : "enabled";
  let state: StewardState | null = null;
  if (env.ADR_STEWARD) {
    try {
      const stub = env.ADR_STEWARD.get(env.ADR_STEWARD.idFromName(ADR_STEWARD_ID)) as Partial<AdrStewardStateStub>;
      state = typeof stub.state === "function" ? await stub.state() : null;
    } catch (err) {
      // The pass times are then not known: they are served as null, never guessed.
      console.warn(JSON.stringify({ service: "cryptophys-ai-kernel", event: "adr_steward_state_unavailable", message: String((err as Error)?.message ?? err).slice(0, 200) }));
    }
  }
  const last = state?.last_pass_at ?? null;
  return {
    agent_id: ADR_STEWARD_ID, status,
    last_pass_at: last, last_full_pass_at: last,
    deployed_commit: env.CF_VERSION_METADATA?.tag ?? null,
    ai_today: state ? { used: aiUsedOn(state, new Date(now).toISOString().slice(0, 10)), cap: ADR_AI_DAILY_CAP } : { used: null, cap: null },
  };
}

function listEntry(r: ProgressRow): AdrListEntry {
  const body = parsed<Partial<AdrProgressDoc>>(r.body_json);
  return {
    adr: r.adr_id,
    title: typeof body?.title === "string" ? body.title : null,
    lifecycle: r.lifecycle,
    deferred: typeof body?.deferred === "boolean" ? body.deferred : null,
    superseded_by: typeof body?.superseded_by === "string" ? body.superseded_by : null,
    status: r.status,
    phases_total: Number(r.phases_total),
    phases_proven: Number(r.phases_proven),
    phases_asserted: Number(r.phases_asserted),
    percent: Number(r.percent),
    percent_proven: Number(r.percent_proven),
    next_step: body?.next_step ?? null,
    blockers: Array.isArray(body?.blockers) ? body.blockers.slice(0, LIST_BLOCKERS) : null,
    owner_actions: Array.isArray(body?.owner_actions) ? body.owner_actions : null,
    drift_count: Array.isArray(body?.drift) ? body.drift.length : null,
    stale: typeof body?.stale === "boolean" ? body.stale : null,
    revision: Number(r.revision),
    changed_at: r.changed_at,
    explanation: parsed<AdrExplanationJson>(r.explanation_json),
  };
}

/** GET /v1/adr: every stored ADR document's summary, sorted by ADR number, and the Steward's state. */
export async function adrListView(env: AdrViewEnv, now = Date.now()): Promise<AdrListView> {
  const steward = await stewardView(env, now);
  let rows: ProgressRow[];
  try {
    rows = (await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM adr_progress ORDER BY adr_id LIMIT ${LIST_LIMIT}`).bind().all<ProgressRow>()).results ?? [];
  } catch (err) {
    if (missingTable(err)) return { schema: ADR_VIEW_SCHEMA, available: false, steward, adrs: [] };
    throw err;
  }
  return { schema: ADR_VIEW_SCHEMA, available: true, steward, adrs: rows.map(listEntry) };
}

export type AdrDetailResult =
  | { ok: true; view: AdrDetailView }
  | { ok: false; status: 404 | 503; error: "not_found" | "not_available"; detail: string };

/** GET /v1/adr/{id}: one ADR's stored document with its explanation and newest history. `id` must pass validAdrId. */
export async function adrDetailView(env: AdrViewEnv, id: string): Promise<AdrDetailResult> {
  if (!validAdrId(id)) throw new Error("invalid adr id");
  let row: ProgressRow | null;
  try {
    row = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM adr_progress WHERE adr_id = ? LIMIT 1`).bind(id).first<ProgressRow>();
  } catch (err) {
    if (missingTable(err)) return { ok: false, status: 503, error: "not_available", detail: "adr_progress does not exist yet (migration 0075)" };
    throw err;
  }
  if (!row) return { ok: false, status: 404, error: "not_found", detail: `no document for ADR-${id}` };
  const body = parsed<AdrProgressDoc>(row.body_json);
  if (!body || typeof body !== "object") throw new Error("adr_progress body unreadable");
  const history = (await env.DB.prepare(
    `SELECT revision, status, percent, created_at FROM adr_progress_history WHERE adr_id = ? ORDER BY revision DESC LIMIT ${DETAIL_HISTORY}`,
  ).bind(id).all<AdrHistoryEntry>()).results ?? [];
  return {
    ok: true,
    view: {
      ...body,
      revision: Number(row.revision),
      changed_at: row.changed_at,
      explanation: parsed<AdrExplanationJson>(row.explanation_json),
      history: history.map((h) => ({ revision: Number(h.revision), status: h.status, percent: Number(h.percent), created_at: h.created_at })),
    },
  };
}
