// ADR-0012 G2b: deploy a unit without GitHub Actions when the change is code only.
//
// The Forge keeps, for every passed commit of main, the Worker modules it bundled and a manifest
// (R2 `cryptophys-forge-bundles`, workers/forge/src/bundles.ts). When the target commit changes only code
// for every Worker of a unit, the Orchestrator uploads the Forge's module as a new version of each Worker
// and deploys it, with the steps of native rollback:
//   1. capture the active deployment;
//   2. upload the module as a version that keeps every binding of the previous version;
//   3. compare the new version's bindings with the active version's: any difference stops here, before
//      traffic moves (an uploaded, undeployed version is harmless);
//   4. deploy it at 100%;
//   5. verify it live through the Drift Detector (version tag and health);
//   6. after every Worker of the unit, record the desired version in the Platform Registry;
//   7. if any step fails, restore every captured deployment already changed.
//
// G2c-1 adds two kinds of change to that path:
//   - D1 migrations. Only the Control Plane unit applies them (SSOT). A new migration that is additive (not the
//     Forge's DESTRUCTIVE_SQL, no applied file edited or removed, its SQL in R2 matching the manifest's sha256,
//     no statement a D1 batch cannot run) is applied before any Worker deploys, through this Worker's own D1
//     binding, one file per D1 batch with the row `wrangler d1 migrations apply` writes to `d1_migrations`.
//     The ledger must list exactly the running version's files first. Migrations are forward-only: a failure
//     stops before any Worker deploys and fails the request with a critical report for the owner.
//     Gate 2026-11-15: a destructive migration is applied only when an owner-approved request names it
//     (deploy_destructive_migration, or a break-glass plan), and only after D1's Time Travel bookmark is read and
//     recorded (`restorePoint`, d1-restore-point.ts); a bookmark that cannot be read stops before any change.
//   - Multi-module Workers: every extra module the Forge stored (WebAssembly, text, data, ES modules), uploaded
//     as its own multipart part under the name the bundle imports it by.
//
// G2c-2 (§5l) adds configuration changes. When a Worker's wrangler.toml changed (or it has [limits], which a
// code-only upload would not carry), the running and target configs stored by the Forge (`config/<worker>.toml`,
// checked against `config_sha256`) and the active version's full binding records give a plan
// (config-diff.ts, `planConfigChange`). The version is then uploaded with exactly the planned bindings (secrets
// kept), the target's compatibility settings and limits, and checked against the plan (bindings and
// `script_runtime`) before any traffic moves. Script settings a version cannot carry (cron schedules,
// observability) are applied only after the new version is verified live, and restored on any later failure.
// Anything else (a running version without a bundle or a stored config, a plan refusal, a migration that is not
// additive) stays on the unit's GitHub workflow, which also renders config.
//
// G2c-2 step 6 (§5l) adds static assets (the Console). The Forge keeps the Console build of each main commit
// (`console-dist.json` and its files); the Worker is eligible only when that build is stored and every file matches
// it, its `[assets]` table is unchanged, its `index.html` passes the deploy workflow's CSP check (no inline script),
// and the zone route the workflow attaches with a zone token (ZONE_ROUTES) is reported for the script, read only.
// The assets are uploaded before the version and sent as `assets: { jwt, config }`, also when the build is
// unchanged: keep_assets is not used, because it is not verified that it keeps `run_worker_first`.
//
// Gate 4 part B (topology.ts, owner 2026-11-15): routes and custom domains, Durable Object migrations and Workflows,
// which the G2c-2 plan refused, are planned against the live state (`planTopology`). Custom domains and Workflows are
// applied after the live check, like the script settings, and undone first on a later failure; an additive Durable
// Object migration deploys the Worker through the Script Upload API (forward-only: Cloudflare refuses a rollback across
// it). Removals and destructive migrations are refused with a reason naming them, unless the owner-approved
// break-glass plan names them in `destructive_topology` (opts.destructiveTopology; recovery-deploy.ts): then they are
// applied, each one audited first, the irreversible ones (a deleted Durable Object class, a deleted Workflow) saying so.
//
// Gate 4 part A (owner 2026-11-15) adds two checks from the deploy workflows, in their own modules:
//   - deploy-vars.ts: the deploy-time `--var` values, kept from the active version, checked before the upload
//     (present, well formed, consistent; a value no platform source holds refuses the deploy) and after it (the
//     new version binds exactly the kept text), when `deployVars` is given;
//   - native-smoke.ts: the workflows' smoke tests through Cloudflare Access with a service token, after each
//     Worker's live check (before its script settings and topology) and after the whole unit (after every
//     Worker's topology, before the desired version), when `smoke` is given; a failed probe restores the applied
//     topology, the script settings and every changed Worker, like a failed live check.
//
// 2026-11-16 (binding props lost out of band, owner-approved): every Worker's service bindings end equal to the ones
// its wrangler.toml declares, as the Forge stored it for the target commit (control-plane-shared/src/service-bindings.ts).
// On 2026-11-15 a version made out of band (a dashboard secret edit) dropped the AGENTS binding's `props`, and every
// native deploy after it kept the loss, because both paths copied the active version's records. Now, right before the
// upload, the active version's service bindings are compared with the declared ones (names, service, entrypoint,
// props): a code-only upload whose active version differs sends the declared service bindings (and keeps every other
// type), a configuration plan plans them from the config (config-diff.ts `service_bindings`), and the uploaded
// version must bind exactly the declared values before any traffic moves. Each restored binding is a step
// `<worker>:service_bindings_restored:<NAME>` and an audit event (deployment.binding_drift_detected before the upload,
// deployment.binding_drift_repaired once the Worker is verified live). An active service binding the config does not
// declare (`service_binding_undeclared:<NAME>`), a declared name bound as another type, or a restored binding whose
// target script the account does not list (`service_binding_target_missing:<NAME>`) refuses the deploy before
// anything is uploaded; the failure is reported like any failed native deploy. No path drops such a binding, the
// break-glass deploy included: it stays refused and reported, and the owner decides case by case (owner 2026-11-16).
// Props unknown: an API record with no `props` key for a binding declared with props is not drift by itself (it is not
// verified live that the versions API returns props). The declared binding is still sent, the step
// `<worker>:service_binding_props_unverifiable:<NAME>` is recorded once, no drift audit is written, and a new version
// whose record has no `props` key is accepted. If the new version's record carries the declared props, the active
// version's missing key was a real loss and is reported as restored (step, binding_drift, repaired audit).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import type { DeployUnit } from "../../control-plane-shared/src/deploy-units.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import {
  D1_MIGRATION_INSERT, D1_MIGRATIONS_TABLE, destructiveMigration, splitSqlStatements, unsupportedStatement,
} from "../../control-plane-shared/src/migration-rules.ts";
import {
  CloudflareWorkers, MODULE_NAME, MODULE_TYPES, nativeRollbackConfigured, sameDeployment, sleep, VERIFY_ATTEMPTS, VERIFY_DELAY_MS,
  type DeploymentVersions, type DriftProbeBinding, type ExtraModule, type ModuleType, type NativeRollbackEnv, type RegistryRollbackBinding, type VersionMetadata, type VersionRecord,
} from "./native-rollback.ts";
import {
  assetsConfigFromToml, configRefusal, parseToml, planConfigChange, uploadBindings, verifyPlannedBindings, verifyVersionSettings,
  type AssetsConfig, type ConfigPlan, type PlanStep,
} from "./config-diff.ts";
import { deployVarsConsistent, keptDeployVars, verifyDeployVars, type DeployVarReference } from "./deploy-vars.ts";
import type { SmokeHooks } from "./native-smoke.ts";
import { unitForService } from "../../control-plane-shared/src/deploy-units.ts";
import { ORCHESTRATOR_UNIT, executorFirstVerdict } from "../../control-plane-shared/src/executor-first.ts";
import { RESTORE_POINT_EVENT, restoreCommand } from "../../control-plane-shared/src/destructive-deploy.ts";
import { consoleDistFileKey, indexHtmlRefusal, readConsoleDistList, readConsoleDistWithList, sameConsoleDist, type AssetFileMap, type DistReader } from "./assets-upload.ts";
import {
  BINDING_DRIFT_DETECTED_EVENT, BINDING_DRIFT_REPAIRED_EVENT, declaredServiceBindingsFromToml, nonServiceBindingSet, restoredStep, serviceBindingDrift,
  serviceDriftRefusal, unverifiableStep, verifyServiceBindings, type BindingDrift, type ServiceBinding,
} from "../../control-plane-shared/src/service-bindings.ts";
import {
  applyTopologyStep, deployWithDoMigration, DO_IRREVERSIBLE, planTopology, restoreTopologyStep, topologyDiff, topologyStepLabel, type TopologyPlan, type TopologyStep,
} from "./topology.ts";

export const NATIVE_DEPLOY_EXECUTOR = "native:deploy";
/** The one unit whose deploy applies D1 migrations (SSOT: "Migrations are applied only by the Control Plane deploy"). */
export const MIGRATING_UNIT = "control-plane";
const BUNDLE_PREFIX = "bundles/";
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MANIFEST_KEY = /^bundles\/([0-9a-f]{40})\/manifest\.json$/;
const MIGRATION_FILE = /^[A-Za-z0-9._-]+\.sql$/;

/** The read-only subset of the R2 bucket binding the Orchestrator uses. */
export interface BundleReader {
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> } | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

export interface NativeDeployEnv extends NativeRollbackEnv {
  DB: D1Database;
  BUNDLES?: BundleReader;
}

/** Native deploy needs what native rollback needs, plus the Forge's bundles. */
export function nativeDeployConfigured(env: NativeDeployEnv): boolean {
  return nativeRollbackConfigured(env) && Boolean(env.BUNDLES);
}

export interface BundleModule { name: string; type: ModuleType; sha256: string; bytes: number }
export interface BundleWorker {
  name: string;
  module: string;
  main_module: string;
  sha256: string;
  bytes: number;
  config_sha256: string;
  compatibility_date: string | null;
  compatibility_flags: string[];
  single_module: boolean;
  assets: boolean;
  /** G2c-1: the external files the bundle imports (absent in older manifests: []). */
  external: string[];
  /** G2c-1: wrangler.toml has [limits] (absent in older manifests: false). */
  limits: boolean;
  /** G2c-1: the stored extra modules, or null when the Forge could not store them all. */
  modules: BundleModule[] | null;
  /** G2c-2: the stored wrangler.toml, relative to `bundles/<sha>/` (absent in older manifests: null, unknown). */
  config: string | null;
}
export interface MigrationFile { file: string; sha256: string }
export interface Manifest { commit: string; workers: BundleWorker[]; migrations: string[] | null; migration_files: MigrationFile[] | null }

function parseModules(raw: unknown): BundleModule[] | null | undefined {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return undefined;
  const out: BundleModule[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    if (typeof m?.name !== "string" || !MODULE_NAME.test(m.name) || !(MODULE_TYPES as readonly unknown[]).includes(m.type)) return undefined;
    if (typeof m.sha256 !== "string" || !HEX64.test(m.sha256) || typeof m.bytes !== "number" || !Number.isInteger(m.bytes) || m.bytes < 0) return undefined;
    out.push({ name: m.name, type: m.type as ModuleType, sha256: m.sha256, bytes: m.bytes });
  }
  return out;
}

/** Parse a forge-bundles.v1 manifest strictly; anything unexpected is unreadable. */
export function parseManifest(text: string, commit: string): Manifest | null {
  let m: { schema?: unknown; commit?: unknown; workers?: unknown; migrations?: unknown; migration_files?: unknown };
  try { m = JSON.parse(text); } catch { return null; }
  if (m?.schema !== "forge-bundles.v1" || m.commit !== commit || !Array.isArray(m.workers)) return null;
  const workers: BundleWorker[] = [];
  for (const raw of m.workers as Record<string, unknown>[]) {
    const w = raw ?? {};
    const name = w.name, module = w.module;
    if (typeof name !== "string" || !/^[a-z0-9-]{1,63}$/.test(name) || module !== `${name}.mjs` || w.main_module !== module) return null;
    if (typeof w.sha256 !== "string" || !HEX64.test(w.sha256) || typeof w.config_sha256 !== "string" || !HEX64.test(w.config_sha256)) return null;
    if (typeof w.bytes !== "number" || !Number.isInteger(w.bytes) || w.bytes < 0) return null;
    if (!Array.isArray(w.compatibility_flags) || !w.compatibility_flags.every((f) => typeof f === "string")) return null;
    if (typeof w.single_module !== "boolean" || typeof w.assets !== "boolean") return null;
    if (w.limits !== undefined && typeof w.limits !== "boolean") return null;
    // G2c-2: the stored config can only be the Forge's own path for this Worker.
    if (w.config !== undefined && w.config !== `config/${name}.toml`) return null;
    const external = w.external === undefined ? [] : Array.isArray(w.external) && w.external.every((x) => typeof x === "string") ? [...w.external as string[]].sort() : null;
    const modules = parseModules(w.modules);
    if (external === null || modules === undefined) return null;
    workers.push({
      name, module, main_module: module, sha256: w.sha256, bytes: w.bytes, config_sha256: w.config_sha256,
      compatibility_date: typeof w.compatibility_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date) ? w.compatibility_date : null,
      compatibility_flags: [...w.compatibility_flags as string[]], single_module: w.single_module, assets: w.assets,
      external, limits: w.limits === true, modules, config: typeof w.config === "string" ? w.config : null,
    });
  }
  const migrations = Array.isArray(m.migrations) && m.migrations.every((x) => typeof x === "string") ? [...m.migrations as string[]].sort() : null;
  let migrationFiles: MigrationFile[] | null = null;
  if (Array.isArray(m.migration_files)) {
    const files = (m.migration_files as Record<string, unknown>[]).map((f) => ({ file: f?.file, sha256: f?.sha256 }));
    if (files.every((f) => typeof f.file === "string" && MIGRATION_FILE.test(f.file) && typeof f.sha256 === "string" && HEX64.test(f.sha256))) {
      migrationFiles = (files as MigrationFile[]).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
      // The hashes must describe exactly the listed files.
      if (!migrations || !sameList(migrationFiles.map((f) => f.file), migrations)) migrationFiles = null;
    }
  }
  return { commit, workers, migrations, migration_files: migrationFiles };
}

export async function readManifest(bucket: BundleReader, commit: string): Promise<Manifest | null> {
  if (!HEX40.test(commit)) return null;
  const obj = await bucket.get(`${BUNDLE_PREFIX}${commit}/manifest.json`);
  return obj ? parseManifest(await obj.text(), commit) : null;
}

/** The manifest of the one commit whose sha starts with `tag` (a 12-hex registry tag). Ambiguous or absent: null. */
export async function manifestForTag(bucket: BundleReader, tag: string): Promise<Manifest | null> {
  if (HEX40.test(tag)) return readManifest(bucket, tag);
  if (!/^[0-9a-f]{12}$/.test(tag)) return null;
  const commits = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await bucket.list({ prefix: `${BUNDLE_PREFIX}${tag}`, cursor, limit: 1000 });
    for (const o of r.objects) { const m = MANIFEST_KEY.exec(o.key); if (m && m[1].startsWith(tag)) commits.add(m[1]); }
    if (!r.truncated) break;
    cursor = r.cursor;
    if (!cursor) break;
  }
  if (commits.size !== 1) return null;
  return readManifest(bucket, [...commits][0]);
}

/**
 * G2c-2: a Worker whose version is uploaded from a configuration plan, not the code-only way. The executor reads
 * both configs again and plans again against the deployment it captures, right before the upload.
 */
export interface PlannedConfig {
  running_commit: string; running: BundleWorker; changes: ConfigPlan["changes"]; steps: PlanStep["kind"][];
  /** Gate 4 part B: the topology changes planned (topology.ts `TopologyPlan.changes`); planned again before the upload. */
  topology?: string[];
  /** Gate 4 part B: the destructive topology items this Worker's diff contains (only ever ones a break-glass plan names). */
  destructive?: string[];
}
/**
 * G2c-2 step 6: a Worker with static assets. `keep` when the running commit's stored build equals the target's
 * (`running_dist: "same"`); the executor still uploads when the active version is not the script's latest upload.
 */
export interface PlannedAssets {
  mode: "keep" | "upload";
  running_commit: string;
  running_dist: "same" | "different" | "missing";
  files: number;
  total_bytes: number;
  binding: string | null;
  config: AssetsConfig;
}
export interface PlannedService { service: string; worker: BundleWorker; running_tag: string; config?: PlannedConfig; assets?: PlannedAssets }
/** A migration the deploy applies before its Workers, in this order. */
export interface PlannedMigration { file: string; sha256: string; destructive?: boolean }
export type Eligibility =
  | { eligible: true; commit: string; services: PlannedService[]; migrations: PlannedMigration[] }
  | { eligible: false; reason: string; service?: string; file?: string };

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The D1 migrations ledger, as wrangler keeps it, sorted by name; null when it cannot be read. */
export async function appliedMigrations(db: D1Database): Promise<string[] | null> {
  try {
    const rows = await db.prepare(`SELECT name FROM ${D1_MIGRATIONS_TABLE} ORDER BY id`).all<{ name: string | null }>();
    const names = (rows.results ?? []).map((r) => r.name);
    return names.every((n): n is string => typeof n === "string") ? names.sort() : null;
  } catch {
    return null;
  }
}

const importOf = (name: string) => {
  const quoted = JSON.stringify("./" + name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s*)${quoted}`);
};

/**
 * The extra modules of one Worker, read from R2 and checked: the manifest lists one stored module for every file
 * the bundle imports and does not inline, each one's bytes match its sha256 and size, and the bundle text imports
 * each one under its name. Returns the modules, or the reason they cannot be uploaded.
 */
export async function readModules(bucket: BundleReader, commit: string, worker: BundleWorker, mainText: string):
  Promise<{ modules: ExtraModule[] } | { reason: string }> {
  if (!worker.modules || worker.modules.length === 0) return { reason: "multi_module" };
  const names = worker.modules.map((m) => m.name).sort();
  if (!sameList(names, worker.external) || new Set(names).size !== names.length || names.includes(worker.main_module)) return { reason: "multi_module" };
  const modules: ExtraModule[] = [];
  for (const m of worker.modules) {
    if (!importOf(m.name).test(mainText)) return { reason: "module_not_imported" };
    const obj = await bucket.get(`${BUNDLE_PREFIX}${commit}/${worker.name}/${m.name}`);
    if (!obj?.arrayBuffer) return { reason: "module_missing" };
    const data = new Uint8Array(await obj.arrayBuffer());
    if (data.length !== m.bytes || await sha256(data) !== m.sha256) return { reason: "module_hash_mismatch" };
    modules.push({ name: m.name, type: m.type, data });
  }
  return { modules };
}

/**
 * G2c-2: one Worker's wrangler.toml as the Forge stored it for a commit, checked against the manifest's
 * `config_sha256`. A manifest that does not name it (older than G2c-2) cannot be planned from.
 */
export async function readConfig(bucket: BundleReader, commit: string, worker: BundleWorker): Promise<{ toml: string } | { reason: string; file: string }> {
  if (!worker.config) return { reason: "config_not_stored", file: `${BUNDLE_PREFIX}${commit}/manifest.json` };
  const key = `${BUNDLE_PREFIX}${commit}/${worker.config}`;
  const obj = await bucket.get(key);
  if (!obj) return { reason: "config_missing", file: key };
  const toml = await obj.text();
  if (await sha256(toml) !== worker.config_sha256) return { reason: "config_hash_mismatch", file: key };
  return { toml };
}

/** Whether a Worker's version must come from a configuration plan: its config changed, or it has [limits]. */
const needsConfigPlan = (target: BundleWorker, running: BundleWorker) => target.config_sha256 !== running.config_sha256 || target.limits || running.limits;

/**
 * G2c-2: what the two configs alone refuse, before any Cloudflare call: `configRefusal` (config-diff.ts), and the
 * checks this path adds, fail closed where the uploaded version cannot be verified:
 *   - `limits_removed`: the running config has [limits] and the target has none. The upload would carry no
 *     limits and `verifyVersionSettings` checks only planned values, so the version's limits would be unknown;
 *   - `placement_unverified`: either config has [placement]. It would be sent in the metadata, but nothing reads
 *     it back from the uploaded version (no platform Worker has one today).
 */
export function workerConfigRefusal(runningToml: string, targetToml: string, allowed: readonly string[] = []): string | null {
  // Gate 4 part B: routes, Durable Object migrations and Workflows are topology.ts's; what the configs alone refuse there
  // (a removal, a destructive migration) is refused here, before any Cloudflare call.
  const refused = configRefusal(runningToml, targetToml, { topology: true });
  if (refused) return refused;
  const run = parseToml(runningToml)!;
  const tgt = parseToml(targetToml)!;
  if (run.limits !== undefined && tgt.limits === undefined) return "limits_removed";
  if (run.placement !== undefined || tgt.placement !== undefined) return "placement_unverified";
  const topo = topologyDiff(runningToml, targetToml, String(tgt.name ?? ""), allowed);
  return "reason" in topo ? topo.reason : null;
}

/** G2c-2: the configuration plan for one Worker against the active version's full binding records. */
export function planWorkerConfig(runningToml: string, targetToml: string, activeBindings: unknown, allowed: readonly string[] = []): { plan: ConfigPlan } | { reason: string } {
  const refused = workerConfigRefusal(runningToml, targetToml, allowed);
  if (refused) return { reason: refused };
  const plan = planConfigChange(runningToml, targetToml, activeBindings, { topology: true });
  return plan.eligible ? { plan } : { reason: plan.reason };
}

/**
 * The read-only Cloudflare calls eligibility makes: the active deployment, one version's full record and (G2c-2
 * step 6) the routes the account's script list reports for a Worker.
 */
export type VersionReader = Pick<CloudflareWorkers, "active" | "version"> & Partial<Pick<CloudflareWorkers, "scriptRoutes" | "topology" | "migrationTag">>;

/**
 * G2c-2 step 6: zone routes a Worker with static assets needs that its wrangler.toml does not manage. deploy-console.yml attaches
 * `nexus.cryptophys.work/console*` after each deploy with a zone token (ensure-zone-route.sh), because the Workers
 * deploy token cannot hold Workers Routes Edit (owner decision 2026-11-06). The Orchestrator holds only
 * CF_DEPLOY_TOKEN, so the native path never attaches a route: it only checks, read only, that the route exists and
 * points at the script, or the Worker stays on its workflow. A test keeps this equal to the workflow's
 * ROUTE_PATTERN and SCRIPT.
 */
export const ZONE_ROUTES: Readonly<Record<string, readonly string[]>> = { "cryptophys-console": ["nexus.cryptophys.work/console*"] };

/**
 * The route check, read only. `route_unverifiable` when the script list cannot be read or does not report the
 * script's routes (the field is nullable, and a token without zone permissions may not see zone routes);
 * `route_missing:<pattern>` when it reports them without the pattern pointing at this script. Fail closed.
 */
export async function zoneRouteRefusal(cf: Partial<Pick<CloudflareWorkers, "scriptRoutes">>, service: string): Promise<string | null> {
  const want = ZONE_ROUTES[service] ?? [];
  if (!want.length) return null;
  if (!cf.scriptRoutes) return "route_unverifiable";
  let routes: Array<{ pattern: string; script: string | null }> | null;
  try { routes = await cf.scriptRoutes(service); } catch { return "route_unverifiable"; }
  if (!routes) return "route_unverifiable";
  for (const pattern of want) {
    if (!routes.some((r) => r.pattern === pattern && (r.script === null || r.script === service))) return `route_missing:${pattern}`;
  }
  return null;
}

/** The bundle bucket as the dist reader of assets-upload.ts (an object without bytes reads as unreadable). */
const distReader = (b: BundleReader): DistReader => ({
  async get(key: string) {
    const o = await b.get(key);
    if (!o) return null;
    return { text: () => o.text(), arrayBuffer: async () => { if (!o.arrayBuffer) throw new Error("console_dist_unreadable"); return o.arrayBuffer(); } };
  },
});

/**
 * G2c-2 step 6: what a Worker with static assets needs, read from R2 only. The target's stored config gives the
 * `[assets]` routing config (it equals the running one: a changed `[assets]` table is refused earlier with
 * `assets_config_changed`); the target's stored Console build must be present with every file matching its list
 * (`console_dist_missing`, `console_dist_unreadable`, `console_dist_hash_mismatch`, with the R2 key in `file`);
 * its `index.html` must pass `indexHtmlRefusal` (`index_html_missing`, `inline_script`, `inline_event_handler`).
 * The running commit's build decides `keep` or `upload`; a running build that is not stored means `upload`.
 */
export async function readAssetsPlan(bundles: BundleReader, commit: string, worker: BundleWorker, runningCommit: string):
  Promise<{ assets: PlannedAssets; files: AssetFileMap } | { reason: string; file?: string }> {
  const bucket = distReader(bundles);
  const cfg = await readConfig(bundles, commit, worker);
  if ("reason" in cfg) return cfg;
  const toml = parseToml(cfg.toml);
  if (!toml) return { reason: "config_unparsed" };
  const ac = assetsConfigFromToml(toml);
  if (!ac) return { reason: "assets_config_missing" };
  if (ac.config === null) return { reason: ac.reason };
  let read: Awaited<ReturnType<typeof readConsoleDistWithList>>;
  try { read = await readConsoleDistWithList(bucket, commit); } catch (err) {
    return { reason: String((err as Error)?.message ?? err).slice(0, 100), ...((err as { file?: string })?.file ? { file: (err as { file: string }).file } : {}) };
  }
  const index = read.files["index.html"];
  if (!index?.bytes) return { reason: "index_html_missing", file: consoleDistFileKey(commit, "index.html") };
  const refused = indexHtmlRefusal(new TextDecoder().decode(index.bytes));
  if (refused) return { reason: refused, file: consoleDistFileKey(commit, "index.html") };
  const running = await readConsoleDistList(bucket, runningCommit);
  const runningDist = !running ? "missing" : sameConsoleDist(running, read.list) ? "same" : "different";
  return {
    assets: {
      mode: runningDist === "same" ? "keep" : "upload", running_commit: runningCommit, running_dist: runningDist,
      files: read.list.files.length, total_bytes: read.list.total_bytes, binding: ac.binding, config: ac.config,
    },
    files: read.files,
  };
}

/** The main module of one Worker, read from R2 and checked against the manifest; null when missing or different. */
async function readMainModule(bucket: BundleReader, commit: string, worker: BundleWorker): Promise<string | null> {
  const obj = await bucket.get(`${BUNDLE_PREFIX}${commit}/${worker.module}`);
  const text = obj ? await obj.text() : null;
  if (text === null) return null;
  if (await sha256(text) !== worker.sha256 || new TextEncoder().encode(text).length !== worker.bytes) return null;
  return text;
}

/**
 * One stored migration, read and checked as the deploy will apply it: its statements, or the reason it cannot be.
 * A destructive migration is refused unless `allowDestructive` (only the break-glass deploy, for a file its
 * owner-approved plan names: recovery-deploy.ts).
 */
export async function readMigration(bucket: BundleReader, commit: string, m: PlannedMigration, allowDestructive = false): Promise<{ statements: string[]; destructive: boolean } | { reason: string }> {
  if (!MIGRATION_FILE.test(m.file)) return { reason: "migration_missing" };
  const obj = await bucket.get(`${BUNDLE_PREFIX}${commit}/migrations/${m.file}`);
  if (!obj) return { reason: "migration_missing" };
  const sql = await obj.text();
  if (await sha256(sql) !== m.sha256) return { reason: "migration_hash_mismatch" };
  let statements: string[];
  try { statements = splitSqlStatements(sql); } catch { return { reason: "migration_unreadable" }; }
  if (statements.length === 0) return { reason: "migration_unreadable" };
  const destructive = destructiveMigration(sql);
  if (destructive && !allowDestructive) return { reason: "destructive_migration" };
  if (unsupportedStatement(statements)) return { reason: "migration_unsupported_statement" };
  return { statements, destructive };
}

/**
 * G2c-1: what a changed migration list means for this unit. Only the Control Plane applies migrations; another
 * unit may deploy once the ledger already lists exactly the target's files (the Control Plane applied them).
 * For the Control Plane: no applied file edited or removed (sha256 in both manifests), the new files sort after
 * the running ones, each one is additive and matches its stored SQL, and the D1 ledger lists exactly the running
 * manifest's files (or already the target's: nothing to apply). Manifests without migration_files (G2b and
 * older) keep the G2b answer, new_migration.
 */
async function migrationPlan(env: Pick<NativeDeployEnv, "DB" | "BUNDLES">, unit: DeployUnit, target: Manifest, running: Manifest, service: string, named: readonly string[] = []):
  Promise<{ migrations: PlannedMigration[] } | { reason: string; service?: string; file?: string }> {
  const targetList = target.migrations!;
  const runningList = running.migrations!;
  const changed = !sameList(runningList, targetList);
  if (unit.unit !== MIGRATING_UNIT) {
    if (!changed) return { migrations: [] };
    const ledger = await appliedMigrations(env.DB);
    if (ledger && sameList(ledger, targetList)) return { migrations: [] };
    // Cut-over gate 2026-11-15 (executor first): the orchestrator may deploy before migrations the Control Plane has
    // not applied yet when none of them names anything its bundled code at the target reads (executor-first.ts),
    // the same evidence the Forge's planner used to put it first. It applies none of them.
    if (unit.unit === ORCHESTRATOR_UNIT && ledger && ledger.every((f) => targetList.includes(f))) {
      const verdict = await executorFirstVerdict(env.BUNDLES!, target.commit, targetList.filter((f) => !ledger.includes(f)));
      if (verdict.state === "independent") return { migrations: [] };
    }
    return { reason: "new_migration", service };
  }
  if (!target.migration_files || !running.migration_files) return changed ? { reason: "new_migration", service } : { migrations: [] };
  const targetHash = new Map(target.migration_files.map((f) => [f.file, f.sha256]));
  for (const f of running.migration_files) {
    // An applied migration removed or edited: the owner's (the Forge: migration_rewritten).
    if (targetHash.get(f.file) !== f.sha256) return { reason: "destructive_migration", service, file: f.file };
  }
  if (!changed) return { migrations: [] };
  const last = runningList.at(-1) ?? "";
  const fresh = target.migration_files.filter((f) => !runningList.includes(f.file));
  const early = fresh.find((f) => f.file <= last);
  if (early) return { reason: "migration_out_of_order", service, file: early.file };
  const ledger = await appliedMigrations(env.DB);
  if (!ledger) return { reason: "d1_migrations_unreadable", service };
  if (sameList(ledger, targetList)) return { migrations: [] };
  if (!sameList(ledger, runningList)) return { reason: "d1_migrations_mismatch", service };
  const out: PlannedMigration[] = [];
  for (const f of fresh) {
    // Gate 2026-11-15: only a file the owner-approved deploy_destructive_migration names may be destructive; any other
    // destructive file keeps the routine refusal (destructive_migration). Routine deploys name none.
    const r = await readMigration(env.BUNDLES!, target.commit, f, named.includes(f.file));
    if ("reason" in r) return { reason: r.reason, service, file: f.file };
    out.push(r.destructive ? { file: f.file, sha256: f.sha256, destructive: true } : { file: f.file, sha256: f.sha256 });
  }
  // A named file that is not one of these pending destructive migrations: the approval no longer matches main and D1.
  const stale = named.find((n) => !out.some((m) => m.file === n && m.destructive));
  if (stale) return { reason: "named_migration_not_pending_destructive", service, file: stale };
  return { migrations: out };
}

/**
 * Whether the unit can deploy `targetSha` from the Forge's bundles alone. For every service of the unit, in
 * unit order: present in the target manifest and in the manifest of the version the registry says it runs,
 * no static assets, every extra module stored, matching and imported; and the D1 migration lists equal, or
 * (G2c-1) the change is one migrationPlan accepts. Any missing or unreadable evidence is ineligible (the
 * GitHub workflow stays the path).
 *
 * G2c-2: a Worker whose wrangler.toml changed, or that has [limits], is eligible only through a configuration
 * plan: both stored configs present and matching their hashes, and nothing the two configs alone refuse
 * (`workerConfigRefusal`), checked for every Worker before any Cloudflare call; then `planWorkerConfig` against
 * the active version's full binding records, read through `cf`. Without `cf` such a Worker keeps the G2b answer
 * (`config_changed`, or `limits` when only [limits] calls for a plan).
 *
 * G2c-2 step 6: a Worker with static assets is eligible only when its `[assets]` table is unchanged (else
 * `assets_config_changed`, from the plan's checks or a differing manifest flag), the target's Console build is
 * stored and matches (`readAssetsPlan`), and, last, its zone routes are reported for the script (`zoneRouteRefusal`).
 * Without a reader that can list the routes, it keeps the G2b answer, `assets`.
 */
export async function nativeDeployEligible(env: Pick<NativeDeployEnv, "DB" | "BUNDLES">, unit: DeployUnit, targetSha: string, cf?: VersionReader,
  opts: { migrations?: "plan" | "skip"; destructive?: readonly string[]; destructiveTopology?: readonly string[]; deployVars?: DeployVarReference } = {}): Promise<Eligibility> {
  const allowed = opts.destructiveTopology ?? [];
  if (!env.BUNDLES) return { eligible: false, reason: "not_configured" };
  if (!HEX40.test(targetSha)) return { eligible: false, reason: "invalid_commit_sha" };
  try {
    const target = await readManifest(env.BUNDLES, targetSha);
    if (!target) return { eligible: false, reason: "no_bundle" };
    if (!target.migrations) return { eligible: false, reason: "migrations_unknown" };
    const services = [...unit.services] as string[];
    const rows = await env.DB.prepare(`SELECT service_id, status, desired_version FROM service_registry WHERE service_id IN (${services.map(() => "?").join(", ")})`)
      .bind(...services).all<{ service_id: string; status: string; desired_version: string | null }>();
    const registry = new Map((rows.results ?? []).map((r) => [r.service_id, r]));
    const running = new Map<string, Manifest | null>();
    const planned: PlannedService[] = [];
    // G2c-2: the Workers that need a configuration plan, with both configs read and checked (pass 1).
    const toPlan: Array<{ index: number; service: string; runningCommit: string; was: BundleWorker; runningToml: string; targetToml: string }> = [];
    let migrations: PlannedMigration[] | null = null;
    let migrationsFrom: string[] | null = null;
    for (const service of services) {
      const worker = target.workers.find((w) => w.name === service);
      if (!worker) return { eligible: false, reason: "service_not_in_bundle", service };
      // G2c-2 step 6: static assets need the route check (a Cloudflare read); without a reader, the G2b answer.
      if (worker.assets && !cf?.scriptRoutes) return { eligible: false, reason: "assets", service };
      if (!worker.single_module && !worker.modules) return { eligible: false, reason: "multi_module", service };
      if (!worker.compatibility_date) return { eligible: false, reason: "config_unreadable", service };
      const reg = registry.get(service);
      const desired = reg?.desired_version ?? "";
      if (!reg || reg.status === "disabled" || !/^[0-9a-f]{12,40}$/.test(desired)) return { eligible: false, reason: "desired_version_unknown", service };
      const tag = desired.length === 40 ? desired : desired.slice(0, 12);
      if (!running.has(tag)) running.set(tag, await manifestForTag(env.BUNDLES, tag));
      const now = running.get(tag);
      const was = now?.workers.find((w) => w.name === service);
      if (!now || !was) return { eligible: false, reason: "running_bundle_missing", service };
      // The break-glass deploy (recovery-deploy.ts) plans its migrations from D1's applied state instead (skip).
      if (opts.migrations !== "skip") {
        if (!now.migrations) return { eligible: false, reason: "migrations_unknown", service };
        if (migrationsFrom === null) {
          const plan = await migrationPlan(env, unit, target, now, service, opts.destructive ?? []);
          if ("reason" in plan) return { eligible: false, ...plan };
          migrations = plan.migrations;
          migrationsFrom = now.migrations;
        } else if (!sameList(now.migrations, migrationsFrom)) {
          // The Workers of the unit run versions with different migration lists: one plan cannot fit them all.
          return { eligible: false, reason: "new_migration", service };
        }
      }
      if (!worker.single_module) {
        const text = await readMainModule(env.BUNDLES, targetSha, worker);
        if (text === null) return { eligible: false, reason: "module_missing", service };
        const mods = await readModules(env.BUNDLES, targetSha, worker, text);
        if ("reason" in mods) return { eligible: false, reason: mods.reason, service };
      }
      if (needsConfigPlan(worker, was)) {
        const run = await readConfig(env.BUNDLES, now.commit, was);
        if ("reason" in run) return { eligible: false, reason: run.reason, service, file: run.file };
        const tgt = await readConfig(env.BUNDLES, targetSha, worker);
        if ("reason" in tgt) return { eligible: false, reason: tgt.reason, service, file: tgt.file };
        const refused = workerConfigRefusal(run.toml, tgt.toml, allowed);
        if (refused) return { eligible: false, reason: refused, service };
        toPlan.push({ index: planned.length, service, runningCommit: now.commit, was, runningToml: run.toml, targetToml: tgt.toml });
      }
      // G2c-2 step 6, after the configs (a changed [assets] table is assets_config_changed above): the stored build.
      let assets: PlannedAssets | undefined;
      if (worker.assets || was.assets) {
        if (worker.assets !== was.assets) return { eligible: false, reason: "assets_config_changed", service };
        const a = await readAssetsPlan(env.BUNDLES, targetSha, worker, now.commit);
        if ("reason" in a) return { eligible: false, reason: a.reason, service, ...(a.file ? { file: a.file } : {}) };
        assets = a.assets;
      }
      planned.push({ service, worker, running_tag: tag.slice(0, 12), ...(assets ? { assets } : {}) });
    }
    // Pass 2 (G2c-2): only now Cloudflare is read, for the Workers that need a plan.
    const records = new Map<string, VersionRecord>();
    for (const p of toPlan) {
      const { service } = p;
      if (!cf) return { eligible: false, reason: p.was.config_sha256 === planned[p.index].worker.config_sha256 ? "limits" : "config_changed", service };
      let active: DeploymentVersions;
      try { active = await cf.active(service); } catch { return { eligible: false, reason: "active_deployment_unreadable", service }; }
      if (active.length !== 1 || active[0].percentage !== 100) return { eligible: false, reason: "active_deployment_split", service };
      let record: VersionRecord;
      try { record = await cf.version(service, active[0].version_id); } catch { return { eligible: false, reason: "active_bindings_unreadable", service }; }
      records.set(service, record);
      const r = planWorkerConfig(p.runningToml, p.targetToml, record.resources?.bindings, allowed);
      if ("reason" in r) return { eligible: false, reason: r.reason, service };
      // Gate 4 part B: routes, Durable Object migrations and Workflows against the live state (no read when unchanged).
      const t = await planTopology(cf, service, p.runningToml, p.targetToml, { assets: planned[p.index].worker.assets, allowed });
      if ("reason" in t) return { eligible: false, reason: t.reason, service };
      planned[p.index] = { ...planned[p.index], config: {
        running_commit: p.runningCommit, running: p.was, changes: r.plan.changes, steps: r.plan.steps.map((s) => s.kind),
        ...(t.plan.changes.length ? { topology: t.plan.changes } : {}),
        ...(t.plan.destructive.length ? { destructive: t.plan.destructive } : {}),
      } };
    }
    // Gate 4: the deploy-time --var values each Worker's new version must carry, kept from its active version (read
    // only). A value no platform source holds keeps the unit on its workflow (deploy-vars.ts).
    if (opts.deployVars) {
      if (!cf) return { eligible: false, reason: "deploy_vars_unreadable" };
      const kept: Record<string, string>[] = [];
      for (const p of planned) {
        let record = records.get(p.service);
        if (!record) {
          let active: DeploymentVersions;
          try { active = await cf.active(p.service); } catch { return { eligible: false, reason: "active_deployment_unreadable", service: p.service }; }
          if (active.length !== 1 || active[0].percentage !== 100) return { eligible: false, reason: "active_deployment_split", service: p.service };
          try { record = await cf.version(p.service, active[0].version_id); } catch { return { eligible: false, reason: "active_bindings_unreadable", service: p.service }; }
        }
        const k = keptDeployVars(unit.unit, p.service, record.resources?.bindings, opts.deployVars);
        if ("reason" in k) return { eligible: false, reason: k.reason, service: p.service };
        kept.push(k.vars);
      }
      const inconsistent = deployVarsConsistent(kept);
      if (inconsistent) return { eligible: false, reason: inconsistent };
    }
    // G2c-2 step 6: the zone routes the workflow attaches with its zone token, verified read only.
    for (const p of planned) {
      if (!p.worker.assets) continue;
      const refused = await zoneRouteRefusal(cf!, p.service);
      if (refused) return { eligible: false, reason: refused, service: p.service };
    }
    return { eligible: true, commit: targetSha, services: planned, migrations: migrations ?? [] };
  } catch {
    return { eligible: false, reason: "bundle_read_failed" };
  }
}

export interface DeployRun {
  ok: boolean;
  reason?: string;
  /** The service whose step failed. */
  service?: string;
  /** Every captured deployment that was changed is active again (true when nothing was changed). */
  restored?: boolean;
  /** Whether production was changed (a deployment, a deploy call, or a D1 migration) before the failure. */
  production_changed?: boolean;
  /** service -> uploaded version id. */
  versions: Record<string, string>;
  /** Steps that completed, `<service>:<step>` or `migration:<file>:applied`, for the audit trail. */
  steps: string[];
  /** G2c-1: the migrations this request applied, in order. Forward-only: a restore never undoes them. */
  migrations_applied?: string[];
  /** G2c-1: the migration that failed (its own batch rolled back; the ones before it stay applied). */
  migration_failed?: string;
  /** G2c-1: when migrating started, for a D1 Time Travel restore by the owner. */
  restore_point_at?: string;
  /**
   * Gate 2026-11-15: the D1 Time Travel bookmark read and recorded before the first destructive migration (only when
   * the deploy applies one). The owner restores to it; the executor never does.
   */
  restore_point?: RestorePoint;
  /** G2c-2: the script settings applied after a live check, `<service>:<kind>`, in order (restored on failure). */
  settings_applied?: string[];
  /**
   * G2c-2 step 6: per Worker with static assets, how its assets reached the version: kept from the active version
   * (`keep`), or uploaded (`upload`, with the files Cloudflare asked for and the bucket count). `keep_refused` says
   * why a planned keep became an upload.
   */
  assets?: Record<string, { mode: "keep" | "upload"; uploaded?: number; buckets?: number; keep_refused?: string }>;
  /** Gate 4 part B: the custom domains and Workflows applied after a live check, `<service>:<kind>:<name>` (undone on failure). */
  topology_applied?: string[];
  /**
   * Gate 4 part B: the Durable Object migrations deployed, `<service>:<new_tag>`. Forward-only: Cloudflare refuses a
   * rollback across them, so a restore after one ends `restored: false` and the new version stays live.
   */
  do_migrations?: string[];
  /** Gate 4 part B: the break-glass plan's destructive topology items applied (each audited before it was applied). */
  destructive_topology_applied?: string[];
  /** Gate 4 part B: what this run did that no restore can give back (a Durable Object class change, a deleted Workflow). */
  irreversible?: string[];
  /** Gate 4: per Worker, the deploy-time `--var` names kept from the active version and verified (never the values). */
  deploy_vars?: Record<string, string[]>;
  /**
   * Gate 4: the workflows' smoke tests through Access. `skipped` (with the reason) while the Orchestrator holds no
   * service token; `failed` names the probe; a failure restores like a failed live check.
   */
  smoke?: { status: "passed" | "failed" | "skipped"; reason?: string; probe?: string; probes: number };
  /**
   * 2026-11-16: per Worker whose active version did not bind its declared service bindings, the bindings resent
   * (`restored`, names and what differed), the undeclared ones that refused the deploy, and whether the Worker was
   * verified live with the declared values (`repaired`). Names only.
   */
  binding_drift?: Record<string, { restored: BindingDrift[]; undeclared: string[]; repaired: boolean; refused?: string }>;
}

/** Every key of `want` is in `got` with an equal value (objects compared recursively, arrays exactly). */
function contains(want: unknown, got: unknown): boolean {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    if (!got || typeof got !== "object" || Array.isArray(got)) return false;
    return Object.entries(want as Record<string, unknown>).every(([k, v]) => contains(v, (got as Record<string, unknown>)[k]));
  }
  return JSON.stringify(want) === JSON.stringify(got);
}

/**
 * G2c-2: apply one script setting and check the API's answer shows it: the schedules list equal to the crons
 * sent, or the script settings containing the observability sent. Anything else throws (fail closed).
 */
async function applyScriptSetting(cf: CloudflareWorkers, service: string, step: PlanStep, body: PlanStep["body"] | PlanStep["restore"]): Promise<void> {
  if (step.kind === "schedules") {
    const crons = body as Array<{ cron: string }>;
    const r = await cf.scriptSetting(service, { method: "PUT", path: "schedules", body: crons }) as { schedules?: Array<{ cron?: unknown }> } | null;
    const got = Array.isArray(r?.schedules) ? r!.schedules.map((x) => x?.cron).sort() : null;
    if (!got || JSON.stringify(got) !== JSON.stringify(crons.map((c) => c.cron).sort())) throw new Error("schedules_not_applied");
    return;
  }
  const settings = body as { observability: Record<string, unknown> };
  const r = await cf.scriptSetting(service, { method: "PATCH", path: "script-settings", body: settings }) as { observability?: unknown } | null;
  if (!contains(settings.observability, r?.observability)) throw new Error("script_settings_not_applied");
}

/**
 * Apply one migration as `wrangler d1 migrations apply` does, through the Orchestrator's D1 binding: its
 * statements and the `d1_migrations` row in one D1 batch, which D1 runs as one transaction. The ledger row goes
 * first, so a file that is already recorded (UNIQUE name) fails the batch before any of its statements run.
 */
export async function applyMigration(db: D1Database, bucket: BundleReader, commit: string, m: PlannedMigration, allowDestructive = false): Promise<number> {
  const r = await readMigration(bucket, commit, m, allowDestructive);
  if ("reason" in r) throw new Error(r.reason);
  await db.batch([db.prepare(D1_MIGRATION_INSERT).bind(m.file), ...r.statements.map((s) => db.prepare(s))]);
  return r.statements.length;
}

/** Gate 2026-11-15: a D1 Time Travel bookmark of the control-plane database, read through the Cloudflare API. */
export interface RestorePoint { bookmark: string; database_id: string; read_at: string }

async function auditQuietly(db: D1Database | undefined, event: Parameters<typeof appendAuditEvent>[1]): Promise<boolean> {
  if (!db) return false;
  try { await appendAuditEvent(db, event); return true; } catch { return false; }
}

/**
 * Execute one queued native deploy over the eligible plan: the migrations first (G2c-1), then each Worker in unit
 * order: capture, (G2c-2) plan the configuration again against the captured version, (step 6) check the route and
 * the stored build again and keep or upload the static assets, upload the version, verify the bindings
 * (and the planned settings), deploy, verify live, then (G2c-2) apply the plan's script settings. The desired
 * version is recorded after every Worker. Never throws; the caller records the outcome. On any failure the
 * applied script settings are restored first (newest first), then every changed service to its captured
 * deployment, newest change first; applied migrations stay (forward-only).
 */

/**
 * Reading a version just uploaded can answer 404 for a moment (2026-11-15, control-plane at d300ee1: the upload of
 * cryptophys-platform-registry succeeded, the read of that version answered cloudflare_api_404_100146, and the
 * deploy restored the two services already moved). Only a 404 is read again, at most UPLOADED_READ_ATTEMPTS times;
 * every other answer, and a 404 that persists, fails the deploy as before. Nothing is deployed before this read.
 */
export const UPLOADED_READ_ATTEMPTS = 4;
export const UPLOADED_READ_DELAY_MS = 2_000;
export async function readUploaded<T>(read: () => Promise<T>, delayMs?: number): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (err) {
      if (i >= UPLOADED_READ_ATTEMPTS || !/^cloudflare_api_404(_|$)/.test(String((err as Error)?.message ?? err))) throw err;
      await sleep(delayMs ?? UPLOADED_READ_DELAY_MS);
    }
  }
}

/**
 * Gate 2026-11-15: store the bookmark before any migration runs. Both writes must succeed (not best effort): the
 * request's details (`restore_point`, while it runs) and the audit event deployment.restore_point_recorded.
 */
async function recordRestorePoint(db: D1Database, requestId: string, commit: string, rp: RestorePoint, files: string[]): Promise<void> {
  const r = await db.prepare("UPDATE deployment_requests SET details_json = json_set(details_json, '$.restore_point', json(?)), updated_at = ? WHERE request_id = ? AND status = 'running'")
    .bind(JSON.stringify(rp), new Date().toISOString(), requestId).run();
  if ((r.meta?.changes ?? 0) !== 1) throw new Error("restore_point_unrecorded: request not running");
  await appendAuditEvent(db, {
    event_type: RESTORE_POINT_EVENT, actor: "agent:deployment-orchestrator", subject: "cryptophys-control-plane", outcome: "recorded",
    payload: { request_id: requestId, commit_sha: commit, bookmark: rp.bookmark, database_id: rp.database_id, read_at: rp.read_at, destructive_migrations: files, restore: restoreCommand(rp.bookmark) },
  });
}

export async function executeNativeDeploy(
  cf: CloudflareWorkers,
  env: { DRIFT: DriftProbeBinding; REGISTRY: RegistryRollbackBinding; BUNDLES: BundleReader; DB?: D1Database },
  requestId: string, commit: string, plan: PlannedService[],
  opts: {
    delayMs?: number; migrations?: PlannedMigration[]; destructive?: readonly string[]; destructiveTopology?: readonly string[];
    deployVars?: DeployVarReference; smoke?: SmokeHooks; restorePoint?: () => Promise<RestorePoint>;
  } = {},
): Promise<DeployRun> {
  const tag = commit.slice(0, 12);
  const steps: string[] = [];
  const versions: Record<string, string> = {};
  const changed: { service: string; captured: DeploymentVersions }[] = [];
  // G2c-2: script settings, recorded before each call so an ambiguous failure is restored as well.
  const settings: { service: string; step: PlanStep }[] = [];
  const assetsRun: NonNullable<DeployRun["assets"]> = {};
  // Gate 4 part B: topology steps, recorded (restore: true) right before their first write.
  const topoApplied: { service: string; step: TopologyStep; restore: boolean }[] = [];
  const doMigrations: string[] = [];
  const destructiveApplied: string[] = [];
  const irreversible: string[] = [];
  /** Gate 4 part B: a destructive item is audited before it is applied; without the audit it is not applied. */
  const auditDestructive = async (service: string, item: string, step: string, note?: string) => {
    const ok = await auditQuietly(env.DB, {
      event_type: note ? "deployment.destructive_topology_irreversible" : "deployment.destructive_topology_applying",
      actor: "agent:deployment-orchestrator", subject: service, outcome: "applying",
      payload: { request_id: requestId, commit_sha: commit, service, item, step, ...(note ? { irreversible: note, restore_possible: false } : { restore_possible: true }) },
    });
    if (!ok) throw new Error(`destructive_audit_unavailable: ${item}`);
  };
  const applied: string[] = [];
  const migrations = opts.migrations ?? [];
  let migrating: string | null = null;
  let restorePoint: string | undefined;
  let bookmark: RestorePoint | undefined;
  let current = "";
  // Gate 4: the kept deploy-time values per Worker, and the smoke tests' record.
  const keptVars: Record<string, Record<string, string>> = {};
  // 2026-11-16: the service-binding drift found per Worker (names only).
  const bindingDrift: NonNullable<DeployRun["binding_drift"]> = {};
  /** The declared service bindings each Worker's new version must bind, from the target commit's stored config. */
  const declaredFor = new Map<string, ServiceBinding[]>();
  /** Per Worker, the declared bindings whose active record had no `props` key (props unknown). */
  const unknownProps = new Map<string, string[]>();
  const markUnverifiable = (service: string, names: readonly string[]) => {
    for (const n of names) { const st = unverifiableStep(service, n); if (!steps.includes(st)) steps.push(st); }
  };
  /** After the upload check: still unknown is named once; shown on the new version means the active had lost them. */
  const propsAfterUpload = (service: string, stillUnknown: readonly string[]) => {
    markUnverifiable(service, stillUnknown);
    const proven = (unknownProps.get(service) ?? []).filter((n) => !stillUnknown.includes(n) && !bindingDrift[service]?.restored.some((d) => d.name === n));
    if (!proven.length) return;
    const entry = bindingDrift[service] ??= { restored: [], undeclared: [], repaired: false };
    for (const n of proven) entry.restored.push({ name: n, kinds: ["props"], retarget: false });
  };
  /** A drift's targets must be Workers of the account; the list is read once, only when a binding is retargeted. */
  let scriptIds: string[] | null = null;
  const checkDrift = async (service: string, restore: BindingDrift[], undeclared: string[], conflicts: string[] = []) => {
    if (!restore.length && !undeclared.length && !conflicts.length) return;
    let refused = serviceDriftRefusal({ undeclared, conflicts });
    if (!refused) {
      for (const d of restore.filter((x) => x.retarget)) {
        const target = String((declaredFor.get(service) ?? []).find((b) => b.name === d.name)?.service ?? "");
        try { scriptIds ??= await cf.scriptIds(); } catch { refused = `service_binding_target_unverifiable:${d.name}`; break; }
        if (!scriptIds.includes(target)) { refused = `service_binding_target_missing:${d.name}`; break; }
      }
    }
    bindingDrift[service] = { restored: restore, undeclared, repaired: false, ...(refused ? { refused } : {}) };
    await auditQuietly(env.DB, {
      event_type: BINDING_DRIFT_DETECTED_EVENT, actor: "agent:deployment-orchestrator", subject: service, outcome: refused ? "refused" : "repairing",
      payload: { request_id: requestId, commit_sha: commit, service, restore: restore.map((d) => ({ name: d.name, kinds: d.kinds })), undeclared, conflicts, ...(refused ? { reason: refused } : {}) },
    });
    if (refused) throw new Error(refused);
  };
  const unitName = plan.length ? unitForService(plan[0].service)?.unit ?? "" : "";
  let smoke: DeployRun["smoke"] = opts.smoke?.skipped ? { status: "skipped", reason: opts.smoke.skipped, probes: 0 } : undefined;
  const smokeRan: string[] = [];
  const runSmoke = async (r: Awaited<ReturnType<SmokeHooks["afterUnit"]>>) => {
    smokeRan.push(...r.probes);
    if (!r.ok) {
      smoke = { status: "failed", reason: r.reason, probe: r.probe, probes: smokeRan.length };
      throw new Error(`smoke_failed: ${r.probe}: ${r.reason}`);
    }
    smoke = { status: "passed", probes: smokeRan.length };
  };
  const gate4 = () => ({
    ...(Object.keys(keptVars).length ? { deploy_vars: Object.fromEntries(Object.entries(keptVars).map(([k, v]) => [k, Object.keys(v)])) } : {}),
    ...(smoke ? { smoke } : {}),
    ...(Object.keys(bindingDrift).length ? { binding_drift: bindingDrift } : {}),
  });
  try {
    if (!HEX40.test(commit) || !plan.length) throw new Error("invalid_plan");
    if ((opts.deployVars || opts.smoke) && !unitName) throw new Error("invalid_plan");
    if (migrations.length) {
      if (!env.DB) throw new Error("migration_db_unavailable");
      // Gate 2026-11-15: before a destructive migration (only one the owner's approval names), D1's Time Travel
      // bookmark is read and recorded, in the request's details and in the audit chain. Without it nothing changes.
      if (migrations.some((m) => opts.destructive?.includes(m.file))) {
        if (!opts.restorePoint) throw new Error("restore_point_unavailable: no bookmark reader");
        try {
          bookmark = await opts.restorePoint();
        } catch (err) {
          throw new Error(`restore_point_unavailable: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
        }
        await recordRestorePoint(env.DB, requestId, commit, bookmark, migrations.filter((m) => opts.destructive!.includes(m.file)).map((m) => m.file));
        steps.push("d1:restore_point_recorded");
      }
      restorePoint = new Date().toISOString();
      for (const m of migrations) {
        migrating = m.file;
        let statements: number;
        try {
          statements = await applyMigration(env.DB, env.BUNDLES, commit, m, opts.destructive?.includes(m.file) ?? false);
        } catch (err) {
          const message = String((err as Error)?.message ?? err).slice(0, 160);
          await auditQuietly(env.DB, {
            event_type: "deployment.native_migration_failed", actor: "agent:deployment-orchestrator", subject: m.file, outcome: "failed",
            payload: { request_id: requestId, commit_sha: commit, file: m.file, sha256: m.sha256, error: message, applied_before: [...applied] },
          });
          throw new Error(`migration_failed: ${m.file}: ${message}`);
        }
        applied.push(m.file);
        steps.push(`migration:${m.file}:applied`);
        await auditQuietly(env.DB, {
          event_type: "deployment.native_migration_applied", actor: "agent:deployment-orchestrator", subject: m.file, outcome: "applied",
          payload: { request_id: requestId, commit_sha: commit, file: m.file, sha256: m.sha256, statements, ledger: D1_MIGRATIONS_TABLE },
        });
      }
      migrating = null;
    }
    for (const { service, worker, config, assets: plannedAssets } of plan) {
      current = service;
      const captured = await cf.active(service);
      if (captured.length !== 1 || captured[0].percentage !== 100) throw new Error("active_deployment_split");
      steps.push(`${service}:captured`);
      // G2c-2: the plan again, right before the upload, against the deployment just captured (its bindings may
      // have changed since the request was queued). Code only (G2b): the active binding set, for the digest check.
      let configPlan: ConfigPlan | null = null;
      let topo: TopologyPlan | null = null;
      let active: { names: string[]; digest: string; restore: boolean; rest: { names: string[]; digest: string } | null } | null = null;
      let capturedRecord: VersionRecord | null = null;
      if (config) {
        const run = await readConfig(env.BUNDLES, config.running_commit, config.running);
        if ("reason" in run) throw new Error(run.reason);
        const tgt = await readConfig(env.BUNDLES, commit, worker);
        if ("reason" in tgt) throw new Error(tgt.reason);
        const record = await cf.version(service, captured[0].version_id);
        capturedRecord = record;
        const r = planWorkerConfig(run.toml, tgt.toml, record.resources?.bindings, opts.destructiveTopology ?? []);
        if ("reason" in r) throw new Error(`config_plan_refused: ${r.reason}`);
        configPlan = r.plan;
        steps.push(`${service}:planned`);
        // 2026-11-16: the plan's service bindings are the target config's; any it had to restore, or would drop, is checked here.
        const declared = declaredServiceBindingsFromToml(tgt.toml);
        if ("reason" in declared) throw new Error(`service_bindings_unreadable: ${declared.reason}`);
        declaredFor.set(service, declared.bindings);
        await checkDrift(service, configPlan.service_bindings.restored, configPlan.service_bindings.undeclared);
        unknownProps.set(service, configPlan.service_bindings.unverifiable);
        markUnverifiable(service, configPlan.service_bindings.unverifiable);
        // Gate 4 part B: the topology again, against what Cloudflare reports now.
        const t = await planTopology(cf, service, run.toml, tgt.toml, { assets: worker.assets, allowed: opts.destructiveTopology ?? [] });
        if ("reason" in t) throw new Error(`topology_refused: ${t.reason}`);
        topo = t.plan;
        if (t.plan.changes.length) steps.push(`${service}:topology_planned`);
      } else {
        const set = await cf.versionBindingSet(service, captured[0].version_id);
        // 2026-11-16: the declared service bindings of the target commit's stored config (code only: the running
        // commit's config is the same text). Without it the result cannot be verified: fail closed.
        const tgt = await readConfig(env.BUNDLES, commit, worker);
        if ("reason" in tgt) throw new Error(`service_bindings_unverifiable: ${tgt.reason}`);
        const declared = declaredServiceBindingsFromToml(tgt.toml);
        if ("reason" in declared) throw new Error(`service_bindings_unreadable: ${declared.reason}`);
        declaredFor.set(service, declared.bindings);
        const drift = serviceBindingDrift(declared.bindings, set.records);
        if (!drift) throw new Error("version_bindings_unreadable");
        await checkDrift(service, drift.restore, drift.undeclared, drift.conflicts);
        unknownProps.set(service, drift.unverifiable);
        markUnverifiable(service, drift.unverifiable);
        // Sent as declared on a drift, and also when props are unknown (harmless; it repairs a loss the API may not show).
        const send = drift.restore.length > 0 || drift.unverifiable.length > 0;
        active = { names: set.names, digest: set.digest, restore: send, rest: send ? await nonServiceBindingSet(set.records) : null };
      }
      // Gate 4: the deploy-time --var values, from the version just captured, before anything is uploaded.
      if (opts.deployVars) {
        const record = capturedRecord ?? await cf.version(service, captured[0].version_id);
        const k = keptDeployVars(unitName, service, record.resources?.bindings, opts.deployVars);
        if ("reason" in k) throw new Error(`deploy_vars_refused: ${k.reason}`);
        const inconsistent = deployVarsConsistent([...Object.values(keptVars), k.vars]);
        if (inconsistent) throw new Error(`deploy_vars_refused: ${inconsistent}`);
        keptVars[service] = k.vars;
        steps.push(`${service}:vars_kept`);
      }
      // G2c-2 step 6: a Worker with static assets. The route again (read only), the stored build again (hashes,
      // index.html), then the assets, before the version that uses them.
      let assetsPart: VersionMetadata["assets"];
      if (worker.assets) {
        if (!plannedAssets) throw new Error("assets_upload_missing");
        const route = await zoneRouteRefusal(cf, service);
        if (route) throw new Error(route);
        steps.push(`${service}:route_verified`);
        const a = await readAssetsPlan(env.BUNDLES, commit, worker, plannedAssets.running_commit);
        if ("reason" in a) throw new Error(a.reason);
        // keep_assets is never used (2026-11-13): it is not verified that a kept asset set keeps the
        // `run_worker_first = true` of the [assets] config, and without it assets would be served before the
        // Console Worker's own checks. An unchanged build is uploaded again with its config sent explicitly; the
        // upload session asks only for the files Cloudflare does not hold, so it costs no bucket.
        const keepRefused = a.assets.mode === "keep" ? "run_worker_first_unverified" : undefined;
        const up = await cf.assetsUploader().upload(service, a.files);
        assetsPart = { jwt: up.jwt, config: a.assets.config, binding: a.assets.binding };
        assetsRun[service] = { mode: "upload", uploaded: up.uploaded, buckets: up.buckets, ...(keepRefused ? { keep_refused: keepRefused } : {}) };
        steps.push(`${service}:assets_uploaded`);
      }
      // An explicit upload of a Worker with assets that neither keeps nor sends them would drop them.
      if (worker.assets && !assetsPart) throw new Error("assets_upload_missing");
      const obj = await env.BUNDLES.get(`${BUNDLE_PREFIX}${commit}/${worker.module}`);
      const text = obj ? await obj.text() : null;
      if (text === null) throw new Error("bundle_module_missing");
      if (await sha256(text) !== worker.sha256 || new TextEncoder().encode(text).length !== worker.bytes) throw new Error("bundle_module_hash_mismatch");
      let extra: ExtraModule[] = [];
      if (!worker.single_module) {
        const mods = await readModules(env.BUNDLES, commit, worker, text);
        if ("reason" in mods) throw new Error(mods.reason);
        extra = mods.modules;
      }
      const metadata: VersionMetadata = configPlan
        ? {
          main_module: worker.main_module, compatibility_date: configPlan.metadata.compatibility_date, compatibility_flags: configPlan.metadata.compatibility_flags,
          tag, message: `native deploy commit ${commit}`,
          config: { bindings: uploadBindings(configPlan), keep_bindings: configPlan.keep_bindings, limits: configPlan.metadata.limits, placement: configPlan.metadata.placement },
          ...(assetsPart ? { assets: assetsPart } : {}),
        }
        : {
          main_module: worker.main_module, compatibility_date: worker.compatibility_date!, compatibility_flags: worker.compatibility_flags,
          tag, message: `native deploy commit ${commit}`,
          ...(assetsPart ? { assets: assetsPart } : {}),
          // 2026-11-16: the active version does not bind the declared service bindings: send them as declared.
          ...(active?.restore ? { services: declaredFor.get(service)! } : {}),
        };
      let versionId: string;
      if (topo?.migration) {
        // Gate 4 part B: a Durable Object migration deploys with the upload (Script Upload API). Recorded as changed
        // before the call; the checks below run after traffic moved, and a restore across it is refused by Cloudflare.
        // A break-glass plan's deleted, renamed or transferred class: recorded first that no rollback can cross it.
        for (const item of topo.migrationItems) await auditDestructive(service, item, `do_migration:${topo.migration.new_tag}`, DO_IRREVERSIBLE);
        changed.push({ service, captured });
        const m = topo;
        versionId = await deployWithDoMigration(cf, service, { module: worker.module, text, metadata, extra }, m, captured, {
          delayMs: opts.delayMs,
          // Cloudflare accepted the upload: the migration is applied, whatever the checks below find.
          onUploaded: () => {
            doMigrations.push(`${service}:${m.migration!.new_tag}`);
            for (const item of m.migrationItems) { destructiveApplied.push(item); irreversible.push(`${item}: ${DO_IRREVERSIBLE}`); }
          },
        });
        steps.push(`${service}:do_migration_deployed`);
      } else {
        versionId = await cf.uploadVersion(service, worker.module, text, metadata, extra);
        steps.push(`${service}:uploaded`);
      }
      versions[service] = versionId;
      if (configPlan) {
        // G2c-2: the new version must bind exactly the plan and run with its settings, or traffic never moves.
        const uploaded = await readUploaded(() => cf.version(service, versionId), opts.delayMs);
        const b = verifyPlannedBindings(configPlan, uploaded.resources?.bindings);
        if (!b.ok) throw new Error(`planned_bindings_differ: ${b.reason}${b.binding ? ` (${b.binding})` : ""}`);
        const sb = verifyServiceBindings(declaredFor.get(service) ?? [], uploaded.resources?.bindings);
        if (!sb.ok) throw new Error(`service_bindings_differ: ${sb.reason}${sb.binding ? ` (${sb.binding})` : ""}`);
        steps.push(`${service}:bindings_match`);
        propsAfterUpload(service, sb.unverifiable);
        for (const d of bindingDrift[service]?.restored ?? []) steps.push(restoredStep(service, d.name));
        const v = verifyVersionSettings(configPlan.metadata, uploaded);
        if (!v.ok) throw new Error(`version_settings_differ: ${v.reason}`);
        steps.push(`${service}:settings_match`);
        if (keptVars[service]) {
          const d = verifyDeployVars(keptVars[service], uploaded.resources?.bindings);
          if (!d.ok) throw new Error(`deploy_vars_differ: ${d.reason}`);
          steps.push(`${service}:vars_verified`);
        }
      } else {
        // keep_bindings copies from the script's latest version, which need not be the active one. The guard is
        // this comparison: the new version must bind exactly what production binds now, or traffic never moves.
        const uploaded = await readUploaded(() => cf.versionBindingSet(service, versionId), opts.delayMs);
        if (active!.rest) {
          // 2026-11-16: the declared service bindings were sent. Every other binding must be what production binds now,
          // and the service bindings exactly the declared ones, props included.
          const rest = await nonServiceBindingSet(uploaded.records ?? []);
          if (!sameList(rest.names, active!.rest.names) || rest.digest !== active!.rest.digest) throw new Error("bindings_differ");
        } else if (!sameList(uploaded.names, active!.names) || uploaded.digest !== active!.digest) throw new Error("bindings_differ");
        const sb = verifyServiceBindings(declaredFor.get(service)!, uploaded.records);
        if (!sb.ok) throw new Error(`service_bindings_differ: ${sb.reason}${sb.binding ? ` (${sb.binding})` : ""}`);
        steps.push(`${service}:bindings_match`);
        propsAfterUpload(service, sb.unverifiable);
        for (const d of bindingDrift[service]?.restored ?? []) steps.push(restoredStep(service, d.name));
        if (keptVars[service]) {
          const record = await readUploaded(() => cf.version(service, versionId), opts.delayMs);
          const d = verifyDeployVars(keptVars[service], record.resources?.bindings);
          if (!d.ok) throw new Error(`deploy_vars_differ: ${d.reason}`);
          steps.push(`${service}:vars_verified`);
        }
      }
      if (!topo?.migration) {
        // Recorded before the POST: an ambiguous failure of the deploy call is restored as well.
        changed.push({ service, captured });
        await cf.deploy(service, [{ version_id: versionId, percentage: 100 }], `deploy ${tag}, ${requestId}`);
        steps.push(`${service}:deployed`);
      }
      let live = false;
      for (let i = 0; i < VERIFY_ATTEMPTS && !live; i++) {
        if (i > 0) await sleep(opts.delayMs ?? VERIFY_DELAY_MS);
        const p = await env.DRIFT.probeService(service).catch(() => null);
        live = Boolean(p?.healthy && p.version_tag === tag);
      }
      if (!live) throw new Error("not_live_at_tag");
      steps.push(`${service}:verified`);
      if (bindingDrift[service]?.restored.length) {
        bindingDrift[service].repaired = true;
        await auditQuietly(env.DB, {
          event_type: BINDING_DRIFT_REPAIRED_EVENT, actor: "agent:deployment-orchestrator", subject: service, outcome: "repaired",
          payload: { request_id: requestId, commit_sha: commit, service, version_id: versionId, bindings: bindingDrift[service].restored.map((d) => d.name), restored: bindingDrift[service].restored.map((d) => ({ name: d.name, kinds: d.kinds })) },
        });
      }
      // Gate 4: the workflow's checks of this Worker through Access (verify-worker-live.sh --require-access), before
      // new schedules reach it. A failure restores like a failed live check.
      if (opts.smoke && !opts.smoke.skipped) {
        await runSmoke(await opts.smoke.afterService(unitName, service, tag));
        steps.push(`${service}:smoke_passed`);
      }
      // G2c-2: crons fire against the active deployment, so new schedules reach only verified new code.
      for (const step of configPlan?.steps ?? []) {
        settings.push({ service, step });
        await applyScriptSetting(cf, service, step, step.body);
        steps.push(`${service}:${step.kind}_applied`);
      }
      // Gate 4 part B: custom domains and Workflows reach only verified new code, after its script settings.
      for (const step of topo?.steps ?? []) {
        if (step.item) await auditDestructive(service, step.item, topologyStepLabel(step), step.irreversible);
        const entry = { service, step, restore: false };
        topoApplied.push(entry);
        await applyTopologyStep(cf.topology(), service, step, () => { entry.restore = true; if (step.irreversible) irreversible.push(`${step.item}: ${step.irreversible}`); }, { delayMs: opts.delayMs });
        steps.push(`${service}:${topologyStepLabel(step)}_applied`);
        if (step.item) {
          destructiveApplied.push(step.item);
          await auditQuietly(env.DB, {
            event_type: "deployment.destructive_topology_applied", actor: "agent:deployment-orchestrator", subject: service, outcome: "applied",
            payload: { request_id: requestId, commit_sha: commit, service, item: step.item, step: topologyStepLabel(step) },
          });
        }
      }
    }
    current = "";
    // Gate 4: the unit's own smoke step from its workflow, after every Worker is live, before the desired version.
    if (opts.smoke && !opts.smoke.skipped) {
      await runSmoke(await opts.smoke.afterUnit(unitName, tag));
      steps.push("unit:smoke_passed");
    }
    if (!env.REGISTRY.recordNativeDeploy) throw new Error("registry_native_deploy_unavailable");
    await env.REGISTRY.recordNativeDeploy(requestId);
    steps.push("desired_recorded");
    return {
      ok: true, versions, steps, ...(migrations.length ? { migrations_applied: applied, restore_point_at: restorePoint } : {}),
      ...(bookmark ? { restore_point: bookmark } : {}),
      ...(settings.length ? { settings_applied: settings.map((x) => `${x.service}:${x.step.kind}`) } : {}),
      ...(Object.keys(assetsRun).length ? { assets: assetsRun } : {}),
      ...(topoApplied.length ? { topology_applied: topoApplied.map((x) => `${x.service}:${topologyStepLabel(x.step)}`) } : {}),
      ...(doMigrations.length ? { do_migrations: doMigrations } : {}),
      ...(destructiveApplied.length ? { destructive_topology_applied: [...new Set(destructiveApplied)] } : {}),
      ...(irreversible.length ? { irreversible } : {}),
      ...gate4(),
    };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    let restored = true;
    // Gate 4 part B: the topology steps first (newest first), only those that wrote something.
    for (const { service, step, restore } of [...topoApplied].reverse()) {
      if (!restore) continue;
      try { steps.push(`${service}:${await restoreTopologyStep(cf.topology(), service, step, { delayMs: opts.delayMs })}`); } catch { restored = false; }
    }
    // G2c-2: the script settings first, newest first (each one's restore body is the running config's value),
    // then the deployments, so the old code never runs under the new schedules.
    for (const { service, step } of [...settings].reverse()) {
      try {
        await applyScriptSetting(cf, service, step, step.restore);
        steps.push(`${service}:${step.kind}_restored`);
      } catch { restored = false; }
    }
    for (const { service, captured } of [...changed].reverse()) {
      try {
        const now = await cf.active(service);
        if (!sameDeployment(now, captured)) await cf.deploy(service, captured, `deploy ${requestId} failed; restoring`);
        if (!sameDeployment(await cf.active(service), captured)) restored = false;
        else steps.push(`${service}:restored`);
      } catch { restored = false; }
    }
    return {
      ok: false, reason, ...(current ? { service: current } : {}), restored,
      production_changed: changed.length > 0 || applied.length > 0 || settings.length > 0 || topoApplied.some((x) => x.restore), versions, steps,
      ...(migrations.length ? { migrations_applied: applied, restore_point_at: restorePoint } : {}),
      ...(bookmark ? { restore_point: bookmark } : {}),
      ...(settings.length ? { settings_applied: settings.map((x) => `${x.service}:${x.step.kind}`) } : {}),
      ...(Object.keys(assetsRun).length ? { assets: assetsRun } : {}),
      ...(topoApplied.length ? { topology_applied: topoApplied.map((x) => `${x.service}:${topologyStepLabel(x.step)}`) } : {}),
      ...(doMigrations.length ? { do_migrations: doMigrations } : {}),
      ...(destructiveApplied.length ? { destructive_topology_applied: [...new Set(destructiveApplied)] } : {}),
      ...(irreversible.length ? { irreversible } : {}),
      ...gate4(),
      ...(migrating ? { migration_failed: migrating } : {}),
    };
  }
}
