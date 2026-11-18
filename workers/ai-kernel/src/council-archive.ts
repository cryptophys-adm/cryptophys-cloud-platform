// HAIC H1.5e (docs/design/HAIC-H0-H1.md §4.4 "Records"): the hourly retry of council transcripts. A closed council stores
// its transcript in R2 itself (council.ts archiveTranscript); if that failed (R2 unavailable, the binding not yet
// deployed), this pass asks each such council's Durable Object to store it again, at most 5 an hour, oldest first.
// Read-only in D1; the object writes only its own transcript and row.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import type { CouncilStub } from "./kernel.ts";

export const ARCHIVE_BATCH = 5;
export interface ArchiveEnv { DB: D1Database; COUNCIL?: { idFromName(name: string): unknown; get(id: unknown): CouncilStub }; TRANSCRIPTS?: unknown }

export async function storeMissingTranscripts(env: ArchiveEnv): Promise<{ asked: string[]; stored: string[]; reason?: string }> {
  if (!env.COUNCIL || !env.TRANSCRIPTS) return { asked: [], stored: [], reason: "no_binding" };
  let ids: string[] = [];
  try {
    ids = ((await env.DB.prepare("SELECT session_id FROM councils WHERE transcript_sha256 IS NOT NULL AND transcript_key IS NULL ORDER BY updated_at LIMIT ?")
      .bind(ARCHIVE_BATCH).all<{ session_id: string }>()).results ?? []).map((r) => r.session_id);
  } catch (err) {
    if (/no such (table|column)/i.test(String((err as Error)?.message ?? err))) return { asked: [], stored: [], reason: "not_migrated" };
    throw err;
  }
  const stored: string[] = [];
  for (const id of ids) {
    const r = await env.COUNCIL.get(env.COUNCIL.idFromName(id)).storeTranscript() as { ok: boolean; value?: { stored?: boolean } };
    if (r?.ok && r.value?.stored) stored.push(id);
  }
  return { asked: ids, stored };
}
