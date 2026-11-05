/**
 * cryptophys-ai-kernel: the AI Worker OS kernel (ADR-0007).
 *
 *  - Agents are Durable Object processes (SupervisorAgent, SignalAnalystAgent, AuditorAgent)
 *    woken by the cron and by operators, plus external agents bound via agent_principals (TP-009).
 *  - Every agent action is a syscall: tier 0 checked here, tier >= 1 decided by the Policy
 *    Engine, dispatched over RPC to the owning Worker, recorded and audited.
 *  - Operators reach the OS through this HTTP API and the MCP endpoint (/mcp), both behind
 *    Cloudflare Access. External agent principals may use /mcp only (at tier <= 1).
 *    Suspending agents is open to every operator; resuming them, turning the global switch
 *    back on, or registering/revoking external principals needs an identity in APPROVER_IDENTITIES.
 */
import type { ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";
import { errorResponse, healthResponse, json, limitParam, newId, readJsonObject, serviceMetadata } from "../../control-plane-shared/src/http.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, actorOf, authenticate, authorize, identityAllowed, listConfigured, requireOperator } from "../../control-plane-shared/src/access.ts";
import { CAPABILITIES, getActivePrincipalByIdentity } from "../../control-plane-shared/src/capabilities.ts";
import {
  addAgentPrincipal, agentStatus, listActions, listAgents, revokeAgentPrincipal,
  setAgentStatus, setAgentsEnabled, wakeAgent, type KernelHttpEnv,
} from "./kernel.ts";
import { handleMcp } from "./mcp.ts";
import { listReports } from "./reports.ts";
import { AUDITOR_ID } from "./auditor.ts";
import { SIGNAL_ANALYST_ID } from "./signal-analyst.ts";
import { AGENT_ID } from "./supervisor.ts";
import { observe } from "./syscall.ts";

export type Env = KernelHttpEnv;
const SERVICE = "cryptophys-ai-kernel";

async function isApprover(request: Request, env: Env): Promise<boolean> {
  return (await authorize(request, env, env.APPROVER_IDENTITIES, "APPROVER_IDENTITIES")).ok;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    const path = url.pathname;
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/health" || path === "/healthz") return healthResponse(env);
      if (path === "/ready" || path === "/readyz") {
        return readinessResponse(env, {
          approver_identities_configured: listConfigured(env.APPROVER_IDENTITIES),
          policy_binding: Boolean(env.POLICY), recovery_binding: Boolean(env.RECOVERY), signals_binding: Boolean(env.SIGNALS),
          supervisor_binding: Boolean(env.SUPERVISOR),
          signal_analyst_binding: Boolean(env.SIGNAL_ANALYST),
          auditor_binding: Boolean(env.AUDITOR),
          memory_binding: Boolean(env.MEMORY),
        });
      }
      if (path === "/") {
        return serviceMetadata(env, "AI Worker OS kernel: agent processes, policy-gated syscalls, MCP front door", [
          "POST /mcp (MCP, JSON-RPC)", "GET /v1/kernel", "POST /v1/kernel/agents-enabled", "GET /v1/status", "GET /v1/reports?agent_id=&kind=&limit=",
          "GET /v1/agents", "GET /v1/agents/{id}", "GET /v1/agents/{id}/actions", "POST /v1/agents/{id}/wake",
          "POST /v1/agents/{id}/suspend", "POST /v1/agents/{id}/resume (APPROVER_IDENTITIES)",
          "POST /v1/agents/{id}/principals (APPROVER_IDENTITIES)", "DELETE /v1/agents/{id}/principals/{access_identity} (APPROVER_IDENTITIES)",
        ]);
      }
    }
    if (path !== "/mcp" && !path.startsWith("/v1/")) return errorResponse(404, "not_found");

    if (path === "/mcp") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return auth.response;
      const callerActor = actorOf(auth.identity);
      const isOperator = listConfigured(env.OPERATOR_IDENTITIES) && identityAllowed(auth.identity, env.OPERATOR_IDENTITIES);
      const principal = await getActivePrincipalByIdentity(env.DB, callerActor);
      if (isOperator && principal) {
        console.warn(JSON.stringify({
          service: SERVICE,
          event: "principal_operator_overlap",
          access_identity: callerActor,
          agent_id: principal.agent_id,
          resolution: "operator",
        }));
      }
      if (isOperator) {
        // Operator and CI identities always receive operator tools. Agent identity is never
        // selected from a request header; external agents require an active registered principal.
        return await handleMcp(request, env, callerActor, await isApprover(request, env));
      }
      if (principal) {
        return await handleMcp(request, env, callerActor, false, {
          agentId: principal.agent_id,
          accessIdentity: principal.access_identity,
        });
      }
      const operator = await requireOperator(request, env);
      return operator.ok ? await handleMcp(request, env, operator.actor, await isApprover(request, env)) : operator.response;
    }

    const operator = await requireOperator(request, env);
    if (!operator.ok) return operator.response;
    try {
      if (path === "/v1/kernel" && request.method === "GET") return json({ ...(await listAgents(env)), capabilities: CAPABILITIES });
      if (path === "/v1/status" && request.method === "GET") return json(await observe(env));
      if (path === "/v1/reports" && request.method === "GET") {
        return json(await listReports(env.DB, {
          agent_id: url.searchParams.get("agent_id"),
          kind: url.searchParams.get("kind"),
          limit: limitParam(url),
        }));
      }
      if (path === "/v1/kernel/agents-enabled" && request.method === "POST") {
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        if (typeof body.value.enabled !== "boolean") return errorResponse(400, "invalid_request", "enabled must be a boolean");
        if (body.value.enabled && !(await isApprover(request, env))) return errorResponse(403, "approver_required", "turning agents back on needs an approver");
        return json(await setAgentsEnabled(env, body.value.enabled, operator.actor));
      }
      if (path === "/v1/agents" && request.method === "GET") return json(await listAgents(env));

      const principalMatch = /^\/v1\/agents\/([a-z0-9-]{2,40})\/principals(?:\/([^/]+))?$/.exec(path);
      if (principalMatch) {
        const [, agentId, encodedIdentity] = principalMatch;
        if (!encodedIdentity) {
          if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
          if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "registering an agent principal needs an approver");
          const body = await readJsonObject(request);
          if (!body.ok) return body.response;
          const res = await addAgentPrincipal(env, agentId, body.value.access_identity, operator.actor);
          return json(res.body, res.status);
        }
        if (request.method !== "DELETE") return errorResponse(405, "method_not_allowed");
        if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "revoking an agent principal needs an approver");
        let decodedIdentity: string;
        try {
          decodedIdentity = decodeURIComponent(encodedIdentity);
        } catch {
          return errorResponse(400, "invalid_request", "invalid access_identity encoding");
        }
        const res = await revokeAgentPrincipal(env, agentId, decodedIdentity, operator.actor);
        return json(res.body, res.status);
      }

      const m = /^\/v1\/agents\/([a-z0-9-]{2,40})(?:\/(actions|wake|suspend|resume))?$/.exec(path);
      if (!m) return errorResponse(404, "not_found");
      const [, agentId, verb] = m;
      if (!verb) {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
        const status = await agentStatus(env, agentId);
        return status ? json(status) : errorResponse(404, "not_found");
      }
      if (verb === "actions") return request.method === "GET" ? json(await listActions(env, agentId, limitParam(url))) : errorResponse(405, "method_not_allowed");
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
      if (verb === "wake") {
        if (agentId !== AGENT_ID && agentId !== SIGNAL_ANALYST_ID && agentId !== AUDITOR_ID) return errorResponse(404, "not_found");
        return json(await wakeAgent(env, agentId));
      }
      if (verb === "suspend") {
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        return json({ agent: await setAgentStatus(env, agentId, "suspended", operator.actor, String(body.value.reason ?? "")) });
      }
      if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "resuming an agent needs an approver");
      return json({ agent: await setAgentStatus(env, agentId, "enabled", operator.actor, "resumed") });
    } catch (err) {
      if ((err as Error)?.message === "agent not found") return errorResponse(404, "not_found");
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },

  async scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(env.SUPERVISOR.get(env.SUPERVISOR.idFromName(AGENT_ID)).cycle("scheduled").then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "supervisor_cycle_failed", message: String((err as Error)?.message ?? err) }));
    }));
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute === 22 && env.SIGNAL_ANALYST) {
      ctx.waitUntil(env.SIGNAL_ANALYST.get(env.SIGNAL_ANALYST.idFromName(SIGNAL_ANALYST_ID)).cycle("scheduled").then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "signal_analyst_cycle_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
    if (minute === 37 && env.AUDITOR) {
      ctx.waitUntil(env.AUDITOR.get(env.AUDITOR.idFromName(AUDITOR_ID)).cycle("scheduled").then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "auditor_cycle_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
  },
};
