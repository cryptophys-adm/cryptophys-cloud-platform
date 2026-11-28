// ADR-0014 §11, docs/design/EVOLVER.md §8 (owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik"): the return
// path. council.decisions.read (tier 0, read only; granted only by XAUUSD_CEILING to xauusd-moderator) returns the state
// updates of the council proposals that the calling agent's origin handed off, oldest first, at most MAX_UPDATES per call,
// after `cursor` ("<created_at>|<update_id>" of the last update read). Cerebrum never calls into xauusd: xauusd pulls.
// An update carries the proposal id, its state, the reason and the platform's references (intent, evolution, change
// request, merge, deploy). Never a price, code or a diff. Before migration 0076 the answer is available: false.
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { externalOriginOf } from "../../control-plane-shared/src/organism.ts";
import type { SyscallEnv } from "./syscall.ts";

export const MAX_UPDATES = 20;
const PRICE_KEY = /^(price|prices|entry|entry_price|sl|tp\d?|stop|stop_loss|take_profit|bid|ask|level|levels|lot|lots|volume)$/i;
const flat = (v: unknown): Record<string, string | number | boolean | null> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]{0,40}$/i.test(k) || PRICE_KEY.test(k)) continue;
    if (typeof x === "number" || typeof x === "boolean" || x === null) out[k] = x as number | boolean | null;
    else if (typeof x === "string" && x.length <= 200) out[k] = x;
  }
  return out;
};
/** The draft of a Cerebrum-confirmed shadow arm (HAIC H2), only its known fields, flat and without a price. */
function draftOf(v: unknown): JsonObject | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (d.kind !== "shadow_arm" || typeof d.target !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(d.target)) return null;
  return { kind: "shadow_arm", target: d.target, params: flat(d.params) ?? {}, measurement: flat(d.measurement), requires: Array.isArray(d.requires) ? d.requires.filter((x) => typeof x === "string").slice(0, 6) : [] } as JsonObject;
}
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\|(evu_[A-Za-z0-9-]{1,64})$/;
// Issue #327 C2: an external intent's progress carries its pull request (pr_url), commit (sha), worker (assignee) and,
// once it ended, why (close_code: owner_closed, expired, refused, completed).
const REFS = ["intent_id", "evolution_id", "cr_id", "merge_sha", "deploy_ref", "pr_url", "sha", "assignee", "close_code"] as const;

export async function readCouncilDecisions(env: Pick<SyscallEnv, "DB">, agentId: string, input: JsonObject): Promise<JsonObject> {
  const agent = await env.DB.prepare("SELECT host_worker FROM agents WHERE agent_id = ? AND status = 'enabled'").bind(agentId).first<{ host_worker: string }>();
  const origin = agent ? externalOriginOf(agent.host_worker)?.origin : undefined;
  if (!origin) return { available: true, updates: [], next_cursor: null, refused: "the caller is not an agent of an external origin" };
  let after = { at: "", id: "" };
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== "") {
    const m = typeof input.cursor === "string" ? CURSOR.exec(input.cursor) : null;
    if (!m) throw new Error("invalid_cursor");
    after = { at: m[1], id: m[2] };
  }
  let rows: Array<{ update_id: string; proposal_id: string; state: string; reason: string | null; refs_json: string; created_at: string }>;
  try {
    rows = (await env.DB.prepare(
      `SELECT update_id, proposal_id, state, reason, refs_json, created_at FROM evolution_updates_v2
       WHERE origin = ? AND (created_at > ? OR (created_at = ? AND update_id > ?)) ORDER BY created_at, update_id LIMIT ${MAX_UPDATES}`,
    ).bind(origin, after.at, after.at, after.id).all<typeof rows[number]>()).results;
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return { available: false, updates: [], next_cursor: null };
    throw err;
  }
  const updates = rows.map((r) => {
    let raw: Record<string, unknown> = {};
    try { const v = JSON.parse(r.refs_json); if (v && typeof v === "object" && !Array.isArray(v)) raw = v; } catch { raw = {}; }
    const refs: Record<string, string> = {};
    for (const k of REFS) if (typeof raw[k] === "string") refs[k] = raw[k] as string;
    // HAIC H2: a shadow arm the owner confirmed in Cerebrum carries its draft (flat values; never a price), so xauusd can run it.
    const draft = draftOf(raw.draft);
    return { schema: "typed_proposal.v1", proposal_id: r.proposal_id, state: r.state, reason: r.reason, refs, at: r.created_at, ...(draft ? { draft } : {}) };
  });
  const last = rows.at(-1);
  return { available: true, origin, updates, next_cursor: last ? `${last.created_at}|${last.update_id}` : (input.cursor as string | undefined) ?? null };
}
