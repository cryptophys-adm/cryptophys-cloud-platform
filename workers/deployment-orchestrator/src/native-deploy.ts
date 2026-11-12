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
// Anything else (static assets, a running version without a bundle or a stored config, a plan refusal, a
// migration that is not additive) stays on the unit's GitHub workflow, which also renders config.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import type { DeployUnit } from "../../control-plane-shared/src/deploy-units.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import {
  D1_MIGRATION_INSERT, D1_MIGRATIONS_TABLE, destructiveMigration, splitSqlStatements, unsupportedStatement,
} from "../../control-plane-shared/src/migration-rules.ts";
import {
  CloudflareWorkers, MODULE_NAME, MODULE_TYPES, nativeRollbackConfigured, sameDeployment, sleep, VERIFY_ATTEMPTS, VERIFY_DELAY_MS,
  type DeploymentVersions, type DriftProbeBinding, type ExtraModule, type ModuleType, type NativeRollbackEnv, type RegistryRollbackBinding, type VersionRecord,
} from "./native-rollback.ts";
import { configRefusal, parseToml, planConfigChange, uploadBindings, verifyPlannedBindings, verifyVersionSettings, type ConfigPlan, type PlanStep } from "./config-diff.ts";

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
export interface PlannedConfig { running_commit: string; running: BundleWorker; changes: ConfigPlan["changes"]; steps: PlanStep["kind"][] }
export interface PlannedService { service: string; worker: BundleWorker; running_tag: string; config?: PlannedConfig }
/** A migration the deploy applies before its Workers, in this order. */
export interface PlannedMigration { file: string; sha256: string }
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
export function workerConfigRefusal(runningToml: string, targetToml: string): string | null {
  const refused = configRefusal(runningToml, targetToml);
  if (refused) return refused;
  const run = parseToml(runningToml)!;
  const tgt = parseToml(targetToml)!;
  if (run.limits !== undefined && tgt.limits === undefined) return "limits_removed";
  if (run.placement !== undefined || tgt.placement !== undefined) return "placement_unverified";
  return null;
}

/** G2c-2: the configuration plan for one Worker against the active version's full binding records. */
export function planWorkerConfig(runningToml: string, targetToml: string, activeBindings: unknown): { plan: ConfigPlan } | { reason: string } {
  const refused = workerConfigRefusal(runningToml, targetToml);
  if (refused) return { reason: refused };
  const plan = planConfigChange(runningToml, targetToml, activeBindings);
  return plan.eligible ? { plan } : { reason: plan.reason };
}

/** The read-only Cloudflare calls eligibility makes: the active deployment and one version's full record. */
export type VersionReader = Pick<CloudflareWorkers, "active" | "version">;

/** The main module of one Worker, read from R2 and checked against the manifest; null when missing or different. */
async function readMainModule(bucket: BundleReader, commit: string, worker: BundleWorker): Promise<string | null> {
  const obj = await bucket.get(`${BUNDLE_PREFIX}${commit}/${worker.module}`);
  const text = obj ? await obj.text() : null;
  if (text === null) return null;
  if (await sha256(text) !== worker.sha256 || new TextEncoder().encode(text).length !== worker.bytes) return null;
  return text;
}

/** One stored migration, read and checked as the deploy will apply it: its statements, or the reason it cannot be. */
export async function readMigration(bucket: BundleReader, commit: string, m: PlannedMigration): Promise<{ statements: string[] } | { reason: string }> {
  if (!MIGRATION_FILE.test(m.file)) return { reason: "migration_missing" };
  const obj = await bucket.get(`${BUNDLE_PREFIX}${commit}/migrations/${m.file}`);
  if (!obj) return { reason: "migration_missing" };
  const sql = await obj.text();
  if (await sha256(sql) !== m.sha256) return { reason: "migration_hash_mismatch" };
  let statements: string[];
  try { statements = splitSqlStatements(sql); } catch { return { reason: "migration_unreadable" }; }
  if (statements.length === 0) return { reason: "migration_unreadable" };
  if (destructiveMigration(sql)) return { reason: "destructive_migration" };
  if (unsupportedStatement(statements)) return { reason: "migration_unsupported_statement" };
  return { statements };
}

/**
 * G2c-1: what a changed migration list means for this unit. Only the Control Plane applies migrations; another
 * unit may deploy once the ledger already lists exactly the target's files (the Control Plane applied them).
 * For the Control Plane: no applied file edited or removed (sha256 in both manifests), the new files sort after
 * the running ones, each one is additive and matches its stored SQL, and the D1 ledger lists exactly the running
 * manifest's files (or already the target's: nothing to apply). Manifests without migration_files (G2b and
 * older) keep the G2b answer, new_migration.
 */
async function migrationPlan(env: Pick<NativeDeployEnv, "DB" | "BUNDLES">, unit: DeployUnit, target: Manifest, running: Manifest, service: string):
  Promise<{ migrations: PlannedMigration[] } | { reason: string; service?: string; file?: string }> {
  const targetList = target.migrations!;
  const runningList = running.migrations!;
  const changed = !sameList(runningList, targetList);
  if (unit.unit !== MIGRATING_UNIT) {
    if (!changed) return { migrations: [] };
    const ledger = await appliedMigrations(env.DB);
    return ledger && sameList(ledger, targetList) ? { migrations: [] } : { reason: "new_migration", service };
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
  for (const f of fresh) {
    const r = await readMigration(env.BUNDLES!, target.commit, f);
    if ("reason" in r) return { reason: r.reason, service, file: f.file };
  }
  return { migrations: fresh.map((f) => ({ file: f.file, sha256: f.sha256 })) };
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
 */
export async function nativeDeployEligible(env: Pick<NativeDeployEnv, "DB" | "BUNDLES">, unit: DeployUnit, targetSha: string, cf?: VersionReader): Promise<Eligibility> {
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
      if (worker.assets) return { eligible: false, reason: "assets", service };
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
      if (!now.migrations) return { eligible: false, reason: "migrations_unknown", service };
      if (migrationsFrom === null) {
        const plan = await migrationPlan(env, unit, target, now, service);
        if ("reason" in plan) return { eligible: false, ...plan };
        migrations = plan.migrations;
        migrationsFrom = now.migrations;
      } else if (!sameList(now.migrations, migrationsFrom)) {
        // The Workers of the unit run versions with different migration lists: one plan cannot fit them all.
        return { eligible: false, reason: "new_migration", service };
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
        const refused = workerConfigRefusal(run.toml, tgt.toml);
        if (refused) return { eligible: false, reason: refused, service };
        toPlan.push({ index: planned.length, service, runningCommit: now.commit, was, runningToml: run.toml, targetToml: tgt.toml });
      }
      planned.push({ service, worker, running_tag: tag.slice(0, 12) });
    }
    // Pass 2 (G2c-2): only now Cloudflare is read, for the Workers that need a plan.
    for (const p of toPlan) {
      const { service } = p;
      if (!cf) return { eligible: false, reason: p.was.config_sha256 === planned[p.index].worker.config_sha256 ? "limits" : "config_changed", service };
      let active: DeploymentVersions;
      try { active = await cf.active(service); } catch { return { eligible: false, reason: "active_deployment_unreadable", service }; }
      if (active.length !== 1 || active[0].percentage !== 100) return { eligible: false, reason: "active_deployment_split", service };
      let record: VersionRecord;
      try { record = await cf.version(service, active[0].version_id); } catch { return { eligible: false, reason: "active_bindings_unreadable", service }; }
      const r = planWorkerConfig(p.runningToml, p.targetToml, record.resources?.bindings);
      if ("reason" in r) return { eligible: false, reason: r.reason, service };
      planned[p.index] = { ...planned[p.index], config: { running_commit: p.runningCommit, running: p.was, changes: r.plan.changes, steps: r.plan.steps.map((s) => s.kind) } };
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
  /** G2c-2: the script settings applied after a live check, `<service>:<kind>`, in order (restored on failure). */
  settings_applied?: string[];
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
export async function applyMigration(db: D1Database, bucket: BundleReader, commit: string, m: PlannedMigration): Promise<number> {
  const r = await readMigration(bucket, commit, m);
  if ("reason" in r) throw new Error(r.reason);
  await db.batch([db.prepare(D1_MIGRATION_INSERT).bind(m.file), ...r.statements.map((s) => db.prepare(s))]);
  return r.statements.length;
}

async function auditQuietly(db: D1Database | undefined, event: Parameters<typeof appendAuditEvent>[1]): Promise<boolean> {
  if (!db) return false;
  try { await appendAuditEvent(db, event); return true; } catch { return false; }
}

/**
 * Execute one queued native deploy over the eligible plan: the migrations first (G2c-1), then each Worker in unit
 * order: capture, (G2c-2) plan the configuration again against the captured version, upload, verify the bindings
 * (and the planned settings), deploy, verify live, then (G2c-2) apply the plan's script settings. The desired
 * version is recorded after every Worker. Never throws; the caller records the outcome. On any failure the
 * applied script settings are restored first (newest first), then every changed service to its captured
 * deployment, newest change first; applied migrations stay (forward-only).
 */
export async function executeNativeDeploy(
  cf: CloudflareWorkers,
  env: { DRIFT: DriftProbeBinding; REGISTRY: RegistryRollbackBinding; BUNDLES: BundleReader; DB?: D1Database },
  requestId: string, commit: string, plan: PlannedService[], opts: { delayMs?: number; migrations?: PlannedMigration[] } = {},
): Promise<DeployRun> {
  const tag = commit.slice(0, 12);
  const steps: string[] = [];
  const versions: Record<string, string> = {};
  const changed: { service: string; captured: DeploymentVersions }[] = [];
  // G2c-2: script settings, recorded before each call so an ambiguous failure is restored as well.
  const settings: { service: string; step: PlanStep }[] = [];
  const applied: string[] = [];
  const migrations = opts.migrations ?? [];
  let migrating: string | null = null;
  let restorePoint: string | undefined;
  let current = "";
  try {
    if (!HEX40.test(commit) || !plan.length) throw new Error("invalid_plan");
    if (migrations.length) {
      if (!env.DB) throw new Error("migration_db_unavailable");
      restorePoint = new Date().toISOString();
      for (const m of migrations) {
        migrating = m.file;
        let statements: number;
        try {
          statements = await applyMigration(env.DB, env.BUNDLES, commit, m);
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
    for (const { service, worker, config } of plan) {
      current = service;
      const captured = await cf.active(service);
      if (captured.length !== 1 || captured[0].percentage !== 100) throw new Error("active_deployment_split");
      steps.push(`${service}:captured`);
      // G2c-2: the plan again, right before the upload, against the deployment just captured (its bindings may
      // have changed since the request was queued). Code only (G2b): the active binding set, for the digest check.
      let configPlan: ConfigPlan | null = null;
      let active: { names: string[]; digest: string } | null = null;
      if (config) {
        const run = await readConfig(env.BUNDLES, config.running_commit, config.running);
        if ("reason" in run) throw new Error(run.reason);
        const tgt = await readConfig(env.BUNDLES, commit, worker);
        if ("reason" in tgt) throw new Error(tgt.reason);
        const record = await cf.version(service, captured[0].version_id);
        const r = planWorkerConfig(run.toml, tgt.toml, record.resources?.bindings);
        if ("reason" in r) throw new Error(`config_plan_refused: ${r.reason}`);
        configPlan = r.plan;
        steps.push(`${service}:planned`);
      } else {
        active = await cf.versionBindingSet(service, captured[0].version_id);
      }
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
      const versionId = await cf.uploadVersion(service, worker.module, text, configPlan
        ? {
          main_module: worker.main_module, compatibility_date: configPlan.metadata.compatibility_date, compatibility_flags: configPlan.metadata.compatibility_flags,
          tag, message: `native deploy commit ${commit}`,
          config: { bindings: uploadBindings(configPlan), keep_bindings: configPlan.keep_bindings, limits: configPlan.metadata.limits, placement: configPlan.metadata.placement },
        }
        : {
          main_module: worker.main_module, compatibility_date: worker.compatibility_date!, compatibility_flags: worker.compatibility_flags,
          tag, message: `native deploy commit ${commit}`,
        }, extra);
      versions[service] = versionId;
      steps.push(`${service}:uploaded`);
      if (configPlan) {
        // G2c-2: the new version must bind exactly the plan and run with its settings, or traffic never moves.
        const uploaded = await cf.version(service, versionId);
        const b = verifyPlannedBindings(configPlan, uploaded.resources?.bindings);
        if (!b.ok) throw new Error(`planned_bindings_differ: ${b.reason}${b.binding ? ` (${b.binding})` : ""}`);
        steps.push(`${service}:bindings_match`);
        const v = verifyVersionSettings(configPlan.metadata, uploaded);
        if (!v.ok) throw new Error(`version_settings_differ: ${v.reason}`);
        steps.push(`${service}:settings_match`);
      } else {
        // keep_bindings copies from the script's latest version, which need not be the active one. The guard is
        // this comparison: the new version must bind exactly what production binds now, or traffic never moves.
        const uploaded = await cf.versionBindingSet(service, versionId);
        if (!sameList(uploaded.names, active!.names) || uploaded.digest !== active!.digest) throw new Error("bindings_differ");
        steps.push(`${service}:bindings_match`);
      }
      // Recorded before the POST: an ambiguous failure of the deploy call is restored as well.
      changed.push({ service, captured });
      await cf.deploy(service, [{ version_id: versionId, percentage: 100 }], `deploy ${tag}, ${requestId}`);
      steps.push(`${service}:deployed`);
      let live = false;
      for (let i = 0; i < VERIFY_ATTEMPTS && !live; i++) {
        if (i > 0) await sleep(opts.delayMs ?? VERIFY_DELAY_MS);
        const p = await env.DRIFT.probeService(service).catch(() => null);
        live = Boolean(p?.healthy && p.version_tag === tag);
      }
      if (!live) throw new Error("not_live_at_tag");
      steps.push(`${service}:verified`);
      // G2c-2: crons fire against the active deployment, so new schedules reach only verified new code.
      for (const step of configPlan?.steps ?? []) {
        settings.push({ service, step });
        await applyScriptSetting(cf, service, step, step.body);
        steps.push(`${service}:${step.kind}_applied`);
      }
    }
    current = "";
    if (!env.REGISTRY.recordNativeDeploy) throw new Error("registry_native_deploy_unavailable");
    await env.REGISTRY.recordNativeDeploy(requestId);
    steps.push("desired_recorded");
    return {
      ok: true, versions, steps, ...(migrations.length ? { migrations_applied: applied, restore_point_at: restorePoint } : {}),
      ...(settings.length ? { settings_applied: settings.map((x) => `${x.service}:${x.step.kind}`) } : {}),
    };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    let restored = true;
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
      ok: false, reason, ...(current ? { service: current } : {}), restored, production_changed: changed.length > 0 || applied.length > 0 || settings.length > 0, versions, steps,
      ...(migrations.length ? { migrations_applied: applied, restore_point_at: restorePoint } : {}),
      ...(settings.length ? { settings_applied: settings.map((x) => `${x.service}:${x.step.kind}`) } : {}),
      ...(migrating ? { migration_failed: migrating } : {}),
    };
  }
}
