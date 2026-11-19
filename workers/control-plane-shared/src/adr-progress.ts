// The ADR Steward, step 1 (docs/design/ADR-STEWARD.md §2, §3; owner 2026-11-16, "ya semua, sesuai rekomendasimu"):
// the schema of one ADR's progress manifest, `architecture/adr/progress/<NNNN>.json` (adr.progress.v1).
//
// A manifest says how an ADR's phases are measured, never what their status is: each phase names an evidence
// predicate, and the status is computed from evidence (proven), from a quoted document (asserted) or not at all (open,
// with its blocker). A manifest never contains SQL: a predicate kind supplies only values to a fixed, parameterized query.
//
// adrManifestProblems() is pure: it returns every problem it finds, or an empty list for a valid manifest, like
// visionProblems() in vision.ts. CI validates every manifest with it (test/adr-progress.test.ts), which also checks what
// a pure function cannot see: quotes against the files they name, `built` paths, the ADR's Status line, dependencies
// across ADRs, and event and migration names against the source. Nothing here reads D1 or evaluates a predicate yet.

export const ADR_PROGRESS_SCHEMA = "adr.progress.v1";
export const ADR_LIFECYCLES = ["accepted", "deferred", "held", "planned", "superseded"] as const;
export type AdrLifecycle = (typeof ADR_LIFECYCLES)[number];
export const ADR_SCOPES = ["platform", "xauusd", "aether"] as const;
export const DOC_CLAIM_STATES = ["done", "built", "not_built", "not_started"] as const;
export const OWNER_ACTION_HREFS = ["#/owner", "#/consensus", "#/code", "#/users"] as const;

/** The named readings of the `reading` kind (§3). A new reading is added here and in code, never in a manifest. */
export const ADR_READINGS = [
  "forge_merge_path",
  "forge_work_cr_merged",
  "git_backup_verified_48h",
  "dependency_audit_fresh_48h",
  "vision_valid",
  "drift_in_sync_all",
  "adr_index_live",
  "orchestrator_github_fallback_absent",
] as const;

/** The `kind` values of agent_reports (migration 0053's CHECK; agents.ts ReportKind) an `agent_report` predicate may name. */
export const ADR_REPORT_KINDS = ["platform_digest", "signal_digest", "audit_digest", "xauusd_digest", "hud_digest", "knowledge_audit"] as const;

export const ADR_ID = /^[0-9]{4}$/;
export const ADR_FILE = /^architecture\/adr\/[0-9]{4}-[a-z0-9-]+\.md$/;
export const PHASE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$/;
export const GROUP_ID = /^[a-z0-9-]{1,24}$/;
export const DEPENDS_ON = /^([0-9]{4}:)?[A-Za-z0-9.-]+$/;
export const FITS = /^[0-9]{4}(:[A-Za-z0-9.-]+)?$/;
export const BUILT_PATH = /^(workers|organism|docs|architecture)\//;
export const MIGRATION_FILE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
export const EVENT_TYPE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const JSON_PATH = /^\$\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const ITEM_FIELD = /^[A-Za-z0-9_]+$/;
const BODY_SCHEMA = /^[a-z0-9_.-]+\.v[0-9]+$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?Z)?$/;
const EXTERNAL_SOURCE = /^(xauusd|aether|github|branch:[A-Za-z0-9._/-]+)$/;
const COMBINATORS = ["all_of", "any_of", "sequence"] as const;
/** At most 3 levels of predicates, counting the phase's own evidence as level 1 (§2.3 $comment). */
export const MAX_PREDICATE_DEPTH = 3;

/** Each kind's own fields (§3): `required` must be present, `optional` may be; any other field is a problem. */
export const PREDICATE_FIELDS: Readonly<Record<string, { required: readonly string[]; optional: readonly string[] }>> = {
  migration_applied: { required: ["name"], optional: [] },
  audit_event: { required: ["event_type"], optional: ["since", "payload", "min_count"] },
  quiet_window: { required: ["fail_types", "success_type", "hours"], optional: [] },
  deploy_step: { required: [], optional: ["step", "step_suffix", "executor", "since"] },
  merged_and_deployed: { required: ["unit"], optional: ["cr_id", "branch"] },
  census_clean: { required: [], optional: ["max_age_h"] },
  observer: { required: ["source"], optional: ["worker", "subject", "metric", "kind_filter", "since", "expect"] },
  kpi_threshold: { required: ["source", "metric", "op", "value", "max_age_h"], optional: ["agent_id", "body_schema", "subject", "kind_filter"] },
  consensus_executed: { required: ["action"], optional: ["target", "since", "owner_approved"] },
  agent_registered: { required: ["agent_id"], optional: ["status"] },
  agent_report: { required: ["report_kind", "agent_id", "body_schema"], optional: ["origin", "body", "item", "since"] },
  reading: { required: ["name"], optional: [] },
  doc_asserted: { required: ["ref", "quote"], optional: [] },
  external_asserted: { required: ["source", "ref", "as_of"], optional: [] },
  not_measurable_yet: { required: ["reason"], optional: [] },
  all_of: { required: ["of"], optional: [] },
  any_of: { required: ["of"], optional: [] },
  sequence: { required: ["of"], optional: [] },
};
export const ADR_PREDICATE_KINDS = Object.freeze(Object.keys(PREDICATE_FIELDS));

export interface AdrPredicate {
  kind: string;
  of?: AdrPredicate[];
  [field: string]: unknown;
}

export interface AdrPhase {
  id: string;
  group?: string;
  title: string;
  weight?: number;
  depends_on?: string[];
  evidence: AdrPredicate;
  built?: string[];
  doc_claim?: { state: (typeof DOC_CLAIM_STATES)[number]; ref: string; quote: string };
  next?: string;
  note?: string;
  owner_action?: { text: string; href?: (typeof OWNER_ACTION_HREFS)[number]; outside_platform?: boolean };
}

export interface AdrManifest {
  schema: typeof ADR_PROGRESS_SCHEMA;
  adr: string;
  title: string;
  adr_file?: string | null;
  lifecycle: AdrLifecycle;
  lifecycle_note?: string;
  superseded_by?: string;
  scope?: (typeof ADR_SCOPES)[number];
  fits?: string[];
  groups?: { id: string; title: string }[];
  phases: AdrPhase[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], at: string, out: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push(`${at}.${k}: unknown field`);
}

function text(v: unknown, at: string, out: string[], max: number, min = 1): void {
  if (!isText(v)) out.push(`${at}: must be a non-empty string`);
  else if (v.length < min || v.length > max) out.push(`${at}: must be ${min}–${max} characters`);
}

/** A repository-relative path: no leading slash, no `..`, no backslash. */
function repoPath(v: unknown, at: string, out: string[]): void {
  if (!isText(v) || v.startsWith("/") || v.includes("\\") || v.split("/").some((s) => s === ".." || s === "." || s === "")) {
    out.push(`${at}: must be a repository-relative path`);
  }
}

function date(v: unknown, at: string, out: string[]): void {
  if (typeof v !== "string" || !DATE.test(v)) out.push(`${at}: must be an ISO date (YYYY-MM-DD) or UTC time`);
}

function eventTypes(v: unknown, at: string, out: string[]): void {
  if (!Array.isArray(v) || v.length === 0) { out.push(`${at}: must be a non-empty array of event types`); return; }
  v.forEach((e, i) => { if (typeof e !== "string" || !EVENT_TYPE.test(e)) out.push(`${at}[${i}]: must match ${EVENT_TYPE}`); });
}

function kindFieldProblems(p: Record<string, unknown>, kind: string, at: string, out: string[]): void {
  switch (kind) {
    case "migration_applied":
      if (typeof p.name !== "string" || !MIGRATION_FILE.test(p.name)) out.push(`${at}.name: must be a migration file name like 0073_platform_identities.sql`);
      break;
    case "audit_event":
      if (typeof p.event_type !== "string" || !EVENT_TYPE.test(p.event_type)) out.push(`${at}.event_type: must match ${EVENT_TYPE}`);
      if ("since" in p) date(p.since, `${at}.since`, out);
      if ("min_count" in p && (!isInt(p.min_count) || p.min_count < 1)) out.push(`${at}.min_count: must be an integer >= 1`);
      if ("payload" in p) {
        if (!isObject(p.payload)) out.push(`${at}.payload: must be an object of JSON paths`);
        else {
          const keys = Object.keys(p.payload);
          if (keys.length === 0 || keys.length > 3) out.push(`${at}.payload: must hold 1–3 paths`);
          for (const k of keys) {
            if (!/^\$\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(k)) out.push(`${at}.payload.${k}: must be a JSON path like $.executor`);
            const v = p.payload[k];
            if (!["string", "number", "boolean"].includes(typeof v)) out.push(`${at}.payload.${k}: must be a string, number or boolean`);
          }
        }
      }
      break;
    case "quiet_window":
      eventTypes(p.fail_types, `${at}.fail_types`, out);
      if (typeof p.success_type !== "string" || !EVENT_TYPE.test(p.success_type)) out.push(`${at}.success_type: must match ${EVENT_TYPE}`);
      if (!isInt(p.hours) || p.hours < 1 || p.hours > 720) out.push(`${at}.hours: must be an integer from 1 to 720`);
      break;
    case "deploy_step":
      if (("step" in p) === ("step_suffix" in p)) out.push(`${at}: exactly one of step or step_suffix`);
      if ("step" in p && !isText(p.step)) out.push(`${at}.step: must be a non-empty string`);
      if ("step_suffix" in p && (typeof p.step_suffix !== "string" || !p.step_suffix.startsWith(":") || p.step_suffix.length < 2)) out.push(`${at}.step_suffix: must start with ":"`);
      if ("executor" in p && !isText(p.executor)) out.push(`${at}.executor: must be a non-empty string`);
      if ("since" in p) date(p.since, `${at}.since`, out);
      break;
    case "merged_and_deployed":
      if (("cr_id" in p) === ("branch" in p)) out.push(`${at}: exactly one of cr_id or branch`);
      if ("cr_id" in p && !isText(p.cr_id)) out.push(`${at}.cr_id: must be a non-empty string`);
      if ("branch" in p && !isText(p.branch)) out.push(`${at}.branch: must be a non-empty string`);
      if (!isText(p.unit)) out.push(`${at}.unit: must name a deploy unit`);
      break;
    case "census_clean":
      if ("max_age_h" in p && (!isInt(p.max_age_h) || p.max_age_h < 1)) out.push(`${at}.max_age_h: must be an integer >= 1`);
      break;
    case "observer":
      if (!["findings", "vitals", "runs"].includes(p.source as string)) out.push(`${at}.source: must be findings, vitals or runs`);
      for (const f of ["worker", "subject", "metric", "kind_filter"]) if (f in p && !isText(p[f])) out.push(`${at}.${f}: must be a non-empty string`);
      if ("since" in p) date(p.since, `${at}.since`, out);
      if ("expect" in p && !["none", "some"].includes(p.expect as string)) out.push(`${at}.expect: must be none or some`);
      break;
    case "kpi_threshold":
      if (!["report_metric", "observer_vitals"].includes(p.source as string)) out.push(`${at}.source: must be report_metric or observer_vitals`);
      if (!isText(p.metric)) out.push(`${at}.metric: must be a non-empty string`);
      if (![">=", "<=", "=="].includes(p.op as string)) out.push(`${at}.op: must be >=, <= or ==`);
      if (typeof p.value !== "number" || !Number.isFinite(p.value)) out.push(`${at}.value: must be a number`);
      if (!isInt(p.max_age_h) || p.max_age_h < 1) out.push(`${at}.max_age_h: must be an integer >= 1`);
      if (p.source === "report_metric") {
        if (!isText(p.agent_id)) out.push(`${at}.agent_id: required for report_metric`);
        if (!isText(p.body_schema)) out.push(`${at}.body_schema: required for report_metric`);
        for (const f of ["subject", "kind_filter"]) if (f in p) out.push(`${at}.${f}: only for observer_vitals`);
      } else if (p.source === "observer_vitals") {
        for (const f of ["agent_id", "body_schema"]) if (f in p) out.push(`${at}.${f}: only for report_metric`);
        for (const f of ["subject", "kind_filter"]) if (f in p && !isText(p[f])) out.push(`${at}.${f}: must be a non-empty string`);
      }
      break;
    case "consensus_executed":
      if (typeof p.action !== "string" || !/^[a-z_]+$/.test(p.action)) out.push(`${at}.action: must be a consensus action name`);
      if ("target" in p && !isText(p.target)) out.push(`${at}.target: must be a non-empty string`);
      if ("since" in p) date(p.since, `${at}.since`, out);
      if ("owner_approved" in p && typeof p.owner_approved !== "boolean") out.push(`${at}.owner_approved: must be a boolean`);
      break;
    case "agent_registered":
      if (typeof p.agent_id !== "string" || !/^[a-z0-9-]+$/.test(p.agent_id)) out.push(`${at}.agent_id: must be an agent id`);
      if ("status" in p && !isText(p.status)) out.push(`${at}.status: must be a non-empty string`);
      break;
    case "agent_report": {
      // A report an agent published (agent_reports): its kind, agent and body.schema, optionally the body's origin
      // (`source`), 1–3 top-level body fields, and one element of `body.items` matching 1–3 fields (any of a list).
      if (!(ADR_REPORT_KINDS as readonly unknown[]).includes(p.report_kind)) out.push(`${at}.report_kind: must be one of ${ADR_REPORT_KINDS.join(", ")}`);
      if (typeof p.agent_id !== "string" || !/^[a-z0-9-]+$/.test(p.agent_id)) out.push(`${at}.agent_id: must be an agent id`);
      if (typeof p.body_schema !== "string" || !BODY_SCHEMA.test(p.body_schema)) out.push(`${at}.body_schema: must be a body schema like strategy_arm.v1`);
      if ("origin" in p && (typeof p.origin !== "string" || !/^[a-z0-9-]{1,64}$/.test(p.origin))) out.push(`${at}.origin: must be a repository or service name`);
      if ("since" in p) date(p.since, `${at}.since`, out);
      const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
      if ("body" in p) {
        if (!isObject(p.body)) out.push(`${at}.body: must be an object of JSON paths`);
        else {
          const keys = Object.keys(p.body);
          if (keys.length === 0 || keys.length > 3) out.push(`${at}.body: must hold 1–3 paths`);
          for (const k of keys) {
            if (!JSON_PATH.test(k)) out.push(`${at}.body.${k}: must be a JSON path like $.mode`);
            else if (k === "$.schema" || k === "$.source") out.push(`${at}.body.${k}: use body_schema or origin`);
            if (!scalar(p.body[k])) out.push(`${at}.body.${k}: must be a string, number or boolean`);
          }
        }
      }
      if ("item" in p) {
        if (!isObject(p.item)) out.push(`${at}.item: must be an object of item fields`);
        else {
          const keys = Object.keys(p.item);
          if (keys.length === 0 || keys.length > 3) out.push(`${at}.item: must hold 1–3 fields`);
          for (const k of keys) {
            const v = p.item[k];
            if (!ITEM_FIELD.test(k)) out.push(`${at}.item.${k}: must be a field name like event`);
            const list = Array.isArray(v) ? v : [v];
            if (list.length === 0 || list.length > 4 || !list.every(scalar)) out.push(`${at}.item.${k}: must be a string, number or boolean, or a list of 1–4 of them`);
          }
        }
      }
      break;
    }
    case "reading":
      if (!(ADR_READINGS as readonly unknown[]).includes(p.name)) out.push(`${at}.name: must be one of ${ADR_READINGS.join(", ")}`);
      break;
    case "doc_asserted":
      repoPath(p.ref, `${at}.ref`, out);
      text(p.quote, `${at}.quote`, out, 200, 6);
      break;
    case "external_asserted":
      if (typeof p.source !== "string" || !EXTERNAL_SOURCE.test(p.source)) out.push(`${at}.source: must be xauusd, aether, github or branch:<name>`);
      text(p.ref, `${at}.ref`, out, 200);
      // An external assertion is dated: what is not asserted yet is not_measurable_yet, never an undated assertion.
      date(p.as_of, `${at}.as_of`, out);
      break;
    case "not_measurable_yet":
      text(p.reason, `${at}.reason`, out, 160);
      break;
  }
}

function predicateProblems(p: unknown, at: string, depth: number, out: string[]): void {
  if (!isObject(p)) { out.push(`${at}: must be an object`); return; }
  const kind = p.kind;
  if (typeof kind !== "string" || !(kind in PREDICATE_FIELDS)) { out.push(`${at}.kind: must be one of ${ADR_PREDICATE_KINDS.join(", ")}`); return; }
  const fields = PREDICATE_FIELDS[kind];
  unknownKeys(p, ["kind", ...fields.required, ...fields.optional], at, out);
  for (const f of fields.required) if (!(f in p)) out.push(`${at}.${f}: required for ${kind}`);
  if ((COMBINATORS as readonly string[]).includes(kind)) {
    if (depth >= MAX_PREDICATE_DEPTH) { out.push(`${at}: nesting deeper than ${MAX_PREDICATE_DEPTH} levels`); return; }
    if (!Array.isArray(p.of) || p.of.length < 1 || p.of.length > 8) { out.push(`${at}.of: must hold 1–8 predicates`); return; }
    p.of.forEach((q, i) => predicateProblems(q, `${at}.of[${i}]`, depth + 1, out));
    return;
  }
  kindFieldProblems(p, kind, at, out);
}

/** Every leaf predicate of a predicate tree (combinators left out), in order. */
export function predicateLeaves(p: AdrPredicate): AdrPredicate[] {
  return Array.isArray(p.of) ? p.of.flatMap(predicateLeaves) : [p];
}

function phaseProblems(ph: unknown, at: string, groups: Set<string>, out: string[]): void {
  if (!isObject(ph)) { out.push(`${at}: must be an object`); return; }
  unknownKeys(ph, ["id", "group", "title", "weight", "depends_on", "evidence", "built", "doc_claim", "next", "note", "owner_action"], at, out);
  if (typeof ph.id !== "string" || !PHASE_ID.test(ph.id)) out.push(`${at}.id: must match ${PHASE_ID}`);
  if ("group" in ph && (typeof ph.group !== "string" || !groups.has(ph.group))) out.push(`${at}.group: must name a group of this manifest`);
  text(ph.title, `${at}.title`, out, 120);
  if ("weight" in ph && (!isInt(ph.weight) || ph.weight < 1 || ph.weight > 5)) out.push(`${at}.weight: must be an integer from 1 to 5`);
  if ("depends_on" in ph) {
    if (!Array.isArray(ph.depends_on)) out.push(`${at}.depends_on: must be an array`);
    else ph.depends_on.forEach((d, i) => { if (typeof d !== "string" || !DEPENDS_ON.test(d)) out.push(`${at}.depends_on[${i}]: must match ${DEPENDS_ON}`); });
  }
  if (!("evidence" in ph)) out.push(`${at}.evidence: required`);
  else predicateProblems(ph.evidence, `${at}.evidence`, 1, out);
  if ("built" in ph) {
    if (!Array.isArray(ph.built) || ph.built.length === 0) out.push(`${at}.built: must be a non-empty array of paths`);
    else ph.built.forEach((b, i) => {
      if (typeof b !== "string" || !BUILT_PATH.test(b)) out.push(`${at}.built[${i}]: must start with workers/, organism/, docs/ or architecture/`);
      else repoPath(b, `${at}.built[${i}]`, out);
    });
  }
  if ("doc_claim" in ph) {
    const c = ph.doc_claim;
    if (!isObject(c)) out.push(`${at}.doc_claim: must be an object`);
    else {
      unknownKeys(c, ["state", "ref", "quote"], `${at}.doc_claim`, out);
      if (!(DOC_CLAIM_STATES as readonly unknown[]).includes(c.state)) out.push(`${at}.doc_claim.state: must be one of ${DOC_CLAIM_STATES.join(", ")}`);
      repoPath(c.ref, `${at}.doc_claim.ref`, out);
      text(c.quote, `${at}.doc_claim.quote`, out, 200, 6);
    }
  }
  if ("next" in ph) text(ph.next, `${at}.next`, out, 160);
  if ("note" in ph) text(ph.note, `${at}.note`, out, 160);
  if ("owner_action" in ph) {
    const a = ph.owner_action;
    if (!isObject(a)) out.push(`${at}.owner_action: must be an object`);
    else {
      unknownKeys(a, ["text", "href", "outside_platform"], `${at}.owner_action`, out);
      text(a.text, `${at}.owner_action.text`, out, 160);
      if ("href" in a && !(OWNER_ACTION_HREFS as readonly unknown[]).includes(a.href)) out.push(`${at}.owner_action.href: must be one of ${OWNER_ACTION_HREFS.join(", ")}`);
      if ("outside_platform" in a && typeof a.outside_platform !== "boolean") out.push(`${at}.owner_action.outside_platform: must be a boolean`);
    }
  }
}

/**
 * Every problem of a candidate manifest (adr.progress.v1); empty when it is valid. With `fileName` (for example
 * "0012.json"), the manifest's `adr` must equal the file's name.
 */
export function adrManifestProblems(m: unknown, fileName?: string): string[] {
  const out: string[] = [];
  if (!isObject(m)) return ["manifest: must be a JSON object"];
  unknownKeys(m, ["schema", "adr", "title", "adr_file", "lifecycle", "lifecycle_note", "superseded_by", "scope", "fits", "groups", "phases"], "manifest", out);
  if (m.schema !== ADR_PROGRESS_SCHEMA) out.push(`manifest.schema: must be "${ADR_PROGRESS_SCHEMA}"`);
  if (typeof m.adr !== "string" || !ADR_ID.test(m.adr)) out.push(`manifest.adr: must match ${ADR_ID}`);
  else if (fileName !== undefined && fileName !== `${m.adr}.json`) out.push(`manifest.adr: "${m.adr}" does not match the file name ${fileName}`);
  text(m.title, "manifest.title", out, 160, 3);
  if (!(ADR_LIFECYCLES as readonly unknown[]).includes(m.lifecycle)) out.push(`manifest.lifecycle: must be one of ${ADR_LIFECYCLES.join(", ")}`);

  const adrFile = "adr_file" in m ? m.adr_file : null;
  if (adrFile !== null) {
    if (typeof m.adr_file !== "string" || !ADR_FILE.test(m.adr_file)) out.push(`manifest.adr_file: must match ${ADR_FILE} or be null`);
    else if (typeof m.adr === "string" && !m.adr_file.startsWith(`architecture/adr/${m.adr}-`)) out.push(`manifest.adr_file: must be ADR-${m.adr}'s file`);
  }
  // §2.1 point 5: a held or planned ADR is not on main; an accepted, deferred or superseded one is.
  const offMain = m.lifecycle === "held" || m.lifecycle === "planned";
  if (offMain && adrFile !== null) out.push(`manifest.adr_file: must be null when the lifecycle is ${m.lifecycle}`);
  if (!offMain && (ADR_LIFECYCLES as readonly unknown[]).includes(m.lifecycle) && adrFile === null) out.push(`manifest.adr_file: required when the lifecycle is ${m.lifecycle}`);
  if (offMain && !("lifecycle_note" in m)) out.push(`manifest.lifecycle_note: required when the lifecycle is ${m.lifecycle} (say where the ADR is)`);
  if ("lifecycle_note" in m) text(m.lifecycle_note, "manifest.lifecycle_note", out, 300);
  if (m.lifecycle === "superseded") {
    if (typeof m.superseded_by !== "string" || !ADR_ID.test(m.superseded_by)) out.push("manifest.superseded_by: required for a superseded ADR");
  } else if ("superseded_by" in m) out.push("manifest.superseded_by: only for a superseded ADR");
  if ("scope" in m && !(ADR_SCOPES as readonly unknown[]).includes(m.scope)) out.push(`manifest.scope: must be one of ${ADR_SCOPES.join(", ")}`);
  if ("fits" in m) {
    if (!Array.isArray(m.fits)) out.push("manifest.fits: must be an array");
    else m.fits.forEach((f, i) => { if (typeof f !== "string" || !FITS.test(f)) out.push(`manifest.fits[${i}]: must match ${FITS}`); });
  }

  const groups = new Set<string>();
  if ("groups" in m) {
    if (!Array.isArray(m.groups)) out.push("manifest.groups: must be an array");
    else m.groups.forEach((g, i) => {
      const at = `manifest.groups[${i}]`;
      if (!isObject(g)) { out.push(`${at}: must be an object`); return; }
      unknownKeys(g, ["id", "title"], at, out);
      if (typeof g.id !== "string" || !GROUP_ID.test(g.id)) out.push(`${at}.id: must match ${GROUP_ID}`);
      else if (groups.has(g.id)) out.push(`${at}.id: duplicate "${g.id}"`);
      else groups.add(g.id);
      text(g.title, `${at}.title`, out, 80);
    });
  }

  if (!Array.isArray(m.phases)) out.push("manifest.phases: must be an array");
  else if (m.phases.length > 40) out.push("manifest.phases: at most 40 phases");
  else {
    const ids = new Set<string>();
    m.phases.forEach((ph, i) => {
      phaseProblems(ph, `phases[${i}]`, groups, out);
      const id = isObject(ph) ? ph.id : undefined;
      if (typeof id === "string") { if (ids.has(id)) out.push(`phases[${i}].id: duplicate "${id}"`); ids.add(id); }
    });
    // A dependency within this manifest must name one of its phases (and not itself); one with an ADR prefix
    // ("0016:T1") is checked against the other manifests by CI.
    m.phases.forEach((ph, i) => {
      if (!isObject(ph) || !Array.isArray(ph.depends_on)) return;
      ph.depends_on.forEach((d, j) => {
        if (typeof d !== "string" || !DEPENDS_ON.test(d)) return;
        const local = d.includes(":") && d.slice(0, 4) === m.adr ? d.slice(5) : d.includes(":") ? null : d;
        if (local === null) return;
        if (local === ph.id) out.push(`phases[${i}].depends_on[${j}]: a phase cannot depend on itself`);
        else if (!ids.has(local)) out.push(`phases[${i}].depends_on[${j}]: "${d}" names no phase of this manifest`);
      });
    });
  }
  return out;
}

/** The manifest, typed, when it is valid; null otherwise. */
export function parseAdrManifest(m: unknown, fileName?: string): AdrManifest | null {
  return adrManifestProblems(m, fileName).length === 0 ? (m as AdrManifest) : null;
}
