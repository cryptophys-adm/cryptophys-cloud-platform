interface Env {
  GITHUB_TOKEN: string;
  CONNECTOR_ACCESS_TOKEN: string;
}

const OWNER = "cryptophys-adm";
const REPO = "cryptophys-cloud-platform";
const WORKFLOW = "deploy-platform-api.yml";
const API = "https://api.github.com";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function rpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, 400);
}

async function github(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API + path, {
    ...init,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

const TOOLS = [
  {
    name: "dispatch_production_deployment",
    description: "Dispatch the production Deploy Platform API workflow on main. This is consequential; call only when the user explicitly requested deployment. Uses the required confirm_production=DEPLOY input.",
    inputSchema: { type: "object", properties: { confirm: { type: "string", enum: ["DEPLOY"], description: "Must be DEPLOY to confirm production deployment." } }, required: ["confirm"], additionalProperties: false },
  },
  {
    name: "get_deployment_status",
    description: "List the latest runs of the Deploy Platform API workflow on main.",
    inputSchema: { type: "object", properties: { per_page: { type: "integer", minimum: 1, maximum: 10 } }, additionalProperties: false },
  },
  {
    name: "get_deployment_jobs",
    description: "Get jobs and step status for a workflow run ID.",
    inputSchema: { type: "object", properties: { run_id: { type: "integer" } }, required: ["run_id"], additionalProperties: false },
  },
];

async function callTool(env: Env, name: string, args: Record<string, unknown>) {
  if (name === "dispatch_production_deployment") {
    if (args.confirm !== "DEPLOY") throw new Error("Production dispatch requires confirm=DEPLOY.");
    const r = await github(env, `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs: { confirm_production: "DEPLOY" } }),
    });
    if (r.status !== 204) throw new Error(`GitHub dispatch failed: HTTP ${r.status} ${(await r.text()).slice(0, 500)}`);
    return { accepted: true, workflow: WORKFLOW, ref: "main", next_step: "Call get_deployment_status to verify that a run started." };
  }
  if (name === "get_deployment_status") {
    const p = Number(args.per_page ?? 5);
    const r = await github(env, `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=${Math.min(10, Math.max(1, p))}`);
    const body = await r.json() as any;
    if (!r.ok) throw new Error(`GitHub run query failed: HTTP ${r.status} ${JSON.stringify(body).slice(0, 500)}`);
    return { total_count: body.total_count, workflow_runs: (body.workflow_runs ?? []).map((x: any) => ({ id: x.id, name: x.name, status: x.status, conclusion: x.conclusion, branch: x.head_branch, sha: x.head_sha, url: x.html_url, created_at: x.created_at, updated_at: x.updated_at })) };
  }
  if (name === "get_deployment_jobs") {
    const id = Number(args.run_id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("run_id must be a positive integer.");
    const r = await github(env, `/repos/${OWNER}/${REPO}/actions/runs/${id}/jobs`);
    const body = await r.json() as any;
    if (!r.ok) throw new Error(`GitHub jobs query failed: HTTP ${r.status} ${JSON.stringify(body).slice(0, 500)}`);
    return { total_count: body.total_count, jobs: (body.jobs ?? []).map((j: any) => ({ name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url, steps: (j.steps ?? []).map((s: any) => ({ name: s.name, status: s.status, conclusion: s.conclusion })) })) };
  }
  throw new Error("Unknown tool.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", service: "cryptophys-github-actions-mcp" });
    if (request.method !== "POST" || url.pathname !== "/mcp") return json({ error: "Not found" }, 404);
    if (!env.CONNECTOR_ACCESS_TOKEN || !env.GITHUB_TOKEN) return json({ error: "Connector secrets are not configured." }, 503);
    if (request.headers.get("authorization") !== `Bearer ${env.CONNECTOR_ACCESS_TOKEN}`) return json({ error: "Unauthorized" }, 401);
    let body: any;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON-RPC body" }, 400); }
    const id = body.id ?? null;
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(id, -32600, "Invalid JSON-RPC request.");
    if (body.method === "initialize") return rpcResult(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cryptophys-github-actions-mcp", version: "1.0.0" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "ping") return rpcResult(id, {});
    if (body.method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (body.method === "tools/call") {
      const name = body.params?.name;
      try {
        const result = await callTool(env, name, body.params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: e instanceof Error ? e.message : "Unknown error" }], isError: true });
      }
    }
    if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    return rpcError(id, -32601, "Method not found.");
  },
};
