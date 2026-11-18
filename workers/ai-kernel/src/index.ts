/**
 * cryptophys-ai-kernel: the AI Worker OS kernel (ADR-0007).
 *
 *  - Agents are Durable Object processes (SupervisorAgent, SignalAnalystAgent, AuditorAgent, AdrStewardAgent)
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
import { accessGate, actorOf, authenticate, identityAllowed, isOwner, listConfigured, requireApprover, requireOperator } from "../../control-plane-shared/src/access.ts";
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
import { ADR_STEWARD_ID } from "./adr-steward.ts";
import { EVOLVER_ID } from "./evolver.ts";
import { SIGNAL_ANALYST_ID } from "./signal-analyst.ts";
import { pruneSyscallConsumptions } from "./retention.ts";
import { AGENT_ID } from "./supervisor.ts";
import { observe } from "./syscall.ts";
import { OwnerDecisionError, agreementReport, getProposal, listProposals, ownerDecide, setConsensusMode } from "./consensus.ts";
import { KnowledgeDecisionError, decideKnowledge, getKnowledge, listKnowledge } from "./knowledge.ts";
import { OWNER_CHANNEL_TOPICS, OWNER_PANEL_URL, TOPICS, channelOf, collectNotices, emailConfigured, reconcileNotices, reconcileOwnerAttentionNow } from "./owner-notices.ts";
import { ownerInbox } from "./owner-inbox.ts";
import { CHANNEL_TOPICS, RELAY_TOPICS, relayReports } from "./report-relay.ts";
import { metabolismView } from "./metabolism-view.ts";
import { meshView } from "./mesh-view.ts";
import { visionView } from "./vision-view.ts";
import { ADR_CACHE_CONTROL, adrDetailView, adrListView, validAdrId } from "./adr-view.ts";
import { intakeEvolutionIntents } from "./evolution-intake.ts";
import { EvolverModeError, evolutionView, setEvolverMode } from "./evolution-view.ts";
import { listConversations } from "./conversation.ts";
import { listCouncils } from "./council.ts";
import { proposeCouncils } from "./council-proposals.ts";
import { storeMissingTranscripts } from "./council-archive.ts";
import { publishHub } from "./hub.ts";
import { ProposalError, decideProposal, expireDrafts, listTypedProposals, readTypedProposal } from "./proposals.ts";
import { DirectiveError, draftFromDirective } from "./directives.ts";

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
          "POST /mcp (MCP, JSON-RPC)", "GET /v1/kernel", "POST /v1/kernel/agents-enabled", "GET /v1/status", "GET /v1/notices", "GET /v1/owner/inbox", "GET /v1/conversations", "GET /v1/conversations/{id}", "POST /v1/conversations/{id}/turns", "POST /v1/conversations/{id}/turns/{n}/rating", "GET /v1/hub (WebSocket; operators)", "GET /v1/proposals", "POST /v1/proposals (a chat directive into a draft; the owner)", "GET /v1/proposals/{id}", "POST /v1/proposals/{id}/confirm | reject (the owner)", "GET /v1/councils", "GET /v1/councils/{id}", "POST /v1/councils", "POST /v1/councils/{id}/messages | pick | dismiss | start", "GET /v1/metabolism", "GET /v1/mesh", "GET /v1/vision", "GET /v1/adr", "GET /v1/adr/{id}", "GET /v1/evolution", "POST /v1/evolution/mode (off: operators; on: the owner)", "GET /v1/consensus", "GET /v1/consensus/report?days=7", "POST /v1/consensus/mode (raise: APPROVER_IDENTITIES person; lower: operators)", "GET /v1/consensus/{id}", "POST /v1/consensus/{id}/approve|reject (APPROVER_IDENTITIES)", "GET /v1/reports?agent_id=&kind=&limit=",
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
      // ADR-0016 T0: the organism's vision (organism/vision.json of this deploy), read-only, for the Console's Vision page.
      if (path === "/v1/vision" && request.method === "GET") return json(visionView());
      // ADR Steward step 4 (docs/design/ADR-STEWARD.md §5): each ADR's progress as the Steward stored it, read-only, for
      // the Vision page's ADR panel. Operators and viewer accounts read it; nothing is ever written through these routes.
      if (path === "/v1/adr" || path.startsWith("/v1/adr/")) {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "the ADR documents are read-only");
        if (path === "/v1/adr") return json(await adrListView(env), 200, { "cache-control": ADR_CACHE_CONTROL });
        const adr = /^\/v1\/adr\/([^/]+)$/.exec(path);
        if (!adr) return errorResponse(404, "not_found");
        if (!validAdrId(adr[1])) return errorResponse(400, "invalid_request", "an ADR id is four digits");
        const one = await adrDetailView(env, adr[1]);
        return one.ok ? json(one.view, 200, { "cache-control": ADR_CACHE_CONTROL }) : errorResponse(one.status, one.error, one.detail);
      }
      // HAIC H1b (docs/design/HAIC-H0-H1.md §3.1, §3.7; owner Q1 2026-11-16): "Ask the organism", owners only. Each
      // conversation is a Durable Object named "<actor>:<id>"; nothing here writes outside the chat's own records.
      if (path === "/v1/conversations" || path.startsWith("/v1/conversations/")) {
        if (!isOwner(operator.identity, env)) return errorResponse(403, "owner_required", "the chat is for owners only");
        if (path === "/v1/conversations") {
          return request.method === "GET" ? json(await listConversations(env, operator.actor)) : errorResponse(405, "method_not_allowed");
        }
        const m = /^\/v1\/conversations\/(cnv_[0-9a-f]{16})(\/turns(?:\/([1-9][0-9]{0,5})\/rating)?)?$/.exec(path);
        if (!m) return errorResponse(404, "not_found");
        if (!env.CONVERSATION) return errorResponse(503, "not_available", "the conversation binding is not configured");
        const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(`${operator.actor}:${m[1]}`));
        let out: unknown;
        if (!m[2]) {
          if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
          out = await stub.read(operator.actor, m[1]);
        } else {
          if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
          const body = await readJsonObject(request);
          if (!body.ok) return body.response;
          out = m[3] ? await stub.rate(operator.actor, m[1], Number(m[3]), body.value.rating) : await stub.turn(operator.actor, m[1], body.value.question);
        }
        const r = out as { ok: boolean; value?: unknown; status?: number; code?: string; message?: string };
        return r.ok ? json(r.value) : errorResponse(r.status ?? 500, r.code ?? "internal_error", r.message);
      }
      // HAIC push hub (docs/design/HAIC-H0-H1.md §4.5): one WebSocket per Console page, for operators (as every channel's
      // GET is); the Console forwards the upgrade only after its Access gate and a same-origin check. Change signals only.
      if (path === "/v1/hub") {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
        if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return errorResponse(426, "upgrade_required", "the hub is a WebSocket");
        if (!env.HUB) return errorResponse(503, "not_available", "the hub binding is not configured");
        return env.HUB.get(env.HUB.idFromName("console")).fetch(new Request("https://hub.internal/connect", { headers: { upgrade: "websocket", "x-hub-actor": operator.actor } }));
      }
      // HAIC H2 (ADR-0017 H2; owner 2026-11-18): typed proposals. Operators read; only the owner confirms (then it is handed
      // off by kind) or rejects a draft. Nothing is executed here: consensus, the evolver, the orchestrator or xauusd act.
      if (path === "/v1/proposals" || path.startsWith("/v1/proposals/")) {
        if (path === "/v1/proposals") {
          if (request.method === "GET") return json(await listTypedProposals(env.DB));
          if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
          // HAIC H2b: the owner's chat directive becomes a draft (one model call from the chat's budget); only a draft.
          if (!isOwner(operator.identity, env)) return errorResponse(403, "owner_required", "only the owner turns a directive into a proposal");
          const body = await readJsonObject(request);
          if (!body.ok) return body.response;
          try {
            const made = await draftFromDirective(env, operator.actor, body.value.directive, body.value.conversation_id);
            await publishHub(env, [{ channel: "inbox", kind: "inbox_changed", data: { source: "proposals" } }]);
            return json(await readTypedProposal(env.DB, made.proposal_id), 201);
          } catch (err) {
            if (err instanceof DirectiveError) return errorResponse(err.status, err.code, err.errors.length ? `${err.message}: ${err.errors.join(", ")}` : err.message);
            throw err;
          }
        }
        const m = /^\/v1\/proposals\/(tp_[0-9a-f]{16})(?:\/(confirm|reject))?$/.exec(path);
        if (!m) return errorResponse(404, "not_found");
        try {
          if (!m[2]) return request.method === "GET" ? json(await readTypedProposal(env.DB, m[1])) : errorResponse(405, "method_not_allowed");
          if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
          if (!isOwner(operator.identity, env)) return errorResponse(403, "owner_required", "only the owner confirms or rejects a typed proposal");
          const body = await readJsonObject(request);
          if (!body.ok) return body.response;
          const out = await decideProposal(env.DB, operator.actor, m[1], m[2] as "confirm" | "reject", body.value.reason);
          await publishHub(env, [{ channel: "inbox", kind: "inbox_changed", data: { source: "proposals" } }]);
          return json(out);
        } catch (err) {
          if (err instanceof ProposalError) return errorResponse(err.status, err.code, err.message);
          throw err;
        }
      }
      // HAIC H1.5b (docs/design/HAIC-H0-H1.md §4): Call for Councils. Operators read; only the owner opens a council, joins
      // it with a message, picks an option or dismisses it (Q6: picks in Cerebrum only). A council never acts.
      if (path === "/v1/councils" || path.startsWith("/v1/councils/")) {
        if (path === "/v1/councils" && request.method === "GET") return json(await listCouncils(env.DB));
        const m = /^\/v1\/councils(?:\/(cs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(messages|pick|dismiss|start))?)?$/.exec(path);
        if (!m) return errorResponse(404, "not_found");
        if (!env.COUNCIL) return errorResponse(503, "not_available", "the council binding is not configured");
        if (request.method === "GET" && m[1] && !m[2]) {
          const out = await env.COUNCIL.get(env.COUNCIL.idFromName(m[1])).read() as { ok: boolean; value?: unknown; status?: number; code?: string; message?: string };
          return out.ok ? json(out.value) : errorResponse(out.status ?? 500, out.code ?? "internal_error", out.message);
        }
        if (request.method !== "POST" || (m[1] && !m[2])) return errorResponse(405, "method_not_allowed");
        if (!isOwner(operator.identity, env)) return errorResponse(403, "owner_required", "only the owner opens, begins, joins, picks or dismisses a council");
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        const id = m[1] ?? `cs_${crypto.randomUUID()}`;
        const stub = env.COUNCIL.get(env.COUNCIL.idFromName(id));
        const out = (!m[1] ? await stub.start(operator.actor, id, body.value.topic, body.value.question)
          : m[2] === "messages" ? await stub.message(operator.actor, body.value.text)
          : m[2] === "pick" ? await stub.pick(operator.actor, body.value.option_id, body.value.note)
          : m[2] === "start" ? await stub.begin(operator.actor)
          : await stub.dismiss(operator.actor)) as { ok: boolean; value?: unknown; status?: number; code?: string; message?: string };
        return out.ok ? json(out.value, m[1] ? 200 : 201) : errorResponse(out.status ?? 500, out.code ?? "internal_error", out.message);
      }
      // ADR-0014 §11 (docs/design/EVOLVER.md step V2): the evolution intents and the evolver's kill switch. Reading is open
      // to operators; "off" is a brake any operator may pull; "on" needs the owner.
      if (path === "/v1/evolution" && request.method === "GET") return json(await evolutionView(env.DB));
      if (path === "/v1/evolution/mode") {
        if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        try {
          return json(await setEvolverMode(env.DB, body.value.mode, operator.actor, isOwner(operator.identity, env), body.value.confirm, body.value.reason));
        } catch (err) {
          if (err instanceof EvolverModeError) return errorResponse(err.status, err.code, err.message);
          throw err;
        }
      }
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
              topics: [
                ...TOPICS.map((t) => ({ topic: t, owner_channel: channelOf(t) === "owner", relay: false })),
                // Owner 2026-11-16: relayed xauusd messages (report-relay.ts); never on the default (xauusd) channel.
                ...RELAY_TOPICS.map((t) => ({ topic: t, owner_channel: false, relay: true })),
              ],
              email: emailConfigured(env) ? "configured" : "off",
            });
          }
          if (!(await isApprover(request, env))) return errorResponse(403, "approver_required", "changing alert channels needs an approver");
          if (!id && request.method === "POST") {
            const body = await readJsonObject(request);
            if (!body.ok) return body.response;
            return json({ channel: await createChannel(alertEnv, operator.actor, body.value, CHANNEL_TOPICS) }, 201);
          }
          if (id && test && request.method === "POST") return json(await testChannel(alertEnv, operator.actor, id, OWNER_PANEL_URL));
          if (id && !test && request.method === "POST") {
            const body = await readJsonObject(request);
            if (!body.ok) return body.response;
            return json({ channel: await updateChannel(alertEnv, operator.actor, id, body.value, CHANNEL_TOPICS, RELAY_TOPICS) });
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
        if (agentId !== AGENT_ID && agentId !== SIGNAL_ANALYST_ID && agentId !== AUDITOR_ID && agentId !== ADR_STEWARD_ID && agentId !== EVOLVER_ID) return errorResponse(404, "not_found");
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
    const cycle = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(AGENT_ID)).cycle("scheduled").then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "supervisor_cycle_failed", message: String((err as Error)?.message ?? err) }));
    });
    ctx.waitUntil(cycle);
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
    // ADR Steward (docs/design/ADR-STEWARD.md §4.3): every tick. One indexed audit query decides whether a pass is due
    // (a watched event, a new deploy, a quiet window's end, the 02:52 UTC daily pass); otherwise it writes nothing.
    if (env.ADR_STEWARD) {
      ctx.waitUntil(env.ADR_STEWARD.get(env.ADR_STEWARD.idFromName(ADR_STEWARD_ID)).cycle("scheduled").then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "adr_steward_cycle_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
    // ADR-0014 §11 (docs/design/EVOLVER.md §4, step V2): record council tasks and the platform's own inventory findings
    // as evolution intents, at every tick. It writes intents and their state updates only; it never acts.
    ctx.waitUntil(intakeEvolutionIntents(env.DB, event.scheduledTime).then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "evolution_intake_failed", message: String((err as Error)?.message ?? err) }));
    }));
    // The evolver (ADR-0014 §11, docs/design/EVOLVER.md §5): every tick; a tick is a few indexed reads unless every gate
    // holds (on, no kill switch, not shadow, nothing in flight, 4 hours since the last start, quiet, not frozen).
    if (env.EVOLVER) {
      ctx.waitUntil(env.EVOLVER.get(env.EVOLVER.idFromName(EVOLVER_ID)).cycle("scheduled").then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "evolver_cycle_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
    // HAIC H1.5d (Q9): once an hour, agents propose councils from the evidence (an Observer cluster, a KPI regression, a
    // persistent census finding), deduplicated and capped; each waits in the owner's inbox until the owner begins it.
    let proposals: Promise<void> = Promise.resolve();
    if (minute === 7 && env.COUNCIL) {
      ctx.waitUntil(proposals = proposeCouncils(env as never, event.scheduledTime).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "council_proposals_failed", message: String((err as Error)?.message ?? err) }));
      }));
      // HAIC H2: typed proposal drafts past their 7-day window expire.
      ctx.waitUntil(expireDrafts(env.DB, event.scheduledTime).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "typed_proposals_expiry_failed", message: String((err as Error)?.message ?? err) }));
      }));
      // HAIC H1.5e: a closed council whose transcript is not in R2 yet is asked to store it again (5 an hour).
      ctx.waitUntil(storeMissingTranscripts(env as never).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "council_transcripts_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
    // ADR-0012 phase 2: owner notices (replaces the owner-attention and drift-alert GitHub workflows).
    let fullPass: Promise<void> = Promise.resolve();
    if (minute === 22 || minute === 52) {
      ctx.waitUntil(fullPass = reconcileNotices({ ...env, ALERT_VAULT: alertVaultOf(env) }, event.scheduledTime)
        .then((changes) => (changes.some((c) => OWNER_CHANNEL_TOPICS.includes(c.topic as never) && c.change !== "unchanged") ? publishHub(env, [{ channel: "inbox", kind: "inbox_changed", data: { source: "notices" } }]) : undefined)).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "owner_notices_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
    // Owner 2026-11-16: a proposal the cycle put in pending_owner (or a draft plan, a pending knowledge proposal) is
    // notified in this tick, once the cycle and this tick's :22/:52 pass have both settled (never concurrently with
    // either); nothing new waiting sends nothing (owner-notices.ts reconcileOwnerAttentionNow).
    ctx.waitUntil(Promise.all([cycle, fullPass, proposals]).then(() => reconcileOwnerAttentionNow({ ...env, ALERT_VAULT: alertVaultOf(env) }))
      // HAIC push hub: an owner notice that changed means the inbox changed; the Owner page reloads at once.
      .then((r) => (r ? publishHub(env, [{ channel: "inbox", kind: "inbox_changed", data: { source: "notices", change: r.change } }]) : undefined)).then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "owner_attention_now_failed", message: String((err as Error)?.message ?? err) }));
    }));
    // Owner 2026-11-16 ("pakai cara 2 lewat kernel"): relay the xauusd Worker's EA heartbeat reports to the alert
    // channels that list ea_heartbeat, at every tick (report-relay.ts).
    ctx.waitUntil(relayReports({ DB: env.DB, ALERT_VAULT: alertVaultOf(env), OWNER_TELEGRAM: env.OWNER_TELEGRAM }, event.scheduledTime).then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "report_relay_failed", message: String((err as Error)?.message ?? err) }));
    }));
    const d = new Date(event.scheduledTime);
    if (d.getUTCHours() === 3 && minute === 7) {
      ctx.waitUntil(pruneSyscallConsumptions(env as any, event.scheduledTime).then(() => undefined, (err) => {
        console.error(JSON.stringify({ service: SERVICE, event: "syscall_consumption_retention_failed", message: String((err as Error)?.message ?? err) }));
      }));
    }
  },
};
