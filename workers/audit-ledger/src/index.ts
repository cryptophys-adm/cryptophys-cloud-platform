import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import {
  errorResponse, healthResponse, json, limitParam, newId, readJsonObject, serviceMetadata, stringField,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent, verifyAuditChain, type AuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, requireOperator } from "../../control-plane-shared/src/access.ts";

export type Env = BaseEnv & { AGENTS?: AgentRpcBinding };

const SERVICE = "cryptophys-audit-ledger";
const EVENT_TYPE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const CATEGORIES = ["deployment", "security", "configuration", "recovery", "access", "other"] as const;

interface Categorization { category: (typeof CATEGORIES)[number]; summary: string }

const categorizeTask: AiTask<Categorization> = {
  name: "categorize_event",
  instructions:
    `You label committed audit events for operators. Return {"category": one of ${JSON.stringify(CATEGORIES)}, ` +
    `"summary": a factual sentence of at most 280 characters}. Never add facts that are not in the event.`,
  maxInputChars: 6000,
  maxOutputTokens: 200,
  validate(output) {
    const o = output as Record<string, unknown>;
    const category = CATEGORIES.find((c) => c === o?.category);
    const summary = boundedString(o?.summary, 280);
    return category && summary ? { category, summary } : null;
  },
};

function present(row: AuditEvent): Record<string, unknown> {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = row.payload_json;
  }
  return { ...row, payload_json: undefined, payload };
}

async function appendEvent(request: Request, env: Env, url: URL, actor: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const b = body.value;
  const eventType = stringField(b, "event_type", 64);
  // The actor is the verified Access identity; any "actor" in the body is ignored.
  const subject = stringField(b, "subject", 200);
  const outcome = stringField(b, "outcome", 64);
  for (const v of [eventType, subject, outcome]) if (v instanceof Error) return errorResponse(400, "invalid_request", v.message);
  if (!EVENT_TYPE.test(eventType as string)) return errorResponse(400, "invalid_request", "event_type must match ^[a-z0-9][a-z0-9_.-]{0,63}$");
  if (b.payload !== undefined && (typeof b.payload !== "object" || b.payload === null || Array.isArray(b.payload))) {
    return errorResponse(400, "invalid_request", "payload must be a JSON object");
  }
  const event = await appendAuditEvent(env.DB, {
    event_type: eventType as string,
    actor,
    subject: subject as string,
    outcome: outcome as string,
    payload: b.payload ?? {},
  });
  const response: Record<string, unknown> = { event: present(event) };
  if (url.searchParams.get("advisory") === "true") {
    response.advisory = await engineFor(env, SERVICE, [categorizeTask.name]).run(categorizeTask, present(event), event.event_id);
  }
  return json(response, 201);
}

async function listEvents(env: Env, url: URL): Promise<Response> {
  const limit = limitParam(url);
  const filters: string[] = [];
  const params: unknown[] = [];
  const subject = url.searchParams.get("subject");
  const eventType = url.searchParams.get("event_type");
  const before = Number(url.searchParams.get("before_rowid") ?? "");
  if (subject) { filters.push("subject = ?"); params.push(subject.slice(0, 200)); }
  if (eventType) { filters.push("event_type = ?"); params.push(eventType.slice(0, 64)); }
  if (Number.isInteger(before) && before > 0) { filters.push("rowid < ?"); params.push(before); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT rowid AS rowid, event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at
     FROM audit_events ${where} ORDER BY rowid DESC LIMIT ?`,
  ).bind(...params, limit).all<AuditEvent & { rowid: number }>();
  const events = rows.results.map(present);
  const last = rows.results.at(-1);
  return json({ events, next_before_rowid: rows.results.length === limit && last ? last.rowid : null });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    const path = url.pathname;
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/health" || path === "/healthz") return healthResponse(env);
      if (path === "/ready" || path === "/readyz") return readinessResponse(env);
      if (path === "/") {
        return serviceMetadata(env, "Append-only, hash-chained audit records", [
          "POST /v1/events", "GET /v1/events", "GET /v1/events/{event_id}", "GET /v1/verify",
        ]);
      }
    }
    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found");
    const operator = await requireOperator(request, env);
    if (!operator.ok) return operator.response;
    try {
      if (path === "/v1/events" && request.method === "POST") return await appendEvent(request, env, url, operator.actor);
      if (path === "/v1/events" && request.method === "GET") return await listEvents(env, url);
      if (path === "/v1/verify" && request.method === "GET") {
        const result = await verifyAuditChain(env.DB);
        if (result.valid === false) {
          const subject = `Audit chain invalid at ${result.first_invalid_event_id}`;
          let shouldPublish = true;
          try {
            const row = await env.DB.prepare("SELECT 1 FROM agent_reports WHERE agent_id = 'audit-ledger' AND subject = ? AND created_at > ? LIMIT 1")
              .bind(subject, new Date(Date.now() - 3600_000).toISOString()).first();
            if (row) shouldPublish = false;
          } catch (err) {
            console.error(JSON.stringify({ service: SERVICE, event: "audit_report_dedup_failed", message: String((err as Error)?.message ?? err) }));
            shouldPublish = false;
          }
          if (shouldPublish) {
            await publishAgentReport(env.AGENTS, "audit-ledger", {
              kind: "audit_digest", severity: "critical",
              subject,
              body: { events_checked: result.events_checked, first_invalid_event_id: result.first_invalid_event_id, reason: result.reason, head_hash: result.head_hash },
            });
          }
        }
        return json(result);
      }
      const match = /^\/v1\/events\/(evt_[0-9a-f-]{36})$/.exec(path);
      if (match && request.method === "GET") {
        const row = await env.DB.prepare(
          "SELECT event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at FROM audit_events WHERE event_id = ?",
        ).bind(match[1]).first<AuditEvent>();
        return row ? json({ event: present(row) }) : errorResponse(404, "not_found");
      }
      return errorResponse(405, "method_not_allowed");
    } catch (err) {
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },
};
