// CB1 (owner 2026-11-28: "sementara B dulu ...", confirmed in the platform session: "comfirmed"; ADR-0014 §13): the
// Forge writes the council ledger into its own data repository `council` (control-plane-shared/src/council-repo.ts).
//
// councilSync, a Forge tick step: it reads D1 after its cursor (the last forge.council_synced audit event), at most
// BATCH proposals a tick, oldest activity first, so a first run backfills over a few ticks:
//   - xauusd's typed_proposal.v1 reports (reports.publish, kind xauusd_digest, from an agent hosted by an xauusd
//     service): the proposal's own states (handoff_pending, handed_off, shadow, live, ...), source xauusd;
//   - evolution_updates_v2 of origin xauusd: the platform's return path (queued_external, in_progress, ..., expired),
//     with close_code and the pr_url or sha ref, source platform.
// Each touched proposal's file is rebuilt whole from D1 (idempotent), compared with main's copy, and the changed files
// become one commit on main's head. Each file is checked by checkCouncilCommit before the fast-forward: a refused file
// is left out of the commit and audited with its problems (forge.council_sync_refused), and the cursor still advances,
// so one bad proposal never blocks the others; it is tried again at its next activity. Only the words a writer validated reach the file (titles with a price-like
// number are withheld); never a price, a level, a lot or a secret.
//
// Pinned: the only repository this module writes is COUNCIL_REPO (a constant; councilRepo refuses any other name, the
// platform and platform-work repositories included). It does not use the evolver's write path (evolution.ts): its
// git objects are built here. The repository is created on the first run when the binding does not have it.
// Tokens are minted per run with a short TTL, sent only in the Authorization header, never logged or returned.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { EXTERNAL_ORIGINS } from "../../control-plane-shared/src/organism.ts";
import { textCarriesPrice } from "../../control-plane-shared/src/correction.ts";
import { secretInText } from "../../control-plane-shared/src/conversation.ts";
import {
  ALLOWLIST_PATH, COUNCIL_LEDGER_SCHEMA, COUNCIL_POLICY_VERDICT_SCHEMA, COUNCIL_REPO, LEDGER_STATES, MAX_FILES_PER_COMMIT, MAX_HISTORY,
  MAX_OVERLAY_ENTRIES, OVERLAY_PATH, OVERLAY_SHADOW_MS, checkCouncilCommit, entryProblems, ledgerPath, ledgerText, overlayText,
  parseAllowlist, verdictProblems, type LedgerFile, type LedgerStep, type OverlayEntry,
} from "../../control-plane-shared/src/council-repo.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "./checks.ts";
import { fastForward, refHead, trustedRemoteFor, ZERO_SHA, type Fetch, type MergeRepo } from "./merge.ts";

export const SYNC_EVENT = "forge.council_synced";
export const REFUSED_EVENT = "forge.council_sync_refused";
export const CREATED_EVENT = "forge.council_repo_created";
export const SYNC_ACTOR = "system:forge-council";
export const COUNCIL_AUTHOR = "Cryptophys Forge <forge@cryptophys.work>";
export const BATCH = Math.min(40, MAX_FILES_PER_COMMIT);
const TOKEN_TTL_S = 120;
const COUNCIL_ORIGIN = "xauusd";
const COUNCIL_HOSTS: readonly string[] = EXTERNAL_ORIGINS.find((o) => o.origin === COUNCIL_ORIGIN)?.services ?? [];
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\|([A-Za-z0-9._:-]{1,120})$/;
const ID = /^[A-Za-z0-9._:-]{1,120}$/;

export interface CouncilBinding {
  get(name: string): Promise<MergeRepo>;
  create?(name: string, opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string }): Promise<unknown>;
}
export interface CouncilEnv { DB: D1Database; ARTIFACTS?: CouncilBinding }
export interface SyncResult { outcome: "not_configured" | "up_to_date" | "unchanged" | "written" | "refused" | "failed"; files?: number; commit?: string; cursor?: string | null; reason?: string; problems?: string[] }

/** The council repository handle. Any other name is refused here, whatever the caller passes. */
export async function councilRepo(binding: CouncilBinding, name: string = COUNCIL_REPO): Promise<{ repo: MergeRepo; created: boolean }> {
  if (name !== COUNCIL_REPO) throw new Error(`council_sync_writes_only_${COUNCIL_REPO}`);
  try {
    return { repo: await binding.get(COUNCIL_REPO), created: false };
  } catch (err) {
    if (typeof binding.create !== "function") throw err;
    try {
      await binding.create(COUNCIL_REPO, { description: "Cryptophys council ledger and policy (data only; ADR-0014 §13)", readOnly: false, setDefaultBranch: "main" });
    } catch { /* another run created it first: read it below */ }
    return { repo: await binding.get(COUNCIL_REPO), created: true };
  }
}

// ---------------------------------------------------------------- git objects (this module's own; not evolution.ts)

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const sha1 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-1", b as Uint8Array<ArrayBuffer>));
type GitType = "commit" | "tree" | "blob";
interface GitObject { type: GitType; body: Uint8Array; sha: string }
async function gitObject(type: GitType, body: Uint8Array): Promise<GitObject> {
  return { type, body, sha: hex(await sha1(concat([enc.encode(`${type} ${body.length}\0`), body]))) };
}
function treeBody(entries: Array<{ mode: string; name: string; hash: string }>): Uint8Array {
  const key = (e: { mode: string; name: string }) => (e.mode === "40000" ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => { const x = enc.encode(key(a)); const y = enc.encode(key(b)); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; });
  return concat(sorted.flatMap((e) => [enc.encode(`${e.mode} ${e.name}\0`), unhex(e.hash)]));
}
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const PACK_TYPE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3 };
async function packOf(objects: GitObject[]): Promise<Uint8Array<ArrayBuffer>> {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"), 0);
  const view = new DataView(head.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [head];
  for (const o of objects) {
    let size = o.body.length;
    const h: number[] = [(PACK_TYPE[o.type] << 4) | (size & 0x0f)];
    size >>>= 4;
    while (size > 0) { h[h.length - 1] |= 0x80; h.push(size & 0x7f); size >>>= 7; }
    parts.push(Uint8Array.from(h), await deflate(o.body));
  }
  const body = concat(parts);
  return concat([body, await sha1(body)]);
}
type Reader = Pick<ArtifactsReader, "readCommit" | "readTree" | "readBlob">;

async function readAt(repo: Reader, treeHash: string | null, path: string): Promise<string | null> {
  if (!treeHash) return null;
  let tree = treeHash;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const e = (await repo.readTree(tree))?.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i < parts.length - 1) { if (e.type !== "tree") return null; tree = e.hash; continue; }
    if (e.type !== "blob" && e.type !== "exec") return null;
    return (await (await repo.readBlob(e.hash))?.text()) ?? null;
  }
  return null;
}
async function buildTree(repo: Reader, treeHash: string | null, files: Map<string, string>, out: GitObject[]): Promise<string> {
  const entries: ArtifactsTreeEntry[] = treeHash ? [...((await repo.readTree(treeHash)) ?? [])] : [];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const sub = new Map<string, Map<string, string>>();
  for (const [path, blob] of files) {
    const i = path.indexOf("/");
    if (i < 0) byName.set(path, { name: path, mode: "100644", hash: blob, type: "blob" });
    else {
      const dir = path.slice(0, i);
      if (!sub.has(dir)) sub.set(dir, new Map());
      sub.get(dir)!.set(path.slice(i + 1), blob);
    }
  }
  for (const [dir, inner] of sub) {
    const prev = byName.get(dir);
    byName.set(dir, { name: dir, mode: "40000", type: "tree", hash: await buildTree(repo, prev?.type === "tree" ? prev.hash : null, inner, out) });
  }
  const obj = await gitObject("tree", treeBody([...byName.values()].map((e) => ({ mode: e.type === "tree" ? "40000" : e.mode, name: e.name, hash: e.hash }))));
  out.push(obj);
  return obj.sha;
}
async function commitObject(tree: string, parent: string | null, title: string, body: string, nowMs: number): Promise<GitObject> {
  const ts = `${Math.floor(nowMs / 1000)} +0000`;
  const text = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${COUNCIL_AUTHOR} ${ts}\ncommitter ${COUNCIL_AUTHOR} ${ts}\n\n${title}\n\n${body}\n`;
  return gitObject("commit", enc.encode(text));
}

// ---------------------------------------------------------------- the ledger from D1

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const parse = (s: unknown): Record<string, unknown> => { try { return obj(JSON.parse(String(s))); } catch { return {}; } };
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
};
/** Words only: a text with a price-like number or a secret is withheld (null). */
const words = (v: unknown, max: number): string | null => { const t = text(v, max); return t && !textCarriesPrice(t) && !secretInText(t) ? t : null; };
const STATES = new Set<string>(LEDGER_STATES);

interface Activity { proposal_id: string; last_at: string }

/** The proposals with activity after the cursor, oldest first, at most BATCH. */
async function touched(db: D1Database, after: { at: string; id: string }): Promise<Activity[]> {
  if (!COUNCIL_HOSTS.length) return [];
  const q = COUNCIL_HOSTS.map(() => "?").join(", ");
  return (await db.prepare(
    `SELECT proposal_id, MAX(at) AS last_at FROM (
       SELECT json_extract(r.body_json, '$.proposal_id') AS proposal_id, r.created_at AS at FROM agent_reports r JOIN agents a ON a.agent_id = r.agent_id
       WHERE a.host_worker IN (${q}) AND r.kind = 'xauusd_digest' AND json_extract(r.body_json, '$.schema') = 'typed_proposal.v1' AND r.created_at >= ?
       UNION ALL
       SELECT proposal_id, created_at AS at FROM evolution_updates_v2 WHERE origin = ? AND created_at >= ?
     ) WHERE proposal_id IS NOT NULL GROUP BY proposal_id
     HAVING last_at > ? OR (last_at = ? AND proposal_id > ?)
     ORDER BY last_at, proposal_id LIMIT ${BATCH}`,
  ).bind(...COUNCIL_HOSTS, after.at, COUNCIL_ORIGIN, after.at, after.at, after.at, after.id).all<Activity>()).results;
}

/** One proposal's ledger file, rebuilt whole from D1; null when the proposal has no safe path. */
export async function ledgerOf(db: D1Database, proposalId: string): Promise<{ path: string; file: LedgerFile } | null> {
  if (!ID.test(proposalId)) return null;
  const q = COUNCIL_HOSTS.map(() => "?").join(", ");
  const reports = COUNCIL_HOSTS.length ? (await db.prepare(
    `SELECT r.body_json, r.created_at FROM agent_reports r JOIN agents a ON a.agent_id = r.agent_id
     WHERE a.host_worker IN (${q}) AND r.kind = 'xauusd_digest' AND json_extract(r.body_json, '$.schema') = 'typed_proposal.v1'
       AND json_extract(r.body_json, '$.proposal_id') = ? ORDER BY r.created_at, r.rowid LIMIT ${MAX_HISTORY}`,
  ).bind(...COUNCIL_HOSTS, proposalId).all<{ body_json: string; created_at: string }>()).results : [];
  const updates = (await db.prepare(
    `SELECT state, reason, refs_json, created_at FROM evolution_updates_v2 WHERE origin = ? AND proposal_id = ? ORDER BY created_at, update_id LIMIT ${MAX_HISTORY}`,
  ).bind(COUNCIL_ORIGIN, proposalId).all<{ state: string; reason: string | null; refs_json: string; created_at: string }>()).results;
  const intent = await db.prepare("SELECT intent_id, title, origin_json FROM evolution_intents_v2 WHERE source = 'council' AND source_ref = ?")
    .bind(proposalId).first<{ intent_id: string; title: string; origin_json: string }>();
  const first = reports.length ? parse(reports[0].body_json) : {};
  const origin = { ...parse(intent?.origin_json), ...obj(first.origin) };
  const session = text(first.session_id, 120) ?? text(origin.session_id, 120) ?? text(origin.council, 120);
  const topic = text(origin.topic, 100);
  const path = ledgerPath(topic, session, proposalId);
  if (!path) return null;

  const steps: LedgerStep[] = [];
  for (const r of reports) {
    const state = String(parse(r.body_json).state ?? "");
    if (STATES.has(state)) steps.push({ at: r.created_at, state, source: "xauusd" });
  }
  for (const u of updates) {
    if (!STATES.has(u.state)) continue;
    const refs = parse(u.refs_json);
    const ref = typeof refs.pr_url === "string" ? { pr_url: refs.pr_url } : typeof refs.sha === "string" ? { sha: refs.sha } : undefined;
    const note = words(u.reason, 300);
    steps.push({
      at: u.created_at, state: u.state, source: "platform",
      ...(typeof refs.close_code === "string" ? { close_code: refs.close_code } : {}),
      ...(ref ? { ref } : {}),
      ...(note && note !== u.state ? { note } : {}),
    });
  }
  steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.source === b.source ? 0 : a.source === "xauusd" ? -1 : 1));
  // A repeated report of the same state in a row (xauusd retries a send) is one step; shadow → live → shadow keeps all three.
  let lastXau = "";
  const history = steps.filter((s) => {
    if (s.source !== "xauusd") return true;
    const repeat = s.state === lastXau;
    lastXau = s.state;
    return !repeat;
  }).slice(-MAX_HISTORY);
  if (!history.length) return null;
  const title = words(first.title, 300) ?? words(intent?.title, 300) ?? "(title withheld: not words only)";
  const opt = (v: unknown) => text(v, 200);
  return {
    path,
    file: {
      schema: COUNCIL_LEDGER_SCHEMA, proposal_id: proposalId, session_id: session, topic, kind: opt(first.kind), title,
      chosen_by: opt(first.chosen_by ?? origin.chosen_by), topic_approved_by: opt(first.topic_approved_by ?? origin.topic_approved_by),
      intent_id: intent?.intent_id ?? null, history,
    },
  };
}

async function lastCursor(db: D1Database): Promise<{ at: string; id: string }> {
  const row = await db.prepare("SELECT payload_json FROM audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1").bind(SYNC_EVENT).first<{ payload_json: string }>();
  const m = row ? CURSOR.exec(String(parse(row.payload_json).cursor ?? "")) : null;
  return m ? { at: m[1], id: m[2] } : { at: "", id: "" };
}

// ---------------------------------------------------------------- the tick step

// ---------------------------------------------------------------- CB2a: the overlay of council-owned settings

const VERDICT_SCAN = 400;
const POLICY_SCAN = MAX_OVERLAY_ENTRIES;
const SHADOW_STATES = new Set(["queued_shadow", "shadow", "live", "reverted"]);
type Scalar = number | boolean | string;
const scalar = (v: unknown): Scalar | null => (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && v.length <= 80) ? v as Scalar : null;

/**
 * The overlay's entries from D1: every policy_parameter proposal of xauusd that reached shadow (its own report says
 * queued_shadow, shadow, live or reverted), with its latest valid council_policy_verdict.v1. A verdict "revert" or 14
 * days in shadow without any verdict (OVERLAY_SHADOW_MS) reverts it: state reverted, the value back to its from.
 */
export async function overlayCandidates(db: D1Database, nowMs: number): Promise<OverlayEntry[]> {
  if (!COUNCIL_HOSTS.length) return [];
  const q = COUNCIL_HOSTS.map(() => "?").join(", ");
  const rows = (await db.prepare(
    `SELECT r.body_json, r.created_at FROM agent_reports r JOIN agents a ON a.agent_id = r.agent_id
     WHERE a.host_worker IN (${q}) AND r.kind = 'xauusd_digest' AND json_extract(r.body_json, '$.schema') IN ('typed_proposal.v1', ?)
       AND (json_extract(r.body_json, '$.kind') = 'policy_parameter' OR json_extract(r.body_json, '$.schema') = ?)
     ORDER BY r.created_at DESC, r.rowid DESC LIMIT ${VERDICT_SCAN}`,
  ).bind(...COUNCIL_HOSTS, COUNCIL_POLICY_VERDICT_SCHEMA, COUNCIL_POLICY_VERDICT_SCHEMA).all<{ body_json: string; created_at: string }>()).results.reverse();
  const props = new Map<string, { key: string; value: Scalar; from: Scalar | null; session_id: string; since: string; at: string; state: OverlayEntry["state"] }>();
  const verdicts = new Map<string, { state: OverlayEntry["state"]; verdict: string; at: string }>();
  for (const r of rows) {
    const b = parse(r.body_json);
    if (b.schema === COUNCIL_POLICY_VERDICT_SCHEMA) {
      if (verdictProblems(b).length) continue;
      verdicts.set(String(b.proposal_id), { state: b.state as OverlayEntry["state"], verdict: String(b.verdict), at: r.created_at });
      continue;
    }
    const id = typeof b.proposal_id === "string" ? b.proposal_id : "";
    const value = scalar(b.value);
    if (!ID.test(id) || typeof b.knob !== "string" || value === null || !SHADOW_STATES.has(String(b.state))) continue;
    const session = text(b.session_id, 120) ?? text(obj(b.origin).council, 120) ?? "";
    const prev = props.get(id);
    props.set(id, {
      key: b.knob, value, from: scalar(b.from), session_id: session,
      since: prev?.since ?? r.created_at, at: r.created_at,
      state: b.state === "live" ? "live" : b.state === "reverted" ? "reverted" : "shadow",
    });
  }
  const out: OverlayEntry[] = [];
  for (const [proposal_id, p] of [...props].slice(-POLICY_SCAN)) {
    const v = verdicts.get(proposal_id);
    let state = p.state;
    let at = p.at;
    let reason: OverlayEntry["reason"] | undefined;
    if (v && v.at >= p.since) {
      state = v.verdict === "revert" ? "reverted" : v.state;
      at = v.at > at ? v.at : at;
      reason = "verdict";
    } else if (state === "shadow" && Date.parse(p.since) + OVERLAY_SHADOW_MS <= nowMs) {
      state = "reverted";
      // Deterministic (the moment it expired), so the same overlay is rebuilt identically at every later tick.
      at = new Date(Date.parse(p.since) + OVERLAY_SHADOW_MS).toISOString();
      reason = "expired";
    }
    out.push({
      key: p.key, value: state === "reverted" && p.from !== null ? p.from : p.value, from: p.from, session_id: p.session_id, proposal_id,
      state, since: p.since, at, ...(reason ? { reason } : {}),
    });
  }
  return out;
}

async function lastRefusalKey(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT payload_json FROM audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1").bind(REFUSED_EVENT).first<{ payload_json: string }>();
  return String(parse(row?.payload_json).key ?? "");
}

// ---------------------------------------------------------------- the tick step

export async function councilSyncTick(env: CouncilEnv, nowMs = Date.now(), fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<SyncResult> {
  if (!env.ARTIFACTS) return { outcome: "not_configured" };
  const after = await lastCursor(env.DB);
  let batch: Activity[];
  let overlay: OverlayEntry[];
  try {
    batch = await touched(env.DB, after);
    overlay = await overlayCandidates(env.DB, nowMs);
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return { outcome: "not_configured", reason: "tables_missing" };
    throw err;
  }
  if (!batch.length && !overlay.length) return { outcome: "up_to_date" };
  const last = batch[batch.length - 1];
  const cursor = last ? `${last.last_at}|${last.proposal_id}` : after.at ? `${after.at}|${after.id}` : null;
  const record = (outcome: string, payload: Record<string, unknown>) =>
    appendAuditEvent(env.DB, { event_type: SYNC_EVENT, actor: SYNC_ACTOR, subject: `repo:${COUNCIL_REPO}`, outcome, payload: { cursor, ...payload } });

  const { repo, created } = await councilRepo(env.ARTIFACTS);
  try {
    if (created) await appendAuditEvent(env.DB, { event_type: CREATED_EVENT, actor: SYNC_ACTOR, subject: `repo:${COUNCIL_REPO}`, outcome: "created", payload: {} });
    const remote = (await repo.info())?.remote ?? "";
    if (!trustedRemoteFor(remote, COUNCIL_REPO)) return { outcome: "failed", reason: "untrusted_remote" };
    const head = await refHead(repo, "main").catch(() => null);
    const tree = head ? (await repo.readCommit(head))?.treeHash ?? null : null;
    if (head && !tree) return { outcome: "failed", reason: "main_unreadable" };
    // The allowlist as main holds it: absent, nothing is council-owned; it changes only by the owner's click (CB2b).
    const { allowlist } = parseAllowlist(await readAt(repo, tree, ALLOWLIST_PATH));

    const files = new Map<string, string>();
    const skipped: string[] = [];
    const refused: Array<{ proposal_id: string; problems: string[] }> = [];
    for (const a of batch) {
      const l = await ledgerOf(env.DB, a.proposal_id);
      if (!l) { skipped.push(a.proposal_id); continue; }
      const next = ledgerText(l.file);
      if ((await readAt(repo, tree, l.path)) === next) continue;
      // Each file on its own: a refused one is left out, the others are written (no poison pill).
      const problems = checkCouncilCommit(new Map([[l.path, next]]));
      if (problems.length) { refused.push({ proposal_id: a.proposal_id, problems: problems.slice(0, 10) }); continue; }
      files.set(l.path, next);
    }
    // The overlay: each entry on its own against the allowlist; a refused entry is left out (and listed for the owner).
    const kept: OverlayEntry[] = [];
    for (const e of overlay) {
      const problems = entryProblems(e, allowlist);
      if (problems.length) refused.push({ proposal_id: e.proposal_id, problems: problems.slice(0, 10) });
      else kept.push(e);
    }
    const current = await readAt(repo, tree, OVERLAY_PATH);
    const nextOverlay = overlayText(kept);
    if ((current ?? overlayText([])) !== nextOverlay && (kept.length || current !== null)) {
      if (checkCouncilCommit(new Map([[OVERLAY_PATH, nextOverlay]]), allowlist).length === 0) files.set(OVERLAY_PATH, nextOverlay);
    }
    // A refusal is audited once per distinct set (the overlay is evaluated every tick); the owner's inbox lists it.
    const key = JSON.stringify(refused.map((r) => [r.proposal_id, r.problems]).sort());
    if (refused.length && key !== await lastRefusalKey(env.DB)) {
      await appendAuditEvent(env.DB, { event_type: REFUSED_EVENT, actor: SYNC_ACTOR, subject: `repo:${COUNCIL_REPO}`, outcome: "refused", payload: { refused: refused.slice(0, 20), key } });
    }
    const refusedIds = refused.map((r) => r.proposal_id);
    if (!files.size) {
      if (batch.length) await record(refused.length ? "refused" : "unchanged", { skipped, refused: refusedIds });
      return { outcome: refused.length ? "refused" : "unchanged", cursor, problems: refused.flatMap((r) => r.problems) };
    }
    const whole = checkCouncilCommit(files, allowlist);
    if (whole.length) {
      // Only the commit's own limits (each file already passed): recorded, and the cursor advances, so it cannot loop.
      await record("refused", { skipped, refused: refusedIds, problems: whole.slice(0, 10) });
      return { outcome: "refused", cursor, problems: whole };
    }
    const objects: GitObject[] = [];
    const blobs = new Map<string, string>();
    for (const [path, body] of files) { const b = await gitObject("blob", enc.encode(body)); objects.push(b); blobs.set(path, b.sha); }
    const newTree = await buildTree(repo, tree, blobs, objects);
    const ledgerFiles = [...files.keys()].filter((p) => p !== OVERLAY_PATH);
    const sessions = [...new Set(ledgerFiles.map((p) => p.split("/")[2]))];
    const title = ledgerFiles.length
      ? `council: ${ledgerFiles.length} proposal${ledgerFiles.length === 1 ? "" : "s"} (${sessions.slice(0, 3).join(", ")}${sessions.length > 3 ? ", ..." : ""})${files.has(OVERLAY_PATH) ? " and the overlay" : ""}`
      : `council: the overlay (${kept.length} setting${kept.length === 1 ? "" : "s"}${kept.some((e) => e.reason === "expired") ? ", expired ones reverted" : ""})`;
    const commit = await commitObject(newTree, head, title, [...files.keys()].map((p) => `- ${p}`).join("\n"), nowMs);
    objects.push(commit);
    const token = (await repo.createToken("write", TOKEN_TTL_S)).plaintext;
    const pushed = await fastForward({ remote, token, branch: "main", from: head ?? ZERO_SHA, to: commit.sha, fetchImpl, pack: await packOf(objects) });
    if (!pushed.ok) return { outcome: "failed", reason: pushed.reason };
    await record("written", { commit: commit.sha, files: [...files.keys()], skipped, refused: refusedIds });
    return { outcome: "written", files: files.size, commit: commit.sha, cursor, ...(refused.length ? { problems: refused.flatMap((r) => r.problems) } : {}) };
  } finally {
    repo[Symbol.dispose]?.();
  }
}
