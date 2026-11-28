// CB1 (owner 2026-11-28: "sementara B dulu, setelah xauusd settle dan bisa dilepas ketergantungan dari github, artinya
// improvements sisa minor baru semua akan dihandle cerebrum", confirmed in the platform session: "comfirmed"; ADR-0014
// §13): the contract of the Forge repository `council` (namespace cryptophys), data only, no executable code.
//
//   ledger/<topic>/<session_id>/<proposal_id>.json   council_ledger.v1: one file per council proposal, every status
//                                                     transition one commit (councilSync in forge/src/council-sync.ts)
//   policy/overlay.json, policy/allowlist.json        CB2 (not written yet; refused by the CB1 check)
//
// Pure: the path rules, the file schema and the check every commit passes before the Forge fast-forwards main. No price,
// level or lot ever enters the repository (the PRICE rule of correction.ts and a key denylist at any depth), and no
// secret (conversation.ts secretInText). The verdict schema xauusd will publish for CB2 is defined here too.
import { textCarriesPrice } from "./correction.ts";
import { secretInText } from "./conversation.ts";

/** The one repository councilSync writes. A constant: the writer refuses any other name (platform, platform-work). */
export const COUNCIL_REPO = "council";
export const COUNCIL_LEDGER_SCHEMA = "council_ledger.v1";
export const COUNCIL_POLICY_VERDICT_SCHEMA = "council_policy_verdict.v1";
/** A path segment (topic, session id, proposal id): letters, digits, "_", "-" and ":"; never a dot or a slash. */
export const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/;
export const LEDGER_PATH = /^ledger\/[A-Za-z0-9][A-Za-z0-9_:-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_:-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_:-]{0,99}\.json$/;
export const NO_TOPIC = "no-topic";
export const NO_SESSION = "no-session";
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_FILES_PER_COMMIT = 60;
export const MAX_HISTORY = 100;
/** Keys that never appear at any depth of a council file. */
export const FORBIDDEN_KEY = /^(price|prices|level|levels|lot|lots|sl|tp\d?|entry|entry_price|stop|stop_loss|take_profit|bid|ask|volume)$/i;
export const LEDGER_STATES = Object.freeze([
  // xauusd's own proposal states (cfc-session.mjs) and the platform's return path (evolution-intake.ts, evolution-progress.ts)
  "draft", "accepted", "handoff_pending", "handed_off", "shadow", "live", "reverted", "rejected", "dismissed", "no_change",
  "queued", "queued_external", "waiting_external", "in_progress", "proposed", "merged", "deployed", "closed", "refused", "expired",
] as const);
export const CLOSE_CODES = Object.freeze(["owner_closed", "expired", "refused", "completed"] as const);

export interface LedgerStep { at: string; state: string; source: "xauusd" | "platform"; close_code?: string; ref?: { pr_url?: string; sha?: string }; note?: string }
export interface LedgerFile {
  schema: typeof COUNCIL_LEDGER_SCHEMA;
  proposal_id: string; session_id: string | null; topic: string | null; kind: string | null; title: string;
  chosen_by: string | null; topic_approved_by: string | null; intent_id: string | null; history: LedgerStep[];
}

/** The ledger path of a proposal, or null when a segment is not safe (never a dot, a slash or an empty segment). */
export function ledgerPath(topic: string | null, session: string | null, proposal: string): string | null {
  const segs = [topic || NO_TOPIC, session || NO_SESSION, proposal];
  if (!segs.every((s) => SEGMENT.test(s))) return null;
  const path = `ledger/${segs[0]}/${segs[1]}/${segs[2]}.json`;
  return LEDGER_PATH.test(path) ? path : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,6}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Every forbidden key and every string with a price-like number or a secret, at any depth (path-named problems). */
/** Identifier fields: their shape is checked by the schema (an id or a commit may hold digit runs that are not prices). */
const ID_KEYS = new Set(["proposal_id", "session_id", "intent_id", "sha", "pr_url", "at"]);
export function contentProblems(v: unknown, at = "$", depth = 0, key = ""): string[] {
  if (depth > 8) return [`${at}: too deep`];
  if (typeof v === "string") {
    if (ID_KEYS.has(key) && (SEGMENT.test(v) || ISO.test(v) || PR_URL.test(v) || SHA.test(v))) return [];
    if (secretInText(v)) return [`${at}: carries a secret`];
    if (textCarriesPrice(v)) return [`${at}: carries a price-like number`];
    return [];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => contentProblems(x, `${at}[${i}]`, depth + 1, key));
  if (isObj(v)) {
    return Object.entries(v).flatMap(([k, x]) => (FORBIDDEN_KEY.test(k) ? [`${at}.${k}: forbidden key`] : contentProblems(x, `${at}.${k}`, depth + 1, k)));
  }
  return [];
}

/** The schema check of one ledger file; [] when it is valid. */
export function ledgerProblems(v: unknown, path: string): string[] {
  if (!isObj(v)) return [`${path}: not an object`];
  const p: string[] = [];
  const keys = ["schema", "proposal_id", "session_id", "topic", "kind", "title", "chosen_by", "topic_approved_by", "intent_id", "history"];
  for (const k of Object.keys(v)) if (!keys.includes(k)) p.push(`${path}: unknown key ${k}`);
  if (v.schema !== COUNCIL_LEDGER_SCHEMA) p.push(`${path}: schema is not ${COUNCIL_LEDGER_SCHEMA}`);
  if (typeof v.proposal_id !== "string" || !SEGMENT.test(v.proposal_id)) p.push(`${path}: invalid proposal_id`);
  const expected = typeof v.proposal_id === "string" ? ledgerPath(typeof v.topic === "string" ? v.topic : null, typeof v.session_id === "string" ? v.session_id : null, v.proposal_id) : null;
  if (expected !== path) p.push(`${path}: the path does not match topic/session_id/proposal_id`);
  for (const k of ["session_id", "topic", "kind", "chosen_by", "topic_approved_by", "intent_id"]) {
    if (v[k] !== null && (typeof v[k] !== "string" || !(v[k] as string).length || (v[k] as string).length > 200)) p.push(`${path}: ${k} is a text of 1 to 200 or null`);
  }
  if (typeof v.title !== "string" || !v.title || v.title.length > 300) p.push(`${path}: title is a text of 1 to 300`);
  if (!Array.isArray(v.history) || v.history.length < 1 || v.history.length > MAX_HISTORY) p.push(`${path}: history holds 1 to ${MAX_HISTORY} steps`);
  else {
    let last = "";
    v.history.forEach((s, i) => {
      const at = `${path}: history[${i}]`;
      if (!isObj(s)) { p.push(`${at} is not an object`); return; }
      for (const k of Object.keys(s)) if (!["at", "state", "source", "close_code", "ref", "note"].includes(k)) p.push(`${at}: unknown key ${k}`);
      if (typeof s.at !== "string" || !ISO.test(s.at)) p.push(`${at}: at is an ISO time`);
      else if (s.at < last) p.push(`${at}: out of order`);
      else last = s.at;
      if (!(LEDGER_STATES as readonly string[]).includes(String(s.state))) p.push(`${at}: unknown state`);
      if (s.source !== "xauusd" && s.source !== "platform") p.push(`${at}: source is xauusd or platform`);
      if (s.close_code !== undefined && !(CLOSE_CODES as readonly string[]).includes(String(s.close_code))) p.push(`${at}: unknown close_code`);
      if (s.ref !== undefined) {
        const r = s.ref;
        const ok = isObj(r) && Object.keys(r).length >= 1 && Object.entries(r).every(([k, x]) => (k === "pr_url" && typeof x === "string" && PR_URL.test(x)) || (k === "sha" && typeof x === "string" && SHA.test(x)));
        if (!ok) p.push(`${at}: ref is {pr_url} or {sha}`);
      }
      if (s.note !== undefined && (typeof s.note !== "string" || !s.note || s.note.length > 300)) p.push(`${at}: note is a text of 1 to 300`);
    });
  }
  return [...p, ...contentProblems(v).map((x) => `${path}: ${x}`)];
}

/**
 * The check of one commit to `council` before main moves (CB1): at most MAX_FILES_PER_COMMIT files, every path under
 * ledger/ in the ledger shape (policy/ waits for CB2 and its owner-merged allowlist), every file at most MAX_FILE_BYTES,
 * JSON, valid against council_ledger.v1, with no forbidden key, price-like number or secret. [] when it may merge.
 */
export function checkCouncilCommit(files: Map<string, string>): string[] {
  const p: string[] = [];
  if (files.size === 0) return ["the commit changes nothing"];
  if (files.size > MAX_FILES_PER_COMMIT) p.push(`at most ${MAX_FILES_PER_COMMIT} files per commit`);
  for (const [path, text] of files) {
    if (!LEDGER_PATH.test(path)) { p.push(`${path}: only ledger/<topic>/<session_id>/<proposal_id>.json is written (CB1)`); continue; }
    if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) { p.push(`${path}: over ${MAX_FILE_BYTES} bytes`); continue; }
    let v: unknown;
    try { v = JSON.parse(text); } catch { p.push(`${path}: not JSON`); continue; }
    p.push(...ledgerProblems(v, path));
  }
  return p;
}

/** The text a ledger file is stored as: stable key order, two-space indent, a final newline. */
export function ledgerText(f: LedgerFile): string {
  const ordered = {
    schema: f.schema, proposal_id: f.proposal_id, session_id: f.session_id, topic: f.topic, kind: f.kind, title: f.title,
    chosen_by: f.chosen_by, topic_approved_by: f.topic_approved_by, intent_id: f.intent_id,
    history: f.history.map((s) => ({ at: s.at, state: s.state, source: s.source, ...(s.close_code ? { close_code: s.close_code } : {}), ...(s.ref ? { ref: s.ref } : {}), ...(s.note ? { note: s.note } : {}) })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * CB2 (built in xauusd's CFC-A6, read by councilSync in CB2): the verdict on a council-owned setting, published by
 * xauusd through reports.publish (kind xauusd_digest) with body.schema council_policy_verdict.v1. Never a price.
 */
export interface CouncilPolicyVerdict {
  schema: typeof COUNCIL_POLICY_VERDICT_SCHEMA;
  proposal_id: string; session_id: string; key: string;
  state: "shadow" | "live" | "reverted"; verdict: "pass" | "fail" | "revert";
  evidence: { n: number; mean_r: number; holdout: boolean };
  at: string;
}
const KEY = /^[a-z][a-z0-9_.]{0,79}$/;
/** The verdict's problems; [] when it is valid. */
export function verdictProblems(v: unknown): string[] {
  if (!isObj(v)) return ["not an object"];
  const p: string[] = [];
  for (const k of Object.keys(v)) if (!["schema", "proposal_id", "session_id", "key", "state", "verdict", "evidence", "at"].includes(k)) p.push(`unknown key ${k}`);
  if (v.schema !== COUNCIL_POLICY_VERDICT_SCHEMA) p.push("schema");
  if (typeof v.proposal_id !== "string" || !SEGMENT.test(v.proposal_id)) p.push("proposal_id");
  if (typeof v.session_id !== "string" || !SEGMENT.test(v.session_id)) p.push("session_id");
  if (typeof v.key !== "string" || !KEY.test(v.key)) p.push("key");
  if (!["shadow", "live", "reverted"].includes(String(v.state))) p.push("state");
  if (!["pass", "fail", "revert"].includes(String(v.verdict))) p.push("verdict");
  const e = v.evidence;
  if (!isObj(e) || !Number.isInteger(e.n) || (e.n as number) < 0 || typeof e.mean_r !== "number" || !Number.isFinite(e.mean_r) || Math.abs(e.mean_r) > 20 || typeof e.holdout !== "boolean" || Object.keys(e).length !== 3) p.push("evidence is {n, mean_r, holdout}");
  if (typeof v.at !== "string" || !ISO.test(v.at)) p.push("at");
  return [...p, ...contentProblems(v)];
}
