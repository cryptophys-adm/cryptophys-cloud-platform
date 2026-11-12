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
// Anything else (a configuration change, a new migration, static assets, extra modules, a running version
// without a bundle) stays on the unit's GitHub workflow, which also applies migrations and renders config.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import type { DeployUnit } from "../../control-plane-shared/src/deploy-units.ts";
import {
  CloudflareWorkers, nativeRollbackConfigured, sameDeployment, sleep, VERIFY_ATTEMPTS, VERIFY_DELAY_MS,
  type DeploymentVersions, type DriftProbeBinding, type NativeRollbackEnv, type RegistryRollbackBinding,
} from "./native-rollback.ts";

export const NATIVE_DEPLOY_EXECUTOR = "native:deploy";
const BUNDLE_PREFIX = "bundles/";
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MANIFEST_KEY = /^bundles\/([0-9a-f]{40})\/manifest\.json$/;

/** The read-only subset of the R2 bucket binding the Orchestrator uses. */
export interface BundleReader {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
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
}
export interface Manifest { commit: string; workers: BundleWorker[]; migrations: string[] | null }

/** Parse a forge-bundles.v1 manifest strictly; anything unexpected is unreadable. */
export function parseManifest(text: string, commit: string): Manifest | null {
  let m: { schema?: unknown; commit?: unknown; workers?: unknown; migrations?: unknown };
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
    workers.push({
      name, module, main_module: module, sha256: w.sha256, bytes: w.bytes, config_sha256: w.config_sha256,
      compatibility_date: typeof w.compatibility_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date) ? w.compatibility_date : null,
      compatibility_flags: [...w.compatibility_flags as string[]], single_module: w.single_module, assets: w.assets,
    });
  }
  const migrations = Array.isArray(m.migrations) && m.migrations.every((x) => typeof x === "string") ? [...m.migrations as string[]].sort() : null;
  return { commit, workers, migrations };
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

export interface PlannedService { service: string; worker: BundleWorker; running_tag: string }
export type Eligibility =
  | { eligible: true; commit: string; services: PlannedService[] }
  | { eligible: false; reason: string; service?: string };

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether the unit can deploy `targetSha` from the Forge's bundles alone. For every service of the unit, in
 * unit order: present in the target manifest and in the manifest of the version the registry says it runs,
 * one module, no static assets, the same wrangler.toml hash; and the D1 migration lists equal. Any missing or
 * unreadable evidence is ineligible (the GitHub workflow stays the path).
 */
export async function nativeDeployEligible(env: Pick<NativeDeployEnv, "DB" | "BUNDLES">, unit: DeployUnit, targetSha: string): Promise<Eligibility> {
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
    for (const service of services) {
      const worker = target.workers.find((w) => w.name === service);
      if (!worker) return { eligible: false, reason: "service_not_in_bundle", service };
      if (worker.assets) return { eligible: false, reason: "assets", service };
      if (!worker.single_module) return { eligible: false, reason: "multi_module", service };
      if (!worker.compatibility_date) return { eligible: false, reason: "config_unreadable", service };
      const reg = registry.get(service);
      const desired = reg?.desired_version ?? "";
      if (!reg || reg.status === "disabled" || !/^[0-9a-f]{12,40}$/.test(desired)) return { eligible: false, reason: "desired_version_unknown", service };
      const tag = desired.length === 40 ? desired : desired.slice(0, 12);
      if (!running.has(tag)) running.set(tag, await manifestForTag(env.BUNDLES, tag));
      const now = running.get(tag);
      const was = now?.workers.find((w) => w.name === service);
      if (!now || !was) return { eligible: false, reason: "running_bundle_missing", service };
      if (was.config_sha256 !== worker.config_sha256) return { eligible: false, reason: "config_changed", service };
      if (!now.migrations) return { eligible: false, reason: "migrations_unknown", service };
      if (!sameList(now.migrations, target.migrations)) return { eligible: false, reason: "new_migration", service };
      planned.push({ service, worker, running_tag: tag.slice(0, 12) });
    }
    return { eligible: true, commit: targetSha, services: planned };
  } catch {
    return { eligible: false, reason: "bundle_read_failed" };
  }
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DeployRun {
  ok: boolean;
  reason?: string;
  /** The service whose step failed. */
  service?: string;
  /** Every captured deployment that was changed is active again (true when nothing was changed). */
  restored?: boolean;
  /** Whether any deployment was changed (or a deploy call was attempted) before the failure. */
  production_changed?: boolean;
  /** service -> uploaded version id. */
  versions: Record<string, string>;
  /** Steps that completed, `<service>:<step>`, for the audit trail. */
  steps: string[];
}

/**
 * Execute one queued native deploy over the eligible plan, in unit order. Never throws; the caller records the
 * outcome. On any failure every changed service is restored to its captured deployment, newest change first.
 */
export async function executeNativeDeploy(
  cf: CloudflareWorkers,
  env: { DRIFT: DriftProbeBinding; REGISTRY: RegistryRollbackBinding; BUNDLES: BundleReader },
  requestId: string, commit: string, plan: PlannedService[], opts: { delayMs?: number } = {},
): Promise<DeployRun> {
  const tag = commit.slice(0, 12);
  const steps: string[] = [];
  const versions: Record<string, string> = {};
  const changed: { service: string; captured: DeploymentVersions }[] = [];
  let current = "";
  try {
    if (!HEX40.test(commit) || !plan.length) throw new Error("invalid_plan");
    for (const { service, worker } of plan) {
      current = service;
      const captured = await cf.active(service);
      if (captured.length !== 1 || captured[0].percentage !== 100) throw new Error("active_deployment_split");
      steps.push(`${service}:captured`);
      const active = await cf.versionBindingSet(service, captured[0].version_id);
      const obj = await env.BUNDLES.get(`${BUNDLE_PREFIX}${commit}/${worker.module}`);
      const text = obj ? await obj.text() : null;
      if (text === null) throw new Error("bundle_module_missing");
      if (await sha256(text) !== worker.sha256 || new TextEncoder().encode(text).length !== worker.bytes) throw new Error("bundle_module_hash_mismatch");
      const versionId = await cf.uploadVersion(service, worker.module, text, {
        main_module: worker.main_module, compatibility_date: worker.compatibility_date!, compatibility_flags: worker.compatibility_flags,
        tag, message: `native deploy commit ${commit}`,
      });
      versions[service] = versionId;
      steps.push(`${service}:uploaded`);
      // keep_bindings copies from the script's latest version, which need not be the active one. The guard is
      // this comparison: the new version must bind exactly what production binds now, or traffic never moves.
      const uploaded = await cf.versionBindingSet(service, versionId);
      if (!sameList(uploaded.names, active.names) || uploaded.digest !== active.digest) throw new Error("bindings_differ");
      steps.push(`${service}:bindings_match`);
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
    }
    current = "";
    if (!env.REGISTRY.recordNativeDeploy) throw new Error("registry_native_deploy_unavailable");
    await env.REGISTRY.recordNativeDeploy(requestId);
    steps.push("desired_recorded");
    return { ok: true, versions, steps };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    let restored = true;
    for (const { service, captured } of [...changed].reverse()) {
      try {
        const now = await cf.active(service);
        if (!sameDeployment(now, captured)) await cf.deploy(service, captured, `deploy ${requestId} failed; restoring`);
        if (!sameDeployment(await cf.active(service), captured)) restored = false;
        else steps.push(`${service}:restored`);
      } catch { restored = false; }
    }
    return { ok: false, reason, ...(current ? { service: current } : {}), restored, production_changed: changed.length > 0, versions, steps };
  }
}
