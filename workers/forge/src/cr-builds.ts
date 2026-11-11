// ADR-0012 §5d (owner 2026-11-11, "langkah B"): the type-check of change requests, read by the Forge itself.
//
// The Workers Builds project cryptophys-forge-typecheck-cr builds every cr/<number> branch with no build
// secrets (workers/forge-typecheck-cr). Its build log carries one line, FORGE_TYPECHECK_RESULT {...}. Each
// tick, for the open change requests whose head has no type-check report yet, the Forge lists that Worker's
// builds through the Workers Builds API with its own secret CF_BUILDS_API_TOKEN, reads the log of the newest
// finished build of the request's branch, and records the line as the head's report when its commit equals
// the head (recordTypecheckReport, the same validation as the CI route). Without the secret the step is a
// no-op. The Forge only reads (GET); the token is never logged or stored.
//
// Preview builds (Worker Previews) may be listed only under their Preview, not in the Worker's build list
// (2026-11-11: the first live tick found no cr/290 build there). When the Worker's list has no finished build
// of a request's branch, the Forge reads that branch's Preview (GET .../previews, then .../previews/{id}/builds).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { recordTypecheckReport } from "./typecheck.ts";

export const CR_TYPECHECK_WORKER = "cryptophys-forge-typecheck-cr";
export const RESULT_MARKER = "FORGE_TYPECHECK_RESULT ";
const API = "https://api.cloudflare.com/client/v4";
const HEX40 = /^[0-9a-f]{40}$/;
const MAX_REQUESTS_PER_TICK = 9;

export interface CrBuildsEnv { DB: D1Database; CF_BUILDS_API_TOKEN?: string; CR_TYPECHECK_WORKER?: string }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface BuildRow { build_uuid?: string; status?: string; build_outcome?: string | null; created_on?: string; build_trigger_metadata?: Record<string, unknown> | null }
interface PreviewRow { preview_id?: string; id?: string; branch?: string }

/** Every string inside a JSON value (build logs come as nested arrays and objects). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** The last FORGE_TYPECHECK_RESULT object in a build log response, or null. */
export function resultFromLogs(logs: unknown): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const s of strings(logs)) {
    for (const line of s.split("\n")) {
      const i = line.indexOf(RESULT_MARKER);
      if (i < 0) continue;
      try {
        const obj = JSON.parse(line.slice(i + RESULT_MARKER.length).trim());
        if (obj && typeof obj === "object" && !Array.isArray(obj)) found = obj as Record<string, unknown>;
      } catch { /* not a result line */ }
    }
  }
  return found;
}

const branchOf = (b: BuildRow) => String(b.build_trigger_metadata?.branch ?? "");
const commitOf = (b: BuildRow) => String(b.build_trigger_metadata?.commit_hash ?? b.build_trigger_metadata?.commit_sha ?? "").toLowerCase();
const finished = (b: BuildRow) => b.status === "stopped" || b.status === "completed" || (b.build_outcome != null && b.build_outcome !== "");

async function api(fetchImpl: Fetch, token: string, path: string): Promise<unknown> {
  const res = await fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null) as { success?: boolean; result?: unknown; errors?: unknown } | null;
  if (!res.ok || !body || body.success === false) throw new Error(`builds_api_${res.status}: ${path.replace(/[0-9a-f]{32}/g, "<id>")}`);
  return body.result;
}

/** One Forge tick of the change-request type-check reader. Never throws for an unconfigured Forge. */
export async function crBuildsTick(env: CrBuildsEnv, nowMs = Date.now(), fetchImpl: Fetch = fetch): Promise<Record<string, unknown>> {
  const token = env.CF_BUILDS_API_TOKEN?.trim();
  if (!token) return { outcome: "not_configured" };
  const open = (await env.DB.prepare(
    `SELECT c.number, c.head_sha FROM forge_change_requests c LEFT JOIN forge_typecheck_reports t ON t.commit_sha = c.head_sha
     WHERE c.status = 'open' AND t.commit_sha IS NULL ORDER BY c.updated_at DESC LIMIT 10`,
  ).all<{ number: number; head_sha: string }>()).results ?? [];
  if (!open.length) return { outcome: "up_to_date" };
  const accounts = await api(fetchImpl, token, "/accounts?per_page=5") as Array<{ id?: string }>;
  const account = accounts?.[0]?.id;
  if (!account) return { outcome: "no_account" };
  const name = env.CR_TYPECHECK_WORKER || CR_TYPECHECK_WORKER;
  const scripts = await api(fetchImpl, token, `/accounts/${account}/workers/scripts`) as Array<{ id?: string; tag?: string }>;
  const tag = scripts?.find((s) => s.id === name)?.tag;
  if (!tag) return { outcome: "no_project", worker: name };
  const builds = (await api(fetchImpl, token, `/accounts/${account}/builds/workers/${tag}/builds?per_page=50`) as BuildRow[]) ?? [];
  let requests = 3; // accounts, scripts and builds; then Preview lookups and logs, within MAX_REQUESTS_PER_TICK
  const recorded: Array<{ number: number; commit: string; conclusion: string }> = [];
  const sameCommit = (b: BuildRow, head: string) => !commitOf(b) || head.startsWith(commitOf(b)) || commitOf(b).startsWith(head);
  const newestFinished = (list: BuildRow[], head: string) => list
    .filter((b) => finished(b) && b.build_uuid && sameCommit(b, head))
    .sort((a, b) => String(b.created_on ?? "").localeCompare(String(a.created_on ?? "")))
    .slice(0, 1);
  let previews: PreviewRow[] | null = null;
  let viaPreview = 0;
  for (const cr of open) {
    if (!HEX40.test(cr.head_sha)) continue;
    const branch = `cr/${cr.number}`;
    let candidates = newestFinished(builds.filter((b) => branchOf(b) === branch), cr.head_sha);
    if (!candidates.length && requests + 2 < MAX_REQUESTS_PER_TICK) {
      // The branch's Preview holds its builds (Worker Previews); its builds all belong to that branch.
      if (previews === null) {
        requests++;
        previews = ((await api(fetchImpl, token, `/accounts/${account}/builds/workers/${tag}/previews`)) as PreviewRow[]) ?? [];
      }
      const preview = previews.find((p) => p.branch === branch);
      const previewId = String(preview?.preview_id ?? preview?.id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
      if (previewId) {
        requests++;
        const own = ((await api(fetchImpl, token, `/accounts/${account}/builds/workers/${tag}/previews/${previewId}/builds`)) as BuildRow[]) ?? [];
        candidates = newestFinished(own.filter((b) => !branchOf(b) || branchOf(b) === branch), cr.head_sha);
        if (candidates.length) viaPreview++;
      }
    }
    for (const b of candidates) {
      if (requests >= MAX_REQUESTS_PER_TICK) break;
      requests++;
      const result = resultFromLogs(await api(fetchImpl, token, `/accounts/${account}/builds/builds/${b.build_uuid}/logs`));
      if (!result || result.commit !== cr.head_sha) continue;
      // The same validation as POST /v1/forge/typecheck-report; the build id is the Builds UUID it was read from.
      const r = await recordTypecheckReport(env.DB, { ...result, build_id: String(b.build_uuid).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64), branch: `cr/${cr.number}` }, "system:forge-cr-builds", nowMs);
      recorded.push({ number: cr.number, commit: r.commit, conclusion: r.conclusion });
    }
  }
  return { outcome: recorded.length ? "recorded" : "waiting", open: open.length, recorded, builds_listed: builds.length, previews_listed: previews?.length ?? null, via_preview: viaPreview };
}
