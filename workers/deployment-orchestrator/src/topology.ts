// ADR-0012 G6 gate 4 part B (docs/GITHUB-CUTOVER.md; owner 2026-11-15, "1 setuju"): the changes the G2c-2 plan refused
// (`routing_changed` for routes, `do_migration`, `workflow_changed`) planned and applied natively, through the Cloudflare
// API with CF_DEPLOY_TOKEN, where that can be done safely. What cannot is refused with a reason that names it.
//
// The plan is always "the target config against what the running config declared AND what Cloudflare reports live":
//   - Custom domains (`routes = [{ pattern, custom_domain = true }]`). A new one is attached with the Workers Custom
//     Domains API (PUT /accounts/{a}/workers/domains, Workers Scripts Write) after the new version is verified live, and
//     read back (GET ?hostname=: exactly one record, on this Worker). On any later failure it is detached again (DELETE
//     /workers/domains/{id}), before the deployments are restored. One already attached to this Worker needs nothing;
//     one on another Worker is refused (`custom_domain_on_other_worker:<host>`): attaching would move it.
//   - Zone routes (a `route`/`routes` pattern without `custom_domain`). Creating or removing one needs the zone permission
//     Workers Routes Edit, which the deploy token does not hold: an owner settings decision (2026-11-06, ADR-0010), not a
//     code gap. A new zone route is accepted only when the script list already reports it for this Worker (attached by
//     the owner); otherwise `zone_route_needs_zone_token:<pattern>`. Removing one stays `zone_route_removal_owner_run`, and
//     turning a custom domain into a zone route or back is `route_change_needs_zone_token:<pattern>`.
//   - `workers_dev` / `preview_urls`, when both configs set them as booleans (absent on either side stays
//     `routing_changed`: wrangler's default depends on the routes). Turning one on is applied natively (POST
//     …/scripts/{name}/subdomain) after the live check, read back, and put back on a later failure.
//   - Durable Object migrations (`[[migrations]]`). The running config's entries must be the first entries of the target's
//     (`do_migration_history_changed`), and the script's live `migration_tag` must be the running config's last tag
//     (`do_migration_tag_differs`), or already the target's (applied: nothing to send). Additive steps
//     (`new_sqlite_classes`, `new_classes`) go natively. Cloudflare applies a migration only through the Script Upload
//     API, which uploads and deploys at once (a version upload with a pending migration is refused), so the Worker is
//     deployed by `CloudflareWorkers.deployScript` with `{ old_tag, new_tag, steps }`, and then checked: the new active
//     deployment, the script's migration tag, the planned bindings and settings, and the live tag (Drift Detector).
//     RESTORE: Cloudflare refuses a rollback across a Durable Object class change (docs/OPERATIONS.md), so on a failure
//     after that upload the executor still tries to restore the captured deployment, Cloudflare refuses, and the run
//     ends `restored: false` with a critical report: the new version stays live, forward-only like a D1 migration. A
//     Worker with static assets is refused (`do_migration_with_assets`).
//   - Workflows (`[[workflows]]`, the Workflows API, Workers Scripts Write). A new one (live 404) is created (PUT
//     /accounts/{a}/workflows/{name} with class_name, script_name, default_retention, limits) after the version is live;
//     a changed one is updated, but only when the live Workflow still runs the running config's class on this script
//     (`workflow_live_differs:<name>`). Each is read back (class_name, script_name). On a later failure an updated one is
//     put back to the running definition; a created one is kept (deleting a Workflow destroys its instances), and the
//     restored code simply does not bind it. A Workflow already live that the running config did not declare is refused
//     (`workflow_set_outside_config:<name>`), one of another script too (`workflow_other_script:<name>`). The Workflow
//     binding itself is in the binding plan (config-diff.ts) and verified on the uploaded version like every binding.
//
// DESTRUCTIVE changes are owner-click (owner 2026-11-15: after cut-over step 6 there is no GitHub fallback). The routine
// deploy refuses each with a reason naming it, decided from the two configs before any Cloudflare call:
//   `custom_domain_removal_owner_run:<host>`, `route_changed_owner_run:<host>` (a custom domain's zone fields),
//   `do_migration_destructive:<deleted_classes|renamed_classes|transferred_classes>:<tag>`, `workflow_removal_owner_run:<name>`,
//   `workers_dev_disable_owner_run:<worker>`, `preview_urls_disable_owner_run:<worker>`.
// The break-glass deploy (`force_redeploy_unit`, an owner-approved recovery plan written and approved by two people) may
// name exactly these in `destructive_topology` (control-plane-shared/src/break-glass.ts TOPOLOGY_ITEM). A named item is
// planned and applied like the others, after the live check; an unnamed one keeps its refusal; a named one the deploy
// does not contain refuses the deploy (recovery-deploy.ts). Each is audited before it is applied, and the two that
// cannot be undone say so first: a deleted, renamed or transferred Durable Object class (no rollback across it; a
// deleted class's objects are gone) and a Workflow removal (its instances are lost; a restore re-creates only the
// definition). A detached custom domain is re-attached on a later failure; a disabled workers.dev is enabled again.
// A Worker whose configs change none of these reads nothing here and is deployed exactly as before.

import { parseToml, type TomlTable, type TomlValue } from "./config-diff.ts";
import type { CloudflareWorkers, DeploymentVersions, ExtraModule, VersionMetadata } from "./native-rollback.ts";

const API = "https://api.cloudflare.com/client/v4";
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RECORD_ID = /^[A-Za-z0-9-]{1,64}$/;
const ZONE_ID = /^[0-9a-f]{32}$/;
const TAG = /^[A-Za-z0-9._-]{1,64}$/;
const CLASS = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const WORKFLOW = /^[A-Za-z0-9_-]{1,64}$/;
const SCRIPT = /^[a-z0-9-]{1,63}$/;
/** Reads of a custom domain after it was attached or detached. */
export const TOPOLOGY_VERIFY_ATTEMPTS = 4;
export const TOPOLOGY_VERIFY_DELAY_MS = 2_000;
/** How many times the migration tag is read after a Durable Object migration deploy (about 14 s at the default delay). */
export const MIGRATION_TAG_ATTEMPTS = 8;

const isTable = (v: unknown): v is TomlTable => Boolean(v) && typeof v === "object" && !Array.isArray(v);
function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------
// The client: Workers Custom Domains, the workers.dev subdomain and Workflows (account level, CF_DEPLOY_TOKEN)
// ---------------------------------------------------------------------------------------------------------

export interface DomainRecord { id: string; hostname: string; service: string; enabled: boolean | null }
export interface WorkflowBody {
  class_name: string;
  script_name: string;
  default_retention?: { success_retention?: string | number; error_retention?: string | number };
  limits?: { steps?: number };
}
export interface WorkflowRecord { class_name: string; script_name: string }
export interface Subdomain { enabled: boolean; previews_enabled: boolean }

export class CloudflareTopology {
  private readonly token: string;
  private readonly account: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, account: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.account = account;
    // Called as a plain function (see CloudflareWorkers): workerd throws "Illegal invocation" otherwise.
    this.fetcher = (input, init) => fetcher(input, init);
  }

  private async call(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; result: unknown }> {
    const res = await this.fetcher(`${API}/accounts/${this.account}/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => null) as { success?: boolean; result?: unknown; errors?: { code: number }[] } | null;
    if (!res.ok || json?.success !== true) {
      const err = new Error(`cloudflare_api_${res.status}_${(json?.errors ?? []).map((e) => e.code).join("-") || "error"}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return { status: res.status, result: json.result };
  }

  /** The custom domains on exactly this hostname. Throws when the list cannot be read. */
  async domains(hostname: string): Promise<DomainRecord[]> {
    if (!HOST.test(hostname)) throw new Error("invalid_hostname");
    const r = await this.call("GET", `workers/domains?hostname=${encodeURIComponent(hostname)}`);
    if (!Array.isArray(r.result)) throw new Error("custom_domains_unreadable");
    const out: DomainRecord[] = [];
    for (const d of r.result as Array<Record<string, unknown>>) {
      if (d?.hostname !== hostname) continue;
      if (typeof d.id !== "string" || !RECORD_ID.test(d.id) || typeof d.service !== "string") throw new Error("custom_domains_unreadable");
      out.push({ id: d.id, hostname, service: d.service, enabled: typeof d.enabled === "boolean" ? d.enabled : null });
    }
    return out;
  }

  async attachDomain(input: { hostname: string; service: string; zone_id?: string; zone_name?: string }): Promise<void> {
    if (!HOST.test(input.hostname) || !SCRIPT.test(input.service)) throw new Error("invalid_custom_domain");
    await this.call("PUT", "workers/domains", { hostname: input.hostname, service: input.service, ...(input.zone_id ? { zone_id: input.zone_id } : {}), ...(input.zone_name ? { zone_name: input.zone_name } : {}) });
  }

  async detachDomain(id: string): Promise<void> {
    if (!RECORD_ID.test(id)) throw new Error("invalid_domain_id");
    await this.call("DELETE", `workers/domains/${id}`);
  }

  /** One Workflow: its class and script, or null when Cloudflare answers 404. Any other failure throws. */
  async workflow(name: string): Promise<WorkflowRecord | null> {
    if (!WORKFLOW.test(name)) throw new Error("invalid_workflow_name");
    let r: { result: unknown };
    try { r = await this.call("GET", `workflows/${name}`); } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
    const w = r.result as { class_name?: unknown; script_name?: unknown } | null;
    if (typeof w?.class_name !== "string" || typeof w.script_name !== "string") throw new Error("workflow_unreadable");
    return { class_name: w.class_name, script_name: w.script_name };
  }

  /** Create or update one Workflow (PUT is both). */
  async putWorkflow(name: string, body: WorkflowBody): Promise<void> {
    if (!WORKFLOW.test(name) || !CLASS.test(body.class_name) || !SCRIPT.test(body.script_name)) throw new Error("invalid_workflow");
    await this.call("PUT", `workflows/${name}`, body);
  }

  /** Delete one Workflow and its instances (only for a break-glass plan that names `workflow_removal:<name>`). */
  async deleteWorkflow(name: string): Promise<void> {
    if (!WORKFLOW.test(name)) throw new Error("invalid_workflow_name");
    await this.call("DELETE", `workflows/${name}`);
  }

  /** The script's workers.dev settings (GET …/scripts/{name}/subdomain). */
  async subdomain(script: string): Promise<Subdomain> {
    if (!SCRIPT.test(script)) throw new Error("invalid_script_name");
    const r = await this.call("GET", `workers/scripts/${script}/subdomain`);
    const s = r.result as { enabled?: unknown; previews_enabled?: unknown } | null;
    if (typeof s?.enabled !== "boolean" || typeof s.previews_enabled !== "boolean") throw new Error("subdomain_unreadable");
    return { enabled: s.enabled, previews_enabled: s.previews_enabled };
  }

  async setSubdomain(script: string, body: Subdomain): Promise<void> {
    if (!SCRIPT.test(script)) throw new Error("invalid_script_name");
    await this.call("POST", `workers/scripts/${script}/subdomain`, { enabled: body.enabled, previews_enabled: body.previews_enabled });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Reading the two configs (pure)
// ---------------------------------------------------------------------------------------------------------

export interface RouteEntry { pattern: string; custom_domain: boolean; zone_id?: string; zone_name?: string }
export interface MigrationStep {
  new_classes?: string[]; new_sqlite_classes?: string[]; deleted_classes?: string[];
  renamed_classes?: Array<{ from: string; to: string }>; transferred_classes?: Array<{ from: string; from_script: string; to: string }>;
}
/** The `migrations` field of a script upload (Cloudflare: WorkersMultipleStepMigrations). */
export interface DoMigrationUpload { old_tag?: string; new_tag: string; steps: MigrationStep[] }
interface MigrationEntry { tag: string; [kind: string]: TomlValue }
interface WorkflowDef { name: string; body: WorkflowBody }

const ROUTE_KEYS = new Set(["pattern", "custom_domain", "zone_id", "zone_name"]);
function routeEntry(v: unknown): RouteEntry | null {
  if (typeof v === "string") return v.length && v.length <= 255 ? { pattern: v, custom_domain: false } : null;
  if (!isTable(v) || Object.keys(v).some((k) => !ROUTE_KEYS.has(k))) return null;
  if (typeof v.pattern !== "string" || !v.pattern.length || v.pattern.length > 255) return null;
  if (v.custom_domain !== undefined && typeof v.custom_domain !== "boolean") return null;
  if (v.zone_id !== undefined && (typeof v.zone_id !== "string" || !ZONE_ID.test(v.zone_id))) return null;
  if (v.zone_name !== undefined && (typeof v.zone_name !== "string" || !HOST.test(v.zone_name))) return null;
  const e: RouteEntry = { pattern: v.pattern, custom_domain: v.custom_domain === true };
  // A custom domain is a hostname: no path, no wildcard (Cloudflare refuses either).
  if (e.custom_domain && !HOST.test(e.pattern)) return null;
  if (typeof v.zone_id === "string") e.zone_id = v.zone_id;
  if (typeof v.zone_name === "string") e.zone_name = v.zone_name;
  return e;
}
function routeEntries(cfg: TomlTable): Map<string, RouteEntry> | null {
  const raw: unknown[] = [];
  if (cfg.route !== undefined) raw.push(cfg.route);
  if (cfg.routes !== undefined) { if (!Array.isArray(cfg.routes)) return null; raw.push(...cfg.routes); }
  const out = new Map<string, RouteEntry>();
  for (const v of raw) {
    const e = routeEntry(v);
    if (!e || out.has(e.pattern)) return null;
    out.set(e.pattern, e);
  }
  return out;
}
const zoneOf = (e: RouteEntry) => ({ ...(e.zone_id ? { zone_id: e.zone_id } : {}), ...(e.zone_name ? { zone_name: e.zone_name } : {}) });

const MIGRATION_KINDS = ["new_classes", "new_sqlite_classes", "deleted_classes", "renamed_classes", "transferred_classes"] as const;
const ADDITIVE = new Set(["new_classes", "new_sqlite_classes"]);
const classList = (v: unknown) => Array.isArray(v) && v.every((c) => typeof c === "string" && CLASS.test(c));
const renameList = (v: unknown, keys: string[]) => Array.isArray(v) && v.every((e) => isTable(e) && Object.keys(e).length === keys.length
  && keys.every((k) => typeof e[k] === "string" && (k === "from_script" ? SCRIPT.test(e[k] as string) : CLASS.test(e[k] as string))));
function migrationEntries(cfg: TomlTable): MigrationEntry[] | null {
  const v = cfg.migrations;
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const tags = new Set<string>();
  const out: MigrationEntry[] = [];
  for (const m of v) {
    if (!isTable(m) || typeof m.tag !== "string" || !TAG.test(m.tag) || tags.has(m.tag)) return null;
    for (const [k, x] of Object.entries(m)) {
      if (k === "tag") continue;
      if (!(MIGRATION_KINDS as readonly string[]).includes(k)) return null;
      if (ADDITIVE.has(k) || k === "deleted_classes") { if (!classList(x)) return null; }
      else if (k === "renamed_classes") { if (!renameList(x, ["from", "to"])) return null; }
      else if (!renameList(x, ["from", "from_script", "to"])) return null;
    }
    tags.add(m.tag);
    out.push(m as MigrationEntry);
  }
  return out;
}

const WORKFLOW_KEYS = new Set(["name", "binding", "class_name", "script_name", "default_retention", "limits"]);
const retentionValue = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 64) || (typeof v === "number" && Number.isInteger(v) && v >= 0);
function workflowDefs(cfg: TomlTable, script: string): Map<string, WorkflowDef> | string {
  const v = cfg.workflows;
  const out = new Map<string, WorkflowDef>();
  if (v === undefined) return out;
  if (!Array.isArray(v)) return "workflow_unreadable:workflows";
  for (const w of v) {
    if (!isTable(w)) return "workflow_unreadable:workflows";
    for (const k of Object.keys(w)) if (!WORKFLOW_KEYS.has(k)) return `workflow_unreadable:${k}`;
    if (typeof w.name !== "string" || !WORKFLOW.test(w.name) || out.has(w.name)) return "workflow_unreadable:name";
    if (typeof w.class_name !== "string" || !CLASS.test(w.class_name)) return "workflow_unreadable:class_name";
    if (w.script_name !== undefined && w.script_name !== script) return `workflow_other_script:${w.name}`;
    const body: WorkflowBody = { class_name: w.class_name, script_name: script };
    if (w.default_retention !== undefined) {
      const r = w.default_retention;
      if (!isTable(r) || Object.keys(r).some((k) => k !== "success_retention" && k !== "error_retention") || !Object.values(r).every(retentionValue)) return "workflow_unreadable:default_retention";
      body.default_retention = { ...r } as WorkflowBody["default_retention"];
    }
    if (w.limits !== undefined) {
      const l = w.limits;
      if (!isTable(l) || Object.keys(l).some((k) => k !== "steps") || (l.steps !== undefined && (typeof l.steps !== "number" || !Number.isInteger(l.steps) || l.steps < 1))) return "workflow_unreadable:limits";
      body.limits = { ...l } as WorkflowBody["limits"];
    }
    out.set(w.name, { name: w.name, body });
  }
  return out;
}

/** The destructive items a break-glass plan names (break-glass.ts TOPOLOGY_ITEM), as topology.ts spells them. */
export const destructiveItem = {
  customDomainRemoval: (host: string) => `custom_domain_removal:${host}`,
  customDomainChange: (host: string) => `custom_domain_change:${host}`,
  doMigration: (kind: string, script: string, tag: string) => `do_migration:${kind}:${script}:${tag}`,
  workflowRemoval: (name: string) => `workflow_removal:${name}`,
  disable: (key: "workers_dev" | "preview_urls", script: string) => `${key}_disable:${script}`,
};

/** What the two configs alone say about routes, the workers.dev subdomain, Durable Object migrations and Workflows. */
export interface TopologyDiff {
  changed: boolean;
  customDomains: RouteEntry[];
  zoneRoutes: RouteEntry[];
  /** Named (break-glass): custom domains to detach, and custom domains whose zone fields change. */
  customDomainRemovals: RouteEntry[];
  customDomainChanges: Array<{ from: RouteEntry; to: RouteEntry }>;
  /** The target's explicit workers_dev / preview_urls where they changed (both configs set them as booleans). */
  subdomain: { workers_dev?: boolean; preview_urls?: boolean; items: string[] } | null;
  migration: { from: string | null; to: string; steps: MigrationStep[]; items: string[] } | null;
  workflows: { create: WorkflowDef[]; update: Array<{ name: string; from: WorkflowBody; to: WorkflowBody }>; remove: WorkflowDef[] };
  /** Script-level settings a script upload sends from the target config (observability, logpush, tail_consumers). */
  scriptSettings: Record<string, unknown>;
  /** The destructive items this diff contains, every one of them named by the caller. */
  destructive: string[];
}

/**
 * The topology change between the running and the target config of `script`, or the refusal the configs alone
 * decide: a destructive change not in `allowed` (the items an owner-approved break-glass plan names), a zone route
 * removal or a change that involves one, a rewritten migration history, unreadable entries. Pure: no Cloudflare call.
 */
export function topologyDiff(runningToml: string, targetToml: string, script: string, allowed: readonly string[] = []): { diff: TopologyDiff } | { reason: string } {
  const run = parseToml(runningToml);
  const tgt = parseToml(targetToml);
  if (!run || !tgt) return { reason: "config_unparsed" };
  const scriptSettings: Record<string, unknown> = {};
  for (const k of ["observability", "logpush", "tail_consumers"] as const) if (tgt[k] !== undefined) scriptSettings[k] = tgt[k];
  const diff: TopologyDiff = {
    changed: false, customDomains: [], zoneRoutes: [], customDomainRemovals: [], customDomainChanges: [], subdomain: null, migration: null,
    workflows: { create: [], update: [], remove: [] }, scriptSettings, destructive: [],
  };
  const named = (item: string) => { if (!allowed.includes(item)) return false; diff.destructive.push(item); return true; };

  // Routes and custom domains.
  if (!same(run.routes, tgt.routes) || !same(run.route, tgt.route)) {
    const r = routeEntries(run);
    const t = routeEntries(tgt);
    if (!r || !t) return { reason: "routes_unreadable" };
    for (const [pattern, e] of r) {
      const now = t.get(pattern);
      if (!now) {
        if (!e.custom_domain) return { reason: `zone_route_removal_owner_run:${pattern}` };
        if (!named(destructiveItem.customDomainRemoval(pattern))) return { reason: `custom_domain_removal_owner_run:${pattern}` };
        diff.customDomainRemovals.push(e);
        continue;
      }
      if (same(e, now)) continue;
      if (!e.custom_domain || !now.custom_domain) return { reason: `route_change_needs_zone_token:${pattern}` };
      if (!named(destructiveItem.customDomainChange(pattern))) return { reason: `route_changed_owner_run:${pattern}` };
      diff.customDomainChanges.push({ from: e, to: now });
    }
    for (const [pattern, e] of t) {
      if (r.has(pattern)) continue;
      (e.custom_domain ? diff.customDomains : diff.zoneRoutes).push(e);
    }
    diff.changed ||= diff.customDomains.length + diff.zoneRoutes.length + diff.customDomainRemovals.length + diff.customDomainChanges.length > 0;
  }

  // workers_dev / preview_urls (config-diff.ts refuses them as routing_changed unless both configs set booleans).
  for (const k of ["workers_dev", "preview_urls"] as const) {
    if (same(run[k], tgt[k])) continue;
    if (typeof run[k] !== "boolean" || typeof tgt[k] !== "boolean") return { reason: "routing_changed" };
    diff.subdomain ??= { items: [] };
    if (tgt[k] === false) {
      const item = destructiveItem.disable(k, script);
      if (!named(item)) return { reason: `${k}_disable_owner_run:${script}` };
      diff.subdomain.items.push(item);
    }
    diff.subdomain[k] = tgt[k] as boolean;
    diff.changed = true;
  }

  // Durable Object migrations.
  if (!same(run.migrations, tgt.migrations)) {
    const r = migrationEntries(run);
    const t = migrationEntries(tgt);
    if (!r || !t) return { reason: "do_migration_unreadable" };
    if (t.length < r.length || r.some((m, i) => !same(m, t[i]))) return { reason: "do_migration_history_changed" };
    const steps: MigrationStep[] = [];
    const items: string[] = [];
    for (const m of t.slice(r.length)) {
      const step: MigrationStep = {};
      for (const kind of MIGRATION_KINDS) {
        const x = m[kind];
        if (!Array.isArray(x) || !x.length) continue;
        if (!ADDITIVE.has(kind)) {
          const item = destructiveItem.doMigration(kind, script, m.tag);
          if (!named(item)) return { reason: `do_migration_destructive:${kind}:${m.tag}` };
          items.push(item);
        }
        (step as Record<string, unknown>)[kind] = structuredClone(x);
      }
      if (!Object.keys(step).length) return { reason: `do_migration_unreadable:${m.tag}` };
      steps.push(step);
    }
    if (steps.length) {
      diff.migration = { from: r.at(-1)?.tag ?? null, to: t.at(-1)!.tag, steps, items };
      diff.changed = true;
    }
  }

  // Workflows: their registrations (the bindings are in the binding plan).
  if (!same(run.workflows, tgt.workflows)) {
    const r = workflowDefs(run, script);
    if (typeof r === "string") return { reason: r };
    const t = workflowDefs(tgt, script);
    if (typeof t === "string") return { reason: t };
    for (const [name, w] of r) {
      if (t.has(name)) continue;
      if (!named(destructiveItem.workflowRemoval(name))) return { reason: `workflow_removal_owner_run:${name}` };
      diff.workflows.remove.push(w);
    }
    for (const [name, w] of t) {
      const was = r.get(name);
      if (!was) diff.workflows.create.push(w);
      else if (!same(was.body, w.body)) diff.workflows.update.push({ name, from: was.body, to: w.body });
    }
    diff.changed ||= diff.workflows.create.length + diff.workflows.update.length + diff.workflows.remove.length > 0;
  }
  diff.destructive.sort();
  return { diff };
}

// ---------------------------------------------------------------------------------------------------------
// The plan against what Cloudflare reports (read only)
// ---------------------------------------------------------------------------------------------------------

/**
 * One step applied after the Worker is verified live. `item` is the break-glass item that allowed a destructive step
 * (audited before the step); `irreversible` says, for the audit and the owner notice, what a restore cannot give back.
 */
export type TopologyStep = (
  | { kind: "custom_domain"; hostname: string; zone_id?: string; zone_name?: string }
  | { kind: "custom_domain_detach"; hostname: string; reattach: { zone_id?: string; zone_name?: string } }
  /** `restore` is the running definition; null for a Workflow this deploy creates (kept on a restore). */
  | { kind: "workflow"; name: string; body: WorkflowBody; restore: WorkflowBody | null }
  | { kind: "workflow_delete"; name: string; restore: WorkflowBody }
  | { kind: "subdomain"; body: Subdomain; restore: Subdomain }
) & { item?: string; irreversible?: string };
export interface TopologyPlan {
  /** Applied in order after the Worker is verified live; undone newest first on a later failure. */
  steps: TopologyStep[];
  /** A Durable Object migration: the Worker is deployed through the Script Upload API with it. */
  migration: DoMigrationUpload | null;
  /** The break-glass items of the migration (deleted, renamed or transferred classes), audited before the upload. */
  migrationItems: string[];
  scriptSettings: Record<string, unknown>;
  /** For the audit trail: `custom_domain:+<host>`, `zone_route:=<pattern>`, `do_migration:<from>-><to>`, `workflow:<create|update>:<name>`, … */
  changes: string[];
  /** Every destructive item the config diff contains (all named): the break-glass deploy checks each named item is here. */
  destructive: string[];
}
export const NO_TOPOLOGY: TopologyPlan = Object.freeze({ steps: [], migration: null, migrationItems: [], scriptSettings: {}, changes: [], destructive: [] }) as TopologyPlan;

export const DO_IRREVERSIBLE = "Cloudflare refuses a rollback across a Durable Object class change: no restore can bring back the previous version, and a deleted class's objects and storage are gone.";
export const WORKFLOW_IRREVERSIBLE = "Deleting a Workflow deletes its instances and their state: a restore re-creates only the definition.";

/** The Cloudflare reads the plan needs (CloudflareWorkers provides them). */
export interface TopologyReader {
  topology?: () => Pick<CloudflareTopology, "domains" | "workflow" | "subdomain">;
  migrationTag?: (script: string) => Promise<string | null>;
  scriptRoutes?: (script: string) => Promise<Array<{ pattern: string; script: string | null }> | null>;
}

/**
 * The topology plan of one Worker: `topologyDiff`, then, only when it changes something, the live state it needs.
 * `allowed` are the destructive items an owner-approved break-glass plan names. Never throws: a read that fails is
 * `topology_read_failed:<error>`.
 */
export async function planTopology(cf: TopologyReader, script: string, runningToml: string, targetToml: string, opts: { assets?: boolean; allowed?: readonly string[] } = {}):
  Promise<{ plan: TopologyPlan } | { reason: string }> {
  const d = topologyDiff(runningToml, targetToml, script, opts.allowed ?? []);
  if ("reason" in d) return d;
  const diff = d.diff;
  if (!diff.changed) return { plan: NO_TOPOLOGY };
  const steps: TopologyStep[] = [];
  const changes: string[] = [];
  let migration: DoMigrationUpload | null = null;
  let migrationItems: string[] = [];
  try {
    const needsClient = diff.customDomains.length + diff.customDomainRemovals.length + diff.customDomainChanges.length
      + diff.workflows.create.length + diff.workflows.update.length + diff.workflows.remove.length > 0 || diff.subdomain !== null;
    if (needsClient && !cf.topology) return { reason: "topology_unverifiable" };
    const topo = cf.topology?.();
    // Named removals and changes first: what this Worker no longer serves.
    for (const e of diff.customDomainRemovals) {
      const item = destructiveItem.customDomainRemoval(e.pattern);
      if (!(await topo!.domains(e.pattern)).some((x) => x.service === script)) { changes.push(`custom_domain:-${e.pattern}(absent)`); continue; }
      steps.push({ kind: "custom_domain_detach", hostname: e.pattern, reattach: zoneOf(e), item });
      changes.push(`custom_domain:-${e.pattern}`);
    }
    for (const c of diff.customDomainChanges) {
      const live = await topo!.domains(c.from.pattern);
      if (live.length !== 1 || live[0].service !== script) return { reason: `custom_domain_live_differs:${c.from.pattern}` };
      const item = destructiveItem.customDomainChange(c.from.pattern);
      steps.push({ kind: "custom_domain_detach", hostname: c.from.pattern, reattach: zoneOf(c.from), item });
      steps.push({ kind: "custom_domain", hostname: c.to.pattern, ...zoneOf(c.to), item });
      changes.push(`custom_domain:~${c.from.pattern}`);
    }
    for (const e of diff.customDomains) {
      const live = await topo!.domains(e.pattern);
      const other = live.find((x) => x.service !== script);
      if (other) return { reason: `custom_domain_on_other_worker:${e.pattern}` };
      if (live.some((x) => x.service === script)) { changes.push(`custom_domain:=${e.pattern}`); continue; }
      steps.push({ kind: "custom_domain", hostname: e.pattern, ...zoneOf(e) });
      changes.push(`custom_domain:+${e.pattern}`);
    }
    if (diff.zoneRoutes.length) {
      if (!cf.scriptRoutes) return { reason: "route_unverifiable" };
      const live = await cf.scriptRoutes(script);
      if (!live) return { reason: "route_unverifiable" };
      for (const e of diff.zoneRoutes) {
        if (!live.some((r) => r.pattern === e.pattern && (r.script === null || r.script === script))) return { reason: `zone_route_needs_zone_token:${e.pattern}` };
        changes.push(`zone_route:=${e.pattern}`);
      }
    }
    if (diff.migration) {
      if (opts.assets) return { reason: "do_migration_with_assets" };
      if (!cf.migrationTag) return { reason: "topology_unverifiable" };
      const tag = await cf.migrationTag(script);
      if (tag === diff.migration.to) changes.push(`do_migration:=${tag}`);
      else if (tag !== diff.migration.from) return { reason: "do_migration_tag_differs" };
      else {
        migration = { ...(diff.migration.from ? { old_tag: diff.migration.from } : {}), new_tag: diff.migration.to, steps: diff.migration.steps };
        migrationItems = diff.migration.items;
        changes.push(`do_migration:${diff.migration.from ?? "none"}->${diff.migration.to}`);
      }
    }
    for (const w of diff.workflows.create) {
      const live = await topo!.workflow(w.name);
      if (live) return { reason: `workflow_set_outside_config:${w.name}` };
      steps.push({ kind: "workflow", name: w.name, body: w.body, restore: null });
      changes.push(`workflow:create:${w.name}`);
    }
    for (const w of diff.workflows.update) {
      const live = await topo!.workflow(w.name);
      if (!live || live.script_name !== script || live.class_name !== w.from.class_name) return { reason: `workflow_live_differs:${w.name}` };
      steps.push({ kind: "workflow", name: w.name, body: w.to, restore: w.from });
      changes.push(`workflow:update:${w.name}`);
    }
    for (const w of diff.workflows.remove) {
      const live = await topo!.workflow(w.name);
      if (!live) { changes.push(`workflow:remove:${w.name}(absent)`); continue; }
      if (live.script_name !== script) return { reason: `workflow_other_script:${w.name}` };
      steps.push({ kind: "workflow_delete", name: w.name, restore: w.body, item: destructiveItem.workflowRemoval(w.name), irreversible: WORKFLOW_IRREVERSIBLE });
      changes.push(`workflow:remove:${w.name}`);
    }
    if (diff.subdomain) {
      const live = await topo!.subdomain(script);
      const body: Subdomain = { enabled: diff.subdomain.workers_dev ?? live.enabled, previews_enabled: diff.subdomain.preview_urls ?? live.previews_enabled };
      if (!same(body, live)) {
        steps.push({ kind: "subdomain", body, restore: live, ...(diff.subdomain.items.length ? { item: diff.subdomain.items.join(",") } : {}) });
        changes.push(`subdomain:workers_dev=${body.enabled},preview_urls=${body.previews_enabled}`);
      }
    }
  } catch (err) {
    return { reason: `topology_read_failed:${String((err as Error)?.message ?? err).slice(0, 80)}` };
  }
  return { plan: { steps, migration, migrationItems, scriptSettings: diff.scriptSettings, changes, destructive: diff.destructive } };
}

// ---------------------------------------------------------------------------------------------------------
// Applying, verifying, restoring
// ---------------------------------------------------------------------------------------------------------

export function topologyStepLabel(s: TopologyStep): string {
  switch (s.kind) {
    case "custom_domain": return `custom_domain:${s.hostname}`;
    case "custom_domain_detach": return `custom_domain_detach:${s.hostname}`;
    case "workflow": return `workflow:${s.name}`;
    case "workflow_delete": return `workflow_delete:${s.name}`;
    case "subdomain": return "subdomain";
  }
}

type TopologyClient = Pick<CloudflareTopology, "domains" | "attachDomain" | "detachDomain" | "workflow" | "putWorkflow" | "deleteWorkflow" | "subdomain" | "setSubdomain">;

async function untilAttached(topo: TopologyClient, script: string, hostname: string, delayMs?: number): Promise<void> {
  for (let i = 0; ; i++) {
    const now = await topo.domains(hostname);
    if (now.length === 1 && now[0].service === script && now[0].enabled !== false) return;
    if (i >= TOPOLOGY_VERIFY_ATTEMPTS - 1) throw new Error(`custom_domain_not_attached:${hostname}`);
    await sleep(delayMs ?? TOPOLOGY_VERIFY_DELAY_MS);
  }
}
async function detachAll(topo: TopologyClient, script: string, hostname: string, delayMs?: number): Promise<void> {
  for (const d of (await topo.domains(hostname)).filter((x) => x.service === script)) await topo.detachDomain(d.id);
  for (let i = 0; ; i++) {
    if (!(await topo.domains(hostname)).some((x) => x.service === script)) return;
    if (i >= TOPOLOGY_VERIFY_ATTEMPTS - 1) throw new Error(`custom_domain_still_attached:${hostname}`);
    await sleep(delayMs ?? TOPOLOGY_VERIFY_DELAY_MS);
  }
}
async function workflowIs(topo: TopologyClient, name: string, body: WorkflowBody | null, error: string): Promise<void> {
  const now = await topo.workflow(name);
  if (body === null ? now !== null : !now || now.class_name !== body.class_name || now.script_name !== body.script_name) throw new Error(`${error}:${name}`);
}
async function subdomainIs(topo: TopologyClient, script: string, body: Subdomain, error: string): Promise<void> {
  if (!same(await topo.subdomain(script), body)) throw new Error(error);
}

/**
 * Apply one step and read it back. `onWrite` is called right before the first write, so the caller restores an
 * ambiguous failure as well, and never undoes what this step did not change. Throws on any difference.
 */
export async function applyTopologyStep(topo: TopologyClient, script: string, step: TopologyStep, onWrite: () => void, opts: { delayMs?: number } = {}): Promise<void> {
  switch (step.kind) {
    case "custom_domain": {
      const before = await topo.domains(step.hostname);
      if (before.some((x) => x.service !== script)) throw new Error(`custom_domain_on_other_worker:${step.hostname}`);
      if (before.some((x) => x.service === script)) return; // attached meanwhile: nothing to do, nothing to undo
      onWrite();
      await topo.attachDomain({ hostname: step.hostname, service: script, ...(step.zone_id ? { zone_id: step.zone_id } : {}), ...(step.zone_name ? { zone_name: step.zone_name } : {}) });
      return untilAttached(topo, script, step.hostname, opts.delayMs);
    }
    case "custom_domain_detach": {
      if (!(await topo.domains(step.hostname)).some((x) => x.service === script)) return; // already gone
      onWrite();
      return detachAll(topo, script, step.hostname, opts.delayMs);
    }
    case "workflow":
      onWrite();
      await topo.putWorkflow(step.name, step.body);
      return workflowIs(topo, step.name, step.body, "workflow_not_applied");
    case "workflow_delete": {
      const live = await topo.workflow(step.name);
      if (!live) return; // already gone
      if (live.script_name !== script) throw new Error(`workflow_other_script:${step.name}`);
      onWrite();
      await topo.deleteWorkflow(step.name);
      return workflowIs(topo, step.name, null, "workflow_not_deleted");
    }
    case "subdomain":
      onWrite();
      await topo.setSubdomain(script, step.body);
      return subdomainIs(topo, script, step.body, "subdomain_not_applied");
  }
}

/** Undo one applied step; returns the step label for the audit trail. Throws when the undo cannot be verified. */
export async function restoreTopologyStep(topo: TopologyClient, script: string, step: TopologyStep, opts: { delayMs?: number } = {}): Promise<string> {
  switch (step.kind) {
    case "custom_domain":
      await detachAll(topo, script, step.hostname, opts.delayMs);
      return `custom_domain_detached:${step.hostname}`;
    case "custom_domain_detach": {
      const live = await topo.domains(step.hostname);
      if (!live.some((x) => x.service === script)) {
        if (live.length) throw new Error(`custom_domain_on_other_worker:${step.hostname}`);
        await topo.attachDomain({ hostname: step.hostname, service: script, ...step.reattach });
      }
      await untilAttached(topo, script, step.hostname, opts.delayMs);
      return `custom_domain_reattached:${step.hostname}`;
    }
    case "workflow":
      // A Workflow this deploy created is kept: deleting one destroys its instances. The restored code does not bind it.
      if (!step.restore) return `workflow_kept:${step.name}`;
      await topo.putWorkflow(step.name, step.restore);
      await workflowIs(topo, step.name, step.restore, "workflow_not_restored");
      return `workflow_restored:${step.name}`;
    case "workflow_delete":
      // The definition comes back; its instances do not (WORKFLOW_IRREVERSIBLE).
      if (!(await topo.workflow(step.name))) await topo.putWorkflow(step.name, step.restore);
      await workflowIs(topo, step.name, step.restore, "workflow_not_recreated");
      return `workflow_recreated:${step.name}`;
    case "subdomain":
      await topo.setSubdomain(script, step.restore);
      await subdomainIs(topo, script, step.restore, "subdomain_not_restored");
      return "subdomain_restored";
  }
}

/**
 * Deploy one Worker with its Durable Object migration (the Script Upload API uploads and deploys at once), then check
 * what Cloudflare reports: a new single deployment at 100% (read again a few times, it can lag) and the script's
 * migration tag equal to the plan's `new_tag`. Returns the new active version id. The caller has recorded the captured
 * deployment as changed before this call, and verifies bindings, settings and the live tag afterwards.
 */
export async function deployWithDoMigration(cf: Pick<CloudflareWorkers, "deployScript" | "active" | "migrationTag">, service: string,
  upload: { module: string; text: string; metadata: VersionMetadata; extra: ExtraModule[] }, plan: TopologyPlan, captured: DeploymentVersions,
  opts: { delayMs?: number; onUploaded?: () => void } = {}): Promise<string> {
  if (!plan.migration) throw new Error("do_migration_missing");
  await cf.deployScript(service, upload.module, upload.text, upload.metadata, upload.extra, plan.migration, plan.scriptSettings);
  opts.onUploaded?.();
  let versionId: string | null = null;
  for (let i = 0; i < TOPOLOGY_VERIFY_ATTEMPTS && !versionId; i++) {
    if (i > 0) await sleep(opts.delayMs ?? TOPOLOGY_VERIFY_DELAY_MS);
    const now = await cf.active(service);
    if (now.length === 1 && now[0].percentage === 100 && !captured.some((c) => c.version_id === now[0].version_id)) versionId = now[0].version_id;
  }
  if (!versionId) throw new Error("do_migration_deployment_unreadable");
  // The script's migration tag can lag the new deployment (2026-11-18, dep_01b18773: the kernel's v8→v9 upload went
  // live, the tag read right after still said v8, and the run failed with a restore Cloudflare refuses across a
  // Durable Object migration). Read it again a few times before calling the migration not applied.
  let tag: string | null = null;
  for (let i = 0; i < MIGRATION_TAG_ATTEMPTS; i++) {
    if (i > 0) await sleep(opts.delayMs ?? TOPOLOGY_VERIFY_DELAY_MS);
    tag = await cf.migrationTag(service);
    if (tag === plan.migration.new_tag) return versionId;
  }
  throw new Error(`do_migration_tag_not_applied: ${String(tag).slice(0, 64)}`);
}
