interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}
export interface Env {
  SERVICE_NAME: string;
  SERVICE_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  GH_ACTIONS_TOKEN: string;
  ORCHESTRATOR_SHARED_SECRET: string;
  DEPLOYMENT_LOCK: DurableObjectNamespaceLike;
}

const REPOSITORY = "cryptophys-adm/cryptophys-cloud-platform";
const WORKFLOW = "validate.yml";
const API = "https://api.github.com";
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers });

async function authorized(request: Request, secret: string): Promise<boolean> {
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret || !supplied.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(supplied.slice(7));
  const b = new TextEncoder().encode(secret);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API + path, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "cryptophys-deployment-orchestrator",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

type CommitStatus = { state?: string; total_count?: number };
type CheckRun = { name: string; status: string; conclusion: string | null };
type CheckSuite = { status: string; conclusion: string | null };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && ["/health", "/healthz"].includes(url.pathname)) {
      return json({
        status: "ok",
        service: env.SERVICE_NAME,
        environment: env.SERVICE_ENVIRONMENT,
        contract_version: env.API_CONTRACT_VERSION
      });
    }

    if (request.method === "GET" && ["/ready", "/readyz"].includes(url.pathname)) {
      const ready = Boolean(
        env.SERVICE_ENVIRONMENT === "staging" &&
        env.GH_ACTIONS_TOKEN &&
        env.ORCHESTRATOR_SHARED_SECRET &&
        env.DEPLOYMENT_LOCK
      );
      return json({
        status: ready ? "ready" : "not_configured",
        service: env.SERVICE_NAME,
        staging_validation_enabled: ready,
        production_dispatch_enabled: false
      }, ready ? 200 : 503);
    }

    if (url.pathname !== "/v1/deployments") return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (env.SERVICE_ENVIRONMENT !== "staging") {
      return json({ error: "staging_only", production_dispatch_enabled: false }, 503);
    }
    if (!(await authorized(request, env.ORCHESTRATOR_SHARED_SECRET))) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK) {
      return json({ error: "not_configured", operational: false }, 503);
    }

    let body: { commit_sha?: unknown; confirm_staging?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const sha = typeof body.commit_sha === "string" ? body.commit_sha : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: "invalid_commit_sha" }, 400);
    if (body.confirm_staging !== "STAGING_TEST") {
      return json({ error: "staging_confirmation_required" }, 400);
    }

    const refResponse = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/git/ref/heads/main");
    if (!refResponse.ok) {
      return json({ error: "github_ref_lookup_failed", status: refResponse.status }, 502);
    }
    const refData = await refResponse.json() as { object?: { sha?: string } };
    if (refData.object?.sha !== sha) {
      return json({ error: "commit_not_current_main", expected_sha: refData.object?.sha ?? null }, 409);
    }

    const [statusResponse, checkRunsResponse, checkSuitesResponse] = await Promise.all([
      gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/commits/" + sha + "/status"),
      gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/commits/" + sha + "/check-runs?per_page=100"),
      gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/commits/" + sha + "/check-suites?per_page=100")
    ]);
    if (!statusResponse.ok || !checkRunsResponse.ok || !checkSuitesResponse.ok) {
      return json({ error: "github_ci_lookup_failed" }, 502);
    }

    const statusData = await statusResponse.json() as CommitStatus;
    const checksData = await checkRunsResponse.json() as { total_count?: number; check_runs?: CheckRun[] };
    const suitesData = await checkSuitesResponse.json() as { total_count?: number; check_suites?: CheckSuite[] };
    const runs = checksData.check_runs ?? [];
    const suites = suitesData.check_suites ?? [];

    const statusBlocked = (statusData.total_count ?? 0) > 0 && statusData.state !== "success";
    const runsBlocked =
      runs.length === 0 ||
      (checksData.total_count ?? 0) > runs.length ||
      runs.some(run => run.status !== "completed" || run.conclusion !== "success");
    const suitesBlocked =
      suites.length === 0 ||
      (suitesData.total_count ?? 0) > suites.length ||
      suites.some(suite => suite.status !== "completed" || suite.conclusion !== "success");

    if (statusBlocked || runsBlocked || suitesBlocked) {
      return json({
        error: "ci_not_green",
        commit_status: statusData.state ?? "unknown",
        status_count: statusData.total_count ?? 0,
        checks_reported: runs.length,
        checks_total: checksData.total_count ?? 0,
        checks: runs.map(({ name, status, conclusion }) => ({ name, status, conclusion })),
        suites_reported: suites.length,
        suites_total: suitesData.total_count ?? 0,
        suites: suites.map(({ status, conclusion }) => ({ status, conclusion }))
      }, 409);
    }

    const lockId = env.DEPLOYMENT_LOCK.idFromName("platform-api-staging-validation:" + sha);
    const lockResponse = await env.DEPLOYMENT_LOCK.get(lockId).fetch("https://lock.internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha })
    });
    const lock = await lockResponse.json() as { claimed?: boolean };
    if (!lockResponse.ok || !lock.claimed) {
      return json({ error: "duplicate_staging_validation_request", commit_sha: sha }, 409);
    }

    // This workflow only type-checks and dry-runs; it never deploys a Worker.
    const dispatch = await gh(
      env.GH_ACTIONS_TOKEN,
      "/repos/" + REPOSITORY + "/actions/workflows/" + WORKFLOW + "/dispatches",
      { method: "POST", body: JSON.stringify({ ref: "main" }) }
    );
    if (dispatch.status !== 204) {
      return json({
        error: "staging_validation_dispatch_failed",
        status: dispatch.status,
        commit_sha: sha,
        manual_reconciliation_required: true
      }, 502);
    }

    return json({
      status: "staging_validation_dispatch_accepted",
      repository: REPOSITORY,
      workflow: WORKFLOW,
      ref: "main",
      requested_commit_sha: sha,
      production_deployment_triggered: false
    }, 202);
  }
};

export class DeploymentLock {
  constructor(private state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/claim") {
      return json({ error: "not_found" }, 404);
    }
    let body: { sha?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const sha = typeof body.sha === "string" ? body.sha : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: "invalid_commit_sha" }, 400);

    return this.state.blockConcurrencyWhile(async () => {
      const key = "claimed:" + sha;
      if (await this.state.storage.get(key)) return json({ claimed: false }, 409);
      await this.state.storage.put(key, { sha, claimed_at: new Date().toISOString() });
      return json({ claimed: true }, 201);
    });
  }
}
