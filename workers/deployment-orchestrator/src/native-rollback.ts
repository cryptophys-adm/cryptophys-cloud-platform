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
const VERIFY_ATTEMPTS = 12;
const VERIFY_DELAY_MS = 5000;

export interface DriftProbeBinding {
  probeService(serviceId: string): Promise<{ reachable: boolean; healthy: boolean; version_tag: string | null; error: string | null }>;
}
export interface RegistryRollbackBinding {
  recordRollback(requestId: string): Promise<{ desired_version: string }>;
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

type DeploymentVersions = { version_id: string; percentage: number }[];

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
    const res = await this.fetcher(`${API}/accounts/${this.account}/workers/scripts/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
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

  async deploy(script: string, versions: DeploymentVersions, message: string): Promise<void> {
    await this.call(`${script}/deployments`, {
      method: "POST",
      body: JSON.stringify({ strategy: "percentage", versions, annotations: { "workers/message": message.slice(0, 100) } }),
    });
  }
}

const sameDeployment = (a: DeploymentVersions, b: DeploymentVersions) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
