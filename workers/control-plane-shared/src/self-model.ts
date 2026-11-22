// ADR-0016 (Telos) T1a (docs/design/TELOS-T1-SELF-MODEL.md §4; owner 2026-11-22, "setuju semua", every default of §11
// accepted): the contract of the daily self-model snapshot, organism.self_model.v1. Pure: no storage, no network, no AI.
//
// - A measure (§4.1) is a finite number, a short status token, a boolean, or null. Its value is null exactly when its
//   reason is set, and the reason comes from a closed list. A non-null value names its source and its as_of (the time of
//   the newest row that went into it). There is never a default number.
// - The document (§4.2) has five sections: Body, Mind, Memory, Will and Ecosystem. Will lists every KPI of the bundled
//   vision exactly once, with its baseline, target and source copied verbatim, and the measured value beside them.
// - selfModelProblems() (§4.3) lists every problem, as visionProblems() does. It refuses a price-bearing ref (parseRef,
//   refCarriesPrice), a forbidden key at any depth (price, level, entry, sl, tp*, lot, params, action, propose, vote),
//   a non-finite number, and a body over 64 KB.
// - The canonical form (§5.2 step 5) sorts keys and rounds numbers to 4 decimals; content_sha256 is the SHA-256 of the
//   canonical document without computed_at, deployed_commit and content_sha256 itself.
//
// It reads the vision and the ref grammar only. It never imports a kernel, consensus, trading or policy module.
import visionFile from "../../../organism/vision.json" with { type: "json" };
import { parseRef, refCarriesPrice } from "./council.ts";
import { VISION_SCHEMA, visionProblems, type Vision } from "./vision.ts";

export const SELF_MODEL_SCHEMA = "organism.self_model.v1";
/** The body bound (§4.3, §4.4: `length(body_json) <= 65536`), in UTF-8 bytes of the canonical JSON. */
export const SELF_MODEL_MAX_BYTES = 65_536;
export const SELF_MODEL_SECTIONS = ["body", "mind", "memory", "will", "ecosystem"] as const;
export type SelfModelSection = (typeof SELF_MODEL_SECTIONS)[number];

/** §4.1: the closed list of reasons a measure is null. */
export const NULL_REASONS = [
  "no_rows", "source_unavailable", "missing_table", "not_built", "source_outside_platform", "no_binding", "definition_pending",
  "subject_mismatch", "no_scored_data", "unavailable_source_field", "stale", "budget_exceeded", "division_by_zero",
] as const;
export type NullReason = (typeof NULL_REASONS)[number];

/** §4.2 (and §5.2 step 3, a source past its time budget): the state of one source read. */
export const SOURCE_STATUSES = ["ok", "empty", "unavailable", "missing_table", "not_built", "budget_exceeded"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type SnapshotStatus = "complete" | "partial";

/** One measured value, or an honest null (§4.1). */
export interface Measure {
  value: number | string | boolean | null;
  unit?: string | null;
  window?: string | null;
  /** The time of the newest row that went into the value, never the compute time. Required when value is not null. */
  as_of?: string | null;
  /** Required when value is not null. */
  source?: string | null;
  /** An ev: ref (council.ts parseRef) that never carries a price. */
  ref?: string | null;
  /** Set exactly when value is null. */
  reason: NullReason | null;
}

export interface WillKpi {
  id: string;
  /** Copied verbatim from organism/vision.json. */
  baseline: number | null;
  /** Copied verbatim from organism/vision.json. */
  target: number | string | null;
  /** The vision's own source, copied verbatim. */
  source: string;
  /** The binding's one-line definition (§6); null only while no binding measures it. */
  definition: string | null;
  measured: Measure;
}
export interface WillGoal { id: string; kpis: WillKpi[] }
export interface WillSection { goals: WillGoal[]; /** The vision's problems, when the bundled vision is invalid (§5.5). */ problems?: string[] }

export interface SourceRead {
  id: string;
  status: SourceStatus;
  /** Rows read: 0 when empty, at least 1 when ok, null when the source could not be read. */
  rows: number | null;
  as_of: string | null;
  /** Read as it is at compute time (registry status, controls, the autonomy dial, adr_progress). */
  point_in_time: boolean;
}

/** A section other than Will: containers (objects, bounded lists) whose leaves are measures and name labels. */
export type SectionNode = Measure | string | SectionNode[] | { [key: string]: SectionNode | number };

export interface SelfModelDocument {
  schema: typeof SELF_MODEL_SCHEMA;
  day: string;
  window_end: string;
  vision: { schema: string | null; sha256: string; valid: boolean };
  sections: {
    body: Record<string, SectionNode>;
    mind: Record<string, SectionNode>;
    memory: Record<string, SectionNode>;
    will: WillSection;
    ecosystem: Record<string, SectionNode>;
  };
  sources: SourceRead[];
  counts: { measured: number; null: number; kpis_measured: number; kpis_total: number };
  content_sha256: string;
  computed_at: string;
  deployed_commit: string | null;
}

/** The vision bundled with this commit (organism/vision.json). */
export const BUNDLED_VISION: unknown = visionFile;

// ---------------------------------------------------------------- shapes

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
/** A status or a level: a machine token, never prose, and never a run of three digits (no price hides in one). */
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const isToken = (v: unknown): v is string => typeof v === "string" && TOKEN.test(v) && !/\d{3}/.test(v);
const SOURCE = /^[a-z][A-Za-z0-9_.:/-]{0,119}$/;
const UNIT = /^[a-z][a-z0-9_%/]{0,23}$/;
/** A window: hours or days back from window_end, the month to date, the day itself, or the state now (point in time). */
const WINDOW = /^(?:\d{1,3}[hd]|mtd|day|now)$/;
const SOURCE_ID = /^[a-z][a-z0-9_]{1,63}$/;
const LABEL_MAX = 200;
const isLabel = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LABEL_MAX && !/[\u0000-\u001f\u007f]/.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const MAX_SOURCES = 64;

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], at: string, out: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push(`${at}.${k}: unknown field`);
}

// ---------------------------------------------------------------- forbidden keys (§4.3, the knowledge.ts pattern)

const FORBIDDEN_KEY_PARTS = new Set(["price", "prices", "level", "levels", "entry", "entries", "sl", "lot", "lots", "params", "param", "action", "actions", "propose", "vote", "votes"]);
const FORBIDDEN_WHOLE_KEYS = new Set(["stop_loss", "stoploss", "take_profit", "takeprofit"]);
/** A key that would carry a price level or an action: a part of it is a forbidden word (tp, tp1, tp2 included). */
export function isForbiddenSelfModelKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (FORBIDDEN_WHOLE_KEYS.has(normalized)) return true;
  return normalized.split(/[^a-z0-9]+/).filter(Boolean).some((p) => FORBIDDEN_KEY_PARTS.has(p) || /^tp\d*$/.test(p));
}

/** Every forbidden key and every non-finite number, at any depth. */
function walkProblems(value: unknown, at: string, out: string[]): void {
  if (typeof value === "number") { if (!Number.isFinite(value)) out.push(`${at}: must be a finite number`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => walkProblems(v, `${at}[${i}]`, out)); return; }
  if (!isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenSelfModelKey(k)) out.push(`${at}.${k}: forbidden key`);
    walkProblems(v, `${at}.${k}`, out);
  }
}

// ---------------------------------------------------------------- one measure (§4.1)

const isMeasureLike = (v: Record<string, unknown>) => "value" in v || "reason" in v;

interface Tally { measured: number; nulls: number }

function measureProblems(m: unknown, at: string, out: string[], tally: Tally): void {
  if (!isObject(m)) { out.push(`${at}: must be a measure object`); return; }
  unknownKeys(m, ["value", "unit", "window", "as_of", "source", "ref", "reason"], at, out);
  if (!("value" in m)) out.push(`${at}.value: required (null when not measured)`);
  if (!("reason" in m)) out.push(`${at}.reason: required (null when measured)`);
  const value = m.value ?? null;
  const reason = m.reason ?? null;
  if (value !== null) {
    if (typeof value === "number") { if (!Number.isFinite(value)) out.push(`${at}.value: must be a finite number`); }
    else if (typeof value === "string") { if (!isToken(value)) out.push(`${at}.value: a string value must be a short status token`); }
    else if (typeof value !== "boolean") out.push(`${at}.value: must be a finite number, a status token, a boolean or null`);
  }
  if (reason !== null && !(NULL_REASONS as readonly unknown[]).includes(reason)) out.push(`${at}.reason: must be one of ${NULL_REASONS.join(", ")}`);
  if (value === null && reason === null) out.push(`${at}: a null value needs a reason`);
  if (value !== null && reason !== null) out.push(`${at}: a measured value has no reason`);
  if (value !== null) {
    if (m.as_of === undefined || m.as_of === null) out.push(`${at}.as_of: required for a measured value`);
    if (m.source === undefined || m.source === null) out.push(`${at}.source: required for a measured value`);
  }
  if (m.as_of !== undefined && m.as_of !== null && !isIso(m.as_of)) out.push(`${at}.as_of: must be an ISO UTC time (YYYY-MM-DDTHH:MM:SSZ)`);
  if (m.source !== undefined && m.source !== null && !(typeof m.source === "string" && SOURCE.test(m.source))) out.push(`${at}.source: must match ${SOURCE}`);
  if (m.unit !== undefined && m.unit !== null && !(typeof m.unit === "string" && UNIT.test(m.unit))) out.push(`${at}.unit: must match ${UNIT}`);
  if (m.window !== undefined && m.window !== null && !(typeof m.window === "string" && WINDOW.test(m.window))) out.push(`${at}.window: must match ${WINDOW}`);
  if (m.ref !== undefined && m.ref !== null) {
    const ref = parseRef(m.ref);
    if (!ref) out.push(`${at}.ref: must be an ev: ref`);
    else if (refCarriesPrice(ref)) out.push(`${at}.ref: carries a price`);
  }
  if (value === null) tally.nulls++; else tally.measured++;
}

/** A section other than Will: objects and bounded lists, whose leaves are measures and labels (names). */
function nodeProblems(n: unknown, at: string, out: string[], tally: Tally): void {
  if (Array.isArray(n)) { n.forEach((v, i) => nodeProblems(v, `${at}[${i}]`, out, tally)); return; }
  if (isObject(n)) {
    if (isMeasureLike(n)) { measureProblems(n, at, out, tally); return; }
    for (const [k, v] of Object.entries(n)) {
      // A bounded list says how many entries it left out (§3): the one number allowed outside a measure.
      if (k === "omitted") { if (!isCount(v)) out.push(`${at}.omitted: must be a non-negative integer`); continue; }
      nodeProblems(v, `${at}.${k}`, out, tally);
    }
    return;
  }
  if (typeof n === "string") { if (!isLabel(n)) out.push(`${at}: a label must be a single line of at most ${LABEL_MAX} characters`); return; }
  if (n === null) out.push(`${at}: a null outside a measure has no reason`);
  else out.push(`${at}: a ${typeof n} outside a measure (every value is a measure with its source and as_of)`);
}

// ---------------------------------------------------------------- Will (§3, §6)

function willProblems(w: unknown, vision: unknown, visionOk: boolean, out: string[], tally: Tally): { listed: number; measured: number } {
  const counts = { listed: 0, measured: 0 };
  const at = "sections.will";
  if (!isObject(w)) { out.push(`${at}: must be an object`); return counts; }
  unknownKeys(w, ["goals", "problems"], at, out);
  if (!Array.isArray(w.goals)) { out.push(`${at}.goals: must be an array`); return counts; }

  if (!visionOk) {
    // §5.5: an invalid vision lists its problems in Will, and no KPI is measured.
    if (w.goals.length !== 0) out.push(`${at}.goals: must be empty while the vision is invalid`);
    const expected = visionProblems(vision);
    if (!Array.isArray(w.problems) || JSON.stringify(w.problems) !== JSON.stringify(expected)) out.push(`${at}.problems: must list the vision's problems`);
    return counts;
  }
  if ("problems" in w && !(Array.isArray(w.problems) && w.problems.length === 0)) out.push(`${at}.problems: must be empty while the vision is valid`);

  const goals = new Map((vision as Vision).growth.goals.map((g) => [g.id, new Map(g.kpis.map((k) => [k.id, k]))]));
  const seenGoals = new Set<string>();
  const seenKpis = new Set<string>();
  w.goals.forEach((g, gi) => {
    const gat = `${at}.goals[${gi}]`;
    if (!isObject(g)) { out.push(`${gat}: must be an object`); return; }
    unknownKeys(g, ["id", "kpis"], gat, out);
    const gid = typeof g.id === "string" ? g.id : null;
    const vkpis = gid === null ? undefined : goals.get(gid);
    if (gid === null || !vkpis) { out.push(`${gat}.id: not a goal of the vision`); return; }
    if (seenGoals.has(gid)) out.push(`${gat}.id: goal "${gid}" listed twice`);
    seenGoals.add(gid);
    if (!Array.isArray(g.kpis)) { out.push(`${gat}.kpis: must be an array`); return; }
    g.kpis.forEach((k, ki) => {
      const kat = `${gat}.kpis[${ki}]`;
      if (!isObject(k)) { out.push(`${kat}: must be an object`); return; }
      unknownKeys(k, ["id", "baseline", "target", "source", "definition", "measured"], kat, out);
      const kid = typeof k.id === "string" ? k.id : null;
      const vk = kid === null ? undefined : vkpis.get(kid);
      if (kid === null || !vk) { out.push(`${kat}.id: not a KPI of goal "${gid}" in the vision`); return; }
      const key = `${gid}/${kid}`;
      if (seenKpis.has(key)) out.push(`${kat}.id: KPI "${key}" listed twice`);
      seenKpis.add(key);
      counts.listed++;
      if (!("baseline" in k) || k.baseline !== vk.baseline) out.push(`${kat}.baseline: must be the vision's baseline, verbatim`);
      if (!("target" in k) || k.target !== vk.target) out.push(`${kat}.target: must be the vision's target, verbatim`);
      if (k.source !== vk.source) out.push(`${kat}.source: must be the vision's source, verbatim`);
      if (k.definition !== null && !isLabel(k.definition)) out.push(`${kat}.definition: must be a one-line definition or null`);
      const before = tally.measured;
      measureProblems(k.measured, `${kat}.measured`, out, tally);
      if (tally.measured > before) {
        counts.measured++;
        if (k.definition === null || k.definition === undefined) out.push(`${kat}.definition: a measured KPI shows its binding's definition`);
      }
    });
  });
  for (const [gid, kpis] of goals) for (const kid of kpis.keys()) {
    if (!seenKpis.has(`${gid}/${kid}`)) out.push(`${at}: KPI "${gid}/${kid}" of the vision is missing`);
  }
  return counts;
}

// ---------------------------------------------------------------- the document (§4.2, §4.3)

/** 00:00 UTC of the day after `day` (§5.2 step 2), or null for a day that is not a calendar date. */
export function windowEndOf(day: string): string | null {
  if (!DAY.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return null;
  return `${new Date(t + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`;
}

/** §4.2: complete when every source is ok or empty, otherwise partial. */
export function selfModelStatus(sources: readonly Pick<SourceRead, "status">[]): SnapshotStatus {
  return sources.every((s) => s.status === "ok" || s.status === "empty") ? "complete" : "partial";
}

function sourceProblems(s: unknown, at: string, out: string[], ids: Set<string>): void {
  if (!isObject(s)) { out.push(`${at}: must be an object`); return; }
  unknownKeys(s, ["id", "status", "rows", "as_of", "point_in_time"], at, out);
  if (typeof s.id !== "string" || !SOURCE_ID.test(s.id)) out.push(`${at}.id: must match ${SOURCE_ID}`);
  else { if (ids.has(s.id)) out.push(`${at}.id: source "${s.id}" listed twice`); ids.add(s.id); }
  if (!(SOURCE_STATUSES as readonly unknown[]).includes(s.status)) out.push(`${at}.status: must be one of ${SOURCE_STATUSES.join(", ")}`);
  else if (s.status === "ok") {
    if (!isCount(s.rows) || s.rows < 1) out.push(`${at}.rows: an ok source read at least one row`);
    if (!isIso(s.as_of)) out.push(`${at}.as_of: an ok source names the time of its newest row`);
  } else if (s.status === "empty") {
    if (s.rows !== 0) out.push(`${at}.rows: an empty source read 0 rows`);
    if (s.as_of !== null) out.push(`${at}.as_of: an empty source has no as_of`);
  } else {
    if (s.rows !== null) out.push(`${at}.rows: a source that was not read has rows null`);
    if (s.as_of !== null) out.push(`${at}.as_of: a source that was not read has no as_of`);
  }
  if (typeof s.point_in_time !== "boolean") out.push(`${at}.point_in_time: must be a boolean`);
}

/**
 * Every problem of a candidate self-model document (organism.self_model.v1); empty when it is valid. `vision` is the
 * bundled organism/vision.json unless a test passes another. The content hash is checked by selfModelContentHash.
 */
export function selfModelProblems(doc: unknown, vision: unknown = BUNDLED_VISION): string[] {
  const out: string[] = [];
  if (!isObject(doc)) return ["self_model: must be a JSON object"];
  unknownKeys(doc, ["schema", "day", "window_end", "vision", "sections", "sources", "counts", "content_sha256", "computed_at", "deployed_commit"], "self_model", out);
  if (doc.schema !== SELF_MODEL_SCHEMA) out.push(`self_model.schema: must be "${SELF_MODEL_SCHEMA}"`);

  const windowEnd = typeof doc.day === "string" ? windowEndOf(doc.day) : null;
  if (windowEnd === null) out.push("day: must be a UTC calendar day (YYYY-MM-DD)");
  else if (doc.window_end !== windowEnd) out.push(`window_end: must be ${windowEnd} (00:00 UTC of the day after day)`);
  if (!isIso(doc.computed_at)) out.push("computed_at: must be an ISO UTC time");
  else if (windowEnd !== null && Date.parse(doc.computed_at) < Date.parse(windowEnd)) out.push("computed_at: must be at or after window_end (the day has ended)");
  if (!("deployed_commit" in doc) || (doc.deployed_commit !== null && !(typeof doc.deployed_commit === "string" && COMMIT.test(doc.deployed_commit)))) out.push("deployed_commit: must be a commit sha or null");
  if (typeof doc.content_sha256 !== "string" || !SHA256.test(doc.content_sha256)) out.push("content_sha256: must be 64 lowercase hex characters");

  const visionOk = visionProblems(vision).length === 0;
  const vh = doc.vision;
  if (!isObject(vh)) out.push("vision: must be an object");
  else {
    unknownKeys(vh, ["schema", "sha256", "valid"], "vision", out);
    if (visionOk ? vh.schema !== VISION_SCHEMA : !(vh.schema === null || typeof vh.schema === "string")) out.push(`vision.schema: must be "${VISION_SCHEMA}"`);
    if (typeof vh.sha256 !== "string" || !SHA256.test(vh.sha256)) out.push("vision.sha256: must be 64 lowercase hex characters");
    if (vh.valid !== visionOk) out.push(`vision.valid: must be ${visionOk} (the bundled vision is ${visionOk ? "valid" : "invalid"})`);
  }

  const tally: Tally = { measured: 0, nulls: 0 };
  let will = { listed: 0, measured: 0 };
  const sections = doc.sections;
  if (!isObject(sections)) out.push("sections: must be an object");
  else {
    unknownKeys(sections, SELF_MODEL_SECTIONS, "sections", out);
    for (const name of SELF_MODEL_SECTIONS) {
      const s = sections[name];
      if (!isObject(s)) { out.push(`sections.${name}: required, an object`); continue; }
      if (name === "will") will = willProblems(s, vision, visionOk, out, tally);
      else nodeProblems(s, `sections.${name}`, out, tally);
    }
  }

  if (!Array.isArray(doc.sources)) out.push("sources: must be an array");
  else {
    if (doc.sources.length > MAX_SOURCES) out.push(`sources: at most ${MAX_SOURCES}`);
    const ids = new Set<string>();
    doc.sources.forEach((s, i) => sourceProblems(s, `sources[${i}]`, out, ids));
  }

  const c = doc.counts;
  if (!isObject(c)) out.push("counts: must be an object");
  else {
    unknownKeys(c, ["measured", "null", "kpis_measured", "kpis_total"], "counts", out);
    const want = { measured: tally.measured, null: tally.nulls, kpis_measured: will.measured, kpis_total: will.listed };
    for (const [k, v] of Object.entries(want)) {
      if (!isCount(c[k])) out.push(`counts.${k}: must be a non-negative integer`);
      else if (c[k] !== v) out.push(`counts.${k}: is ${c[k]}, the document holds ${v}`);
    }
  }

  walkProblems(doc, "self_model", out);
  let bytes = Infinity;
  try { bytes = new TextEncoder().encode(canonicalJson(doc)).length; } catch { out.push("self_model: must serialize as JSON"); }
  if (Number.isFinite(bytes) && bytes > SELF_MODEL_MAX_BYTES) out.push(`self_model: ${bytes} bytes, over the ${SELF_MODEL_MAX_BYTES}-byte bound`);
  return out;
}

/** The document, typed, when it is valid; null otherwise. */
export function parseSelfModel(doc: unknown, vision: unknown = BUNDLED_VISION): SelfModelDocument | null {
  return selfModelProblems(doc, vision).length === 0 ? (doc as SelfModelDocument) : null;
}

// ---------------------------------------------------------------- canonical form and hash (§4.2, §5.2 step 5, §5.3)

const round4 = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(4)) + 0 : n);

/** Sorted keys at every depth, numbers rounded to 4 decimals; undefined object members dropped, as JSON does. */
export function canonicalSelfModel(value: unknown): unknown {
  if (typeof value === "number") return round4(value);
  if (Array.isArray(value)) return value.map(canonicalSelfModel);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, canonicalSelfModel(value[k])]));
  }
  return value;
}
/** The canonical JSON text: the form that is hashed, measured against the 64 KB bound and stored. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalSelfModel(value));

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** content_sha256: the canonical document without computed_at, deployed_commit and content_sha256 itself. */
export function selfModelContentHash(doc: Record<string, unknown>): Promise<string> {
  const { computed_at: _c, deployed_commit: _d, content_sha256: _h, ...content } = doc;
  return sha256Hex(canonicalJson(content));
}

/** vision.sha256: the SHA-256 of the bundled vision in the same canonical form. */
export const visionSha256 = (vision: unknown = BUNDLED_VISION): Promise<string> => sha256Hex(canonicalJson(vision));
