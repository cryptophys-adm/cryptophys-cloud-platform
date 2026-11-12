// ADR-0012 G2c-2 (§5l): the Forge keeps the built Console UI of a main commit.
//
// POST /v1/forge/console-dist {confirm: "UPLOAD", commit, files: [{path, content_base64, content_type}]}
// from the CI service token only, the same way /v1/forge/typecheck-report is authorized: the Workers Builds run
// of workers/forge-typecheck builds workers/console/ui and posts its `dist` here. The files go to the R2 bucket
// `cryptophys-forge-bundles` beside the commit's modules (G2a):
//   - `bundles/<sha>/console-dist/<path>` for each file;
//   - `bundles/<sha>/console-dist.json` last (path, sha256, size, content type of each), so a reader that finds the
//     list finds every file it names.
// The Deployment Orchestrator uploads them as the Console's static assets (deployment-orchestrator/src/
// assets-upload.ts), so a Console deploy no longer needs GitHub Actions to build. A commit's dist is written once:
// the same files again are accepted unchanged, different files are refused (409). Bundles are pruned with the
// rest of `bundles/` after 14 days (bundles.ts).
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { actorOf, type AccessIdentity } from "../../control-plane-shared/src/access.ts";
import { errorResponse, json, readJsonObject } from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";

export const CONSOLE_DIST_SCHEMA = "forge-console-dist.v1";
/** Workers Free static-asset limits: 25 MiB per file, 20,000 files per version. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20_000;
/** One request carries one file of the maximum size in base64 with room to spare (an isolate has 128 MB). */
export const MAX_BODY_BYTES = 36 * 1024 * 1024;
const HEX40 = /^[0-9a-f]{40}$/;
/** Relative, `/`-separated, no empty, `.` or `..` segment, a conservative character set (Vite output fits). */
export const DIST_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+~-]+(?:\/[A-Za-z0-9._@+~-]+)*$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:; ?charset=[A-Za-z0-9_-]{1,32})?$/i;

/** The subset of the R2 bucket binding this route uses. */
export interface DistBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string | Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}
export interface ConsoleDistEnv { DB: D1Database; BUNDLES?: DistBucket }
export interface ConsoleDistEntry { path: string; sha256: string; size: number; content_type: string }
export interface ConsoleDistList { schema: typeof CONSOLE_DIST_SCHEMA; commit: string; stored_at: string; total_bytes: number; files: ConsoleDistEntry[] }

const bad = (code: string, status = 400) => Object.assign(new Error(code), { status });

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical base64 (a multiple of 4, padding only at the end), checked in one linear pass: a regular expression
 *  with a repeated group overflows the stack on a 25 MiB file. */
export function isBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  for (let i = 0; i < s.length - pad; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (!ok) return false;
  }
  return true;
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ValidatedDist { commit: string; files: Array<ConsoleDistEntry & { bytes: Uint8Array }> }

/** Validate the request body. Throws a 400 with the first problem found. */
export async function validateConsoleDist(input: Record<string, unknown>): Promise<ValidatedDist> {
  const commit = typeof input.commit === "string" ? input.commit : "";
  if (!HEX40.test(commit)) throw bad("invalid_commit");
  const raw = input.files;
  if (!Array.isArray(raw) || raw.length === 0) throw bad("invalid_files");
  if (raw.length > MAX_FILES) throw bad("too_many_files");
  const seen = new Set<string>();
  const files: ValidatedDist["files"] = [];
  for (const f of raw as Array<Record<string, unknown>>) {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw bad("invalid_file");
    const path = f.path;
    if (typeof path !== "string" || path.length > 512 || !DIST_PATH.test(path)) throw bad("invalid_path");
    if (seen.has(path)) throw bad("duplicate_path");
    seen.add(path);
    const type = f.content_type;
    if (typeof type !== "string" || !CONTENT_TYPE.test(type)) throw bad("invalid_content_type");
    const b64 = f.content_base64;
    if (typeof b64 !== "string") throw bad("invalid_content");
    // Checked before decoding: base64 is 4/3 of the bytes.
    if (Math.floor(b64.length / 4) * 3 > MAX_FILE_BYTES + 2) throw bad("file_too_large");
    if (!isBase64(b64)) throw bad("invalid_content");
    const bytes = decodeBase64(b64);
    if (bytes.length > MAX_FILE_BYTES) throw bad("file_too_large");
    files.push({ path, sha256: await sha256Hex(bytes), size: bytes.length, content_type: type.toLowerCase(), bytes });
  }
  if (!seen.has("index.html")) throw bad("index_html_missing");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { commit, files };
}

const listKey = (commit: string) => `bundles/${commit}/console-dist.json`;
const sameFiles = (a: ConsoleDistEntry[], b: ConsoleDistEntry[]) => a.length === b.length
  && a.every((x, i) => x.path === b[i].path && x.sha256 === b[i].sha256 && x.size === b[i].size && x.content_type === b[i].content_type);

/** Store a validated dist. Idempotent for the same files; different files for a stored commit are refused (409). */
export async function storeConsoleDist(env: ConsoleDistEnv, dist: ValidatedDist, actor: string, nowMs = Date.now()): Promise<{ commit: string; files: number; total_bytes: number; stored: boolean }> {
  const bucket = env.BUNDLES;
  if (!bucket) throw bad("bundles_not_configured", 503);
  const entries: ConsoleDistEntry[] = dist.files.map(({ path, sha256, size, content_type }) => ({ path, sha256, size, content_type }));
  const total = entries.reduce((n, f) => n + f.size, 0);
  const existing = await bucket.get(listKey(dist.commit));
  if (existing) {
    let prior: ConsoleDistList | null = null;
    try { prior = JSON.parse(await existing.text()); } catch { prior = null; }
    if (prior?.schema === CONSOLE_DIST_SCHEMA && Array.isArray(prior.files) && sameFiles(prior.files, entries)) {
      return { commit: dist.commit, files: entries.length, total_bytes: total, stored: false };
    }
    throw bad("console_dist_conflict", 409);
  }
  for (const f of dist.files) {
    await bucket.put(`bundles/${dist.commit}/console-dist/${f.path}`, f.bytes, {
      httpMetadata: { contentType: f.content_type },
      customMetadata: { sha256: f.sha256, commit: dist.commit },
    });
  }
  const list: ConsoleDistList = { schema: CONSOLE_DIST_SCHEMA, commit: dist.commit, stored_at: new Date(nowMs).toISOString(), total_bytes: total, files: entries };
  // The list goes last: a reader that finds it finds every file it names.
  await bucket.put(listKey(dist.commit), JSON.stringify(list), { httpMetadata: { contentType: "application/json" } });
  await appendAuditEvent(env.DB, {
    event_type: "forge.console_dist_stored", actor, subject: dist.commit, outcome: "stored",
    payload: { files: entries.length, total_bytes: total, index_sha256: entries.find((f) => f.path === "index.html")?.sha256 ?? null },
  });
  return { commit: dist.commit, files: entries.length, total_bytes: total, stored: true };
}

/** The route handler. The caller has already passed the Access gate and requireOperator. */
export async function handleConsoleDist(request: Request, env: ConsoleDistEnv, identity: AccessIdentity): Promise<Response> {
  if (identity.type !== "service_token") return errorResponse(403, "service_token_required");
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  if (body.value.confirm !== "UPLOAD") return errorResponse(400, "confirmation_required", 'type "UPLOAD" to store a Console build');
  try {
    const dist = await validateConsoleDist(body.value);
    return json(await storeConsoleDist(env, dist, actorOf(identity)));
  } catch (err) {
    const e = err as Error & { status?: number };
    if (!e.status) throw err;
    return errorResponse(e.status, e.message);
  }
}
