/**
 * Exact-duplicate dedup for learning (owner 2026-11-14, after the learning mandate): not a cap. memory.remember and
 * knowledge.propose compute a content hash; when the same agent already holds an identical row, the call succeeds
 * with that row's id and writes nothing new. Nothing is refused, and new or different content is always written.
 *
 * What is normalized, exactly (and nothing else):
 *  - memory.remember: hash of ["cryptophys.memory-dedup.v1", agent_id, kind, text].
 *      agent_id as it is (the Policy Engine's verified subject); kind trimmed; text trimmed and every run of
 *      whitespace (spaces, tabs, line breaks) collapsed into one space. Case is kept: memory text is natural language
 *      whose case can carry names and codes, so "Audit OK" and "audit ok" are different memories. source_ref is not
 *      part of the hash: it is provenance, not content.
 *  - knowledge.propose: hash of ["cryptophys.knowledge-dedup.v1", agent_id, item_id, item without "version"].
 *      The item's object keys are sorted (at every depth), every string is trimmed with its whitespace runs
 *      collapsed, array order and case are kept, numbers and booleans are as they are. The version is left out, so
 *      the same claim proposed again under a new version is the same knowledge. A proposal that expired unreviewed is
 *      not a duplicate (the agent may propose it again, by design), so expired rows are never matched.
 *
 * Rows written before migration 0067 have no hash and are never matched; an exact resubmission of an old knowledge
 * item under its own item_id and version still returns the existing row (knowledge.ts compares content_sha256).
 */

export const MEMORY_DEDUP_VERSION = "cryptophys.memory-dedup.v1";
export const KNOWLEDGE_DEDUP_VERSION = "cryptophys.knowledge-dedup.v1";

/** Trim and collapse every whitespace run into one space; case is kept. */
export const normalizeText = (s: string): string => s.trim().replace(/\s+/g, " ");

/** Sorted keys at every depth, normalized strings; arrays keep their order. */
export function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = normalizeValue((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function memoryDedupHash(agentId: string, kind: string, text: string): Promise<string> {
  return sha256Hex(JSON.stringify([MEMORY_DEDUP_VERSION, agentId, kind.trim(), normalizeText(text)]));
}

export function knowledgeDedupHash(agentId: string, item: Record<string, unknown>): Promise<string> {
  const { version: _version, ...content } = item;
  return sha256Hex(JSON.stringify([KNOWLEDGE_DEDUP_VERSION, agentId, String(item.item_id ?? ""), normalizeValue(content)]));
}

/** Before migration 0067 the column does not exist: dedup is skipped and the call goes on as before. */
export const missingDedupColumn = (err: unknown): boolean => /no such column:?\s*dedup_sha256|has no column named dedup_sha256/i.test(String((err as Error)?.message ?? err));
