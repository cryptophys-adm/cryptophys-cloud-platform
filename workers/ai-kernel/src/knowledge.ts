/**
 * TP-028: learned-knowledge proposals (RFC_AETHER_KNOWLEDGE_GUARDIAN phase A6, ADR-0007 tier 1).
 *
 * Aether's curator and calibrator (host cryptophys-aether, reached through AgentRpc) draft learned-
 * knowledge candidates with knowledge.propose. A draft is only a proposal: a person who is an approver
 * approves or rejects it here (Console, POST /v1/knowledge/{id}/approve|reject). Approval means
 * "approved for shadow testing", never "promoted": promotion is an owner PR in the xauusd repository.
 * The proposing agent reads its own proposals' review status with knowledge.status (tier 0).
 *
 * The kernel validates every candidate deterministically before it is stored (RFC §8.3): a claim of
 * measured outcomes or a role reminder, natural language within 300 characters, every number in the
 * text found in the evidence, at least 10 cited decision cards, and no price, level, size or order
 * wording anywhere. Advisory only: nothing here changes an agent, a prompt or a parameter.
 */
import { verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { newId, type JsonObject } from "../../control-plane-shared/src/http.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";

export const KNOWLEDGE_ITEM_VERSION = "cryptophys.knowledge-item.v1";
export const KNOWLEDGE_KINDS = ["caution", "role_reminder", "param_candidate"] as const;
export const CLAIM_TYPES = ["measured_outcome", "role_reminder"] as const;
export const KNOWLEDGE_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
/** A proposal not decided within 14 days expires; the agent may propose it again with fresh evidence. */
export const KNOWLEDGE_REVIEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const KNOWLEDGE_MAX_PER_DAY = 20;
export const MIN_CITED_CARDS = 10;
const MAX_ITEM_BYTES = 8 * 1024;

const ITEM_ID = /^k-[a-z0-9-]{1,40}$/;
const CARD_ID = /^d:[0-9A-Za-z]+:\d+:\d+$/;
const PROPOSAL_ID = /^knw_[0-9a-f-]{36}$/;
/** XAUUSD room agent ids (manifest ids such as r37_funnel) and platform agent ids. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;
/** Price-like numbers: 3+ digits, including grouped thousands (no level ever leaves Aether). */
const PRICE = /\b(?:\d{3,}(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)\b/;
const ORDER = /\b(?:buy|sell)\s+(?:limit|stop)\b|\b(?:place|open|enter)\s+(?:an?\s+|the\s+)?(?:order|position)\b|\blots?\b|\blot size\b|\bposition siz(?:e|ing)\b|\b(?:stop[- ]loss|take[- ]profit|entry|target)\s+(?:at|of|to|near)\b/i;
const TRADING_VALUE_TALK = /\b(?:prices?|levels?|sizes?|sizing|entries?|targets?|support|resistance|zones?)\b/i;
/** Field names, key=value and field definitions belong to the canon, never to learned text. */
const FIELD_TALK = /\b[a-z]+_[a-z0-9_]+\b|\w+\s*=\s*\S|\bmeans\b|\bcode\s+\d+\s+is\b/i;
const FORBIDDEN_KEYS = new Set(["entry", "entry_price", "stop", "stop_loss", "take_profit", "tp1", "tp2", "trade_plan", "plan", "key_levels", "zones", "levels", "close", "price", "atr", "position_size_pct", "lots", "size"]);

export class KnowledgeDecisionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const FORBIDDEN_KEY_PARTS = new Set(["price", "prices", "level", "levels", "size", "sizing", "entry", "entries", "target", "targets", "stop", "order", "orders", "lot", "lots", "plan"]);

function forbiddenKeys(value: unknown, path = "item"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const normalized = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
    const forbidden = FORBIDDEN_KEYS.has(normalized) || parts.some((part) => FORBIDDEN_KEY_PARTS.has(part));
    return [...(forbidden ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)];
  });
}

/** Evidence is structured data: free-form strings cannot smuggle trading language or price-like values into the kernel. */
function evidenceHasTradingText(value: unknown): boolean {
  if (typeof value === "string") {
    // ISO date windows are legitimate evidence strings; other 3+ digit runs in free-form evidence are not.
    const withoutDates = value.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+Z?)?\b/g, "");
    return TRADING_VALUE_TALK.test(value) || ORDER.test(value) || PRICE.test(withoutDates);
  }
  if (Array.isArray(value)) return value.some(evidenceHasTradingText);
  if (isObject(value)) return Object.values(value).some(evidenceHasTradingText);
  return false;
}

// Numeric evidence is allowed only under fields emitted by Aether's current deterministic
// curator/calibrator contracts (plus the platform fixture metrics). An opaque numeric key such
// as { observed_value: 4050 } could otherwise smuggle a price while bypassing string redaction.
const SAFE_EVIDENCE_NUMERIC_KEYS = new Set([
  "candles", "bars", "wrong", "baseline_wrong_rate", "p_value",
  "window_days", "rooms_with_break", "rooms", "rate_pct",
  "decisive", "wrong_pct", "baseline_wrong_pct", "baseline_decisive",
  "episodes", "longest_candles", "proposed_value", "default_value", "tested_values",
]);

function evidenceHasUnscopedNumber(value: unknown, key = ""): boolean {
  if (typeof value === "number") return Number.isFinite(value) && !SAFE_EVIDENCE_NUMERIC_KEYS.has(key);
  if (Array.isArray(value)) return value.some((v) => evidenceHasUnscopedNumber(v, key));
  if (isObject(value)) return Object.entries(value).some(([k, v]) => evidenceHasUnscopedNumber(v, k));
  return false;
}

function hasNumericLeaf(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNumericLeaf);
  if (isObject(value)) return Object.values(value).some(hasNumericLeaf);
  return false;
}

function numbersOf(text: string): string[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0])));
}

function evidenceNumbers(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.add(String(value));
    if (value > 0 && value < 1) { out.add(String(Math.round(value * 100))); out.add(String(Math.round(value * 1000) / 10)); }
  } else if (typeof value === "string") numbersOf(value).forEach((n) => out.add(n));
  else if (Array.isArray(value)) value.forEach((v) => evidenceNumbers(v, out));
  else if (isObject(value)) Object.values(value).forEach((v) => evidenceNumbers(v, out));
  return out;
}

/** Pure: why a knowledge item is refused (empty when it may be stored as a proposal). RFC §6.2 and §8.3. */
export function validateKnowledgeItem(item: unknown): string[] {
  if (!isObject(item)) return ["not_an_object"];
  const errors: string[] = [];
  if (item.schema !== KNOWLEDGE_ITEM_VERSION) errors.push("unsupported_schema");
  if (typeof item.item_id !== "string" || !ITEM_ID.test(item.item_id)) errors.push("item_id_invalid");
  if (!Number.isInteger(item.version) || (item.version as number) < 1 || (item.version as number) > 999) errors.push("version_invalid");
  if (!(KNOWLEDGE_KINDS as readonly string[]).includes(String(item.kind))) errors.push("kind_invalid");
  if (!(CLAIM_TYPES as readonly string[]).includes(String(item.claim_type))) errors.push("claim_type_invalid");
  if (item.kind === "role_reminder" && item.claim_type !== "role_reminder") errors.push("claim_type_mismatch");
  if (item.kind !== "role_reminder" && item.claim_type !== "measured_outcome") errors.push("claim_type_mismatch");
  const audience = isObject(item.audience) ? item.audience : null;
  const agents = Array.isArray(audience?.agents) ? audience!.agents as unknown[] : [];
  if (!agents.length || agents.length > 20 || !agents.every((a) => typeof a === "string" && AGENT_ID.test(a))) errors.push("audience_invalid");
  const charts = Array.isArray(audience?.charts) ? audience!.charts as unknown[] : [];
  if (!charts.every((c) => typeof c === "string" && ["15", "60", "240", "1D"].includes(c))) errors.push("audience_charts_invalid");
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!text || text.length > 300) errors.push("text_length");
  if (evidenceHasTradingText(item.situation)) errors.push("situation_trading_value_wording");
  if (hasNumericLeaf(item.situation)) errors.push("situation_numeric_value");
  if (item.params !== undefined && evidenceHasTradingText(item.params)) errors.push("params_trading_value_wording");
  if (PRICE.test(text)) errors.push("text_price_like_number");
  if (TRADING_VALUE_TALK.test(text)) errors.push("text_trading_value_wording");
  if (ORDER.test(text)) errors.push("text_order_wording");
  if (FIELD_TALK.test(text)) errors.push("text_not_natural_language");
  const evidence = isObject(item.evidence) ? item.evidence : null;
  if (!evidence) errors.push("evidence_missing");
  else {
    if (evidenceHasTradingText(evidence)) errors.push("evidence_trading_value_wording");
    if (evidenceHasUnscopedNumber(evidence)) errors.push("evidence_unscoped_numeric_field");
    const known = evidenceNumbers(evidence);
    const missing = numbersOf(text).filter((n) => !known.has(n));
    if (missing.length) errors.push(`text_number_not_in_evidence:${missing.slice(0, 3).join(",")}`);
  }
  const provenance = isObject(item.provenance) ? item.provenance : null;
  const cards = Array.isArray(provenance?.card_ids) ? provenance!.card_ids as unknown[] : [];
  const distinct = new Set(cards.filter((c) => typeof c === "string" && CARD_ID.test(c)));
  if (distinct.size < MIN_CITED_CARDS || distinct.size !== cards.length) errors.push("provenance_cards");
  if (typeof provenance?.canon_sha !== "string" || !/^[0-9a-f]{64}$/.test(provenance.canon_sha as string)) errors.push("provenance_canon");
  if (item.kind === "param_candidate") {
    const p = isObject(item.params) ? item.params : null;
    if (!p || typeof p.family !== "string" || typeof p.grid !== "string" || !isObject(p.values) || typeof p.hypothesis !== "string" || typeof p.metric !== "string") errors.push("params_invalid");
  } else if (item.params !== undefined) errors.push("params_only_for_param_candidate");
  for (const k of forbiddenKeys(item)) errors.push(`forbidden_key:${k}`);
  if (new TextEncoder().encode(JSON.stringify(item)).byteLength > MAX_ITEM_BYTES) errors.push("item_too_large");
  return errors;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface ProposalRow {
  proposal_id: string; proposer_agent_id: string; item_id: string; item_version: number; kind: string;
  item_json: string; content_sha256: string; status: string; decided_by: string | null; reason: string | null;
  decision_id: string; created_at: string; decided_at: string | null;
}

function present(r: ProposalRow, withItem = true): JsonObject {
  return {
    proposal_id: r.proposal_id, proposer_agent_id: r.proposer_agent_id, item_id: r.item_id, item_version: r.item_version,
    kind: r.kind, content_sha256: r.content_sha256, status: r.status, decided_by: r.decided_by, reason: r.reason,
    created_at: r.created_at, decided_at: r.decided_at,
    ...(withItem ? { item: JSON.parse(r.item_json) as JsonObject } : {}),
  };
}

/** Marks pending proposals older than the review window as expired (idempotent). */
async function expireStale(db: D1Database, now: number): Promise<void> {
  await db.prepare("UPDATE knowledge_proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?")
    .bind(new Date(now).toISOString(), new Date(now - KNOWLEDGE_REVIEW_WINDOW_MS).toISOString()).run();
}

/** knowledge.propose (tier 1): store one validated candidate as a pending proposal. */
export async function proposeKnowledge(db: D1Database, agentId: string, decisionId: string, input: JsonObject, now = Date.now()): Promise<JsonObject> {
  await verifySyscallDecision(db, decisionId, agentId, "knowledge.propose", now);
  const item = input.item;
  const errors = validateKnowledgeItem(item);
  if (errors.length) throw new Error(`invalid_knowledge_item: ${errors.slice(0, 8).join("; ")}`);
  const it = item as Record<string, unknown>;
  const today = new Date(now).toISOString().slice(0, 10);
  const used = await db.prepare("SELECT COUNT(*) AS n FROM knowledge_proposals WHERE proposer_agent_id = ? AND created_at >= ?").bind(agentId, `${today}T00:00:00.000Z`).first<{ n: number }>();
  if ((used?.n ?? 0) >= KNOWLEDGE_MAX_PER_DAY) throw new Error("knowledge_daily_limit");
  const itemJson = JSON.stringify(item);
  const sha = await sha256Hex(itemJson);
  const proposalId = newId("knw");
  const createdAt = new Date(now).toISOString();
  try {
    await db.prepare(
      `INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(proposalId, agentId, it.item_id as string, it.version as number, it.kind as string, itemJson, sha, decisionId, createdAt).run();
  } catch {
    throw new Error("knowledge_item_version_exists");
  }
  await appendAuditEvent(db, {
    event_type: "knowledge.proposed", actor: `agent:${agentId}`, subject: `${it.item_id as string}@${it.version as number}`, outcome: "pending",
    payload: { proposal_id: proposalId, kind: it.kind as string, content_sha256: sha },
  });
  return { proposal_id: proposalId, item_id: it.item_id as string, item_version: it.version as number, status: "pending", content_sha256: sha, created_at: createdAt };
}

/** knowledge.status (tier 0): the calling agent's own proposals, newest first, without item bodies. */
export async function knowledgeStatus(db: D1Database, agentId: string, input: JsonObject, now = Date.now()): Promise<JsonObject> {
  await expireStale(db, now);
  const since = typeof input.since === "string" && !Number.isNaN(Date.parse(input.since)) ? input.since : new Date(now - 30 * 86_400_000).toISOString();
  const rows = (await db.prepare(
    "SELECT * FROM knowledge_proposals WHERE proposer_agent_id = ? AND (created_at >= ? OR decided_at >= ?) ORDER BY created_at DESC LIMIT 100",
  ).bind(agentId, since, since).all<ProposalRow>()).results ?? [];
  return { agent_id: agentId, proposals: rows.map((r) => present(r, false)) };
}

/** GET /v1/knowledge for the Console: proposals of every agent, newest first. */
export async function listKnowledge(db: D1Database, { limit = 50, status = null as string | null } = {}, now = Date.now()): Promise<JsonObject> {
  await expireStale(db, now);
  const n = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  const rows = status && (KNOWLEDGE_STATUSES as readonly string[]).includes(status)
    ? (await db.prepare("SELECT * FROM knowledge_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, n).all<ProposalRow>()).results ?? []
    : (await db.prepare("SELECT * FROM knowledge_proposals ORDER BY created_at DESC LIMIT ?").bind(n).all<ProposalRow>()).results ?? [];
  const counts = (await db.prepare("SELECT status, COUNT(*) AS n FROM knowledge_proposals GROUP BY status").all<{ status: string; n: number }>()).results ?? [];
  return { proposals: rows.map((r) => present(r)), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

export async function getKnowledge(db: D1Database, proposalId: string): Promise<JsonObject | null> {
  if (!PROPOSAL_ID.test(proposalId)) return null;
  const r = await db.prepare("SELECT * FROM knowledge_proposals WHERE proposal_id = ?").bind(proposalId).first<ProposalRow>();
  return r ? present(r) : null;
}

/**
 * A person's decision on a pending proposal. Approvers only (checked by the caller); a person's Access
 * identity, never a service token; never the proposer. Each proposal is decided once.
 */
export async function decideKnowledge(db: D1Database, proposalId: string, decision: "approve" | "reject", approver: string, reasonRaw: unknown, now = Date.now()): Promise<JsonObject> {
  if (!PROPOSAL_ID.test(proposalId)) throw new KnowledgeDecisionError(404, "not_found", "unknown proposal");
  if (!/^[^@\s]{1,100}@[^@\s]{1,100}$/.test(approver)) throw new KnowledgeDecisionError(403, "person_required", "a knowledge review needs a person's Access identity");
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 500) : null;
  await expireStale(db, now);
  const r = await db.prepare("SELECT * FROM knowledge_proposals WHERE proposal_id = ?").bind(proposalId).first<ProposalRow>();
  if (!r) throw new KnowledgeDecisionError(404, "not_found", "unknown proposal");
  if (`agent:${r.proposer_agent_id}` === approver) throw new KnowledgeDecisionError(403, "separation_of_duties", "the proposer cannot review its own proposal");
  if (r.status !== "pending") throw new KnowledgeDecisionError(409, "not_pending", `proposal is ${r.status}`);
  const status = decision === "approve" ? "approved" : "rejected";
  const at = new Date(now).toISOString();
  const res = await db.prepare("UPDATE knowledge_proposals SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE proposal_id = ? AND status = 'pending'")
    .bind(status, approver, reason, at, proposalId).run();
  if (!res.meta?.changes) throw new KnowledgeDecisionError(409, "not_pending", "proposal was decided concurrently");
  await appendAuditEvent(db, {
    event_type: decision === "approve" ? "knowledge.approved" : "knowledge.rejected", actor: approver,
    subject: `${r.item_id}@${r.item_version}`, outcome: status,
    payload: { proposal_id: proposalId, proposer: `agent:${r.proposer_agent_id}`, content_sha256: r.content_sha256, reason },
  });
  return { proposal_id: proposalId, item_id: r.item_id, item_version: r.item_version, status, decided_by: approver, reason, decided_at: at };
}

