// Review 2026-11-26: main's pack passed MAX_PACK_BYTES (32 MiB) on 2026-11-26 and every backup since 01:20Z failed
// with pack_too_large. The backup now streams: the pack goes to an R2 multipart upload part by part, with the bundle's
// SHA-256 and the pack's SHA-1 computed as the bytes pass (crypto.DigestStream in workerd, a JS hasher elsewhere), so
// the Worker holds one part whatever the pack's size. The daily verify refuses a bundle too large to hold in memory
// (bundle_too_large_to_verify) instead of exhausting the Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { NO_CHILD_PROCESS, canSpawn, migratedDb, pseudoRandom } from "./harness.ts";
import { lastReviewedRecord } from "./harness.ts";
import { FLUSH, pktLine, type Fetch } from "../../forge/src/merge.ts";
import {
  BundleStreamWriter, MAX_PACK_BYTES, MAX_STREAMED_PACK_BYTES, STREAM_PART_BYTES, bundleHeader, gitBackupTick,
  type BundleUpload, type GitBackupBucket, type UploadedPart,
} from "../../forge/src/git-backup.ts";
import { MAX_VERIFY_BUNDLE_BYTES, gitBackupVerifyTick } from "../../forge/src/bundle-verify.ts";
import { Sha1, Sha256, defaultHasher, jsHasher, type HasherFactory } from "../../forge/src/digest.ts";

const HOST = "b".repeat(32) + ".artifacts.cloudflare.net";
const REMOTE = `https://${HOST}/git/cryptophys/platform.git`;
const SECRET = "art_v1_" + "STREAMREADTOKENSECRETVALUE";
const TOKEN = SECRET + "?expires=1794300000";
const NOW = Date.parse("2026-11-26T12:04:00.000Z");

// The gate-8 fixture: `git bundle create x.bundle --all` of main (2 commits) and claude/topic (1 more), 875 bytes.
const GIT_BUNDLE_B64 = "IyB2MiBnaXQgYnVuZGxlCmU1NzliMWRhYjliN2JkMWU1ODk0N2FjZmUxNDExNTZjNmQxOTQxODUgcmVmcy9oZWFkcy9jbGF1ZGUvdG9waWMKNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCByZWZzL2hlYWRzL21haW4KNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCBIRUFECgpQQUNLAAAAAgAAAAmeDXicnctNDsIgEEDhPadgb2IGyvCTmMaVJ/ACAwxK0pYG0Xh89QpuXr7NG51ZThC8i1pBRJ90VhYJwEBIOfgSi0nGZfIUxE6dtyGNI53DhNYpRI2YtfFZ2xSVpQRky8QxWARBz3FvXV5av7G88mPIU/n5zG9a94WPdXvRUvMslQsGtQcAefgGRGrrWsfg/24x2l6T+AB8g0I+nw14nJ3LQQrCMBBA0X1OMXtBpknbJCDiyhN4gclkRgttU9IoHl+9gpvP2/xWRQCRE1P0mkVs6NU7dZgVx8zJRgmMvcYuqtmoytogKKtLiTRSF9CyJnRDyuxHi96hMAUOQmjo2R6lwrXUu8BN9gYn/fkib1q2WY7T+qJ5ymfofOwHGxARDt+g4bIsU2vy32124bJm8wF300UGngp4nJ3LQQrCMBBA0X1OMXtBptPGSUDElSfwAiEz1UBjSjqKx1ev4ObzNt+6KkjwKpSyH4WRhAMTDSwxpIlVM/HokQ5RXHravXW4tH5TuOpmcJx/Pus71XXRfXm80lLkBAPHyVNARNh9gy63WouZ/ne7ufTN3AdDMDURpgR4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wxxCiKEmvpKKEgT/pWl3ZOaHQBTOmqExd4Xafv0tHEAB2eBquPHicK8hJLEnLL8pVKDPiAgAfJAQ4NnicK8kvyEzmAgAItAIqpQJ4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wBwDX6A7XpQJ4nDM0MDAzMVEIcnV08XXVy01h+DmvecrzfVX/WeLPbc5cMevpg7J8PQD5qRAwOXicK8hJLEnLL8rlAgASrANwdnFZXD0qI0XwUxNug/64oT+jyX4=";
const GIT_BUNDLE = Uint8Array.from(atob(GIT_BUNDLE_B64), (c) => c.charCodeAt(0));
const MAIN = "47a2d93567155255d248d26cb16ac0a6f3eb9650";
const TOPIC = "e579b1dab9b7bd1e58947acfe141156c6d194185";
const HEADER_END = new TextDecoder().decode(GIT_BUNDLE).indexOf("\n\n") + 2;
const PACK = GIT_BUNDLE.slice(HEADER_END);
/** The refs as selectRefs orders them for the bundle header (git's order: branches, then HEAD). */
const REFS = [{ name: "refs/heads/claude/topic", sha: TOPIC }, { name: "refs/heads/main", sha: MAIN }, { name: "HEAD", sha: MAIN }];

const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of parts) { o.set(p, a); a += p.length; } return o; };
const sha = (alg: "sha1" | "sha256", ...parts: Uint8Array[]) => { const h = createHash(alg); for (const p of parts) h.update(p); return h.digest("hex"); };
/** node:crypto behind the HasherFactory interface (the big test: the JS hasher is checked separately in GS-1). */
const nodeHasher: HasherFactory = (a) => { const h = createHash(a === "SHA-1" ? "sha1" : "sha256"); return { update: (b) => { h.update(b); }, digest: async () => h.digest("hex") }; };

/** Side-band-64k packets of the pack, produced lazily (one packet per pull), so the server holds nothing. */
function sidebandStream(next: () => Uint8Array | null, ack = "NAK\n"): ReadableStream<Uint8Array> {
  let sentAck = false, done = false;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sentAck) { sentAck = true; c.enqueue(pktLine(ack)); return; }
      if (done) return;
      const piece = next();
      if (piece === null) { done = true; c.enqueue(FLUSH); c.close(); return; }
      c.enqueue(pktLine(cat(Uint8Array.of(1), piece)));
    },
  });
}
const piecesOf = (bytes: Uint8Array, size = 100) => { let at = 0; return () => { if (at >= bytes.length) return null; const p = bytes.subarray(at, at + size); at += size; return p; }; };

function fakeServer(packStream: () => ReadableStream<Uint8Array>) {
  const fetchImpl: Fetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (headers.authorization !== `Bearer ${SECRET}`) return new Response("denied", { status: 401 });
    if (url === `${REMOTE}/info/refs?service=git-upload-pack`) {
      const caps = "multi_ack side-band side-band-64k ofs-delta no-progress agent=git/2.43.0 symref=HEAD:refs/heads/main";
      const adv = cat(pktLine("# service=git-upload-pack\n"), FLUSH, pktLine(`${MAIN} HEAD\0${caps}\n`), pktLine(`${TOPIC} refs/heads/claude/topic\n`), pktLine(`${MAIN} refs/heads/main\n`), FLUSH);
      return new Response(adv, { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    }
    if (url === `${REMOTE}/git-upload-pack` && init?.method === "POST") return new Response(packStream(), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    return new Response("not found", { status: 404 });
  };
  return fetchImpl;
}
const repoAt = (head: string) => ({
  log: async () => [{ hash: head }], readCommit: async () => null, readTree: async () => null, readBlob: async () => null,
  info: async () => ({ remote: REMOTE }), createToken: async () => ({ plaintext: TOKEN, expiresAt: "2026-11-26T12:06:00Z" }),
});

/** An R2-like bucket with multipart. `keep` false: parts are hashed and dropped (the memory test). */
function multipartBucket(o: { keep?: boolean; onPart?: (n: number, bytes: number) => void } = {}) {
  const objects = new Map<string, { bytes: Uint8Array | null; size: number; sha256: string; options: any; uploaded: Date }>();
  const aborted: string[] = [];
  const partSizes: number[] = [];
  const bucket: GitBackupBucket & { get(key: string): Promise<any> } = {
    async put(key, value, options) { const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value); objects.set(key, { bytes, size: bytes.length, sha256: sha("sha256", bytes), options, uploaded: new Date(NOW) }); return { size: bytes.length }; },
    async list(q) { const keys = [...objects.keys()].filter((k) => k.startsWith(q?.prefix ?? "")).sort(); return { objects: keys.map((k) => ({ key: k, uploaded: objects.get(k)!.uploaded })), truncated: false }; },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
    async createMultipartUpload(key, options): Promise<BundleUpload> {
      const kept: Uint8Array[] = [];
      const h = createHash("sha256");
      let size = 0;
      return {
        async uploadPart(partNumber: number, value: Uint8Array): Promise<UploadedPart> {
          partSizes.push(value.length); o.onPart?.(partNumber, value.length);
          h.update(value); size += value.length;
          if (o.keep !== false) kept.push(value.slice());
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts: UploadedPart[]) {
          assert.deepEqual(parts.map((p) => p.partNumber), parts.map((_, i) => i + 1));
          objects.set(key, { bytes: o.keep !== false ? cat(...kept) : null, size, sha256: h.digest("hex"), options, uploaded: new Date(NOW) });
          return { size };
        },
        async abort() { aborted.push(key); },
      };
    },
    async get(key) { const x = objects.get(key); return x && x.bytes ? { arrayBuffer: async () => x.bytes!.slice().buffer, size: x.size, customMetadata: x.options?.customMetadata } : null; },
  };
  return { bucket, objects, aborted, partSizes };
}
const rows = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT * FROM forge_git_backups ORDER BY ran_at").all().map((r: any) => ({ ...r }));
const audits = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT event_type, outcome, payload_json FROM audit_events WHERE event_type LIKE 'forge.git_backup%' ORDER BY rowid").all().map((r: any) => ({ ...r, payload: JSON.parse(r.payload_json) }));

test("GS-1. the JS SHA-1 and SHA-256 equal node:crypto at every block boundary and in any split; DigestStream is used where it exists", async () => {
  // Pseudo-random, not crypto.getRandomValues (workerd caps it at 64 KiB a call): the same lengths and splits.
  const data = pseudoRandom(1_048_583);
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65_537, data.length]) {
    const bytes = data.subarray(0, n);
    for (const [alg, H] of [["sha1", Sha1], ["sha256", Sha256]] as const) {
      const whole = new H(); whole.update(bytes);
      assert.equal(await whole.digest(), sha(alg, bytes), `${alg} ${n} whole`);
      const split = new H();
      for (let i = 0; i < n;) { const k = 1 + ((i * 7919) % 97); split.update(bytes.subarray(i, i + k)); i += k; }
      assert.equal(await split.digest(), sha(alg, bytes), `${alg} ${n} split`);
    }
  }
  assert.equal(await jsHasher("SHA-1").digest(), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  // node has no crypto.DigestStream, so the default is the JS hasher; with one, the default writes to it.
  assert.equal(typeof (globalThis.crypto as any).DigestStream, "undefined");
  assert.ok(defaultHasher("SHA-1") instanceof Sha1);
  const written: Uint8Array[] = [];
  class FakeDigestStream { digest = Promise.resolve(new Uint8Array(32).fill(7).buffer); getWriter() { return { write: async (b: Uint8Array) => { written.push(b); }, close: async () => {} }; } }
  (globalThis.crypto as any).DigestStream = FakeDigestStream;
  try {
    const h = defaultHasher("SHA-256");
    await h.update(Uint8Array.of(1, 2));
    assert.equal(await h.digest(), "07".repeat(32));
    assert.deepEqual(written, [Uint8Array.of(1, 2)]);
  } finally { delete (globalThis.crypto as any).DigestStream; }
});

test("GS-2. the streamed backup writes git's own bundle byte for byte, in parts; D1 and the audit record it; the verify passes", async () => {
  const db = migratedDb();
  const b = multipartBucket();
  const fetchImpl = fakeServer(() => sidebandStream(piecesOf(PACK, 100)));
  const r = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW, fetchImpl, MAX_PACK_BYTES, { partBytes: 128 });
  assert.equal(r.outcome, "written", JSON.stringify(r));
  assert.equal(r.written, "streamed");
  const key = `git-backups/platform/2026-11-26-${MAIN}.bundle`;
  assert.equal(r.key, key);
  const stored = b.objects.get(key)!;
  assert.deepEqual(stored.bytes, GIT_BUNDLE, "the same bytes as `git bundle create --all`");
  assert.equal(r.parts, Math.ceil(GIT_BUNDLE.length / 128));
  assert.ok(b.partSizes.slice(0, -1).every((n) => n === 128));
  assert.equal(r.bundle_sha256, sha("sha256", GIT_BUNDLE));
  assert.ok(Number(r.peak_held_bytes) <= 128 + 12 + 20);
  // The metadata known before the pack; the hashes and sizes are in D1 and the audit event.
  const meta = stored.options.customMetadata;
  assert.deepEqual(Object.keys(meta).sort(), ["created_at", "format", "main_sha", "refs", "repo", "run_id", "source", "written"]);
  assert.equal(meta.written, "streamed");
  const [row] = rows(db);
  assert.equal(row.status, "ok");
  assert.equal(row.bundle_sha256, sha("sha256", GIT_BUNDLE));
  assert.equal(row.bundle_bytes, GIT_BUNDLE.length);
  assert.equal(row.pack_bytes, PACK.length);
  assert.equal(row.pack_sha1, Array.from(PACK.subarray(PACK.length - 20), (x) => x.toString(16).padStart(2, "0")).join(""));
  assert.equal(row.pack_sha1, sha("sha1", PACK.subarray(0, PACK.length - 20)), "the trailer is the SHA-1 of the rest");
  assert.equal(row.objects, 9);
  assert.deepEqual(JSON.parse(row.refs_json), REFS.filter((x) => x.name !== "HEAD"));
  const [ev] = audits(db);
  assert.equal(ev.event_type, "forge.git_backup_written");
  assert.equal(ev.payload.written, "streamed");
  assert.ok(!JSON.stringify([rows(db), audits(db), meta]).includes(SECRET.slice(7)), "the token is never stored");
  // The daily verify reads it back and passes (metadata has no sha256, so the D1 row is the reference).
  const v = await gitBackupVerifyTick({ DB: db as never, BUNDLES: b.bucket as never }, NOW + 60_000);
  assert.equal(v.outcome, "verified", JSON.stringify(v));
  assert.equal(v.objects, 9);
});

test("GS-3. a bad pack, a wrong checksum or a pack over the cap aborts the upload: nothing is stored, the failure is recorded", async () => {
  const cases: Array<[string, Uint8Array, number | undefined]> = [
    ["pack_checksum_mismatch", cat(PACK.subarray(0, PACK.length - 1), Uint8Array.of(PACK[PACK.length - 1] ^ 1)), undefined],
    ["not_a_pack", cat(new TextEncoder().encode("KCAP"), PACK.subarray(4)), undefined],
    ["pack_too_large", PACK, 200],
  ];
  for (const [reason, pack, cap] of cases) {
    const db = migratedDb();
    const b = multipartBucket();
    const r = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW, fakeServer(() => sidebandStream(piecesOf(pack, 100))), MAX_PACK_BYTES, { partBytes: 64, maxStreamedPackBytes: cap });
    assert.equal(r.outcome, "failed", reason);
    assert.equal(r.error, reason);
    assert.deepEqual(b.aborted, [`git-backups/platform/2026-11-26-${MAIN}.bundle`], `${reason}: aborted`);
    assert.equal(b.objects.size, 0, `${reason}: nothing stored`);
    assert.deepEqual(rows(db).map((x) => [x.status, x.error]), [["failed", reason]]);
  }
  // The writer alone: an empty pack never completes.
  const done: string[] = [];
  const w = new BundleStreamWriter({ uploadPart: async (n) => ({ partNumber: n, etag: "e" }), complete: async () => { done.push("x"); return {}; }, abort: async () => {} }, bundleHeader(REFS));
  await assert.rejects(() => w.finish(), /pack_too_short/);
  assert.deepEqual(done, []);
  assert.equal(MAX_STREAMED_PACK_BYTES, 1024 * 1024 * 1024);
  assert.equal(STREAM_PART_BYTES, 8 * 1024 * 1024);
});

/** GS-4's run: the 80 MiB pack through the streamed writer; with `measure`, the process's memory at every part too. */
async function streamEightyMiB(measure: boolean): Promise<void> {
  const gc = measure ? ((globalThis as { gc?: () => void }).gc ?? (setFlagsFromString("--expose-gc"), runInNewContext("gc") as () => void)) : () => {};
  const PACK_BYTES = 80 * 1024 * 1024;
  // A synthetic pack: "PACK", version 2, one object, pseudo-random body, the SHA-1 trailer; generated as it is read.
  const head = Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1);
  const body = PACK_BYTES - 12 - 20;
  const sha1 = createHash("sha1"), sha256 = createHash("sha256");
  const header = bundleHeader(REFS);
  sha256.update(header);
  let produced = 0, trailerSent = false;
  const block = pseudoRandom(65_000, 7);
  const next = () => {
    if (produced === 0) { produced = 1; sha1.update(head); sha256.update(head); return head; }
    const sent = produced - 1;
    if (sent < body) { const n = Math.min(65_000, body - sent); const p = new Uint8Array(block.subarray(0, n)); p[0] = sent & 0xff; produced += n; sha1.update(p); sha256.update(p); return p; }
    if (!trailerSent) { trailerSent = true; const t = new Uint8Array(sha1.digest()); sha256.update(t); return t; }
    return null;
  };
  gc();
  const base = process.memoryUsage();
  const buffers: number[] = [], heap: number[] = [];
  const b = multipartBucket({
    keep: false,
    onPart: () => { if (!measure) return; gc(); const m = process.memoryUsage(); buffers.push(m.arrayBuffers - base.arrayBuffers); heap.push(m.heapUsed - base.heapUsed); },
  });
  const db = migratedDb();
  const r = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW, fakeServer(() => sidebandStream(next)), MAX_PACK_BYTES, { hasher: nodeHasher });
  assert.equal(r.outcome, "written", JSON.stringify(r));
  assert.equal(r.written, "streamed");
  assert.equal(r.bundle_bytes, header.length + PACK_BYTES);
  assert.equal(r.bundle_sha256, sha256.digest("hex"));
  assert.equal(b.objects.get(String(r.key))!.sha256, r.bundle_sha256, "the stored bytes are the bundle");
  assert.equal(r.parts, Math.ceil((header.length + PACK_BYTES) / STREAM_PART_BYTES));
  assert.ok(PACK_BYTES > 64 * 1024 * 1024);
  // What the writer holds, by its own account: one part, the pack's head and its last 20 bytes.
  assert.ok(Number(r.peak_held_bytes) <= STREAM_PART_BYTES + 32, String(r.peak_held_bytes));
  if (!measure) return;
  // What the process holds, measured after a GC at every part (11 samples): flat at about one part. A single sample
  // can carry a transient of the runtime's own (seen up to 31 MiB once in a few runs), so the median and the last
  // sample are held to one part with room, and every sample to well below the pack (an in-memory copy is 80 MiB+).
  const MiB = 1024 * 1024;
  const median = (xs: number[]) => [...xs].sort((a, c) => a - c)[Math.floor(xs.length / 2)];
  const show = (xs: number[]) => xs.map((x) => (x / MiB).toFixed(1)).join(" ");
  assert.equal(buffers.length, r.parts);
  assert.ok(median(buffers) <= 12 * MiB && buffers.at(-1)! <= 12 * MiB, `array buffers (MiB): ${show(buffers)}`);
  assert.ok(Math.max(...buffers) < 48 * MiB, `array buffers (MiB): ${show(buffers)}`);
  assert.ok(median(heap) <= 12 * MiB && Math.max(...heap) < 48 * MiB, `heap (MiB): ${show(heap)}`);
}

test("GS-4. an 80 MiB pack (over 64 MiB) streams with flat memory: one 8 MiB part held, the heap and buffers stay far below the pack", async (t) => {
  // The memory is measured in its own process (A2, review 2026-11-26: in-process, the full suite's other tests disturbed
  // it once): the child re-runs this file with only GS-4, GS4_CHILD=1 and --expose-gc. Here the run itself is asserted
  // in-process (the bundle, its SHA-256, the parts, the writer's own peak), on every runner.
  if (process.env.GS4_CHILD === "1") { await streamEightyMiB(true); return; }
  await streamEightyMiB(false);
  await t.test("GS-4m. the process's memory, measured in a child process", async (st) => {
    if (!(await canSpawn())) { st.skip(NO_CHILD_PROCESS); return; }
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, ["--expose-gc", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "--test", "--test-name-pattern=^GS-4\\.", new URL(import.meta.url).pathname],
      // Without the parent runner's NODE_TEST_CONTEXT, the child reports as a plain test run (TAP on stdout).
      { encoding: "utf8", env: Object.fromEntries(Object.entries({ ...process.env, GS4_CHILD: "1" }).filter(([k]) => k !== "NODE_TEST_CONTEXT")), maxBuffer: 1 << 22 });
    assert.equal(r.status, 0, `${r.stdout.slice(-3000)}\n${r.stderr.slice(-2000)}`);
    assert.match(r.stdout, /# pass 1\n/);
  });
});

test("GS-5. the verify refuses a bundle over its sanity bound before reading it; the in-memory path is unchanged", async () => {
  const db = migratedDb();
  db.raw.prepare(`INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, r2_key, bundle_sha256, bundle_bytes, pack_bytes, pack_sha1, pack_version, objects, refs, refs_json)
    VALUES ('gbk_big', ?, '2026-11-26', '2026-11-26T12:00:00.000Z', 'ok', 'git-backups/platform/big.bundle', ?, ?, 1, ?, 2, 1, 1, '[]')`).run(MAIN, "0".repeat(64), MAX_VERIFY_BUNDLE_BYTES + 1, "0".repeat(40));
  let reads = 0;
  const bucket = { put: async () => ({}), list: async () => ({ objects: [], truncated: false }), delete: async () => {}, get: async () => { reads++; return null; } };
  const v = await gitBackupVerifyTick({ DB: db as never, BUNDLES: bucket as never }, NOW);
  assert.equal(v.outcome, "failed");
  assert.equal(v.reason, "bundle_too_large_to_verify");
  assert.equal(reads, 0, "the object is never read");
  assert.equal(MAX_VERIFY_BUNDLE_BYTES, 256 * 1024 * 1024, "256 MiB since A2 (was 40 MiB while the verify held the bundle whole)");
  assert.equal(MAX_PACK_BYTES, 32 * 1024 * 1024, "the in-memory cap (fallback path, transfer.ts) is unchanged");
});

test("GS-6. the record: SSOT line 5 and the gate 8 bullets; no guard path", async () => {
  const { readFileSync } = await import("node:fs");
  const { criticalPathReason } = await import("../src/guard-paths.ts");
  const ssot = readFileSync(new URL("../../../docs/SSOT.md", import.meta.url), "utf8");
  assert.match(lastReviewedRecord(), /^Last reviewed: 2026-11-16 \((?:[^\n]*\); )?git backup streamed, 2026-11-26 \(review: /);
  assert.match(ssot, /  - Streamed since 2026-11-26 \(review, after main's pack passed 32 MiB[^\n]*R2 multipart upload in 8 MiB parts \(`STREAM_PART_BYTES`\)/);
  assert.match(ssot, /fails as `bundle_too_large_to_verify` before it is read/);
  for (const p of ["workers/forge/src/git-backup.ts", "workers/forge/src/digest.ts", "workers/forge/src/bundle-verify.ts", "docs/SSOT.md"]) assert.equal(criticalPathReason(p), null, p);
});

test("GS-7. a 40 MiB bundle verifies at the production bound with a measured peak below 96 MB; an object past the bound fails, it does not exhaust memory", async (t) => {
  const { MAX_VERIFY_INFLATED_BYTES: BOUND, VERIFIER_VERSION: VERSION } = await import("../../forge/src/bundle-verify.ts");
  assert.equal(BOUND, 32 * 1024 * 1024);
  assert.equal(VERSION, 4);
  // The measurement needs a process of its own (the bundle built and verified in a child, its maxRSS read).
  if (!(await canSpawn())) { t.skip(NO_CHILD_PROCESS); return; }
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { MAX_VERIFY_INFLATED_BYTES, VERIFIER_VERSION } = await import("../../forge/src/bundle-verify.ts");
  const child = new URL("./fixtures/verify-memory-child.mts", import.meta.url).pathname;
  const root = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
  const dir = mkdtempSync(join(tmpdir(), "gs7-"));
  const run = (args: string[], gc = false) => {
    const r = spawnSync(process.execPath, [...(gc ? ["--expose-gc"] : []), "--disable-warning=ExperimentalWarning", child, ...args], { encoding: "utf8", maxBuffer: 1 << 20 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  };
  try {
    const MiB = 1024 * 1024;
    assert.equal(MAX_VERIFY_INFLATED_BYTES, 32 * MiB);
    assert.equal(VERIFIER_VERSION, 4);
    // Near the bound: 40 MiB of bundle, one object inflating to 30 MiB.
    const file = join(dir, "b.bundle");
    const built = run(["build", root, file, "40", "30"]);
    assert.ok(built.bundle_bytes > 38 * MiB && built.bundle_bytes <= MAX_VERIFY_BUNDLE_BYTES, String(built.bundle_bytes));
    const m = run(["verify", root, file], true);
    assert.equal(m.objects, built.objects);
    assert.ok(m.peak_held_bytes >= 30 * MiB, "the large object was held");
    // What a Worker would hold: the bundle (read before the measure) plus what the verify added at its peak.
    const peak = m.bundle_bytes + Math.max(0, m.added);
    assert.ok(peak < 96 * 1000 * 1000, `measured peak ${(peak / MiB).toFixed(1)} MiB (bundle ${(m.bundle_bytes / MiB).toFixed(1)} + verify ${(m.added / MiB).toFixed(1)})`);
    // Past the bound (60 MiB, which peaked at about 109 MiB under the old 64 MiB bound): refused, not held.
    run(["build", root, file, "40", "60"]);
    const over = run(["verify", root, file], true);
    assert.equal(over.failed, "pack_too_large_to_verify");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
