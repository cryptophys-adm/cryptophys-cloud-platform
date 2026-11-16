// Cut-over gate (owner 2026-11-15, "1 setuju"): the D1 Time Travel bookmark a native deploy reads before it applies a
// destructive migration (control-plane-shared/src/destructive-deploy.ts). deploy-control-plane.yml logs the same
// bookmark before `wrangler d1 migrations apply` ("Pre-migration D1 bookmark"); after the cut-over step 6 this is
// that record.
//
// Read only, with CF_DEPLOY_TOKEN, which needs Account → D1 → Read (or Edit) for the bookmark (D1_BOOKMARK_PERMISSION):
//   1. the database: the `DB` D1 binding of the Orchestrator's own running version (CF_VERSION_METADATA.id, else its
//      active deployment), the database the migrations are applied through (Workers Scripts read, as for every deploy);
//   2. GET /accounts/{account_id}/d1/database/{database_id}/time_travel/bookmark: the current bookmark (Cloudflare API,
//      D1 → Database → Time Travel → Get Bookmark; docs checked 2026-11-15, D1 Time Travel last updated 2026-11-06).
// Never restores: a D1 restore overwrites the database for every service and is the owner's (OPERATIONS).
import { D1_BOOKMARK, D1_BOOKMARK_PERMISSION } from "../../control-plane-shared/src/destructive-deploy.ts";
import type { RestorePoint } from "./native-deploy.ts";
import type { CloudflareWorkers } from "./native-rollback.ts";

const API = "https://api.cloudflare.com/client/v4";
export const ORCHESTRATOR_SCRIPT = "cryptophys-deployment-orchestrator";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const D1_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;

/** The `DB` D1 binding's database id in a version's binding records, or null. */
export function d1DatabaseId(bindings: unknown): string | null {
  if (!Array.isArray(bindings)) return null;
  const db = bindings.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "d1" && (b as { name?: unknown }).name === "DB");
  if (db.length !== 1) return null;
  const id = (db[0] as { id?: unknown; database_id?: unknown }).id ?? (db[0] as { database_id?: unknown }).database_id;
  return typeof id === "string" && D1_ID.test(id) ? id : null;
}

/**
 * Read the current bookmark of the control-plane database. Throws with a reason (never returns a guess):
 * `own_version_unreadable`, `d1_binding_unreadable`, `d1_permission_missing: …` (401/403, naming the permission),
 * `cloudflare_d1_api_<status>` or `bookmark_unreadable`.
 */
export async function readD1RestorePoint(
  cf: Pick<CloudflareWorkers, "active" | "version">, token: string, account: string, ownVersionId: string | undefined,
  fetcher: typeof fetch = fetch, now = () => new Date(),
): Promise<RestorePoint> {
  let versionId = typeof ownVersionId === "string" && UUID.test(ownVersionId) ? ownVersionId : null;
  let bindings: unknown;
  try {
    if (!versionId) {
      const active = await cf.active(ORCHESTRATOR_SCRIPT);
      if (active.length !== 1 || active[0].percentage !== 100) throw new Error("split");
      versionId = active[0].version_id;
    }
    bindings = (await cf.version(ORCHESTRATOR_SCRIPT, versionId)).resources?.bindings;
  } catch {
    throw new Error("own_version_unreadable");
  }
  const databaseId = d1DatabaseId(bindings);
  if (!databaseId) throw new Error("d1_binding_unreadable");
  const call = (input: string, init: RequestInit) => fetcher(input, init);
  const res = await call(`${API}/accounts/${account}/d1/database/${databaseId}/time_travel/bookmark`, {
    method: "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) throw new Error(`d1_permission_missing: ${D1_BOOKMARK_PERMISSION}`);
  const body = await res.json().catch(() => null) as { success?: boolean; result?: { bookmark?: unknown }; errors?: { code: number }[] } | null;
  if (!res.ok || !body?.success) throw new Error(`cloudflare_d1_api_${res.status}_${(body?.errors ?? []).map((e) => e.code).join("-") || "error"}`);
  const bookmark = body.result?.bookmark;
  if (typeof bookmark !== "string" || bookmark.length > 160 || !D1_BOOKMARK.test(bookmark)) throw new Error("bookmark_unreadable");
  return { bookmark, database_id: databaseId, read_at: now().toISOString() };
}
