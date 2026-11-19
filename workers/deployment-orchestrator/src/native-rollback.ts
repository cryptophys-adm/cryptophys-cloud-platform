// ADR-0012 phase 2: roll a Worker back without GitHub. The Orchestrator switches traffic back to
// a version that production ran before, through the Workers Deployments API. The steps match
// rollback-worker.yml:
//   1. capture the active deployment;
//   2. find the version tagged with the target;
//   3. deploy it at 100%;
//   4. verify it live through the Drift Detector;
//   5. record it as the desired version in the Platform Registry;
//   6. if any step fails, restore the captured deployment.
// No build and no new code are involved.
//
// It is active only when the owner has set the Worker secret CF_DEPLOY_TOKEN (Workers Scripts
// Edit) and the deploy has set CF_ACCOUNT_ID. Otherwise the GitHub workflow stays the path.
// Requests are queued in deployment_requests and executed by this Worker's own cron, which fires
// only at minutes outside the drift and kernel cron windows (wait-cron-window.sh SAFE).

import { AssetsUploader, assetsMetadata, type AssetsConfig } from "./assets-upload.ts";
import { CloudflareTopology, type DoMigrationUpload } from "./topology.ts";

export const NATIVE_EXECUTOR = "native:rollback";
/** Must stay a subset of SAFE in .github/scripts/wait-cron-window.sh. */
export const SAFE_MINUTES = [2, 10, 17, 25, 32, 40, 47, 55];
const API = "https://api.cloudflare.com/client/v4";
export const VERIFY_ATTEMPTS = 12;
export const VERIFY_DELAY_MS = 5000;

export interface DriftProbeBinding {
  probeService(serviceId: string): Promise<{ reachable: boolean; healthy: boolean; version_tag: string | null; error: string | null }>;
}
export interface RegistryRollbackBinding {
  recordRollback(requestId: string): Promise<{ desired_version: string }>;
  /** ADR-0012 G2b: records the deployed commit for every service of a running native deploy's unit. */
  recordNativeDeploy?(requestId: string): Promise<{ desired_version: string; services: string[] }>;
  /** Owner 2026-11-19: records the deployed commit for the Workers a failed native deploy could not restore. */
  recordNotRestored?(requestId: string, services: string[]): Promise<{ desired_version: string; services: string[] }>;
}
export interface NativeRollbackEnv {
  CF_DEPLOY_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  DRIFT?: DriftProbeBinding;
  REGISTRY?: RegistryRollbackBinding;
}

export function nativeRollbackConfigured(env: NativeRollbackEnv): boolean {
  return Boolean(env.CF_DEPLOY_TOKEN && env.CF_ACCOUNT_ID && /^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID) && env.DRIFT && env.REGISTRY);
}

export type DeploymentVersions = { version_id: string; percentage: number }[];
const UUID = /^[0-9a-f-]{36}$/;

/**
 * Every binding type the platform's Workers use (wrangler.toml and the deploy workflows' --var). A version
 * uploaded by the Orchestrator keeps all of them from the script's previous version: it never sends a binding,
 * except (2026-11-16) the declared service bindings when the active version does not bind them as declared
 * (`VersionMetadata.services`; then `service` is not kept) and the plain-text values when a deploy-time value
 * changes (`VersionMetadata.plain_text`, owner 2026-11-16; then `plain_text` is not kept). Both can be sent at once.
 */
export const KEEP_BINDINGS = [
  "plain_text", "secret_text", "secret_key", "d1", "service", "durable_object_namespace", "r2_bucket", "kv_namespace", "ai",
  "vectorize", "workflow", "artifacts", "worker_loader", "version_metadata", "secrets_store_secret", "send_email",
  "analytics_engine", "queue", "browser",
] as const;

/**
 * ADR-0012 G2c-1: the module types of a version upload's extra parts, as Wrangler uploads them: an ES module,
 * a Text rule (a string), a Data rule (an ArrayBuffer) and compiled WebAssembly (a WebAssembly.Module).
 */
export const MODULE_TYPES = ["application/javascript+module", "text/plain", "application/octet-stream", "application/wasm"] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];
export interface ExtraModule { name: string; type: ModuleType; data: Uint8Array }
/** A module name: a relative path of plain segments (the Forge's MODULE_NAME). */
export const MODULE_NAME = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

export interface VersionMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  /** The 12-character commit tag the Drift Detector reads back from the version metadata binding. */
  tag: string;
  message: string;
  /**
   * ADR-0012 G2c-2: a configuration change. The version sends exactly these bindings and keeps only
   * `keep_bindings` (the secrets) from the previous version, with the target config's `limits` and `placement`.
   * Absent: the code-only upload of G2b (every platform binding type kept, none sent).
   */
  config?: { bindings: Array<{ type: string; name: string; [field: string]: unknown }>; keep_bindings: string[]; limits?: Record<string, unknown>; placement?: Record<string, unknown> };
  /**
   * ADR-0012 G2c-2 step 6: a Worker that serves static assets (the Console). Either the assets of the previously
   * uploaded version are kept (`keep_assets: true`), or the completion token of a fresh upload is sent with the
   * `[assets]` routing config (`assets: { jwt, config }`). A version upload of such a Worker without either would
   * drop its assets, so the executor never uploads one without this. `binding` is the `[assets]` binding name: on
   * a code-only upload it is sent as `{ type: "assets", name }` (Cloudflare's direct-upload example); a planned
   * configuration already carries it in `config.bindings`.
   */
  assets?: { keep: true; binding: string | null } | { keep?: false; jwt: string; config: AssetsConfig; binding: string | null };
  /**
   * 2026-11-16 (binding props lost out of band): a code-only upload whose active version does not bind the service
   * bindings its wrangler.toml declares. These are sent as declared and `service` is no longer a kept type, so the
   * new version binds exactly the declared service bindings; every other type is kept as before. Only without
   * `config` (a planned configuration already carries its service bindings).
   */
  services?: Array<{ type: "service"; name: string; service: string; entrypoint?: string; environment?: string; props?: Record<string, unknown> }>;
  /**
   * Owner 2026-11-16 (deploy-vars.ts, the identity table): a code-only upload that changes a deploy-time value. Every
   * `plain_text` binding of the active version is sent explicitly, the changed ones with their new text, and
   * `plain_text` is dropped from `keep_bindings`, so the new version's plain-text values do not depend on how Cloudflare
   * merges a kept binding with a sent one of the same name. Not used with `config` (a plan sends every binding). May
   * come with `services`: then both types are sent and neither is kept.
   */
  plain_text?: Array<{ type: "plain_text"; name: string; text: string }>;
}

/** ADR-0012 G2c-2: a version as `GET …/scripts/{name}/versions/{id}` returns it (the API's `result`). */
export interface VersionRecord { id?: string; resources?: { bindings?: unknown; script_runtime?: Record<string, unknown> }; [field: string]: unknown }

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((k) => [k, normalize((input as Record<string, unknown>)[k])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/**
 * The binding set of a list of binding records (versionBindingSet's answer): sorted `type:name` strings and a digest of
 * every record. Owner 2026-11-16: the native deploy also computes it for the active records with a changed deploy-time
 * value's text replaced, the set the new version must then have. Unreadable or empty fails closed.
 */
export async function bindingSetOf(list: unknown[] | null): Promise<{ names: string[]; digest: string; records: Array<{ type: string; name: string; [field: string]: unknown }> }> {
  if (!list) throw new Error("version_bindings_unreadable");
  const records = list.map((b) => b as { type?: unknown; name?: unknown });
  if (!records.length || !records.every((b) => typeof b?.type === "string" && typeof b?.name === "string")) throw new Error("version_bindings_unreadable");
  const names = records.map((b) => `${b.type}:${b.name}`).sort();
  const canonical = records.map((b) => canonicalJson(b)).sort().join("\n");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  // 2026-11-16: the records themselves, so the service bindings can be compared with the declared ones.
  return { names, digest: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""), records: records as Array<{ type: string; name: string }> };
}

export class CloudflareWorkers {
  private readonly token: string;
  private readonly account: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, account: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.account = account;
    // Called as a plain function: the runtime's global fetch throws "Illegal invocation" when it is called as a
    // method of another object (this.fetcher(...)), which workerd does.
    this.fetcher = (input, init) => fetcher(input, init);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    // A multipart body (a version upload) sets its own content type with the boundary.
    const type: Record<string, string> = init.body instanceof FormData ? {} : { "content-type": "application/json" };
    // An empty path is the account's script list itself.
    const res = await this.fetcher(`${API}/accounts/${this.account}/workers/scripts${path ? `/${path}` : ""}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...type, ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null) as { success?: boolean; result?: T; errors?: { code: number }[] } | null;
    if (!res.ok || !body?.success) throw new Error(`cloudflare_api_${res.status}_${(body?.errors ?? []).map((e) => e.code).join("-") || "error"}`);
    return body.result as T;
  }

  /** The active deployment: the newest one's versions, sorted by version id. */
  async active(script: string): Promise<DeploymentVersions> {
    const r = await this.call<{ deployments: { created_on: string; versions: DeploymentVersions }[] }>(`${script}/deployments`);
    const latest = [...(r.deployments ?? [])].sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on)).pop();
    const versions = (latest?.versions ?? []).map(({ version_id, percentage }) => ({ version_id, percentage }))
      .sort((a, b) => a.version_id.localeCompare(b.version_id));
    if (!versions.length || !versions.every((v) => /^[0-9a-f-]{36}$/.test(v.version_id))) throw new Error("active_deployment_unreadable");
    return versions;
  }

  /** The newest uploaded version carrying the 12-character tag, or null. */
  async versionForTag(script: string, tag: string): Promise<string | null> {
    const r = await this.call<{ items: { id: string; annotations?: Record<string, string>; metadata?: { created_on?: string } }[] }>(`${script}/versions?per_page=100`);
    const match = (r.items ?? []).filter((v) => v.annotations?.["workers/tag"] === tag && /^[0-9a-f-]{36}$/.test(v.id))
      .sort((a, b) => Date.parse(a.metadata?.created_on ?? "") - Date.parse(b.metadata?.created_on ?? "")).pop();
    return match?.id ?? null;
  }

  /**
   * ADR-0012 G2b: upload one module as a new version of the script, without deploying it. The version keeps the
   * bindings of every listed type from the script's previous version (`keep_bindings`), so secrets and the
   * deploy-time variables are never sent from here. An uploaded version receives no traffic until `deploy`.
   * Returns the new version id.
   */
  async uploadVersion(script: string, moduleName: string, moduleText: string, metadata: VersionMetadata, extra: ExtraModule[] = []): Promise<string> {
    const form = this.uploadForm(moduleName, moduleText, metadata, extra, {});
    const r = await this.call<{ id?: string }>(`${script}/versions`, { method: "POST", body: form });
    if (typeof r?.id !== "string" || !UUID.test(r.id)) throw new Error("version_upload_unreadable");
    return r.id;
  }

  /**
   * Gate 4 part B (topology.ts): a Durable Object migration. Cloudflare applies `migrations` only on the Script Upload
   * API (`PUT /accounts/{a}/workers/scripts/{name}`), which uploads AND deploys the new version at once; a version upload
   * with a pending migration is refused (Cloudflare docs, "Deployment management: Durable Object migrations"). Only a
   * planned configuration may be sent this way (its bindings, the secrets kept), never static assets. The caller reads
   * the new active deployment and the script's migration tag afterwards; nothing is returned from here.
   */
  async deployScript(script: string, moduleName: string, moduleText: string, metadata: VersionMetadata, extra: ExtraModule[], migrations: DoMigrationUpload,
    settings: Record<string, unknown> = {}): Promise<void> {
    if (!metadata.config || metadata.assets) throw new Error("invalid_script_upload");
    if (!migrations || !/^[A-Za-z0-9._-]{1,64}$/.test(migrations.new_tag) || !Array.isArray(migrations.steps) || !migrations.steps.length) throw new Error("invalid_script_upload");
    // A script upload also sets script-level settings; the target config's own values are sent so none is reset.
    const scriptSettings = Object.fromEntries(Object.entries(settings).filter(([k]) => k === "observability" || k === "logpush" || k === "tail_consumers"));
    const form = this.uploadForm(moduleName, moduleText, metadata, extra, { migrations, ...scriptSettings });
    await this.call<unknown>(script, { method: "PUT", body: form });
  }

  /**
   * Gate 4 part B: the tag of the Durable Object migration last applied to the script (`migration_tag` in the account's
   * script list; null when the script reports none). Throws when the list cannot be read or does not hold the script once.
   */
  async migrationTag(script: string): Promise<string | null> {
    if (!/^[a-z0-9-]{1,63}$/.test(script)) throw new Error("invalid_script_name");
    const r = await this.call<unknown>("");
    if (!Array.isArray(r)) throw new Error("script_list_unreadable");
    const items = r.filter((x) => (x as { id?: unknown })?.id === script) as Array<{ migration_tag?: unknown }>;
    if (items.length !== 1) throw new Error("script_not_listed");
    const tag = items[0].migration_tag;
    if (tag === undefined || tag === null || tag === "") return null;
    if (typeof tag !== "string") throw new Error("migration_tag_unreadable");
    return tag;
  }

  /** Gate 4 part B: the Workers Custom Domains and Workflows client, with the same token, account and fetcher. */
  topology(): CloudflareTopology {
    return new CloudflareTopology(this.token, this.account, this.fetcher);
  }

  /** The multipart body of a version or script upload (the metadata part, the main module and each extra module). */
  private uploadForm(moduleName: string, moduleText: string, metadata: VersionMetadata, extra: ExtraModule[], scriptFields: Record<string, unknown>): FormData {
    if (!/^[a-z0-9-]{1,63}\.mjs$/.test(moduleName) || metadata.main_module !== moduleName) throw new Error("invalid_module_name");
    if (!/^[0-9a-f]{12}$/.test(metadata.tag)) throw new Error("invalid_version_tag");
    const names = new Set<string>([moduleName]);
    for (const m of extra) {
      if (!MODULE_NAME.test(m.name) || names.has(m.name)) throw new Error("invalid_module_name");
      if (!(MODULE_TYPES as readonly string[]).includes(m.type)) throw new Error("invalid_module_type");
      names.add(m.name);
    }
    const config = metadata.config;
    const plain = metadata.plain_text;
    if (plain && (config || !plain.every((b) => b?.type === "plain_text" && typeof b.name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(b.name) && typeof b.text === "string")
      || new Set(plain.map((b) => b.name)).size !== plain.length)) throw new Error("invalid_plain_text_upload");
    if (config && (!Array.isArray(config.bindings) || !config.keep_bindings.every((t) => t === "secret_text" || t === "secret_key"))) throw new Error("invalid_config_upload");
    const services = metadata.services;
    if (services && (config || !Array.isArray(services) || !services.every((b) => b?.type === "service" && typeof b.name === "string" && typeof b.service === "string"))) throw new Error("invalid_services_upload");
    // G2c-2 step 6: exactly one of keep_assets and a completion token, never both, never an empty token.
    const assets = metadata.assets;
    let assetsFields: Record<string, unknown> = {};
    let assetsBinding: Array<{ type: string; name: string }> = [];
    if (assets) {
      if (assets.binding !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(assets.binding)) throw new Error("invalid_assets_upload");
      if (assets.keep === true) {
        if ("jwt" in assets) throw new Error("invalid_assets_upload");
        assetsFields = { keep_assets: true };
      } else {
        assetsFields = { assets: assetsMetadata(assets.jwt, assets.config) };
      }
      if (assets.binding && !config) assetsBinding = [{ type: "assets", name: assets.binding }];
      if (assets.binding && config && !config.bindings.some((b) => b.type === "assets" && b.name === assets.binding)) throw new Error("invalid_assets_upload");
    }
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({
      main_module: metadata.main_module,
      compatibility_date: metadata.compatibility_date,
      compatibility_flags: metadata.compatibility_flags,
      // G2c-2: a planned configuration sends its bindings and keeps only the secrets; G2b keeps every type
      // (and, for a Worker with static assets, sends its assets binding, which is not a kept type).
      ...(config
        ? { bindings: config.bindings, keep_bindings: [...config.keep_bindings], ...(config.limits ? { limits: config.limits } : {}), ...(config.placement ? { placement: config.placement } : {}) }
        : services || plain
          // 2026-11-16: the declared service bindings and/or every plain-text value sent, every other platform type kept.
          ? {
            bindings: [...assetsBinding, ...(services ?? []), ...(plain ?? []).map((b) => ({ type: "plain_text", name: b.name, text: b.text }))],
            keep_bindings: KEEP_BINDINGS.filter((t) => !(services && t === "service") && !(plain && t === "plain_text")),
          }
          : { ...(assetsBinding.length ? { bindings: assetsBinding } : {}), keep_bindings: [...KEEP_BINDINGS] }),
      ...assetsFields,
      ...scriptFields,
      annotations: { "workers/tag": metadata.tag, "workers/message": metadata.message.slice(0, 100) },
    })], { type: "application/json" }));
    form.append(moduleName, new Blob([moduleText], { type: "application/javascript+module" }), moduleName);
    // G2c-1: each extra module is its own part, named as the main module imports it ("./<name>" from the root).
    for (const m of extra) form.append(m.name, new Blob([m.data as BlobPart], { type: m.type }), m.name);
    return form;
  }

  /**
   * The bindings of one version: sorted `type:name` strings, and a digest of every binding's full record as the
   * API returns it (secret values are never returned, so for a secret this covers its type and name). Two
   * versions bind the same resources only when both are equal. Unreadable or empty fails closed.
   */
  async versionBindingSet(script: string, versionId: string): Promise<{ names: string[]; digest: string; records: Array<{ type: string; name: string; [field: string]: unknown }> }> {
    const r = await this.version(script, versionId) as VersionRecord & { bindings?: unknown };
    const list = Array.isArray(r?.resources?.bindings) ? r.resources!.bindings as unknown[] : Array.isArray(r?.bindings) ? r.bindings as unknown[] : null;
    return bindingSetOf(list);
  }

  /**
   * 2026-11-16: the names of every script of the account (`GET /accounts/{a}/workers/scripts`, the list scriptRoutes
   * reads), to check that a service binding about to be restored points at a Worker that exists. Throws when the list
   * cannot be read.
   */
  async scriptIds(): Promise<string[]> {
    const r = await this.call<unknown>("");
    if (!Array.isArray(r)) throw new Error("script_list_unreadable");
    const ids = r.map((x) => (x as { id?: unknown })?.id);
    if (!ids.every((id): id is string => typeof id === "string")) throw new Error("script_list_unreadable");
    return ids;
  }

  /**
   * ADR-0012 G2c-2: one version's full record as the API returns it: the raw `resources.bindings` (secrets by
   * type and name only) and `resources.script_runtime` (compatibility, limits). Unreadable fails closed.
   */
  async version(script: string, versionId: string): Promise<VersionRecord> {
    if (!UUID.test(versionId)) throw new Error("invalid_version_id");
    const r = await this.call<VersionRecord>(`${script}/versions/${versionId}`);
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("version_unreadable");
    return r;
  }

  /**
   * ADR-0012 G2c-2: a script-level setting a version upload cannot carry: `PUT schedules` (the cron triggers, a
   * JSON array of `{ cron }`) or `PATCH script-settings` (`{ observability }`). Returns the API's `result`.
   */
  async scriptSetting(script: string, step: { method: "PUT"; path: "schedules"; body: Array<{ cron: string }> } | { method: "PATCH"; path: "script-settings"; body: Record<string, unknown> }): Promise<unknown> {
    if (!(step.method === "PUT" && step.path === "schedules") && !(step.method === "PATCH" && step.path === "script-settings")) throw new Error("invalid_script_setting");
    return this.call<unknown>(`${script}/${step.path}`, { method: step.method, body: JSON.stringify(step.body) });
  }

  /**
   * ADR-0012 G2c-2 step 6: the routes Cloudflare associates with one script, read from the account's script list
   * (`GET /accounts/{a}/workers/scripts`, "List Worker Scripts", which Workers Scripts Read or Edit may call; each
   * item has `routes: [{ id, pattern, script }]`, documented as nullable). The zone routes API (`GET
   * /zones/{zone}/workers/routes`) needs the zone permission Workers Routes Read, which CF_DEPLOY_TOKEN does not
   * hold. Returns null when the list does not report the script's routes; throws when it cannot be read.
   */
  async scriptRoutes(script: string): Promise<Array<{ pattern: string; script: string | null }> | null> {
    if (!/^[a-z0-9-]{1,63}$/.test(script)) throw new Error("invalid_script_name");
    const r = await this.call<unknown>("");
    if (!Array.isArray(r)) throw new Error("script_list_unreadable");
    const items = r.filter((x) => (x as { id?: unknown })?.id === script) as Array<{ routes?: unknown }>;
    if (items.length !== 1) return null;
    const routes = items[0].routes;
    if (!Array.isArray(routes)) return null;
    const out: Array<{ pattern: string; script: string | null }> = [];
    for (const x of routes as Array<{ pattern?: unknown; script?: unknown }>) {
      if (typeof x?.pattern !== "string") return null;
      if (x.script !== undefined && x.script !== null && typeof x.script !== "string") return null;
      out.push({ pattern: x.pattern, script: typeof x.script === "string" ? x.script : null });
    }
    return out;
  }

  /**
   * ADR-0012 G2c-2 step 6: the id of the script's latest uploaded version, the one `keep_assets` and
   * `keep_bindings` copy from. Cloudflare's List Versions: "The first version in the list is the latest version."
   */
  async latestVersionId(script: string): Promise<string> {
    const r = await this.call<{ items?: Array<{ id?: unknown }> }>(`${script}/versions?per_page=1`);
    const id = r?.items?.[0]?.id;
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("versions_unreadable");
    return id;
  }

  /** ADR-0012 G2c-2 step 6: the static-assets upload client, with the same token, account and fetcher. */
  assetsUploader(): AssetsUploader {
    return new AssetsUploader(this.token, this.account, this.fetcher);
  }

  /** The bindings of one version as sorted `type:name` strings. */
  async versionBindings(script: string, versionId: string): Promise<string[]> {
    return (await this.versionBindingSet(script, versionId)).names;
  }

  async deploy(script: string, versions: DeploymentVersions, message: string): Promise<void> {
    await this.call(`${script}/deployments`, {
      method: "POST",
      body: JSON.stringify({ strategy: "percentage", versions, annotations: { "workers/message": message.slice(0, 100) } }),
    });
  }
}

export const sameDeployment = (a: DeploymentVersions, b: DeploymentVersions) => JSON.stringify(a) === JSON.stringify(b);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RollbackRun {
  ok: boolean;
  version_id?: string;
  reason?: string;
  restored?: boolean;
  /** Steps that completed, for the audit trail. */
  steps: string[];
}

/** Execute one queued rollback. Never throws; the caller records the outcome. */
export async function executeRollback(
  cf: CloudflareWorkers, env: Required<Pick<NativeRollbackEnv, "DRIFT" | "REGISTRY">>,
  requestId: string, script: string, tag: string, opts: { delayMs?: number } = {},
): Promise<RollbackRun> {
  const steps: string[] = [];
  let captured: DeploymentVersions | null = null;
  try {
    captured = await cf.active(script);
    steps.push("captured");
    const versionId = await cf.versionForTag(script, tag);
    if (!versionId) return { ok: false, reason: "no_version_with_tag", steps };
    const target: DeploymentVersions = [{ version_id: versionId, percentage: 100 }];
    if (!sameDeployment(captured, target)) {
      await cf.deploy(script, target, `rollback to ${tag}, ${requestId}`);
      steps.push("deployed");
    } else {
      steps.push("already_active");
    }
    let live = false;
    for (let i = 0; i < VERIFY_ATTEMPTS && !live; i++) {
      if (i > 0) await sleep(opts.delayMs ?? VERIFY_DELAY_MS);
      const p = await env.DRIFT.probeService(script).catch(() => null);
      live = Boolean(p?.healthy && p.version_tag === tag);
    }
    if (!live) throw new Error("not_live_at_tag");
    steps.push("verified");
    await env.REGISTRY.recordRollback(requestId);
    steps.push("desired_recorded");
    return { ok: true, version_id: versionId, steps };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    let restored = false;
    if (captured && steps.includes("deployed")) {
      try {
        const now = await cf.active(script);
        if (!sameDeployment(now, captured)) await cf.deploy(script, captured, `rollback ${requestId} failed; restoring`);
        restored = sameDeployment(await cf.active(script), captured);
      } catch { restored = false; }
    }
    return { ok: false, reason, restored, steps };
  }
}
