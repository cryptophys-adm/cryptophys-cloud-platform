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
import { accessGate, actorOf, authenticate, identityAllowed, listConfigured, requireApprover, requireOperator } from "../../control-plane-shared/src/access.ts";
import { CAPABILITIES, getActivePrincipalByIdentity, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import {
  addAgentPrincipal, agentStatus, listActions, listAgents, revokeAgentPrincipal,
  setAgentStatus, setAgentsEnabled, wakeAgent, type KernelHttpEnv,
} from "./kernel.ts";
import { handleMcp } from "./mcp.ts";
import { KERNEL_HOST, alertVaultOf } from "./kernel.ts";
import { AlertChannelError, createChannel, deleteChannel, listChannels, testChannel, updateChannel } from "./alert-channels.ts";
import { REPORT_ID_RE, ReportAcknowledgeError, acknowledgeReport, listReports } from "./reports.ts";
import { AUDITOR_ID } from "./auditor.ts";
import { SIGNAL_ANALYST_ID } from "./signal-analyst.ts";
import { pruneSyscallConsumptions } from "./retention.ts";
import { AGENT_ID } from "./supervisor.ts";
import { observe } from "./syscall.ts";
import { OwnerDecisionError, agreementReport, getProposal, listProposals, ownerDecide, setConsensusMode } from "./consensus.ts";
import { KnowledgeDecisionError, decideKnowledge, getKnowledge, listKnowledge } from "./knowledge.ts";
import { OWNER_CHANNEL_TOPICS, OWNER_PANEL_URL, TOPICS, channelOf, collectNotices, emailConfigured, reconcileNotices } from "./owner-notices.ts";
import { ownerInbox } from "./owner-inbox.ts";
import { metabolismView } from "./metabolism-view.ts";
import { meshView } from "./mesh-view.ts";

export type Env = KernelHttpEnv;
const SERVICE = "cryptophys-ai-kernel";

async function isApprover(request: Request, env: Env): Promise<boolean> {
  // Owners and approver accounts (2026-11-07); requireApprover refuses service tokens.
  const authorization = await requireApprover(request, env);
  return authorization.ok;
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
          policy_binding: Boolean(env.POLICY), recovery_binding: Boolean(env.RECOVERY),
          supervisor_binding: Boolean(env.SUPERVISOR),
          signal_analyst_binding: Boolean(env.SIGNAL_ANALYST),
          auditor_binding: Boolean(env.AUDITOR),
          memory_binding: Boolean(env.MEMORY),
        });
      }
      if (path === "/") {
        return serviceMetadata(env, "AI Worker OS kernel: agent processes, policy-gated syscalls, MCP front door", [
          "POST /mcp (MCP, JSON-RPC)", "GET /v1/kernel", "POST /v1/kernel/agents-enabled", "GET /v1/status", "GET /v1/notices", "GET /v1/owner/inbox", "GET /v1/metabolism", "GET /v1/mesh", "GET /v1/consensus", "GET /v1/consensus/report?days=7", "POST /v1/consensus/mode (raise: APPROVER_IDENTITIES person; lower: operators)", "GET /v1/consensus/{id}", "POST /v1/consensus/{id}/approve|reject (APPROVER_IDENTITIES)", "GET /v1/reports?agent_id=&kind=&limit=",
          "POST /v1/reports/{id}/acknowledge (APPROVER_IDENTITIES person; critical reports only)",
          "GET /v1/alerts", "POST /v1/alerts | /v1/alerts/{id} | /v1/alerts/{id}/test, DELETE /v1/alerts/{id} (APPROVER_IDENTITIES)",
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
      let agentSessionPrincipal = principal;
      if (principal) {
        const agent = await getAgent(env.DB, principal.agent_id);
        if (agent && agent.host_worker === KERNEL_HOST) {
          console.log(JSON.stringify({ service: SERVICE, event: "kernel_agent_principal_ignored", access_identity: callerActor, agent_id: principal.agent_id }));
          agentSessionPrincipal = null;
        }
      }
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
      if (agentSessionPrincipal) {
        return await handleMcp(request, env, callerActor, false, {
          agentId: agentSessionPrincipal.agent_id,
          accessIdentity: agentSessionPrincipal.access_identity,
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
      if (path === "/v1/notices" && request.method === "GET") {
        // Each notice carries its channel: "owner" (emailed and sent to Telegram) or "console" (owner 2026-11-13).
        return json({ notices: await collectNotices(env.DB), email: emailConfigured(env) ? "configured" : "not_configured", owner_channel_topics: OWNER_CHANNEL_TOPICS });
      }
      // Owner 2026-11-13: the Console's Owner page, the one place a person is needed (approvals and open critical
      // reports). Read-only and open to operators; every action on it goes to its own approver-only route.
      if (path === "/v1/owner/inbox" && request.method === "GET") return json(await ownerInbox(env.DB));
      if (path === "/v1/metabolism" && request.method === "GET") return json(await metabolismView(env));
      if (path === "/v1/mesh" && request.method === "GET") return json(await meshView(env));
      if (path === "/v1/consensus" && request.method === "GET") return json(await listProposals(env, limitParam(url)));
      if (path === "/v1/consensus/mode" && request.method === "POST") {
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        try {
          return json(await setConsensusMode(env, body.value.mode, operator.actor, operator.identity.type, await isApprover(request, env), body.value.confirm, body.value.reason));
        } catch (err) {
          if (err instanceof OwnerDecisionError) return errorResponse(err.status, err.code, err.message);
          throw err;
        }
      }
      if (path === "/v1/consensus/report" && request.method === "GET") return json(await agreementReport(env, Number(url.searchParams.get("days") ?? "7")));
      // TP-028: learned-knowledge proposals from Aether (tier 1 drafts). Listing is open to operators;
      // a decision needs an approver, a person, never the proposer.
      if (path === "/v1/knowledge" && request.method === "GET") return json(await listKnowledge(env.DB, { limit: limitParam(url), status: url.searchParams.get("status") }));
      const knowledgeDecision = /^\/v1\/knowledge\/(knw_[0-9a-f-]{36})\/(approve|reject)$/.exec(path);
      if (knowledgeDecision) {
        if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
        if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "a knowledge review needs an approver");
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        try {
          return json(await decideKnowledge(env.DB, knowledgeDecision[1], knowledgeDecision[2] === "approve" ? "approve" : "reject", operator.actor, body.value.reason));
        } catch (err) {
          if (err instanceof KnowledgeDecisionError) return errorResponse(err.status, err.code, err.message);
          throw err;
        }
      }
      if (path.startsWith("/v1/knowledge/") && request.method === "GET") {
        const found = await getKnowledge(env.DB, path.slice("/v1/knowledge/".length));
        return found ? json(found) : errorResponse(404, "not_found", "unknown knowledge proposal");
      }
      const ownerMatch = /^\/v1\/consensus\/(cns_[0-9a-f-]{36})\/(approve|reject)$/.exec(path);
      if (ownerMatch) {
        // ADR-0009 phase 4: one owner click on a critical proposal. Approvers only; a person, never a token.
        if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
        if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "an owner decision needs an approver");
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        try {
          return json(await ownerDecide(env, ownerMatch[1], ownerMatch[2] === "approve" ? "approve" : "reject", operator.actor, body.value.reason));
        } catch (err) {
          if (err instanceof OwnerDecisionError) return errorResponse(err.status, err.code, err.message);
          throw err;
        }
      }
      if (path.startsWith("/v1/consensus/") && request.method === "GET") {
        const id = path.slice("/v1/consensus/".length);
        if (!/^cns_[0-9a-f-]{36}$/.test(id)) return errorResponse(404, "not_found");
        const found = await getProposal(env, id);
        return found ? json(found) : errorResponse(404, "not_found");
      }
      // Owner 2026-11-13 (Alerts page): the owner's Telegram alert channels. Operators read; approvers change.
      if (path === "/v1/alerts" || path.startsWith("/v1/alerts/")) {
        const alertEnv = { DB: env.DB, ALERT_VAULT: alertVaultOf(env), OWNER_TELEGRAM: env.OWNER_TELEGRAM };
        const m = /^\/v1\/alerts(?:\/([^/]+))?(\/test)?$/.exec(path);
        if (!m) return errorResponse(404, "not_found");
        const [, id, test] = m;
        try {
          if (!id && request.method === "GET") {
            const channels = await listChannels(env.DB);
            return json({
              channels: channels ?? [], available: channels !== null, vault: Boolean(alertEnv.ALERT_VAULT),
              topics: TOPICS.map((t) => ({ topic: t, owner_channel: channelOf(t) === "owner" })),
              email: emailConfigured(env) ? "configured" : "off",
            });
          }
          if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "changing alert channels needs an approver");
          if (!id && request.method === "POST") {
            const body = await readJsonObject(request);
            if (!body.ok) return body.response;
            return json({ channel: await createChannel(alertEnv, operator.actor, body.value, TOPICS) }, 201);
          }
          if (id && test && request.method === "POST") return json(await testChannel(alertEnv, operator.actor, id, OWNER_PANEL_URL));
          if (id && !test && request.method === "POST") {
            const body = await readJsonObject(request);
            if (!body.ok) return body.response;
            return json({ channel: await updateChannel(alertEnv, operator.actor, id, body.value, TOPICS) });
          }
          if (id && !test && request.method === "DELETE") return json(await deleteChannel(alertEnv, operator.actor, id));
          return errorResponse(405, "method_not_allowed");
        } catch (err) {
          if (err instanceof AlertChannelError) return errorResponse(err.status, err.code, err.message);
          throw err;
        }
      }
      const ackMatch = /^\/v1\/reports\/([^/]+)\/acknowledge$/.exec(path);
      if (ackMatch) {
        // ADR-0009 amendment 2026-11-13: an approver, a person, acknowledges a critical report as handled, so it
        // no longer counts as open for the consensus baseline. Operators and service tokens are refused.
        if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
        if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "acknowledging a critical report needs an approver");
        if (!REPORT_ID_RE.test(ackMatch[1])) return errorResponse(404, "not_found", "unknown report");
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        try {
          return json(await acknowledgeReport(env.DB, ackMatch[1], operator.actor, body.value.confirm, body.value.reason));
        } catch (err) {
          if (err instanceof ReportAcknowledgeError) return errorResponse(err.status, err.code, err.message);
          throw err;
        }
      }
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
    // ADR-0012 phase 2: owner notices (replaces the owner-attention and drift-alert GitHub workflows).
    if (minute === 22 || minute === 52) {
      ctx.waitUntil(reconcileNotices({ ...env, ALERT_VAULT: alertVaultOf(env) }, event.scheduledTime).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "owner_notices_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
    const d = new Date(event.scheduledTime);
    if (d.getUTCHours() === 3 && minute === 7) {
      ctx.waitUntil(pruneSyscallConsumptions(env as any, event.scheduledTime).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "syscall_consumption_retention_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
  },
};
