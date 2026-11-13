// ADR-0012 gate 8 (§5m): the off-Artifacts copy of the canonical repository, a daily git bundle in R2.
//
// After the cut-over (G6) GitHub is archived, and Artifacts (a beta product) holds the only live copy of
// cryptophys/platform. This tick step keeps a second copy outside Artifacts. At most once per UTC day per head of
// main (and an hour after a failed run of that head), it:
//   1. mints a read token for `platform` with a 120 s TTL (as G4 does for platform-work) and checks that the
//      repository's remote is this account's Artifacts host and that exact path (trustedRemoteFor);
//   2. runs Git smart-HTTP upload-pack (protocol v0, stateless): ref discovery (GET info/refs), then one fetch
//      (POST git-upload-pack) that wants the head of every refs/heads/* (main required), sends `done` and no
//      `have` lines, so the answer is a full clone. side-band-64k (or side-band) is requested when advertised and
//      demultiplexed: band 1 is the pack, band 2 progress (ignored), band 3 a fatal error. NAK and ACK lines
//      before the pack are read and skipped; ERR fails the run;
//   3. checks the result is a packfile: "PACK", version 2 or 3, at least one object, and a trailing SHA-1 equal to
//      the SHA-1 of everything before it. Anything else fails the run, and nothing is written;
//   4. writes a git bundle v2 (`# v2 git bundle`, `<sha> HEAD`, one `<sha> <ref>` line per branch, a blank line,
//      the pack) to R2 at git-backups/platform/<UTC date>-<main sha>.bundle, with its SHA-256, size, object count
//      and pack checksum in customMetadata;
//   5. records the run in D1 (forge_git_backups, migration 0054) and audits forge.git_backup_written, or
//      forge.git_backup_failed with the reason;
//   6. retention: R2 keeps the newest bundle of each of the last GIT_BACKUP_RETAINED_DAYS UTC days that have one.
//
// Memory. The Worker has 128 MB. The pack is held once as chunks and once as the bundle buffer while the bundle is
// assembled, so the pack is capped at MAX_PACK_BYTES (32 MiB, about 64 MiB at the peak). A larger pack fails the
// run with `pack_too_large` and nothing is written (never a truncated bundle). Measured 2026-11-13 on a full clone
// of main (359 commits, 5,114 objects): 2.3 MB as git packs it with deltas, 8.5 MB with no deltas at all.
//
// The token goes only into the Authorization header. It is never logged, stored, audited or returned, and any error
// text is scrubbed of it before it is recorded.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { GIT_BACKUP_PREFIX, GIT_BACKUP_RETAINED_DAYS, GIT_BACKUP_ROW_RETENTION_DAYS, type GitBackupRef } from "../../control-plane-shared/src/git-backup.ts";
import { canonicalMainHead } from "./census.ts";
import type { ArtifactsReader } from "./checks.ts";
import { CANONICAL_REPO, FLUSH, ZERO_SHA, discoverRefs, gitHeaders, pktLine, remoteBase, tokenSecret, trustedRemoteFor, validBranch, validSha, type Advertisement, type Fetch } from "./merge.ts";

export const GIT_BACKUP_TOKEN_TTL_S = 120;
/** A failed run of the same head is retried after this long. */
export const GIT_BACKUP_RETRY_MS = 3_600_000;
/** The largest pack the Worker assembles (see "Memory" above). */
export const MAX_PACK_BYTES = 32 * 1024 * 1024;
/** Branches in one bundle; more fails the run (`too_many_refs`) rather than leaving some out. */
export const MAX_REFS = 5_000;
/** The fetch must finish within the read token's lifetime. */
export const FETCH_TIMEOUT_MS = 110_000;
/** Bundles deleted by retention per run; the next run continues. */
export const MAX_PRUNE_DELETES = 100;
export const BUNDLE_SIGNATURE = "# v2 git bundle\n";
export const BUNDLE_CONTENT_TYPE = "application/x-git-bundle";
const ACTOR = "system:forge-git-backup";
const KEY = /^git-backups\/platform\/(\d{4}-\d{2}-\d{2})-([0-9a-f]{40})\.bundle$/;

export class GitBackupError extends Error {}
const fail = (reason: string): never => { throw new GitBackupError(reason); };

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const printable = (v: string, n = 160) => v.replace(/[^\x20-\x7e]/g, "?").trim().slice(0, n);

// ---------------------------------------------------------------- refs and the request

/**
 * The refs a backup holds: every valid refs/heads/* branch (main required), sorted by name, then HEAD (= main),
 * in the order `git bundle create --all` writes them, so a clone of the bundle checks out main.
 */
export function selectRefs(adv: Advertisement): { refs: GitBackupRef[]; main: string; skipped: number } {
  const main = adv.refs.get("refs/heads/main");
  if (!main || !validSha(main) || main === ZERO_SHA) fail("main_not_advertised");
  const heads: GitBackupRef[] = [];
  let skipped = 0;
  for (const [name, sha] of adv.refs) {
    if (!name.startsWith("refs/heads/")) continue;
    if (validBranch(name.slice("refs/heads/".length)) && validSha(sha) && sha !== ZERO_SHA) heads.push({ name, sha }); else skipped++;
  }
  if (heads.length > MAX_REFS) fail("too_many_refs");
  heads.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { refs: [...heads, { name: "HEAD", sha: main! }], main: main!, skipped };
}

export type Sideband = "side-band-64k" | "side-band" | null;

/** The capabilities this client asks for, from what the server advertised. */
export function chooseCapabilities(advertised: ReadonlySet<string>): { caps: string[]; sideband: Sideband } {
  const sideband: Sideband = advertised.has("side-band-64k") ? "side-band-64k" : advertised.has("side-band") ? "side-band" : null;
  const caps: string[] = [];
  if (sideband) caps.push(sideband);
  if (advertised.has("ofs-delta")) caps.push("ofs-delta");
  if (sideband && advertised.has("no-progress")) caps.push("no-progress");
  if ([...advertised].some((c) => c.startsWith("agent="))) caps.push("agent=cryptophys-forge/1");
  return { caps, sideband };
}

/**
 * The upload-pack request: the wants (capabilities on the first), a flush, then `done`. A full clone sends no
 * haves; a transfer (transfer.ts) names the commits the receiving repository already has, so the pack omits
 * what they reach.
 */
export function uploadPackRequest(wants: string[], caps: string[], haves: string[] = []): Uint8Array<ArrayBuffer> {
  const unique = [...new Set(wants)];
  if (!unique.length || !unique.every(validSha)) fail("invalid_wants");
  if (!haves.every(validSha)) fail("invalid_haves");
  const parts: Uint8Array[] = unique.map((w, i) => pktLine(i === 0 && caps.length ? `want ${w} ${caps.join(" ")}\n` : `want ${w}\n`));
  parts.push(FLUSH);
  for (const h of [...new Set(haves)].filter((h) => !unique.includes(h)).slice(0, 32)) parts.push(pktLine(`have ${h}\n`));
  parts.push(pktLine("done\n"));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------------------------------------------------------------- the response

/** Reads exact byte counts from a stream, without copying when the bytes lie in one chunk. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private head = 0;
  private offset = 0;
  private available = 0;
  private ended = false;
  total = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private limit: number;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number) { this.reader = reader; this.limit = limit; }

  private async fill(n: number): Promise<boolean> {
    while (this.available < n && !this.ended) {
      const r = await this.reader.read();
      if (r.done) { this.ended = true; break; }
      const c = r.value;
      this.total += c.length;
      if (this.total > this.limit) fail("pack_too_large");
      if (c.length) { this.chunks.push(c); this.available += c.length; }
    }
    return this.available >= n;
  }

  /** Exactly n bytes, or null at the end of the stream (fewer bytes left are an error). */
  async take(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) {
      if (this.available === 0) return null;
      fail("response_truncated");
    }
    const first = this.chunks[this.head];
    if (first.length - this.offset >= n) {
      const out = first.subarray(this.offset, this.offset + n);
      this.advance(n);
      return out;
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[this.head];
      const k = Math.min(n - at, c.length - this.offset);
      out.set(c.subarray(this.offset, this.offset + k), at);
      at += k;
      this.advance(k);
    }
    return out;
  }

  /** The rest of the stream, chunk by chunk. */
  async drain(sink: (c: Uint8Array) => void): Promise<void> {
    for (;;) {
      if (this.available === 0 && !(await this.fill(1))) return;
      const c = this.chunks[this.head];
      const k = c.length - this.offset;
      sink(c.subarray(this.offset));
      this.advance(k);
    }
  }

  private advance(k: number) {
    this.offset += k;
    this.available -= k;
    while (this.head < this.chunks.length && this.offset >= this.chunks[this.head].length) {
      this.offset -= this.chunks[this.head].length;
      this.chunks[this.head] = new Uint8Array(0);
      this.head++;
    }
    if (this.head > 64 && this.head === this.chunks.length) { this.chunks = []; this.head = 0; }
  }
}

/** One pkt-line: null for a flush, the payload otherwise, or undefined at the end of the stream. */
async function readPkt(r: ByteReader): Promise<Uint8Array | null | undefined> {
  const head = await r.take(4);
  if (!head) return undefined;
  const text = dec.decode(head);
  if (!/^[0-9a-f]{4}$/i.test(text)) fail("pkt_malformed");
  const length = parseInt(text, 16);
  if (length === 0) return null;
  if (length < 4) fail("pkt_malformed");
  const body = await r.take(length - 4);
  if (body === null && length > 4) fail("response_truncated");
  return body ?? new Uint8Array(0);
}

export interface ReceivedPack { chunks: Uint8Array[]; bytes: number; progress_lines: number }

/**
 * Read an upload-pack result: the acknowledgement lines (NAK, or a final ACK; ACK … continue|common|ready are
 * skipped; ERR fails), then the pack, demultiplexed when side-band was requested. Bounded by maxPackBytes.
 */
export async function receivePack(body: ReadableStream<Uint8Array>, sideband: Sideband, maxPackBytes = MAX_PACK_BYTES): Promise<ReceivedPack> {
  const reader = new ByteReader(body.getReader(), maxPackBytes + Math.ceil(maxPackBytes / 64) + 65_536);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let progress = 0;
  const push = (c: Uint8Array) => {
    if (!c.length) return;
    bytes += c.length;
    if (bytes > maxPackBytes) fail("pack_too_large");
    chunks.push(c);
  };
  for (;;) {
    const pkt = await readPkt(reader);
    if (pkt === undefined) fail("no_acknowledgement");
    if (pkt === null) fail("unexpected_flush");
    const line = dec.decode(pkt!).replace(/\n$/, "");
    if (line === "NAK" || /^ACK [0-9a-f]{40}$/.test(line)) break;
    if (/^ACK [0-9a-f]{40} (continue|common|ready)$/.test(line)) continue;
    if (line.startsWith("ERR ")) fail(`remote_error:${printable(line.slice(4))}`);
    fail("unexpected_response");
  }
  if (!sideband) {
    await reader.drain(push);
    return { chunks, bytes, progress_lines: 0 };
  }
  for (;;) {
    const pkt = await readPkt(reader);
    if (pkt === undefined) fail("sideband_unterminated");
    if (pkt === null) break;
    if (!pkt!.length) fail("sideband_malformed");
    const band = pkt![0];
    if (band === 1) push(pkt!.subarray(1));
    else if (band === 2) progress++;
    else if (band === 3) fail(`remote_error:${printable(dec.decode(pkt!.subarray(1)))}`);
    else fail("sideband_malformed");
  }
  return { chunks, bytes, progress_lines: progress };
}

export interface PackInfo { version: number; objects: number; sha1: string }

/** A packfile: "PACK", version 2 or 3, at least one object, and its trailing SHA-1 over everything before it. */
export async function verifyPack(pack: Uint8Array<ArrayBuffer>): Promise<PackInfo> {
  if (pack.length < 32) fail("pack_too_short");
  if (pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) fail("not_a_pack");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) fail(`pack_version_${version}`);
  const objects = view.getUint32(8);
  if (objects < 1) fail("pack_empty");
  const trailer = hex(pack.subarray(pack.length - 20));
  const digest = hex(await crypto.subtle.digest("SHA-1", pack.subarray(0, pack.length - 20)));
  if (digest !== trailer) fail("pack_checksum_mismatch");
  return { version, objects, sha1: trailer };
}

/** The bundle v2 header: the signature, one `<sha> <ref>` line per ref (no prerequisites: a full clone), a blank line. */
export function bundleHeader(refs: GitBackupRef[]): Uint8Array<ArrayBuffer> {
  if (!refs.length) fail("no_refs");
  for (const r of refs) if (!validSha(r.sha) || !/^(HEAD|refs\/[\x21-\x7e]+)$/.test(r.name)) fail("invalid_ref");
  return enc.encode(BUNDLE_SIGNATURE + refs.map((r) => `${r.sha} ${r.name}\n`).join("") + "\n");
}

/** Header + pack in one buffer (the chunks are released as they are copied), checked, with its SHA-256. */
export async function assembleBundle(refs: GitBackupRef[], received: ReceivedPack): Promise<{ bundle: Uint8Array<ArrayBuffer>; pack: PackInfo; sha256: string; pack_bytes: number }> {
  const header = bundleHeader(refs);
  const bundle = new Uint8Array(header.length + received.bytes);
  bundle.set(header, 0);
  let at = header.length;
  for (let i = 0; i < received.chunks.length; i++) {
    bundle.set(received.chunks[i], at);
    at += received.chunks[i].length;
    received.chunks[i] = new Uint8Array(0);
  }
  received.chunks.length = 0;
  const pack = await verifyPack(bundle.subarray(header.length));
  return { bundle, pack, sha256: hex(await crypto.subtle.digest("SHA-256", bundle)), pack_bytes: received.bytes };
}

// ---------------------------------------------------------------- the fetch

export interface FetchedBundle { bundle: Uint8Array<ArrayBuffer>; refs: GitBackupRef[]; main: string; skipped: number; pack: PackInfo; sha256: string; pack_bytes: number; sideband: Sideband }

/** Ref discovery, the full-clone fetch and the bundle, over smart HTTP with `token`. Throws GitBackupError. */
export async function fetchBundle(remote: string, token: string, fetchImpl: Fetch, maxPackBytes = MAX_PACK_BYTES): Promise<FetchedBundle> {
  const base = remoteBase(remote);
  if (!base) fail("invalid_remote");
  const discovered = await discoverRefs(base!, token, fetchImpl, "git-upload-pack");
  if (!discovered.ok) fail(`discovery_failed:${discovered.reason}`);
  const adv = (discovered as { ok: true; adv: Advertisement }).adv;
  const { refs, main, skipped } = selectRefs(adv);
  const { caps, sideband } = chooseCapabilities(adv.capabilities);
  const body = uploadPackRequest(refs.map((r) => r.sha), caps);
  let res: Response;
  try {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    res = await fetchImpl(`${base}/git-upload-pack`, {
      method: "POST", redirect: "manual", body, ...(signal ? { signal } : {}),
      headers: gitHeaders(token, { "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" }),
    });
  } catch {
    fail("fetch_unreachable");
  }
  if (res!.status !== 200) fail(`fetch_http_${res!.status}`);
  if (!(res!.headers.get("content-type") ?? "").startsWith("application/x-git-upload-pack-result")) fail("fetch_not_smart_http");
  const declared = Number(res!.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxPackBytes + Math.ceil(maxPackBytes / 64) + 65_536) fail("pack_too_large");
  if (!res!.body) fail("fetch_empty");
  const received = await receivePack(res!.body!, sideband, maxPackBytes);
  const assembled = await assembleBundle(refs, received);
  return { ...assembled, refs, main, skipped, sideband };
}

// ---------------------------------------------------------------- R2 and retention

type PutOptions = { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
/** The subset of the R2 bucket binding this step uses. */
export interface GitBackupBucket {
  put(key: string, value: Uint8Array | ArrayBuffer, options?: PutOptions): Promise<{ size?: number } | null | unknown>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

export const bundleKey = (day: string, main: string) => `${GIT_BACKUP_PREFIX}${day}-${main}.bundle`;

/**
 * Keep the newest bundle of each of the last `keepDays` UTC days that have one; delete the rest (older bundles of
 * the same day, and older days). Never deletes `keep`. Objects under the prefix with another name are left alone.
 */
export async function pruneGitBackups(bucket: GitBackupBucket, keep: string | null, keepDays = GIT_BACKUP_RETAINED_DAYS, maxDeletes = MAX_PRUNE_DELETES): Promise<string[]> {
  const all: Array<{ key: string; day: string; uploaded: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: GIT_BACKUP_PREFIX, cursor, limit: 1000 });
    for (const o of page.objects) {
      const m = KEY.exec(o.key);
      if (m) all.push({ key: o.key, day: m[1], uploaded: o.uploaded instanceof Date ? o.uploaded.getTime() : Date.parse(String(o.uploaded)) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const newest = new Map<string, { key: string; uploaded: number }>();
  for (const o of all) {
    const n = newest.get(o.day);
    if (!n || o.uploaded > n.uploaded || (o.uploaded === n.uploaded && o.key > n.key)) newest.set(o.day, o);
  }
  const keptDays = new Set([...newest.keys()].sort().reverse().slice(0, keepDays));
  const keepKeys = new Set([...keptDays].map((d) => newest.get(d)!.key));
  if (keep) keepKeys.add(keep);
  const doomed = all.filter((o) => !keepKeys.has(o.key)).map((o) => o.key).sort().slice(0, maxDeletes);
  if (doomed.length) await bucket.delete(doomed);
  return doomed;
}

// ---------------------------------------------------------------- the tick

export interface GitBackupRepo extends ArtifactsReader {
  info?(): Promise<{ remote: string } | null>;
  createToken?(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt: string | number }>;
}
export interface GitBackupEnv { DB: D1Database; BUNDLES?: GitBackupBucket }

/** Error text with every form of the token replaced. */
export function redact(text: string, token: string | null): string {
  if (!token) return text;
  let out = text;
  for (const t of [token, tokenSecret(token)]) if (t && t.length >= 8) out = out.split(t).join("[redacted]");
  return out;
}

/**
 * One git backup of `platform`, at most once per UTC day per head of main (a failed run of that head is retried
 * after GIT_BACKUP_RETRY_MS). Records the run; never throws.
 */
export async function gitBackupTick(env: GitBackupEnv, repo: GitBackupRepo, nowMs = Date.now(), fetchImpl: Fetch = (i, init) => fetch(i, init), maxPackBytes = MAX_PACK_BYTES): Promise<Record<string, unknown>> {
  const bucket = env.BUNDLES;
  if (!bucket) return { outcome: "not_configured" };
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let head: string;
  try {
    const sha = await canonicalMainHead(repo);
    if (!sha) return { outcome: "no_main" };
    head = sha;
    const last = await env.DB.prepare("SELECT ran_at, status FROM forge_git_backups WHERE main_sha = ? AND day = ? ORDER BY ran_at DESC LIMIT 1").bind(head, day).first<{ ran_at: string; status: string }>();
    if (last && (last.status === "ok" || nowMs - Date.parse(last.ran_at) < GIT_BACKUP_RETRY_MS)) return { outcome: "not_due", main_sha: head, last: last.ran_at, last_status: last.status };
  } catch (e) {
    return { outcome: "failed", error: String((e as Error)?.message ?? e).slice(0, 300), recorded: false };
  }
  const ranAt = new Date(nowMs).toISOString();
  const runId = `gbk_${head.slice(0, 12)}_${nowMs}`;
  let token: string | null = null;
  try {
    const remote = (await repo.info?.())?.remote ?? "";
    if (!trustedRemoteFor(remote, CANONICAL_REPO)) fail("untrusted_remote");
    if (typeof repo.createToken !== "function") fail("token_unavailable");
    token = (await repo.createToken!("read", GIT_BACKUP_TOKEN_TTL_S)).plaintext;
    if (typeof token !== "string" || !tokenSecret(token)) fail("token_unavailable");
    const got = await fetchBundle(remote, token!, fetchImpl, maxPackBytes);
    if (got.main !== head) fail("main_moved_during_backup");
    const key = bundleKey(day, got.main);
    const stored = await bucket.put(key, got.bundle, {
      httpMetadata: { contentType: BUNDLE_CONTENT_TYPE },
      customMetadata: {
        source: "cryptophys-forge", repo: `cryptophys/${CANONICAL_REPO}`, format: "git-bundle-v2", main_sha: got.main,
        sha256: got.sha256, bytes: String(got.bundle.length), pack_sha1: got.pack.sha1, pack_version: String(got.pack.version),
        objects: String(got.pack.objects), refs: String(got.refs.length - 1), created_at: ranAt, run_id: runId,
      },
    }) as { size?: unknown } | null;
    if (stored && typeof stored === "object" && typeof stored.size === "number" && stored.size !== got.bundle.length) fail("r2_size_mismatch");
    const branches = got.refs.filter((r) => r.name !== "HEAD");
    await env.DB.prepare(
      `INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, r2_key, bundle_sha256, bundle_bytes, pack_bytes, pack_sha1, pack_version, objects, refs, refs_json, error, pruned_at)
       VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(runId, got.main, day, ranAt, key, got.sha256, got.bundle.length, got.pack_bytes, got.pack.sha1, got.pack.version, got.pack.objects, branches.length, JSON.stringify(branches)).run();
    await appendAuditEvent(env.DB, {
      event_type: "forge.git_backup_written", actor: ACTOR, subject: key, outcome: "succeeded",
      payload: { run_id: runId, main_sha: got.main, bundle_sha256: got.sha256, bundle_bytes: got.bundle.length, pack_bytes: got.pack_bytes, pack_sha1: got.pack.sha1, pack_version: got.pack.version, objects: got.pack.objects, refs: branches.length, refs_skipped: got.skipped, sideband: got.sideband },
    }).catch(() => undefined);
    const pruned = await prune(env.DB, bucket, key, nowMs);
    return { outcome: "written", main_sha: got.main, key, bundle_sha256: got.sha256, bundle_bytes: got.bundle.length, objects: got.pack.objects, refs: branches.length, pruned };
  } catch (e) {
    const error = redact(String((e as Error)?.message ?? e), token).slice(0, 300);
    token = null;
    try {
      await env.DB.prepare("INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, error) VALUES (?, ?, ?, ?, 'failed', ?)").bind(runId, head, day, ranAt, error).run();
      await appendAuditEvent(env.DB, { event_type: "forge.git_backup_failed", actor: ACTOR, subject: head, outcome: "failed", payload: { run_id: runId, main_sha: head, error } }).catch(() => undefined);
      return { outcome: "failed", main_sha: head, error };
    } catch {
      return { outcome: "failed", main_sha: head, error, recorded: false };
    }
  }
}

/** R2 retention, then D1: mark the deleted bundles, and drop rows older than the row retention whose bundle is gone. */
async function prune(db: D1Database, bucket: GitBackupBucket, keep: string, nowMs: number): Promise<number> {
  try {
    const deleted = await pruneGitBackups(bucket, keep);
    const at = new Date(nowMs).toISOString();
    for (const key of deleted) await db.prepare("UPDATE forge_git_backups SET pruned_at = ? WHERE r2_key = ? AND pruned_at IS NULL").bind(at, key).run();
    const before = new Date(nowMs - GIT_BACKUP_ROW_RETENTION_DAYS * 86_400_000).toISOString();
    await db.prepare("DELETE FROM forge_git_backups WHERE ran_at < ? AND (status = 'failed' OR pruned_at IS NOT NULL)").bind(before).run();
    return deleted.length;
  } catch {
    return 0; // retention is retried after the next successful backup
  }
}
