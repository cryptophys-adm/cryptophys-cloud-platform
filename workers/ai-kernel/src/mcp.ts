/**
 * MCP front door of the AI Worker OS (ADR-0007): JSON-RPC 2.0 over streamable HTTP (single
 * JSON responses, no SSE). It sits behind Cloudflare Access and the operator allow-list; the
 * caller's verified identity is the actor. Tools are the operator's view of the OS. No tool
 * can approve, deploy, rotate secrets or touch funds, and re-enabling agents needs an approver.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { CAPABILITIES } from "../../control-plane-shared/src/capabilities.ts";
import { observe } from "./syscall.ts";
import { listAgents, listActions, setAgentStatus, setAgentsEnabled, wakeAgent, type KernelHttpEnv } from "./kernel.ts";

export const PROTOCOL_VERSION = "2025-06-18";

interface Tool { name: string; description: string; inputSchema: JsonObject; approverOnly?: boolean }
const str = (description: string) => ({ type: "string", description });

export const TOOLS: Tool[] = [
  { name: "platform_status", description: "Drift per service, recent signal ingestion runs, open agent proposals and the kill switch.", inputSchema: { type: "object", properties: {} } },
  { name: "list_capabilities", description: "The capability catalog with autonomy tiers (0 observe, 1 propose, 2 reversible act, 3 human only).", inputSchema: { type: "object", properties: {} } },
  { name: "list_agents", description: "Registered agents, their tier limit, capabilities and status.", inputSchema: { type: "object", properties: {} } },
  { name: "list_agent_actions", description: "Recent syscalls of an agent with their policy decision and outcome.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["agent_id"] } },
  { name: "wake_agent", description: "Run one supervisor cycle now and return its report.", inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] } },
  { name: "suspend_agent", description: "Suspend an agent (any operator).", inputSchema: { type: "object", properties: { agent_id: str("agent id"), reason: str("why") }, required: ["agent_id", "reason"] } },
  { name: "resume_agent", description: "Resume a suspended agent (approver only).", approverOnly: true, inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] } },
  { name: "set_agents_enabled", description: "Global kill switch: false stops every agent (any operator); true needs an approver.",
    inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] } },
];

const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError });

export async function handleMcp(request: Request, env: KernelHttpEnv, actor: string, isApprover: boolean): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  let msg: JsonObject;
  try { msg = (await request.json()) as JsonObject; } catch { return rpcError(null, -32700, "parse error"); }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "invalid request");
  const id = msg.id;
  // Notifications (no id) get 202 Accepted with no body.
  if (id === undefined) return new Response(null, { status: 202 });
  const params = (msg.params ?? {}) as JsonObject;
  switch (msg.method) {
    case "initialize":
      return rpc(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "cryptophys-ai-kernel", version: "1.0.0" },
        instructions: "AI Worker OS for the cryptophys platform. Advisory: agents observe, propose and take bounded reversible actions under policy; humans approve the rest." });
    case "ping": return rpc(id, {});
    case "tools/list": return rpc(id, { tools: TOOLS.map(({ approverOnly: _a, ...t }) => t) });
    case "tools/call": {
      const name = params.name as string;
      const args = (params.arguments ?? {}) as JsonObject;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool ${String(name)}`);
      try {
        return rpc(id, await callTool(env, tool, args, actor, isApprover));
      } catch (err) {
        return rpc(id, text({ error: String((err as Error)?.message ?? err) }, true));
      }
    }
    default: return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

async function callTool(env: KernelHttpEnv, tool: Tool, args: JsonObject, actor: string, isApprover: boolean) {
  if (tool.approverOnly && !isApprover) return text({ error: "approver_required" }, true);
  const agentId = String(args.agent_id ?? "");
  switch (tool.name) {
    case "platform_status": return text(await observe(env));
    case "list_capabilities": return text(CAPABILITIES);
    case "list_agents": return text(await listAgents(env));
    case "list_agent_actions": return text(await listActions(env, agentId, Number(args.limit ?? 20)));
    case "wake_agent": return text(await wakeAgent(env, agentId));
    case "suspend_agent": return text(await setAgentStatus(env, agentId, "suspended", actor, String(args.reason ?? "")));
    case "resume_agent": return text(await setAgentStatus(env, agentId, "enabled", actor, "resumed"));
    case "set_agents_enabled": {
      if (args.enabled === true && !isApprover) return text({ error: "approver_required" }, true);
      if (typeof args.enabled !== "boolean") return text({ error: "enabled must be a boolean" }, true);
      return text(await setAgentsEnabled(env, args.enabled, actor));
    }
  }
  return text({ error: "unknown tool" }, true);
}
