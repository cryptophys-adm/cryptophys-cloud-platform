// ADR-0012 G2c-2 (§5l): configuration and binding changes without GitHub.
//
// Until now a unit whose wrangler.toml changed (`config_changed`, §5g) deploys through its GitHub workflow,
// which renders the deploy-time values and runs `wrangler deploy`. This module computes, without wrangler and
// without GitHub, what that deploy would have changed, and says when it cannot:
//   1. `parseToml`: a strict TOML subset, enough for this repository's workers/*/wrangler.toml. Anything it
//      does not understand returns null (`config_unparsed`); it never guesses.
//   2. `bindingsFromToml`: the bindings a config declares, as records in the Workers API metadata shape
//      (`{ type, name, ... }`). An unknown kind is refused with a reason.
//   3. `planConfigChange(runningToml, targetToml, activeBindings)`: the active version's bindings with the
//      toml diff applied. A binding the diff does not name (a deploy-time `--var`, a secret, one the
//      dashboard added) is kept exactly as the API returned it. Deploy-time placeholders resolve from the
//      active binding of the same type and name. Secrets are never in the plan: they stay via keep_bindings.
//      Service bindings (2026-11-16) are the exception to "kept verbatim": the target config's value is the plan
//      whenever the active record differs from it (see `service_bindings`, control-plane-shared/src/service-bindings.ts).
//      Settings that are not bindings go to the version metadata or to separate plan steps; the ones a
//      version upload cannot apply make the Worker ineligible (it stays on its GitHub workflow).
//   4. `verifyPlannedBindings`: after the upload and before any traffic moves, the new version must bind
//      exactly the plan (the same principle as the G2b binding check). An uploaded version that is never
//      deployed is harmless.
// Pure functions only: no I/O, no Cloudflare call. Wiring into native-deploy.ts is a later step (§5l).
import { parseToml, type TomlTable, type TomlValue } from "../../control-plane-shared/src/toml.ts";
import { propsUnknown, serviceBindingDiff, type BindingDrift, type ServiceBinding } from "../../control-plane-shared/src/service-bindings.ts";

// ---------------------------------------------------------------------------------------------------------
// 1. TOML subset (control-plane-shared/src/toml.ts since 2026-11-16; re-exported for this module's callers)
// ---------------------------------------------------------------------------------------------------------

export type { TomlTable, TomlValue } from "../../control-plane-shared/src/toml.ts";
export { parseToml } from "../../control-plane-shared/src/toml.ts";

// ---------------------------------------------------------------------------------------------------------
// 2. Bindings in the Workers API metadata shape
// ---------------------------------------------------------------------------------------------------------

/** A binding as the Workers API metadata (and GET /versions/{id}) represents it. */
export interface BindingRecord { type: string; name: string; [field: string]: unknown }
export type BindingsResult = { bindings: BindingRecord[]; reason?: undefined } | { bindings: null; reason: string };

/** Binding types whose value the API never returns; they stay through keep_bindings and never enter a plan. */
export const SECRET_TYPES = ["secret_text", "secret_key"] as const;
const isSecret = (type: string) => (SECRET_TYPES as readonly string[]).includes(type);

interface KindSpec {
  /** The API binding type. */
  type: string;
  /** Where the binding name comes from in the toml entry. */
  nameField: "binding" | "name";
  /** toml field -> API field. */
  fields: Record<string, string>;
  required: string[];
  /** Fields only wrangler reads locally (or registration settings handled elsewhere); never sent. */
  ignored: string[];
}

/** Array-of-entries kinds, keyed by their wrangler.toml path. */
const ARRAY_KINDS: Record<string, KindSpec> = {
  d1_databases: { type: "d1", nameField: "binding", fields: { database_id: "id" }, required: ["database_id"], ignored: ["database_name", "migrations_dir", "migrations_table", "preview_database_id"] },
  services: { type: "service", nameField: "binding", fields: { service: "service", entrypoint: "entrypoint", environment: "environment", props: "props" }, required: ["service"], ignored: [] },
  "durable_objects.bindings": { type: "durable_object_namespace", nameField: "name", fields: { class_name: "class_name", script_name: "script_name", environment: "environment" }, required: ["class_name"], ignored: [] },
  r2_buckets: { type: "r2_bucket", nameField: "binding", fields: { bucket_name: "bucket_name", jurisdiction: "jurisdiction" }, required: ["bucket_name"], ignored: ["preview_bucket_name"] },
  kv_namespaces: { type: "kv_namespace", nameField: "binding", fields: { id: "namespace_id" }, required: ["id"], ignored: ["preview_id"] },
  vectorize: { type: "vectorize", nameField: "binding", fields: { index_name: "index_name" }, required: ["index_name"], ignored: [] },
  // A workflow's registration (default_retention, limits) is not a binding: topology.ts registers it (gate 4 part B).
  workflows: { type: "workflow", nameField: "binding", fields: { name: "workflow_name", class_name: "class_name", script_name: "script_name" }, required: ["name", "class_name"], ignored: ["default_retention", "limits"] },
  artifacts: { type: "artifacts", nameField: "binding", fields: { namespace: "namespace" }, required: ["namespace"], ignored: [] },
  worker_loaders: { type: "worker_loader", nameField: "binding", fields: {}, required: [], ignored: [] },
  secrets_store_secrets: { type: "secrets_store_secret", nameField: "binding", fields: { store_id: "store_id", secret_name: "secret_name" }, required: ["store_id", "secret_name"], ignored: [] },
  send_email: { type: "send_email", nameField: "name", fields: { destination_address: "destination_address", allowed_destination_addresses: "allowed_destination_addresses", allowed_sender_addresses: "allowed_sender_addresses" }, required: [], ignored: [] },
  analytics_engine_datasets: { type: "analytics_engine", nameField: "binding", fields: { dataset: "dataset" }, required: ["dataset"], ignored: [] },
  "queues.producers": { type: "queue", nameField: "binding", fields: { queue: "queue_name", delivery_delay: "delivery_delay" }, required: ["queue"], ignored: [] },
};
/** Single-table kinds (`[ai]`, `[browser]`, `[version_metadata]`): only a binding name. */
const TABLE_KINDS: Record<string, string> = { ai: "ai", browser: "browser", version_metadata: "version_metadata" };

/** Top-level keys that are settings, not bindings. Anything outside these and the binding kinds is refused. */
const SETTING_KEYS = new Set([
  "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "routes", "route",
  "observability", "triggers", "limits", "placement", "migrations", "rules", "previews", "logpush", "tail_consumers",
]);
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const isTable = (v: unknown): v is TomlTable => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function entryRecord(path: string, spec: KindSpec, entry: unknown): BindingRecord | string {
  if (!isTable(entry)) return `binding_unreadable:${path}`;
  const name = entry[spec.nameField];
  if (typeof name !== "string" || !BINDING_NAME.test(name)) return `binding_unreadable:${path}`;
  const record: BindingRecord = { type: spec.type, name };
  for (const [k, v] of Object.entries(entry)) {
    if (k === spec.nameField) continue;
    if (spec.ignored.includes(k)) continue;
    const apiField = spec.fields[k];
    if (!apiField) return `unsupported_binding_field:${path}.${k}`;
    record[apiField] = v;
  }
  for (const k of spec.required) if (record[spec.fields[k]] === undefined) return `binding_unreadable:${path}`;
  return record;
}

/**
 * Every binding a parsed wrangler.toml declares, as API metadata records, sorted by `type:name`. Refuses an
 * unknown top-level key (`unsupported_key:<key>`), an unknown field (`unsupported_binding_field:<path>`), a
 * non-string `[vars]` value (`var_not_string:<name>`) and a duplicate binding name.
 */
export function bindingsFromToml(config: TomlTable): BindingsResult {
  const out: BindingRecord[] = [];
  const refuse = (reason: string): BindingsResult => ({ bindings: null, reason });
  for (const [key, value] of Object.entries(config)) {
    if (SETTING_KEYS.has(key)) continue;
    if (key === "vars") {
      if (!isTable(value)) return refuse("binding_unreadable:vars");
      for (const [name, text] of Object.entries(value)) {
        if (!BINDING_NAME.test(name)) return refuse("binding_unreadable:vars");
        if (typeof text !== "string") return refuse(`var_not_string:${name}`);
        out.push({ type: "plain_text", name, text });
      }
      continue;
    }
    if (key in TABLE_KINDS) {
      if (!isTable(value) || Object.keys(value).some((k) => k !== "binding") || typeof value.binding !== "string" || !BINDING_NAME.test(value.binding)) {
        return refuse(`binding_unreadable:${key}`);
      }
      out.push({ type: TABLE_KINDS[key], name: value.binding });
      continue;
    }
    if (key === "assets") {
      // The assets binding only; the rest of [assets] is the assets configuration (assetsConfigFromToml).
      if (!isTable(value)) return refuse("binding_unreadable:assets");
      if (value.binding !== undefined) {
        if (typeof value.binding !== "string" || !BINDING_NAME.test(value.binding)) return refuse("binding_unreadable:assets");
        out.push({ type: "assets", name: value.binding });
      }
      continue;
    }
    // Nested kinds: [[durable_objects.bindings]] and [[queues.producers]] ([[queues.consumers]] is not a binding).
    const nested: Array<[string, unknown]> = [];
    if (key === "durable_objects" || key === "queues") {
      if (!isTable(value)) return refuse(`binding_unreadable:${key}`);
      for (const [sub, v] of Object.entries(value)) {
        if (key === "queues" && sub === "consumers") continue;
        nested.push([`${key}.${sub}`, v]);
      }
    } else {
      nested.push([key, value]);
    }
    for (const [path, v] of nested) {
      const spec = ARRAY_KINDS[path];
      if (!spec) return refuse(`unsupported_key:${path}`);
      if (!Array.isArray(v)) return refuse(`binding_unreadable:${path}`);
      for (const entry of v) {
        const r = entryRecord(path, spec, entry);
        if (typeof r === "string") return refuse(r);
        out.push(r);
      }
    }
  }
  const names = new Set<string>();
  for (const b of out) {
    if (names.has(b.name)) return refuse(`duplicate_binding_name:${b.name}`);
    names.add(b.name);
  }
  return { bindings: out.sort((a, b) => keyOf(a).localeCompare(keyOf(b))) };
}

/** The `[assets]` routing configuration for the version metadata (`assets.config`), or null with a reason. */
export function assetsConfigFromToml(config: TomlTable): { config: AssetsConfig; binding: string | null } | { config: null; reason: string } | null {
  const a = config.assets;
  if (a === undefined) return null;
  if (!isTable(a)) return { config: null, reason: "assets_unreadable" };
  const out: AssetsConfig = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === "directory" || k === "binding") continue;
    if (k === "html_handling" && typeof v === "string" && ["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"].includes(v)) out.html_handling = v;
    else if (k === "not_found_handling" && typeof v === "string" && ["single-page-application", "404-page", "none"].includes(v)) out.not_found_handling = v;
    else if (k === "run_worker_first" && (typeof v === "boolean" || (Array.isArray(v) && v.every((x) => typeof x === "string")))) out.run_worker_first = v as boolean | string[];
    else return { config: null, reason: `unsupported_assets_field:${k}` };
  }
  return { config: out, binding: typeof a.binding === "string" ? a.binding : null };
}
export interface AssetsConfig { html_handling?: string; not_found_handling?: string; run_worker_first?: boolean | string[] }

// ---------------------------------------------------------------------------------------------------------
// 3. The plan
// ---------------------------------------------------------------------------------------------------------

/**
 * Deploy-time placeholders in the committed configs and how the deploy workflows substitute them
 * (.github/scripts/render-d1-config.sh):
 *   - `__CONTROL_PLANE_D1_DATABASE_ID__` (every `[[d1_databases]] database_id`): the id of the D1 database
 *     named D1_DATABASE_NAME, resolved from the D1 API.
 *   - `owner-notify-placeholder@example.invalid` (the AI Kernel's `[[send_email]] allowed_destination_addresses`):
 *     the approver emails from APPROVER_IDENTITIES.
 * Any other `__NAME__` is treated as a placeholder as well. A placeholder resolves from the active version's
 * binding of the same type and name, and only when the field's text is the same in the running config.
 */
export const PLACEHOLDER = /__[A-Z][A-Z0-9_]*__|owner-notify-placeholder@example\.invalid/;

export const keyOf = (b: { type: string; name: string }) => `${b.type}:${b.name}`;

function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Fields the API adds to a record it was not sent: a service binding's `environment` ("production"), a
 * Durable Object binding's `namespace_id`. Only these may appear in an uploaded record built from config.
 */
const SERVER_ADDED: Record<string, Record<string, (v: unknown) => boolean>> = {
  service: { environment: (v) => v === "production" },
  durable_object_namespace: { namespace_id: (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v) },
};
/** Fields the API returns that are not upload input: dropped from records sent back in the metadata. */
const OUTPUT_ONLY: Record<string, string[]> = { durable_object_namespace: ["namespace_id"] };

/** Whether `actual` (from the API) is the binding `planned` describes: every planned field equal, extra fields only the server's. */
export function recordMatches(planned: BindingRecord, actual: BindingRecord): boolean {
  if (planned.type !== actual.type || planned.name !== actual.name) return false;
  for (const [k, v] of Object.entries(planned)) if (!same(v, actual[k])) return false;
  const extra = SERVER_ADDED[planned.type] ?? {};
  for (const [k, v] of Object.entries(actual)) {
    if (k in planned) continue;
    if (!extra[k]?.(v)) return false;
  }
  return true;
}

function placeholderIn(v: unknown): string | null {
  if (typeof v === "string") return PLACEHOLDER.exec(v)?.[0] ?? null;
  if (Array.isArray(v)) { for (const x of v) { const p = placeholderIn(x); if (p) return p; } }
  if (isTable(v as TomlValue)) { for (const x of Object.values(v as TomlTable)) { const p = placeholderIn(x); if (p) return p; } }
  return null;
}

/** Replace each placeholder-bearing field with the active binding's field; null names the unresolved placeholder. */
function resolve(record: BindingRecord, running: BindingRecord | undefined, active: BindingRecord | undefined): { record: BindingRecord } | { unresolved: string } {
  const out: BindingRecord = { ...record };
  for (const [k, v] of Object.entries(record)) {
    const p = placeholderIn(v);
    if (!p) continue;
    if (!running || !same(running[k], v) || !active || active[k] === undefined || placeholderIn(active[k])) return { unresolved: p };
    out[k] = active[k];
  }
  return { record: out };
}

export type PlanStep =
  | { kind: "schedules"; method: "PUT"; path: "schedules"; body: Array<{ cron: string }>; restore: Array<{ cron: string }>; when: "after_verify" }
  | { kind: "script_settings"; method: "PATCH"; path: "script-settings"; body: { observability: TomlTable }; restore: { observability: TomlTable }; when: "after_verify" };

export interface VersionSettings {
  compatibility_date: string;
  compatibility_flags: string[];
  limits?: TomlTable;
  placement?: TomlTable;
}

export interface ConfigPlan {
  eligible: true;
  /** Every non-secret binding the new version must have, in the API shape, sorted by `type:name`. */
  bindings: BindingRecord[];
  /** `type:name` -> where the record came from: kept verbatim from the active version, or built from the target config. */
  sources: Record<string, "active" | "config">;
  /** `type:name` of the active secrets; kept by `keep_bindings`, never sent. */
  secrets: string[];
  keep_bindings: string[];
  /** Version metadata fields the target config sets (always the full target values, not a diff). */
  metadata: VersionSettings;
  /** Script-level changes a version upload cannot carry, applied after the new version is verified live. */
  steps: PlanStep[];
  changes: { added: string[]; removed: string[]; changed: string[]; settings: string[] };
  /**
   * 2026-11-16 (binding props lost out of band): the service bindings the active version does not bind as the target
   * config declares, for a reason the toml diff does not explain. `restored` are planned from the config (sent as
   * declared, `<worker>:service_bindings_restored:<NAME>`); `undeclared` are active service bindings neither config
   * declares: they are NOT in `bindings`, and the executor refuses the plan (`serviceDriftRefusal`) rather than drop them.
   * `unverifiable` are declared bindings with props whose active record has no `props` key (service-bindings.ts
   * `propsUnknown`): planned from the config (the props are sent), not reported as drift by themselves.
   */
  service_bindings: { restored: BindingDrift[]; undeclared: string[]; unverifiable: string[] };
}
export interface Ineligible { eligible: false; reason: string }
export type ConfigPlanResult = ConfigPlan | Ineligible;

const no = (reason: string): Ineligible => ({ eligible: false, reason });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROUTING_KEYS = ["routes", "route", "workers_dev", "preview_urls"] as const;
const IDENTITY_KEYS = ["name", "main"] as const;

function readActive(list: unknown): BindingRecord[] | null {
  if (!Array.isArray(list)) return null;
  const out: BindingRecord[] = [];
  const keys = new Set<string>();
  for (const b of list) {
    if (!isTable(b as TomlValue) || typeof (b as BindingRecord).type !== "string" || typeof (b as BindingRecord).name !== "string") return null;
    const r = b as BindingRecord;
    if (keys.has(keyOf(r))) return null;
    keys.add(keyOf(r));
    out.push(r);
  }
  return out;
}

function crons(config: TomlTable): string[] | null {
  const t = config.triggers;
  if (t === undefined) return [];
  if (!isTable(t) || Object.keys(t).some((k) => k !== "crons")) return null;
  const c = t.crons ?? [];
  if (!Array.isArray(c) || !c.every((x) => typeof x === "string" && x.length <= 100)) return null;
  return [...c as string[]];
}

interface ConfigReading {
  runB: BindingRecord[];
  tgtB: BindingRecord[];
  metadata: VersionSettings;
  steps: PlanStep[];
  settings: string[];
}

/**
 * Gate 4 part B (topology.ts, owner 2026-11-15): with `topology`, the routes (`routes`, `route`), the Durable Object
 * `[[migrations]]` and the `[[workflows]]` registrations are not refused here; topology.ts plans them (and refuses
 * what it cannot apply natively). The Workflow bindings stay in the binding plan either way. Without it (the
 * default), every one of them is refused as before. `workers_dev` and `preview_urls` go to topology.ts only when both
 * configs set them as booleans; otherwise they stay `routing_changed`.
 */
export interface ConfigReadOptions { topology?: boolean }

/** Everything the two configs alone decide: the settings and steps, the declared bindings, or the refusal. */
function readConfigs(runningToml: string, targetToml: string, opts: ConfigReadOptions = {}): ConfigReading | Ineligible {
  const run = parseToml(runningToml);
  const tgt = parseToml(targetToml);
  if (!run || !tgt) return no("config_unparsed");

  for (const k of IDENTITY_KEYS) if (!same(run[k], tgt[k])) return no("identity_changed");
  for (const k of ROUTING_KEYS) {
    if (opts.topology && (k === "routes" || k === "route")) continue;
    // topology.ts applies workers_dev / preview_urls when both configs set them explicitly (wrangler's default otherwise depends on the routes).
    if (opts.topology && typeof run[k] === "boolean" && typeof tgt[k] === "boolean") continue;
    if (!same(run[k], tgt[k])) return no("routing_changed");
  }
  // Durable Object migrations are applied only by a script upload that deploys; a version upload cannot.
  if (!opts.topology && !same(run.migrations, tgt.migrations)) return no("do_migration");
  if (!same(run.assets, tgt.assets)) return no("assets_config_changed");
  if (!same(run.rules, tgt.rules)) return no("build_rules_changed");
  if (!same(run.previews, tgt.previews)) return no("previews_changed");
  // wrangler registers a workflow (PUT /workflows/{name}) on deploy; a binding alone does not.
  if (!opts.topology && !same(run.workflows, tgt.workflows)) return no("workflow_changed");
  const consumers = (c: TomlTable) => (isTable(c.queues) ? c.queues.consumers : undefined);
  if (!same(consumers(run), consumers(tgt))) return no("queue_consumer_changed");
  // Not available on version uploads (Cloudflare: multipart upload metadata).
  if (!same(run.tail_consumers, tgt.tail_consumers)) return no("tail_consumers_changed");
  if (!same(run.logpush, tgt.logpush)) return no("logpush_changed");

  const runB = bindingsFromToml(run);
  if (!runB.bindings) return no(runB.reason);
  const tgtB = bindingsFromToml(tgt);
  if (!tgtB.bindings) return no(tgtB.reason);

  // Settings that are not bindings.
  const date = tgt.compatibility_date;
  if (typeof date !== "string" || !DATE.test(date)) return no("compatibility_date_missing");
  const flags = tgt.compatibility_flags ?? [];
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === "string")) return no("config_unparsed");
  for (const k of ["limits", "placement", "observability"] as const) if (tgt[k] !== undefined && !isTable(tgt[k])) return no("config_unparsed");
  const runCrons = crons(run);
  const tgtCrons = crons(tgt);
  if (!runCrons || !tgtCrons) return no("unsupported_key:triggers");
  const metadata: VersionSettings = { compatibility_date: date, compatibility_flags: [...flags as string[]] };
  if (tgt.limits !== undefined) metadata.limits = tgt.limits as TomlTable;
  if (tgt.placement !== undefined) metadata.placement = tgt.placement as TomlTable;
  const settings: string[] = [];
  for (const k of ["compatibility_date", "compatibility_flags", "limits", "placement"] as const) if (!same(run[k], tgt[k])) settings.push(k);
  const steps: PlanStep[] = [];
  if (!same(runCrons, tgtCrons)) {
    settings.push("triggers.crons");
    steps.push({ kind: "schedules", method: "PUT", path: "schedules", body: tgtCrons.map((cron) => ({ cron })), restore: runCrons.map((cron) => ({ cron })), when: "after_verify" });
  }
  if (!same(run.observability, tgt.observability)) {
    // Observability is a script setting (not listed for version uploads); removing the table is ambiguous.
    if (!isTable(tgt.observability) || !isTable(run.observability)) return no("observability_removed_or_added");
    settings.push("observability");
    steps.push({ kind: "script_settings", method: "PATCH", path: "script-settings", body: { observability: tgt.observability }, restore: { observability: run.observability }, when: "after_verify" });
  }
  return { runB: runB.bindings, tgtB: tgtB.bindings, metadata, steps, settings };
}

/**
 * The refusal the two configs alone decide (the toml subset, identity, routing, Durable Object migrations,
 * assets, rules, workflows, queues, tail consumers, logpush, unsupported keys and settings), or null when only
 * the active version's bindings can decide. No Cloudflare call is needed for this; `planConfigChange` makes the
 * same checks first.
 */
export function configRefusal(runningToml: string, targetToml: string, opts: ConfigReadOptions = {}): string | null {
  const r = readConfigs(runningToml, targetToml, opts);
  return "eligible" in r ? r.reason : null;
}

/**
 * The bindings and settings a version of the target config must have, given the running config and the full
 * binding records the API returns for the active version. Ineligible (the Worker stays on its GitHub workflow)
 * with an explicit reason whenever a version upload cannot reproduce what `wrangler deploy` would do.
 */
export function planConfigChange(runningToml: string, targetToml: string, activeBindings: unknown, opts: ConfigReadOptions = {}): ConfigPlanResult {
  const read = readConfigs(runningToml, targetToml, opts);
  if ("eligible" in read) return read;
  const { runB, tgtB, metadata, steps, settings } = read;
  const active = readActive(activeBindings);
  if (!active) return no("active_bindings_unreadable");

  // Bindings.
  const runMap = new Map(runB.map((b) => [keyOf(b), b]));
  const tgtMap = new Map(tgtB.map((b) => [keyOf(b), b]));
  const activeMap = new Map(active.map((b) => [keyOf(b), b]));
  const secrets = active.filter((b) => isSecret(b.type)).map(keyOf).sort();
  const planned = new Map<string, BindingRecord>();
  const sources: Record<string, "active" | "config"> = {};
  const changes = { added: [] as string[], removed: [] as string[], changed: [] as string[], settings };

  // The running config must describe what is active for every binding the diff touches.
  const matchesRunning = (k: string): Ineligible | null => {
    const r = runMap.get(k)!;
    const a = activeMap.get(k);
    if (!a) return no(`active_binding_missing:${k}`);
    const resolved = resolve(r, r, a);
    if ("unresolved" in resolved) return no(`unresolved_placeholder:${resolved.unresolved}`);
    return recordMatches(resolved.record, a) ? null : no(`active_differs_from_config:${k}`);
  };

  for (const a of active) {
    const k = keyOf(a);
    if (a.type === "service") continue; // planned below, from the config
    if (isSecret(a.type)) {
      if (tgtMap.has(k) || runMap.has(k)) return no(`binding_name_conflict:${a.name}`);
      continue;
    }
    if (runMap.has(k) && !tgtMap.has(k)) {
      const bad = matchesRunning(k);
      if (bad) return bad;
      changes.removed.push(k);
      continue;
    }
    if (runMap.has(k) && !same(runMap.get(k), tgtMap.get(k))) continue; // changed: built below
    if (!runMap.has(k) && tgtMap.has(k)) return no(`binding_set_outside_config:${k}`);
    planned.set(k, a);
    sources[k] = "active";
  }
  for (const k of runMap.keys()) if (!activeMap.has(k) && !k.startsWith("service:")) return no(`active_binding_missing:${k}`);
  for (const [k, t] of tgtMap) {
    if (t.type === "service") continue; // planned below, from the config
    const r = runMap.get(k);
    if (r && same(r, t)) continue; // unchanged: kept from the active version above
    if (r) {
      const bad = matchesRunning(k);
      if (bad) return bad;
    }
    const resolved = resolve(t, r, activeMap.get(k));
    if ("unresolved" in resolved) return no(`unresolved_placeholder:${resolved.unresolved}`);
    planned.set(k, resolved.record);
    sources[k] = "config";
    (r ? changes.changed : changes.added).push(k);
  }

  // 2026-11-16: service bindings carry no secret, so the target config's value is always the plan. An active record
  // equal to it is kept verbatim (as before); one that is missing or differs (a version made out of band, e.g. by a
  // dashboard secret edit, that dropped `props`) is planned from the config and reported as restored, unless the toml
  // diff alone explains the difference (an added binding, or a changed one whose active record is the running value).
  // An active service binding neither config declares is reported as undeclared and left out of the plan; the
  // executor refuses such a plan. A service binding the diff removes is removed, whatever the active record holds.
  const restored: BindingDrift[] = [];
  const unverifiable: string[] = [];
  const undeclared: string[] = [];
  for (const [k, t] of tgtMap) {
    if (t.type !== "service") continue;
    const r = runMap.get(k);
    const a = activeMap.get(k);
    const resolved = resolve(t, r, a);
    if ("unresolved" in resolved) return no(`unresolved_placeholder:${resolved.unresolved}`);
    const declared = resolved.record;
    // The same comparison as every other path (service-bindings.ts): the API's `environment` and an empty `props` are no difference.
    const matches = (want: BindingRecord, got: BindingRecord | undefined) => serviceBindingDiff(want as unknown as ServiceBinding, got).length === 0;
    // Props unknown (no `props` key on the active record): never kept verbatim, so the declared props are sent.
    const unknown = propsUnknown(declared as unknown as ServiceBinding, a);
    if (unknown) unverifiable.push(t.name);
    const keep = a !== undefined && matches(declared, a) && !unknown;
    planned.set(k, keep ? a! : declared);
    sources[k] = keep ? "active" : "config";
    if (r && !same(r, t)) changes.changed.push(k);
    else if (!r) changes.added.push(k);
    if (keep) continue;
    // Only the props are unknown: resent, but not drift by itself.
    if (unknown && matches(declared, a)) continue;
    let explained = !r && !a;
    if (r && !same(r, t) && a) {
      const was = resolve(r, r, a);
      explained = !("unresolved" in was) && matches(was.record, a);
    }
    if (!explained) {
      const kinds = serviceBindingDiff(declared as unknown as ServiceBinding, a);
      restored.push({ name: t.name, kinds: kinds.length ? kinds : ["fields"], retarget: kinds.includes("missing") || kinds.includes("service") });
    }
  }
  for (const a of active) {
    if (a.type !== "service" || tgtMap.has(keyOf(a))) continue;
    if (runMap.has(keyOf(a))) changes.removed.push(keyOf(a));
    else undeclared.push(a.name);
  }

  const names = new Set<string>(secrets.map((s) => s.slice(s.indexOf(":") + 1)));
  for (const b of planned.values()) {
    if (names.has(b.name)) return no(`binding_name_conflict:${b.name}`);
    names.add(b.name);
  }
  const bindings = [...planned.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  for (const list of [changes.added, changes.removed, changes.changed]) list.sort();
  return {
    eligible: true, bindings, sources, secrets, keep_bindings: [...SECRET_TYPES], metadata, steps, changes,
    service_bindings: { restored: restored.sort((a, b) => a.name.localeCompare(b.name)), undeclared: undeclared.sort(), unverifiable: unverifiable.sort() },
  };
}

/**
 * The plan's bindings as upload input: output-only fields (a Durable Object binding's `namespace_id`) dropped.
 * The version is uploaded with these as `bindings` and `keep_bindings: ["secret_text", "secret_key"]`.
 */
export function uploadBindings(plan: ConfigPlan): BindingRecord[] {
  return plan.bindings.map((b) => {
    const drop = OUTPUT_ONLY[b.type];
    if (!drop) return { ...b };
    return Object.fromEntries(Object.entries(b).filter(([k]) => !drop.includes(k))) as BindingRecord;
  });
}

// ---------------------------------------------------------------------------------------------------------
// 4. After the upload, before traffic
// ---------------------------------------------------------------------------------------------------------

export type BindingCheck = { ok: true } | { ok: false; reason: string; binding?: string };

/**
 * Whether the uploaded version binds exactly the plan. Non-secret records: the same `type:name` set; a record
 * kept from the active version must be equal field for field; one built from config may differ only by the
 * fields the API adds. Secrets: the same `type:name` set as the active version. Any difference aborts the
 * deploy before traffic moves.
 */
export function verifyPlannedBindings(plan: Pick<ConfigPlan, "bindings" | "sources" | "secrets">, uploadedVersionBindings: unknown): BindingCheck {
  const uploaded = readActive(uploadedVersionBindings);
  if (!uploaded) return { ok: false, reason: "uploaded_bindings_unreadable" };
  const plain = uploaded.filter((b) => !isSecret(b.type));
  const secrets = uploaded.filter((b) => isSecret(b.type)).map(keyOf).sort();
  if (!same(secrets, [...plan.secrets].sort())) return { ok: false, reason: "secrets_differ" };
  const want = new Map(plan.bindings.map((b) => [keyOf(b), b]));
  for (const b of plain) if (!want.has(keyOf(b))) return { ok: false, reason: "unexpected_binding", binding: keyOf(b) };
  for (const [k, p] of want) {
    const got = plain.find((b) => keyOf(b) === k);
    if (!got) return { ok: false, reason: "missing_binding", binding: k };
    // A service binding built from config: the shared comparison (a record without a `props` key is accepted as props
    // unknown; the executor names it, service-bindings.ts verifyServiceBindings).
    const ok = plan.sources[k] === "active" ? same(p, got)
      : p.type === "service" ? serviceBindingDiff(p as unknown as ServiceBinding, got).length === 0
      : recordMatches(p, got);
    if (!ok) return { ok: false, reason: "binding_differs", binding: k };
  }
  return { ok: true };
}

/**
 * Whether the uploaded version runs with the planned settings, read from the version as the API returns it
 * (`GET /accounts/{a}/workers/scripts/{name}/versions/{id}`, `result.resources.script_runtime`). The Cloudflare
 * docs do not list `limits` among the version-upload metadata fields, so a version that came back without the
 * planned `cpu_ms` aborts the deploy rather than run with the default limit. Unreadable fails closed.
 */
export function verifyVersionSettings(metadata: VersionSettings, version: unknown): BindingCheck {
  const runtime = (version as { resources?: { script_runtime?: Record<string, unknown> } } | null)?.resources?.script_runtime;
  if (!runtime || typeof runtime !== "object") return { ok: false, reason: "version_settings_unreadable" };
  if (runtime.compatibility_date !== metadata.compatibility_date) return { ok: false, reason: "compatibility_date_differs" };
  const flags = Array.isArray(runtime.compatibility_flags) ? [...runtime.compatibility_flags as unknown[]].map(String).sort() : [];
  if (!same(flags, [...metadata.compatibility_flags].sort())) return { ok: false, reason: "compatibility_flags_differ" };
  if (metadata.limits) {
    const limits = runtime.limits as Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(metadata.limits)) if (!limits || !same(limits[k], v)) return { ok: false, reason: "limits_differ" };
  }
  return { ok: true };
}
