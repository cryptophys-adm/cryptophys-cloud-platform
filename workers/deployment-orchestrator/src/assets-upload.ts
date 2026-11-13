// ADR-0012 G2c-2 (§5l): the Console's static assets without GitHub.
//
// The Console UI (workers/console/ui, Vite) is built on Workers Builds by workers/forge-typecheck, which posts
// the built `dist` to the Forge (POST /v1/forge/console-dist, workers/forge/src/console-dist.ts). The Forge
// keeps it in R2 next to the commit's modules: `bundles/<sha>/console-dist/<path>` and a list,
// `bundles/<sha>/console-dist.json` (path, sha256, size, content type). This module uploads such a file set as
// a Worker's static assets through the Workers API, following Cloudflare's "Static Assets: Direct Upload":
//   1. the manifest: `/<path>` -> { hash, size } for every file;
//   2. POST /accounts/{a}/workers/scripts/{name}/assets-upload-session { manifest } -> { jwt, buckets };
//   3. for each bucket (the hashes Cloudflare does not hold yet), POST /accounts/{a}/workers/assets/upload?base64=true,
//      multipart, one part per hash (the base64 content, with the file's content type), authorized by the
//      session JWT, never by the API token; the last answer (201) carries the completion JWT;
//   4. the version upload then sends `assets: { jwt, config }` in its metadata (`assetsMetadata`).
// When every file is already held, `buckets` is empty and the session JWT is the completion token.
// Nothing here deploys; the version that uses the completion JWT receives no traffic until it is deployed.
// Wired into the native deploy by step 6 (native-deploy.ts: readAssetsPlan and the executor), which also uses
// `indexHtmlRefusal` (the deploy workflow's CSP check of index.html) and `sameConsoleDist` (keep or upload).

const API = "https://api.cloudflare.com/client/v4";
/** Workers Free static-asset limits: 25 MiB per file, 20,000 files per version. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_FILES = 20_000;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** A dist path: relative, `/`-separated, no empty, `.` or `..` segment, a conservative character set. */
export const DIST_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+~-]+(?:\/[A-Za-z0-9._@+~-]+)*$/;
export const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:; ?charset=[A-Za-z0-9_-]{1,32})?$/i;

export interface AssetFile { bytes?: Uint8Array; text?: string; contentType: string }
/** Relative dist path (`index.html`, `assets/app-1a2b.js`) -> content. */
export type AssetFileMap = Record<string, AssetFile>;
export type AssetsManifest = Record<string, { hash: string; size: number }>;
export interface AssetsConfig { html_handling?: string; not_found_handling?: string; run_worker_first?: boolean | string[] }

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The extension as Node's path.extname gives it, without the dot: `index.html` -> `html`, `.nojekyll` -> ``. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}

/**
 * THE ASSET HASH RULE, in one place. Cloudflare's "Static Assets: Direct Upload" documentation computes it, in its
 * programmatic example (createManifest), as the first 32 hexadecimal characters of the SHA-256 of the file's
 * base64 encoding followed by its extension without the dot:
 *   sha256(base64(content) + extname(path).substring(1)).hex.slice(0, 32)
 * (read from developers.cloudflare.com/workers/static-assets/direct-upload on 2026-11-12). The API itself only
 * says "a 32 hexadecimal character hash of the file"; the rule must only be stable, because Cloudflare matches
 * files across uploads by it. If it ever disagreed with what the API expects, the upload fails closed: a bucket
 * naming a hash outside our manifest, or no completion token, aborts before any version exists.
 */
export async function assetHash(base64: string, path: string): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(base64 + extensionOf(path)))).slice(0, 32);
}

const bytesOf = (f: AssetFile): Uint8Array | null => f.bytes instanceof Uint8Array ? f.bytes : typeof f.text === "string" ? new TextEncoder().encode(f.text) : null;

export interface PreparedAssets {
  manifest: AssetsManifest;
  /** hash -> the content to send for it. */
  byHash: Map<string, { base64: string; contentType: string; path: string }>;
}

/** Validate a file map against the limits and build the upload manifest. Throws on anything invalid. */
export async function buildAssetsManifest(files: AssetFileMap): Promise<PreparedAssets> {
  const paths = Object.keys(files).sort();
  if (!paths.length) throw new Error("assets_empty");
  if (paths.length > MAX_ASSET_FILES) throw new Error("assets_too_many_files");
  const manifest: AssetsManifest = {};
  const byHash = new Map<string, { base64: string; contentType: string; path: string }>();
  for (const path of paths) {
    if (path.length > 512 || !DIST_PATH.test(path)) throw new Error("asset_path_invalid");
    const f = files[path];
    const bytes = f ? bytesOf(f) : null;
    if (!bytes) throw new Error("asset_content_missing");
    if (bytes.length > MAX_ASSET_BYTES) throw new Error("asset_too_large");
    if (typeof f.contentType !== "string" || !CONTENT_TYPE.test(f.contentType)) throw new Error("asset_content_type_invalid");
    const base64 = toBase64(bytes);
    const hash = await assetHash(base64, path);
    manifest[`/${path}`] = { hash, size: bytes.length };
    // Equal content with the same extension has the same hash: one upload serves both paths.
    const prior = byHash.get(hash);
    if (prior && (prior.base64 !== base64 || prior.contentType !== f.contentType)) throw new Error("asset_hash_collision");
    if (!prior) byHash.set(hash, { base64, contentType: f.contentType, path });
  }
  return { manifest, byHash };
}

/** The `assets` object of the version metadata: the completion token and the `[assets]` routing config as present. */
export function assetsMetadata(jwt: string, config: AssetsConfig): { jwt: string; config: AssetsConfig } {
  if (!JWT.test(jwt) || jwt.length > 8192) throw new Error("assets_jwt_invalid");
  const out: AssetsConfig = {};
  if (config.html_handling !== undefined) out.html_handling = config.html_handling;
  if (config.not_found_handling !== undefined) out.not_found_handling = config.not_found_handling;
  if (config.run_worker_first !== undefined) out.run_worker_first = config.run_worker_first;
  return { jwt, config: out };
}

export interface AssetsUploadResult { jwt: string; manifest: AssetsManifest; uploaded: number; buckets: number }

/** The Workers static-assets upload client. `fetchImpl` is injectable for tests. */
export class AssetsUploader {
  private readonly token: string;
  private readonly account: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, account: string, fetcher: typeof fetch = fetch) {
    if (!/^[0-9a-f]{32}$/.test(account)) throw new Error("invalid_account_id");
    this.token = token;
    this.account = account;
    // Called as a plain function, as in CloudflareWorkers (native-rollback.ts): the runtime's global fetch throws
    // "Illegal invocation" when it is called as a method of another object (this.fetcher(...)), which workerd does.
    this.fetcher = (input, init) => fetcher(input, init);
  }

  private async json<T>(res: Response): Promise<{ status: number; result: T }> {
    const body = await res.json().catch(() => null) as { success?: boolean; result?: T; errors?: { code: number }[] } | null;
    if (!res.ok || !body?.success) throw new Error(`cloudflare_api_${res.status}_${(body?.errors ?? []).map((e) => e.code).join("-") || "error"}`);
    return { status: res.status, result: body.result as T };
  }

  /** Register the manifest. Returns the session JWT and the buckets of hashes still to upload. */
  async startSession(script: string, manifest: AssetsManifest): Promise<{ jwt: string; buckets: string[][] }> {
    if (!/^[a-z0-9-]{1,63}$/.test(script)) throw new Error("invalid_script_name");
    const res = await this.fetcher(`${API}/accounts/${this.account}/workers/scripts/${script}/assets-upload-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    const { result } = await this.json<{ jwt?: unknown; buckets?: unknown }>(res);
    const jwt = result?.jwt;
    const buckets = result?.buckets ?? [];
    if (typeof jwt !== "string" || !JWT.test(jwt)) throw new Error("assets_session_unreadable");
    if (!Array.isArray(buckets) || !buckets.every((b) => Array.isArray(b) && b.every((h) => typeof h === "string" && HEX32.test(h)))) throw new Error("assets_session_unreadable");
    return { jwt, buckets: buckets as string[][] };
  }

  /**
   * Upload each requested bucket with the session JWT. Every hash must be one of ours and appear once; the
   * completion JWT must come with the last bucket's answer and not before.
   */
  async uploadBuckets(sessionJwt: string, buckets: string[][], prepared: PreparedAssets): Promise<{ jwt: string; uploaded: number }> {
    if (!buckets.length) return { jwt: sessionJwt, uploaded: 0 };
    const seen = new Set<string>();
    for (const bucket of buckets) {
      if (!bucket.length) throw new Error("assets_empty_bucket");
      for (const h of bucket) {
        if (!prepared.byHash.has(h)) throw new Error("assets_unknown_bucket_hash");
        if (seen.has(h)) throw new Error("assets_duplicate_bucket_hash");
        seen.add(h);
      }
    }
    let completion: string | null = null;
    let uploaded = 0;
    for (let i = 0; i < buckets.length; i++) {
      const form = new FormData();
      for (const h of buckets[i]) {
        const f = prepared.byHash.get(h)!;
        form.append(h, new Blob([f.base64], { type: f.contentType }), h);
      }
      const res = await this.fetcher(`${API}/accounts/${this.account}/workers/assets/upload?base64=true`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionJwt}` },
        body: form,
      });
      const { status, result } = await this.json<{ jwt?: unknown } | null>(res);
      uploaded += buckets[i].length;
      const jwt = result && typeof result === "object" ? result.jwt : undefined;
      const last = i === buckets.length - 1;
      if (jwt !== undefined && jwt !== null) {
        if (!last) throw new Error("assets_completion_before_last_bucket");
        if (typeof jwt !== "string" || !JWT.test(jwt) || status !== 201) throw new Error("assets_completion_unreadable");
        completion = jwt;
      }
    }
    if (!completion) throw new Error("assets_no_completion_token");
    return { jwt: completion, uploaded };
  }

  /** Manifest, session, buckets: the completion JWT for `assetsMetadata`. */
  async upload(script: string, files: AssetFileMap): Promise<AssetsUploadResult> {
    const prepared = await buildAssetsManifest(files);
    const session = await this.startSession(script, prepared.manifest);
    const done = await this.uploadBuckets(session.jwt, session.buckets, prepared);
    return { jwt: done.jwt, manifest: prepared.manifest, uploaded: done.uploaded, buckets: session.buckets.length };
  }
}

// ---------------------------------------------------------------------------------------------------------
// The Forge's stored dist (written by workers/forge/src/console-dist.ts)
// ---------------------------------------------------------------------------------------------------------

export const CONSOLE_DIST_SCHEMA = "forge-console-dist.v1";
export interface ConsoleDistEntry { path: string; sha256: string; size: number; content_type: string }
export interface ConsoleDistList { schema: typeof CONSOLE_DIST_SCHEMA; commit: string; stored_at: string; total_bytes: number; files: ConsoleDistEntry[] }

/** The read-only subset of the R2 bucket binding this needs. */
export interface DistReader {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>;
}

/** Parse `console-dist.json` strictly; anything unexpected is unreadable (null). */
export function parseConsoleDistList(text: string, commit: string): ConsoleDistList | null {
  let m: Partial<ConsoleDistList>;
  try { m = JSON.parse(text); } catch { return null; }
  if (m?.schema !== CONSOLE_DIST_SCHEMA || m.commit !== commit || !Array.isArray(m.files) || !m.files.length || m.files.length > MAX_ASSET_FILES) return null;
  const seen = new Set<string>();
  let total = 0;
  for (const f of m.files as ConsoleDistEntry[]) {
    if (!f || typeof f.path !== "string" || !DIST_PATH.test(f.path) || f.path.length > 512 || seen.has(f.path)) return null;
    if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) return null;
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_ASSET_BYTES) return null;
    if (typeof f.content_type !== "string" || !CONTENT_TYPE.test(f.content_type)) return null;
    seen.add(f.path);
    total += f.size;
  }
  if (m.total_bytes !== total) return null;
  return m as ConsoleDistList;
}

export const consoleDistListKey = (commit: string) => `bundles/${commit}/console-dist.json`;
export const consoleDistFileKey = (commit: string, path: string) => `bundles/${commit}/console-dist/${path}`;
/** A read failure of the stored dist: its reason and the R2 key it concerns. */
const distError = (code: string, file: string) => Object.assign(new Error(code), { file });

/** A commit's `console-dist.json` alone (no file is read), or null when it is absent or unreadable. */
export async function readConsoleDistList(bucket: DistReader, commit: string): Promise<ConsoleDistList | null> {
  if (!HEX40.test(commit)) return null;
  const obj = await bucket.get(consoleDistListKey(commit));
  return obj ? parseConsoleDistList(await obj.text(), commit) : null;
}

/**
 * Read a commit's Console dist from the Forge's bucket into a file map, with its list, checking every file's
 * SHA-256 and size against the list. Throws `console_dist_missing`, `console_dist_unreadable` or
 * `console_dist_hash_mismatch`; the error's `file` is the R2 key concerned.
 */
export async function readConsoleDistWithList(bucket: DistReader, commit: string): Promise<{ list: ConsoleDistList; files: AssetFileMap }> {
  if (!HEX40.test(commit)) throw new Error("invalid_commit_sha");
  const listKey = consoleDistListKey(commit);
  const obj = await bucket.get(listKey);
  if (!obj) throw distError("console_dist_missing", listKey);
  const list = parseConsoleDistList(await obj.text(), commit);
  if (!list) throw distError("console_dist_unreadable", listKey);
  const files: AssetFileMap = {};
  for (const f of list.files) {
    const key = consoleDistFileKey(commit, f.path);
    const o = await bucket.get(key);
    if (!o) throw distError("console_dist_missing", key);
    const bytes = new Uint8Array(await o.arrayBuffer());
    if (bytes.length !== f.size || await sha256Hex(bytes) !== f.sha256) throw distError("console_dist_hash_mismatch", key);
    files[f.path] = { bytes, contentType: f.content_type };
  }
  return { list, files };
}

/** The file map of `readConsoleDistWithList`. */
export async function readConsoleDist(bucket: DistReader, commit: string): Promise<AssetFileMap> {
  return (await readConsoleDistWithList(bucket, commit)).files;
}

/**
 * Whether two stored dists hold the same files: the same paths with the same SHA-256, size and content type.
 * Equal lists give equal asset hashes (`assetHash` depends only on the content and the extension), so the assets
 * the Workers API holds for one are the assets of the other.
 */
export function sameConsoleDist(a: ConsoleDistList, b: ConsoleDistList): boolean {
  const canon = (l: ConsoleDistList) => JSON.stringify([...l.files].map((f) => [f.path, f.sha256, f.size, f.content_type]).sort());
  return canon(a) === canon(b);
}

/**
 * The deploy workflow's check of the built `index.html`, repeated on the stored one (ADR-0012 §5l step 6). The
 * Console sends CSP `script-src 'self'`, so an inline script would not run and the page would break:
 * deploy-console.yml fails on `grep -Eq '<script>|<script [^>]*>[^<]' dist/index.html` (line by line). This is that
 * test, and stricter, fail closed: every `<script>` element must be closed, carry a `src` and have no content;
 * no inline event handler attribute (`on…=`) and no `javascript:` URL, which `script-src 'self'` blocks as well.
 * Returns the reason, or null when the page passes.
 */
export function indexHtmlRefusal(html: string): string | null {
  for (const line of html.split("\n")) if (/<script>|<script [^>]*>[^<]/.test(line)) return "inline_script";
  const opened = html.match(/<script\b/gi)?.length ?? 0;
  const elements = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (elements.length !== opened) return "inline_script";
  for (const [, attrs, body] of elements) if (!/\ssrc\s*=/i.test(` ${attrs}`) || body.trim() !== "") return "inline_script";
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) return "inline_event_handler";
  if (/javascript:/i.test(html)) return "inline_script";
  return null;
}
