/**
 * Long-term semantic agent memory backed by D1 (agent_memories) and Cloudflare Vectorize (TP-008).
 *
 *  - memory.recall (tier 0): embeds the query and queries Vectorize with a strict metadata filter
 *    { agent_id } and D1 WHERE agent_id = ?, returning at most 5 memories owned by the calling agent.
 *  - memory.remember (tier 1, policy-gated, max_per_hour = 12): verifies the Policy Engine decision id,
 *    embeds the bounded text (<= 1000 chars), and writes the D1 row and Vectorize vector under the
 *    exact same memory_id with metadata { agent_id, kind }.
 *  - Advisory only: memory is passed as `context` to AI draft tasks, never to triggers or validators.
 *    Missing or failing Vectorize/embeddings never fail an agent cycle; the cycle records
 *    `memory: "unavailable"` and continues deterministically.
 */
import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import { boundedString, engineFor } from "../../control-plane-shared/src/ai-engine.ts";
import { verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";
import { newId, nowIso, type JsonObject } from "../../control-plane-shared/src/http.ts";
import type { CycleReport, KernelEnv } from "./supervisor.ts";
import { syscall } from "./syscall.ts";

const SERVICE = "cryptophys-ai-kernel";
export const MAX_MEMORY_TEXT_LEN = 1000;
export const MAX_RECALL_TOP_K = 5;
export const DEFAULT_RECALL_TOP_K = 3;
export const RETENTION_DAYS = 90;
export const RETENTION_BATCH_LIMIT = 100;

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorizeBinding {
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]): Promise<unknown>;
  query(
    vector: number[],
    options?: { topK?: number; filter?: Record<string, unknown>; returnMetadata?: boolean | "none" | "indexed" | "all" },
  ): Promise<{ matches: VectorizeMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface MemoryEnv extends BaseEnv {
  MEMORY?: VectorizeBinding;
}

export interface StoredMemory {
  memory_id: string;
  agent_id: string;
  kind: string;
  text: string;
  source_ref: string | null;
  created_at: string;
  score?: number;
}

/** Tier 0 handler for `memory.recall`: strictly scoped to the calling `agentId`. */
export async function recallMemories(env: MemoryEnv, agentId: string, input: JsonObject): Promise<JsonObject> {
  if (!env.MEMORY) throw new Error("memory_binding_missing");
  const query = boundedString(input.query, MAX_MEMORY_TEXT_LEN);
  if (!query) throw new Error("invalid_memory_query");
  const rawTopK = typeof input.top_k === "number" && Number.isInteger(input.top_k) ? input.top_k : DEFAULT_RECALL_TOP_K;
  const topK = Math.max(1, Math.min(MAX_RECALL_TOP_K, rawTopK));

  const emb = await engineFor(env, SERVICE, ["embed"]).embed(query, `${agentId}:recall:${Date.now()}`);
  if (emb.status !== "ok") throw new Error(`embed_${emb.reason}`);

  const vecRes = await env.MEMORY.query(emb.data, {
    topK,
    filter: { agent_id: agentId },
    returnMetadata: true,
  });
  const matches = Array.isArray(vecRes?.matches) ? vecRes.matches.slice(0, topK) : [];
  // Enforce caller isolation even if a backing store ignored the metadata filter.
  const ownMatches = matches.filter((m) => !m.metadata || !("agent_id" in m.metadata) || m.metadata.agent_id === agentId);
  if (ownMatches.length === 0) {
    return { agent_id: agentId, memories: [] };
  }

  const placeholders = ownMatches.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT memory_id, agent_id, kind, text, source_ref, created_at
     FROM agent_memories
     WHERE agent_id = ? AND memory_id IN (${placeholders})`,
  ).bind(agentId, ...ownMatches.map((m) => m.id)).all<StoredMemory>();

  const byId = new Map(rows.results.map((r) => [r.memory_id, r]));
  const memories: JsonObject[] = [];
  for (const m of ownMatches) {
    const row = byId.get(m.id);
    if (!row || row.agent_id !== agentId) continue;
    memories.push({
      memory_id: row.memory_id,
      agent_id: row.agent_id,
      kind: row.kind,
      text: row.text,
      source_ref: row.source_ref,
      created_at: row.created_at,
      score: m.score,
    });
  }
  return { agent_id: agentId, memories };
}

/** Tier 1 target for `memory.remember`: verifies the Policy decision id and writes D1 + Vectorize with the same id. */
export async function rememberMemory(
  env: MemoryEnv,
  agentId: string,
  decisionId: string,
  input: JsonObject,
): Promise<JsonObject> {
  await verifySyscallDecision(env.DB, decisionId, agentId, "memory.remember");
  if (!env.MEMORY) throw new Error("memory_binding_missing");
  const kind = boundedString(input.kind, 80);
  const text = boundedString(input.text, MAX_MEMORY_TEXT_LEN);
  const sourceRef = typeof input.source_ref === "string" && input.source_ref.trim() ? input.source_ref.trim().slice(0, 200) : null;
  if (!kind || !text) throw new Error("invalid_memory_input");

  const emb = await engineFor(env, SERVICE, ["embed"]).embed(text, `${agentId}:remember:${decisionId}`);
  if (emb.status !== "ok") throw new Error(`embed_${emb.reason}`);

  const memoryId = newId("mem");
  const createdAt = nowIso();

  await env.MEMORY.upsert([
    {
      id: memoryId,
      values: emb.data,
      metadata: { agent_id: agentId, kind },
    },
  ]);

  await env.DB.prepare(
    `INSERT INTO agent_memories (memory_id, agent_id, kind, text, source_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(memoryId, agentId, kind, text, sourceRef, createdAt).run();

  return {
    memory_id: memoryId,
    agent_id: agentId,
    kind,
    text,
    source_ref: sourceRef,
    created_at: createdAt,
  };
}

/**
 * Best-effort advisory recall before an agent drafts with its AI engine.
 * Never throws; records `report.memory = "unavailable"` if MEMORY is missing or recall fails.
 */
export async function recallContextForAgent(
  env: KernelEnv,
  agentId: string,
  query: string,
  report: CycleReport,
): Promise<JsonObject[] | undefined> {
  if (!env.MEMORY) {
    report.memory = "unavailable";
    return undefined;
  }
  try {
    const res = await syscall(env, agentId, "memory.recall", { query: query.slice(0, MAX_MEMORY_TEXT_LEN), top_k: DEFAULT_RECALL_TOP_K });
    report.actions.push(res);
    if (res.outcome !== "succeeded") {
      report.memory = "unavailable";
      return undefined;
    }
    const memories = (res.result.memories as JsonObject[] | undefined) ?? [];
    return memories;
  } catch {
    report.memory = "unavailable";
    return undefined;
  }
}

/**
 * Best-effort advisory remember after an agent successfully proposes a plan or publishes a report.
 * Never throws; records `report.memory = "unavailable"` if MEMORY or embeddings fail.
 */
export async function rememberOutcomeForAgent(
  env: KernelEnv,
  agentId: string,
  kind: string,
  text: string,
  sourceRef: string | null,
  report: CycleReport,
): Promise<void> {
  if (!env.MEMORY || report.memory === "unavailable") {
    report.memory = "unavailable";
    return;
  }
  try {
    const res = await syscall(env, agentId, "memory.remember", {
      kind,
      text: text.slice(0, MAX_MEMORY_TEXT_LEN),
      source_ref: sourceRef,
    });
    report.actions.push(res);
    if (res.outcome !== "succeeded") {
      report.memory = "unavailable";
    }
  } catch {
    report.memory = "unavailable";
  }
}

/**
 * 90-day retention cleanup executed during the Auditor's daily 00:37 UTC cycle.
 * Deletes at most 100 expired memories per cycle from both Vectorize and D1.
 */
export async function pruneExpiredMemories(
  env: MemoryEnv,
  now = Date.now(),
): Promise<{ deleted: number; memory_ids: string[] }> {
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 3_600_000).toISOString();
  const expired = await env.DB.prepare(
    `SELECT memory_id FROM agent_memories WHERE created_at < ? ORDER BY created_at ASC LIMIT ?`,
  ).bind(cutoff, RETENTION_BATCH_LIMIT).all<{ memory_id: string }>();

  const ids = expired.results.map((r) => r.memory_id);
  if (ids.length === 0) {
    return { deleted: 0, memory_ids: [] };
  }
  if (env.MEMORY) {
    await env.MEMORY.deleteByIds(ids);
  }
  const placeholders = ids.map(() => "?").join(", ");
  await env.DB.prepare(`DELETE FROM agent_memories WHERE memory_id IN (${placeholders})`).bind(...ids).run();
  return { deleted: ids.length, memory_ids: ids };
}
