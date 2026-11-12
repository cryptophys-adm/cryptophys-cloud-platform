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
 * uploaded by the Orchestrator keeps all of them from the script's previous version: it never sends a binding.
 */
export const KEEP_BINDINGS = [
  "plain_text", "secret_text", "secret_key", "d1", "service", "durable_object_namespace", "r2_bucket", "kv_namespace", "ai",
  "vectorize", "workflow", "artifacts", "worker_loader", "version_metadata", "secrets_store_secret", "send_email",
  "analytics_engine", "queue", "browser",
] as const;

export interface VersionMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  /** The 12-character commit tag the Drift Detector reads back from the version metadata binding. */
  tag: string;
  message: string;
}

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

export class CloudflareWorkers {
  private readonly token: string;
  private readonly account: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, account: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.account = account;
    this.fetcher = fetcher;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    // A multipart body (a version upload) sets its own content type with the boundary.
    const type: Record<string, string> = init.body instanceof FormData ? {} : { "content-type": "application/json" };
    const res = await this.fetcher(`${API}/accounts/${this.account}/workers/scripts/${path}`, {
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
  async uploadVersion(script: string, moduleName: string, moduleText: string, metadata: VersionMetadata): Promise<string> {
    if (!/^[a-z0-9-]{1,63}\.mjs$/.test(moduleName) || metadata.main_module !== moduleName) throw new Error("invalid_module_name");
    if (!/^[0-9a-f]{12}$/.test(metadata.tag)) throw new Error("invalid_version_tag");
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({
      main_module: metadata.main_module,
      compatibility_date: metadata.compatibility_date,
      compatibility_flags: metadata.compatibility_flags,
      keep_bindings: [...KEEP_BINDINGS],
      annotations: { "workers/tag": metadata.tag, "workers/message": metadata.message.slice(0, 100) },
    })], { type: "application/json" }));
    form.append(moduleName, new Blob([moduleText], { type: "application/javascript+module" }), moduleName);
    const r = await this.call<{ id?: string }>(`${script}/versions`, { method: "POST", body: form });
    if (typeof r?.id !== "string" || !UUID.test(r.id)) throw new Error("version_upload_unreadable");
    return r.id;
  }

  /**
   * The bindings of one version: sorted `type:name` strings, and a digest of every binding's full record as the
   * API returns it (secret values are never returned, so for a secret this covers its type and name). Two
   * versions bind the same resources only when both are equal. Unreadable or empty fails closed.
   */
  async versionBindingSet(script: string, versionId: string): Promise<{ names: string[]; digest: string }> {
    if (!UUID.test(versionId)) throw new Error("invalid_version_id");
    const r = await this.call<{ resources?: { bindings?: unknown }; bindings?: unknown }>(`${script}/versions/${versionId}`);
    const list = Array.isArray(r?.resources?.bindings) ? r.resources!.bindings as unknown[] : Array.isArray(r?.bindings) ? r.bindings as unknown[] : null;
    if (!list) throw new Error("version_bindings_unreadable");
    const records = list.map((b) => b as { type?: unknown; name?: unknown });
    if (!records.length || !records.every((b) => typeof b?.type === "string" && typeof b?.name === "string")) throw new Error("version_bindings_unreadable");
    const names = records.map((b) => `${b.type}:${b.name}`).sort();
    const canonical = records.map((b) => canonicalJson(b)).sort().join("\n");
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return { names, digest: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("") };
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
