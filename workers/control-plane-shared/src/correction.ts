// HAIC H3a (docs/design/HAIC-H3.md §3–§4; owner 2026-11-19, every recommended default accepted): the correction.v1
// contract. A rating (up or down) or a correction (a category, an optional short text, optional evidence refs) on one
// agent output, recorded as high-weight labelled knowledge. Pure functions only: no storage, no network.
//
// - Never refused for its content: secrets are redacted, price-like numbers masked as [level], long text truncated,
//   an unknown category stored as `other`; each step is flagged in `redactions`. Only a structurally empty input (no
//   target, or no rating, category or text) is invalid.
// - No parameters: a record has no params, values or change field, and no price-like key at any depth; a correction
//   never changes a trading parameter, a weight, a proposal or a gate.
// - Weight (Q2): owner 3 for ratings and corrections, 1 for owner reject reasons (owner_decision), 2 for H5 reviewers,
//   and 1 for any actor that is not an owner. It orders and feeds the teaching record; it never skips a gate.
// - Dedup (§4.3): the same actor, target, label, rating, category, normalized text and sorted refs give the same
//   dedup_sha256; the ledger (H3b) then returns the existing row and writes nothing.
import { parseRef, refCarriesPrice } from "./council.ts";
import { redactText, secretInText } from "./conversation.ts";

export const CORRECTION_SCHEMA = "correction.v1";
export const CORRECTION_DEDUP_VERSION = "cryptophys.correction-dedup.v1";
export const CORRECTION_SIDES = ["cerebrum", "nexus"] as const;
export const CORRECTION_SOURCES = ["chat_rating", "council", "typed_proposal", "knowledge_review", "nexus_card", "nexus_room", "nexus_engine", "nexus_council"] as const;
export const CORRECTION_LABELS = ["owner_rating", "owner_correction", "owner_decision", "reviewer_correction"] as const;
export const CORRECTION_CATEGORIES = [
  "reading_wrong", "invalidation_too_tight", "invalidation_too_loose", "evidence_wrong", "evidence_missing",
  "overconfident", "underconfident", "rule_broken", "good_call", "other",
] as const;
export const CORRECTION_ATTESTATIONS = ["cerebrum_access", "xauusd_nexus_access"] as const;
export const CORRECTION_REDACTIONS = ["secret", "price", "truncated"] as const;
export const CORRECTION_TEXT_MAX = 500;
export const CORRECTION_REFS_MAX = 10;
/** Weights by label for an owner (Q2); any other actor gets NON_OWNER_WEIGHT. */
export const LABEL_WEIGHT: Readonly<Record<CorrectionLabel, number>> = { owner_rating: 3, owner_correction: 3, owner_decision: 1, reviewer_correction: 2 };
export const NON_OWNER_WEIGHT = 1;

export type CorrectionSide = (typeof CORRECTION_SIDES)[number];
export type CorrectionSource = (typeof CORRECTION_SOURCES)[number];
export type CorrectionLabel = (typeof CORRECTION_LABELS)[number];
export type CorrectionCategory = (typeof CORRECTION_CATEGORIES)[number];
export type CorrectionRedaction = (typeof CORRECTION_REDACTIONS)[number];

export interface CorrectionTarget { ref: string; subject: string; as_of: string | null }
export interface Correction {
  schema: typeof CORRECTION_SCHEMA;
  correction_id: string;
  side: CorrectionSide;
  source: CorrectionSource;
  label: CorrectionLabel;
  rating: "up" | "down" | null;
  category: CorrectionCategory | null;
  target: CorrectionTarget;
  text: string | null;
  evidence_refs: string[];
  actor: string;
  attested_by: (typeof CORRECTION_ATTESTATIONS)[number];
  weight: number;
  supersedes: string | null;
  redactions: CorrectionRedaction[];
  created_at: string;
  content_sha256: string;
  dedup_sha256: string;
  /** Set when an unknown category was stored as "other". */
  category_raw?: string;
  /** How many evidence refs did not parse and were dropped. */
  invalid_refs?: number;
}

/** What a caller sends: the record's content without ids, times, weight, hashes or redaction flags. */
export interface CorrectionInput {
  side?: unknown; source?: unknown; label?: unknown; rating?: unknown; category?: unknown;
  target?: { ref?: unknown; subject?: unknown; as_of?: unknown } | null;
  text?: unknown; evidence_refs?: unknown; supersedes?: unknown;
  [key: string]: unknown;
}
/** Who records it: decided by the caller's authentication, never by the input. */
export interface CorrectionContext { actor: string; owner: boolean; attested_by: (typeof CORRECTION_ATTESTATIONS)[number]; now: string; correction_id: string }

const ID = /^cor_[0-9a-f]{16}$/;
const SUBJECT = /^(agent|model|seat):[A-Za-z0-9_.:-]{1,100}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Price-like numbers: 3+ digits, including grouped thousands (the knowledge.ts PRICE rule), anywhere in the text. */
const PRICE_G = /(?:\d{1,3}(?:[.,\s_'’]\d{3})+(?:[.,]\d+)?|\d{3,}(?:[.,]\d+)?)/g;
const PRICE = new RegExp(PRICE_G.source);
/** A record never carries a parameter or a price-like field, at any depth. */
const FORBIDDEN_KEYS = new Set(["params", "parameters", "values", "value", "change", "changes", "patch", "set", "weight_delta"]);
const PRICE_KEY_PARTS = new Set(["price", "prices", "level", "levels", "size", "sizing", "entry", "entries", "stop", "order", "orders", "lot", "lots", "sl", "tp", "tp1", "tp2"]);
const ALLOWED_KEYS = new Set([
  "schema", "correction_id", "side", "source", "label", "rating", "category", "target", "text", "evidence_refs", "actor", "attested_by",
  "weight", "supersedes", "redactions", "created_at", "content_sha256", "dedup_sha256", "category_raw", "invalid_refs",
]);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Trim and collapse every whitespace run; case is kept (the same rule as ai-kernel/src/learning-dedup.ts). */
export const normalizeText = (s: string): string => s.trim().replace(/\s+/g, " ");

/** The longest owner-typed category kept beside category "other". */
export const CATEGORY_RAW_MAX = 60;

/** Keys that name a parameter or a price, anywhere in a value. */
export function forbiddenCorrectionKeys(value: unknown, path = "correction"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenCorrectionKeys(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const parts = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]/);
    const bad = FORBIDDEN_KEYS.has(k.toLowerCase()) || parts.some((p) => PRICE_KEY_PARTS.has(p));
    return [...(bad ? [`${path}.${k}`] : []), ...forbiddenCorrectionKeys(v, `${path}.${k}`)];
  });
}

/** A ref without a price field: the field is dropped (§4.1 price safety). Null when the ref does not parse. */
function safeRef(raw: unknown): { ref: string; priced: boolean } | null {
  const ref = parseRef(raw);
  if (!ref || typeof raw !== "string") return null;
  return refCarriesPrice(ref) ? { ref: raw.slice(0, raw.indexOf("#")), priced: true } : { ref: raw, priced: false };
}

/** Text as stored: secrets redacted, prices masked, at most CORRECTION_TEXT_MAX characters; each step flagged. */
export function safeText(raw: unknown, redactions: Set<CorrectionRedaction>): string | null {
  if (typeof raw !== "string") return null;
  let text = normalizeText(raw);
  if (!text) return null;
  if (secretInText(text)) { text = redactText(text); redactions.add("secret"); }
  if (PRICE.test(text)) { text = text.replace(PRICE_G, "[level]"); redactions.add("price"); }
  if (text.length > CORRECTION_TEXT_MAX) { text = text.slice(0, CORRECTION_TEXT_MAX); redactions.add("truncated"); }
  return text;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

/** §4.3: the same actor, target, label, rating, category, normalized text and sorted refs; ids, times, supersedes left out. */
export function correctionDedupHash(c: Pick<Correction, "actor" | "target" | "label" | "rating" | "category" | "text" | "evidence_refs">): Promise<string> {
  return sha256Hex(JSON.stringify([CORRECTION_DEDUP_VERSION, c.actor, c.target.ref, c.label, c.rating, c.category, normalizeText(c.text ?? ""), [...c.evidence_refs].sort()]));
}
/** The record's content: everything but its id, its time, its weight and its two hashes. */
export function correctionContentHash(c: Omit<Correction, "content_sha256" | "dedup_sha256">): Promise<string> {
  const { correction_id: _i, created_at: _c, weight: _w, ...content } = c;
  return sha256Hex(JSON.stringify(canonical(content)));
}

export type BuildResult = { ok: true; correction: Correction } | { ok: false; error: string };

/**
 * An input into a stored record (§4.4). Structural errors only: an unknown side, source or label, a target that is not
 * an ev: ref or names no subject, or nothing to learn (no rating, category or text). Everything else is made safe.
 */
export async function buildCorrection(input: CorrectionInput, ctx: CorrectionContext): Promise<BuildResult> {
  if (!isObject(input)) return { ok: false, error: "invalid_request" };
  const bad = forbiddenCorrectionKeys(input, "input").filter((k) => !/^input\.target\.(ref|subject|as_of)$/.test(k));
  if (bad.length) return { ok: false, error: `forbidden_key: ${bad[0]}` };
  if (!CORRECTION_SIDES.includes(input.side as CorrectionSide)) return { ok: false, error: "invalid_side" };
  if (!CORRECTION_SOURCES.includes(input.source as CorrectionSource)) return { ok: false, error: "invalid_source" };
  const redactions = new Set<CorrectionRedaction>();
  const target = isObject(input.target) ? input.target : null;
  const tref = target ? safeRef(target.ref) : null;
  if (!tref) return { ok: false, error: "invalid_target" };
  if (tref.priced) redactions.add("price");
  const subject = typeof target!.subject === "string" ? target!.subject : "";
  if (!SUBJECT.test(subject)) return { ok: false, error: "invalid_subject" };
  const asOf = typeof target!.as_of === "string" && ISO.test(target!.as_of) ? target!.as_of : null;
  const rating = input.rating === "up" || input.rating === "down" ? input.rating : null;
  let category: CorrectionCategory | null = null;
  let categoryRaw: string | undefined;
  if (typeof input.category === "string" && input.category.trim()) {
    if (CORRECTION_CATEGORIES.includes(input.category as CorrectionCategory)) category = input.category as CorrectionCategory;
    // The owner's own word is kept, made safe as the text is (2026-11-22, review of xauusd #521: a typed category such as
    // "SL at 4095.5 too tight" was stored unmasked): secrets redacted, prices masked, then cut to 60 characters.
    else { category = "other"; categoryRaw = (safeText(input.category, redactions) ?? "").slice(0, CATEGORY_RAW_MAX) || undefined; }
  }
  const text = safeText(input.text, redactions);
  if (!rating && !category && !text) return { ok: false, error: "empty" };
  const label: CorrectionLabel = CORRECTION_LABELS.includes(input.label as CorrectionLabel) ? input.label as CorrectionLabel
    : input.label === undefined ? (category || text ? "owner_correction" : "owner_rating") : ("" as CorrectionLabel);
  if (!label) return { ok: false, error: "invalid_label" };
  if (label === "owner_rating" && !rating) return { ok: false, error: "rating_required" };
  const refs: string[] = [];
  let invalid = 0;
  for (const r of Array.isArray(input.evidence_refs) ? input.evidence_refs : []) {
    const s = safeRef(r);
    if (!s) { invalid += 1; continue; }
    if (s.priced) redactions.add("price");
    if (!refs.includes(s.ref) && refs.length < CORRECTION_REFS_MAX) refs.push(s.ref);
  }
  const supersedes = typeof input.supersedes === "string" && ID.test(input.supersedes) ? input.supersedes : null;
  const base: Omit<Correction, "content_sha256" | "dedup_sha256"> = {
    schema: CORRECTION_SCHEMA, correction_id: ctx.correction_id, side: input.side as CorrectionSide, source: input.source as CorrectionSource,
    label, rating, category, target: { ref: tref.ref, subject, as_of: asOf }, text, evidence_refs: refs,
    actor: ctx.actor, attested_by: ctx.attested_by, weight: ctx.owner ? LABEL_WEIGHT[label] : NON_OWNER_WEIGHT,
    supersedes, redactions: CORRECTION_REDACTIONS.filter((r) => redactions.has(r)), created_at: ctx.now,
    ...(categoryRaw ? { category_raw: categoryRaw } : {}), ...(invalid ? { invalid_refs: invalid } : {}),
  };
  return { ok: true, correction: { ...base, content_sha256: await correctionContentHash(base), dedup_sha256: await correctionDedupHash(base) } };
}

/** Every rule a stored or sent record must hold (both sides validate the shared fixtures with it). */
export function validateCorrection(c: unknown): string[] {
  if (!isObject(c)) return ["not_an_object"];
  const errors: string[] = [];
  for (const k of Object.keys(c)) if (!ALLOWED_KEYS.has(k)) errors.push(`unknown_key: ${k}`);
  for (const k of forbiddenCorrectionKeys(c).filter((k) => !/^correction\.target\.(ref|subject|as_of)$/.test(k))) errors.push(`forbidden_key: ${k}`);
  if (c.schema !== CORRECTION_SCHEMA) errors.push("schema");
  if (typeof c.correction_id !== "string" || !ID.test(c.correction_id)) errors.push("correction_id");
  if (!CORRECTION_SIDES.includes(c.side as CorrectionSide)) errors.push("side");
  if (!CORRECTION_SOURCES.includes(c.source as CorrectionSource)) errors.push("source");
  const label = c.label as CorrectionLabel;
  if (!CORRECTION_LABELS.includes(label)) errors.push("label");
  if (!(c.rating === null || c.rating === "up" || c.rating === "down")) errors.push("rating");
  if (!(c.category === null || CORRECTION_CATEGORIES.includes(c.category as CorrectionCategory))) errors.push("category");
  const t = isObject(c.target) ? c.target : null;
  const ref = t ? parseRef(t.ref) : null;
  if (!t || !ref) errors.push("target.ref");
  else if (refCarriesPrice(ref)) errors.push("target.ref_carries_price");
  if (!t || typeof t.subject !== "string" || !SUBJECT.test(t.subject)) errors.push("target.subject");
  if (t && !(t.as_of === null || (typeof t.as_of === "string" && ISO.test(t.as_of)))) errors.push("target.as_of");
  if (c.text !== null) {
    if (typeof c.text !== "string" || !c.text.trim()) errors.push("text");
    else {
      if (c.text.length > CORRECTION_TEXT_MAX) errors.push("text_too_long");
      if (secretInText(c.text)) errors.push("text_carries_secret");
      if (PRICE.test(c.text)) errors.push("text_carries_price");
    }
  }
  if (!Array.isArray(c.evidence_refs) || c.evidence_refs.length > CORRECTION_REFS_MAX) errors.push("evidence_refs");
  else for (const r of c.evidence_refs) {
    const p = parseRef(r);
    if (!p) errors.push("evidence_refs.unparsed");
    else if (refCarriesPrice(p)) errors.push("evidence_refs.carries_price");
  }
  if (typeof c.actor !== "string" || c.actor.length < 3 || c.actor.length > 200) errors.push("actor");
  if (!CORRECTION_ATTESTATIONS.includes(c.attested_by as (typeof CORRECTION_ATTESTATIONS)[number])) errors.push("attested_by");
  if (!(c.weight === NON_OWNER_WEIGHT || (CORRECTION_LABELS.includes(label) && c.weight === LABEL_WEIGHT[label]))) errors.push("weight");
  if (!(c.supersedes === null || (typeof c.supersedes === "string" && ID.test(c.supersedes)))) errors.push("supersedes");
  if (!Array.isArray(c.redactions) || !c.redactions.every((r) => CORRECTION_REDACTIONS.includes(r as CorrectionRedaction))) errors.push("redactions");
  if (typeof c.created_at !== "string" || !ISO.test(c.created_at)) errors.push("created_at");
  if (typeof c.content_sha256 !== "string" || !HEX64.test(c.content_sha256)) errors.push("content_sha256");
  if (typeof c.dedup_sha256 !== "string" || !HEX64.test(c.dedup_sha256)) errors.push("dedup_sha256");
  // What there is to learn, by label.
  if (label === "owner_rating" && c.rating === null) errors.push("owner_rating_without_rating");
  if (label === "owner_correction" && c.category === null && c.text === null) errors.push("owner_correction_without_content");
  if (label === "owner_decision" && c.text === null) errors.push("owner_decision_without_reason");
  if (c.category_raw !== undefined && (c.category !== "other" || typeof c.category_raw !== "string" || c.category_raw.length > CATEGORY_RAW_MAX)) errors.push("category_raw");
  else if (typeof c.category_raw === "string") {
    if (secretInText(c.category_raw)) errors.push("category_raw_carries_secret");
    if (PRICE.test(c.category_raw)) errors.push("category_raw_carries_price");
  }
  if (c.invalid_refs !== undefined && !(Number.isInteger(c.invalid_refs) && (c.invalid_refs as number) > 0)) errors.push("invalid_refs");
  return errors;
}
