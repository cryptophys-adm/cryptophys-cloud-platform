// ADR-0012 G2c-1: the files a Worker bundle imports but does not inline (its extra modules), read from the
// package the commit's lockfile pins, the way `npm ci` installs it for the GitHub deploy.
//
// A snapshot of the repository has no node_modules (they are not committed), and a Worker module such as
// esbuild-wasm's esbuild.wasm is binary. For an external under `<root>/node_modules/<package>/<file>`, the Forge
// reads `<root>/package-lock.json` from the same commit, fetches the package tarball the lockfile names (the npm
// registry only), checks it against the lockfile's sha512 integrity before reading anything from it, and takes
// the file out of the tar. Anything else (no lockfile entry, another registry, a file not in the package, an
// external outside node_modules) is unresolved, and a different digest is an error: that Worker's manifest then
// has no `modules`, and its deploy stays on the GitHub workflow.
import type { Snapshot } from "./runner/core.ts";

/** The bytes of each external path it can resolve (absent: unresolved). */
export type ExternalSource = (paths: string[]) => Promise<Map<string, Uint8Array>>;

const REGISTRY = "https://registry.npmjs.org/";
/** A package tarball larger than this is not read (esbuild-wasm is about 5 MB, sql.js about 10 MB). */
export const MAX_TARBALL_BYTES = 48 * 1024 * 1024;
/** A single file taken from a tarball larger than this is refused. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

interface LockEntry { resolved?: unknown; integrity?: unknown }

/** `<root>/node_modules/a/node_modules/@s/b/x/y.js` -> { root, key: "node_modules/a/node_modules/@s/b", file: "x/y.js" }. */
export function lockLocation(path: string): { root: string; key: string; file: string } | null {
  const at = path.indexOf("/node_modules/");
  if (at <= 0) return null;
  const root = path.slice(0, at);
  const parts = path.slice(at + 1).split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const key: string[] = [];
  let i = 0;
  while (parts[i] === "node_modules") {
    const scoped = parts[i + 1]?.startsWith("@");
    const name = scoped ? parts.slice(i + 1, i + 3) : parts.slice(i + 1, i + 2);
    if (name.length !== (scoped ? 2 : 1)) return null;
    key.push("node_modules", ...name);
    i += 1 + name.length;
  }
  const file = parts.slice(i).join("/");
  return file ? { root, key: key.join("/"), file } : null;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new Error("tarball_too_large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const field = (h: Uint8Array, start: number, len: number) => {
  const end = h.subarray(start, start + len).indexOf(0);
  return new TextDecoder().decode(h.subarray(start, start + (end < 0 ? len : end)));
};
const octal = (h: Uint8Array, start: number, len: number) => {
  const s = field(h, start, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error("tar_header_unreadable");
  return s ? Number.parseInt(s, 8) : 0;
};

/** A byte queue over a stream: reads only as far as asked, and copies a kept byte once. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader(); }
  /** True when at least n bytes are buffered (false at the end of the stream). */
  async need(n: number): Promise<boolean> {
    while (this.size < n && !this.done) {
      const r = await this.reader.read();
      if (r.done) { this.done = true; break; }
      if (r.value.length) { this.chunks.push(r.value); this.size += r.value.length; }
    }
    return this.size >= n;
  }
  /** Remove n buffered bytes; returns them when `keep`. */
  take(n: number, keep: boolean): Uint8Array | null {
    const out = keep ? new Uint8Array(n) : null;
    let o = 0;
    while (o < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - o);
      if (out) out.set(c.subarray(0, k), o);
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
      o += k;
    }
    this.size -= n;
    return out;
  }
  /** Skip n bytes, reading the stream as it goes. */
  async skip(n: number): Promise<boolean> {
    let left = n;
    while (left > 0) {
      if (!(await this.need(1))) return false;
      const k = Math.min(left, this.size);
      this.take(k, false);
      left -= k;
    }
    return true;
  }
  async close(): Promise<void> { await this.reader.cancel().catch(() => undefined); }
}

/**
 * The regular files of a tar archive (ustar, with pax `path` records and GNU long names), from the decompressed
 * stream, keeping only the paths `want` asks for. The first path segment (npm's `package/`) is removed.
 */
export async function untar(stream: ReadableStream<Uint8Array>, want: (path: string) => boolean): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const q = new ByteQueue(stream);
  let longName: string | null = null;
  try {
    for (;;) {
      if (!(await q.need(512))) break;
      const h = q.take(512, true)!;
      if (h.every((b) => b === 0)) break;
      const size = octal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 48);
      const padded = Math.ceil(size / 512) * 512;
      const prefix = field(h, 345, 155);
      const name = (longName ?? (prefix ? prefix + "/" : "") + field(h, 0, 100)).split("/").slice(1).join("/");
      longName = null;
      const meta = type === "x" || type === "L";
      if (!meta && !(type === "0" && want(name))) {
        if (!(await q.skip(padded))) throw new Error("tar_truncated");
        continue;
      }
      if (size > MAX_FILE_BYTES) throw new Error("tar_entry_too_large");
      if (!(await q.need(size))) throw new Error("tar_truncated");
      const body = q.take(size, true)!;
      if (!(await q.skip(padded - size))) throw new Error("tar_truncated");
      if (type === "x") {
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
        if (m) longName = m[1];
      } else if (type === "L") {
        longName = new TextDecoder().decode(body).replace(/\0+$/, "");
      } else {
        files.set(name, body);
      }
    }
  } finally {
    await q.close();
  }
  return files;
}

/**
 * The external files of one commit, from the npm packages its lockfiles pin. Each package is fetched, checked and
 * read once per call, however many of its files are asked for. A path that cannot be resolved is left out.
 */
export function lockfileSource(snapshot: Snapshot, fetcher: typeof fetch = fetch): ExternalSource {
  return async (paths: string[]) => {
    const out = new Map<string, Uint8Array>();
    const byPackage = new Map<string, { resolved: string; integrity: string; files: Map<string, string> }>();
    for (const path of paths) {
      const loc = lockLocation(path);
      if (!loc) continue;
      const lockText = snapshot[`${loc.root}/package-lock.json`];
      if (lockText === undefined) continue;
      let entry: LockEntry | undefined;
      try { entry = (JSON.parse(lockText) as { packages?: Record<string, LockEntry> }).packages?.[loc.key]; } catch { continue; }
      const resolved = typeof entry?.resolved === "string" ? entry.resolved : "";
      const integrity = typeof entry?.integrity === "string" ? entry.integrity : "";
      if (!resolved.startsWith(REGISTRY) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) continue;
      const key = `${resolved} ${integrity}`;
      if (!byPackage.has(key)) byPackage.set(key, { resolved, integrity, files: new Map() });
      byPackage.get(key)!.files.set(loc.file, path);
    }
    for (const pkg of byPackage.values()) {
      const res = await fetcher(pkg.resolved, { headers: { accept: "application/octet-stream" } });
      if (!res.ok || !res.body) continue;
      const tgz = await readAll(res.body, MAX_TARBALL_BYTES);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", tgz as BufferSource));
      // Nothing is read from a tarball the lockfile does not pin.
      if (`sha512-${base64(digest)}` !== pkg.integrity) throw new Error(`integrity_mismatch: ${pkg.resolved}`);
      const files = await untar(new Blob([tgz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")), (p) => pkg.files.has(p));
      for (const [file, path] of pkg.files) { const bytes = files.get(file); if (bytes) out.set(path, bytes); }
    }
    return out;
  };
}
