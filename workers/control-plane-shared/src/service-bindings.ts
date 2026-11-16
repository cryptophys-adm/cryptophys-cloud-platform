// 2026-11-16 (owner-approved): a Worker's service bindings are what its wrangler.toml declares, on every deploy path.
//
// Incident 2026-11-15 ~22:00-23:30 UTC: an out-of-band version of cryptophys-recovery-manager (and of
// cryptophys-deployment-orchestrator) appeared, most likely from secret edits in the dashboard, without the AGENTS
// binding's `props = { host_worker = "..." }`. The AI Kernel's AgentRpc entrypoint (ai-kernel/src/agent-rpc.ts) then
// refused the caller (`caller_identity_missing`), and every report of the Recovery Manager was lost. Each later native
// deploy kept the loss: the code-only upload keeps every binding of the previous version (keep_bindings) and checks
// the new version against the ACTIVE one, and the configuration plan kept an unchanged binding verbatim from the
// active version. Only a `wrangler deploy` from the GitHub workflow put the props back, and that workflow leaves at
// cut-over step 6.
//
// A service binding carries no secret (a script name, an entrypoint, JSON props), so the declared value can always be
// sent again. This module, pure and shared by the Orchestrator's native deploy (native-deploy.ts, config-diff.ts) and
// the Recovery Manager's rescue executor (executor-rescue.ts), says:
//   - `declaredServiceBindings`: the `[[services]]` of a wrangler.toml, in the Workers API shape
//     (`{ type: "service", name, service, entrypoint?, environment?, props? }`), refused when anything is unreadable;
//   - `serviceBindingDrift`: how the active version's service bindings (as `GET .../versions/{id}` returns them)
//     differ: a declared binding missing, its service, entrypoint or props different (deep-equal JSON), or an active
//     service binding the config does not declare (`undeclared`), or a declared name bound as another type;
//   - `serviceDriftRefusal`: what may not be repaired by resending: an undeclared service binding
//     (`service_binding_undeclared:<NAME>`; dropping it is the owner's decision, not a routine deploy's) and a name
//     bound as another type (`service_binding_name_conflict:<NAME>`);
//   - `verifyServiceBindings`: after the upload, the new version binds exactly the declared service bindings, props
//     included (the API may add `environment: "production"`, nothing else).
// Names only ever leave this module in steps, audit events and reports; a service binding has no secret value anyway.

import { parseToml, type TomlTable } from "./toml.ts";

export interface ServiceBinding {
  type: "service";
  name: string;
  service: string;
  entrypoint?: string;
  environment?: string;
  props?: Record<string, unknown>;
}

/** What differs for one declared binding: absent, or which of its fields. */
export type DriftKind = "missing" | "service" | "entrypoint" | "props" | "environment" | "fields";
export interface BindingDrift {
  name: string;
  kinds: DriftKind[];
  /** The declared target script is not the one the active version binds (missing, or `service` differs). */
  retarget: boolean;
}
export interface ServiceBindingDrift {
  /** Declared bindings the active version does not bind as declared: resent from the config. */
  restore: BindingDrift[];
  /** Active service bindings the config does not declare. */
  undeclared: string[];
  /** Declared names the active version binds as another type. */
  conflicts: string[];
}

/** The audit events of a drift (deployment-orchestrator and recovery-manager). */
export const BINDING_DRIFT_DETECTED_EVENT = "deployment.binding_drift_detected";
export const BINDING_DRIFT_REPAIRED_EVENT = "deployment.binding_drift_repaired";
/** The outcome step of one restored binding: `<worker>:service_bindings_restored:<BINDING>` (names only). */
export const restoredStep = (worker: string, binding: string) => `${worker}:service_bindings_restored:${binding}`;

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FIELDS = new Set(["binding", "service", "entrypoint", "environment", "props"]);
const isTable = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

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
 * The `[[services]]` a parsed wrangler.toml declares, sorted by name. Refused (never guessed) when an entry is not a
 * table, has a field outside binding/service/entrypoint/environment/props, or a binding name, script name,
 * entrypoint or props of the wrong shape, or when two entries share a name.
 */
export function declaredServiceBindings(config: TomlTable): { bindings: ServiceBinding[] } | { reason: string } {
  const list = config.services;
  if (list === undefined) return { bindings: [] };
  if (!Array.isArray(list)) return { reason: "services_unreadable" };
  const out: ServiceBinding[] = [];
  for (const entry of list) {
    if (!isTable(entry)) return { reason: "services_unreadable" };
    for (const k of Object.keys(entry)) if (!FIELDS.has(k)) return { reason: `unsupported_binding_field:services.${k}` };
    const { binding, service, entrypoint, environment, props } = entry;
    if (typeof binding !== "string" || !BINDING_NAME.test(binding)) return { reason: "services_unreadable" };
    if (typeof service !== "string" || !SCRIPT_NAME.test(service)) return { reason: `services_unreadable:${binding}` };
    if (entrypoint !== undefined && (typeof entrypoint !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(entrypoint))) return { reason: `services_unreadable:${binding}` };
    if (environment !== undefined && typeof environment !== "string") return { reason: `services_unreadable:${binding}` };
    if (props !== undefined && !isTable(props)) return { reason: `services_unreadable:${binding}` };
    if (out.some((b) => b.name === binding)) return { reason: `duplicate_binding_name:${binding}` };
    const b: ServiceBinding = { type: "service", name: binding, service };
    if (entrypoint !== undefined) b.entrypoint = entrypoint as string;
    if (environment !== undefined) b.environment = environment as string;
    if (props !== undefined) b.props = props as Record<string, unknown>;
    out.push(b);
  }
  return { bindings: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** `declaredServiceBindings` of a wrangler.toml text; `config_unparsed` when the text is outside the TOML subset. */
export function declaredServiceBindingsFromToml(text: string): { bindings: ServiceBinding[] } | { reason: string } {
  const config = parseToml(text);
  return config ? declaredServiceBindings(config) : { reason: "config_unparsed" };
}

export type ApiBinding = { type: string; name: string; [field: string]: unknown };

/** The binding records of a version, as the API returns them; null when they cannot be read. */
export function readBindingRecords(list: unknown): ApiBinding[] | null {
  if (!Array.isArray(list)) return null;
  if (!list.every((b) => isTable(b) && typeof b.type === "string" && typeof b.name === "string")) return null;
  return list as ApiBinding[];
}

/** The fields of `actual` that differ from the declared binding (empty: it is the declared binding). */
export function serviceBindingDiff(declared: ServiceBinding, actual: ApiBinding | undefined): DriftKind[] {
  if (!actual || actual.type !== "service") return ["missing"];
  const kinds: DriftKind[] = [];
  if (actual.service !== declared.service) kinds.push("service");
  if (!same(actual.entrypoint, declared.entrypoint)) kinds.push("entrypoint");
  // Props absent and props `{}` pass the same (empty) object to the target's ctx.props.
  const props = (p: unknown) => (isTable(p) && Object.keys(p).length === 0 ? undefined : p);
  if (!same(props(actual.props), props(declared.props))) kinds.push("props");
  // The API adds `environment: "production"` to a binding sent without one.
  if (declared.environment !== undefined ? actual.environment !== declared.environment : actual.environment !== undefined && actual.environment !== "production") kinds.push("environment");
  for (const k of Object.keys(actual)) if (!["type", "name", "service", "entrypoint", "props", "environment"].includes(k)) { kinds.push("fields"); break; }
  return kinds;
}

/**
 * How the active version's service bindings differ from the declared ones. Null when the active bindings cannot be
 * read (callers fail closed).
 */
export function serviceBindingDrift(declared: readonly ServiceBinding[], activeBindings: unknown): ServiceBindingDrift | null {
  const active = readBindingRecords(activeBindings);
  if (!active) return null;
  const restore: BindingDrift[] = [];
  const conflicts: string[] = [];
  for (const d of declared) {
    const sameName = active.filter((b) => b.name === d.name);
    if (sameName.some((b) => b.type !== "service")) { conflicts.push(d.name); continue; }
    const a = sameName[0];
    const kinds = serviceBindingDiff(d, a);
    if (kinds.length) restore.push({ name: d.name, kinds, retarget: kinds.includes("missing") || kinds.includes("service") });
  }
  const names = new Set(declared.map((d) => d.name));
  const undeclared = active.filter((b) => b.type === "service" && !names.has(b.name)).map((b) => b.name).sort();
  return { restore, undeclared, conflicts: conflicts.sort() };
}

/** What a routine deploy may not repair by resending the declared bindings, or null. */
export function serviceDriftRefusal(drift: Pick<ServiceBindingDrift, "undeclared"> & Partial<Pick<ServiceBindingDrift, "conflicts">>): string | null {
  if (drift.conflicts?.length) return `service_binding_name_conflict:${drift.conflicts.join(",")}`;
  if (drift.undeclared.length) return `service_binding_undeclared:${drift.undeclared.join(",")}`;
  return null;
}

/**
 * Whether an uploaded version binds exactly the declared service bindings: the same names, each one's service,
 * entrypoint and props equal (props deep-equal), no other field but the API's `environment: "production"`.
 */
export function verifyServiceBindings(declared: readonly ServiceBinding[], uploadedBindings: unknown): { ok: true } | { ok: false; reason: string; binding?: string } {
  const uploaded = readBindingRecords(uploadedBindings);
  if (!uploaded) return { ok: false, reason: "uploaded_bindings_unreadable" };
  const services = uploaded.filter((b) => b.type === "service");
  const names = new Set(declared.map((d) => d.name));
  for (const b of services) if (!names.has(b.name)) return { ok: false, reason: "service_binding_unexpected", binding: b.name };
  for (const d of declared) {
    const got = uploaded.filter((b) => b.name === d.name);
    if (got.length !== 1) return { ok: false, reason: got.length ? "service_binding_duplicated" : "service_binding_missing", binding: d.name };
    const kinds = serviceBindingDiff(d, got[0]);
    if (kinds.length) return { ok: false, reason: `service_binding_${kinds[0]}_differs`, binding: d.name };
  }
  return { ok: true };
}

/** The sorted `type:name` and a digest of every record that is not a service binding (the code-only check). */
export async function nonServiceBindingSet(records: readonly ApiBinding[]): Promise<{ names: string[]; digest: string }> {
  const rest = records.filter((b) => b.type !== "service");
  const text = rest.map((b) => canonical(b)).sort().join("\n");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return { names: rest.map((b) => `${b.type}:${b.name}`).sort(), digest: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("") };
}
