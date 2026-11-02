export interface Env { SERVICE_NAME: string; SERVICE_ENVIRONMENT: string; API_CONTRACT_VERSION: string; GH_ACTIONS_TOKEN: string; ORCHESTRATOR_SHARED_SECRET: string; DEPLOYMENT_LOCK: DurableObjectNamespace }
const REPOSITORY = "cryptophys-adm/cryptophys-cloud-platform";
const WORKFLOW = "deploy-platform-api.yml";
const API = "https://api.github.com";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers });
async function authorized(request: Request, secret: string): Promise<boolean> { const supplied = request.headers.get("authorization") ?? ""; if (!secret || !supplied.startsWith("Bearer ")) return false; const a = new TextEncoder().encode(supplied.slice(7)); const b = new TextEncoder().encode(secret); if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> { return fetch(API + path, { ...init, headers: { accept: "application/vnd.github+json", authorization: "Bearer " + token, "x-github-api-version": "2022-11-28", "user-agent": "cryptophys-deployment-orchestrator", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } }); }
export default { async fetch(request: Request, env: Env): Promise<Response> {
 const url = new URL(request.url);
 if (request.method === "GET" && ["/health", "/healthz"].includes(url.pathname)) return json({ status: "ok", service: env.SERVICE_NAME, environment: env.SERVICE_ENVIRONMENT, contract_version: env.API_CONTRACT_VERSION });
 if (request.method === "GET" && ["/ready", "/readyz"].includes(url.pathname)) { const ready = Boolean(env.GH_ACTIONS_TOKEN && env.ORCHESTRATOR_SHARED_SECRET && env.DEPLOYMENT_LOCK); return json({ status: ready ? "ready" : "not_configured", service: env.SERVICE_NAME, production_execution_enabled: ready }, ready ? 200 : 503); }
 if (url.pathname !== "/v1/deployments") return json({ error: "not_found" }, 404);
 if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
 if (!(await authorized(request, env.ORCHESTRATOR_SHARED_SECRET))) return json({ error: "unauthorized" }, 401);
 if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK) return json({ error: "not_configured", operational: false }, 503);
 let body: { commit_sha?: unknown; confirm_production?: unknown }; try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); }
 const sha = typeof body.commit_sha === "string" ? body.commit_sha : ""; if (!/^[0-9a-f]{40}$/i.test(sha)) return json({ error: "invalid_commit_sha" }, 400);
 if (body.confirm_production !== "DEPLOY") return json({ error: "production_confirmation_required" }, 400);
 const refResponse = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/git/ref/heads/main"); if (!refResponse.ok) return json({ error: "github_ref_lookup_failed", status: refResponse.status }, 502);
 const refData = await refResponse.json() as { object?: { sha?: string } }; if (refData.object?.sha !== sha) return json({ error: "commit_not_current_main", expected_sha: refData.object?.sha ?? null }, 409);
 const pair = await Promise.all([gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/commits/" + sha + "/status"), gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/commits/" + sha + "/check-runs?per_page=100")]);
 if (!pair[0].ok || !pair[1].ok) return json({ error: "github_ci_lookup_failed" }, 502);
 const statusData = await pair[0].json() as { state?: string }; const checksData = await pair[1].json() as { check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }; const runs = checksData.check_runs ?? [];
 if (statusData.state !== "success" || runs.length === 0 || runs.some(r => r.status !== "completed" || r.conclusion !== "success")) return json({ error: "ci_not_green", commit_status: statusData.state ?? "unknown", checks: runs.map(({ name, status, conclusion }) => ({ name, status, conclusion })) }, 409);
 const lockId = env.DEPLOYMENT_LOCK.idFromName("platform-api-production:" + sha); const lockResponse = await env.DEPLOYMENT_LOCK.get(lockId).fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
 const lock = await lockResponse.json() as { claimed?: boolean }; if (!lockResponse.ok || !lock.claimed) return json({ error: "duplicate_deployment_request", commit_sha: sha }, 409);
 const dispatch = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/workflows/" + WORKFLOW + "/dispatches", { method: "POST", body: JSON.stringify({ ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: sha } }) });
 if (dispatch.status !== 204) return json({ error: "workflow_dispatch_failed", status: dispatch.status, commit_sha: sha, manual_reconciliation_required: true }, 502);
 return json({ status: "dispatch_accepted", repository: REPOSITORY, workflow: WORKFLOW, ref: "main", validated_commit_sha: sha, confirmation: "DEPLOY", production_approval: "GitHub environment protection remains authoritative; approval may still be required before deployment." }, 202);
} };
export class DeploymentLock { constructor(private state: DurableObjectState) {} async fetch(request: Request): Promise<Response> { if (request.method !== "POST" || new URL(request.url).pathname !== "/claim") return json({ error: "not_found" }, 404); let body: { sha?: unknown }; try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); } const sha = typeof body.sha === "string" ? body.sha : ""; if (!/^[0-9a-f]{40}$/i.test(sha)) return json({ error: "invalid_commit_sha" }, 400); return this.state.blockConcurrencyWhile(async () => { const key = "claimed:" + sha; if (await this.state.storage.get(key)) return json({ claimed: false }, 409); await this.state.storage.put(key, { sha, claimed_at: new Date().toISOString() }); return json({ claimed: true }, 201); }); } }
