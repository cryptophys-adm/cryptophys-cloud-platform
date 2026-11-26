// A2 (review 2026-11-26): the daily verify reads the stored bundle by range, in 4 MiB pages with an 8 MiB page cache
// (PagedSource), and never holds it whole: the SHA-256 and the pack's SHA-1 are fed page by page, each entry's stream is
// read in a window that grows on demand, an evicted delta base is read back by range. It counts its reads (r2_reads)
// and fails closed past MAX_VERIFY_READS (verify_too_many_reads) or VERIFY_ELAPSED_BUDGET_MS (verify_cpu_budget). The
// size cap is 256 MiB. VERIFIER_VERSION 4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NO_CHILD_PROCESS, canSpawn, migratedDb, pseudoRandom } from "./harness.ts";
import {
  MAX_VERIFY_BUNDLE_BYTES, MAX_VERIFY_READS, PagedSource, VERIFIER_VERSION, VERIFY_ELAPSED_BUDGET_MS, VERIFY_PAGE_BYTES, VERIFY_PAGE_CACHE_BYTES,
  adler32, gitBackupVerifyTick, verifyBundle, verifyBundleFrom,
} from "../../forge/src/bundle-verify.ts";
import { GitBackupError } from "../../forge/src/git-backup.ts";

// The gate-8 fixture: `git bundle create x.bundle --all`, main (2 commits) and claude/topic (1 more), 875 bytes.
const GIT_BUNDLE = Uint8Array.from(atob("IyB2MiBnaXQgYnVuZGxlCmU1NzliMWRhYjliN2JkMWU1ODk0N2FjZmUxNDExNTZjNmQxOTQxODUgcmVmcy9oZWFkcy9jbGF1ZGUvdG9waWMKNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCByZWZzL2hlYWRzL21haW4KNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCBIRUFECgpQQUNLAAAAAgAAAAmeDXicnctNDsIgEEDhPadgb2IGyvCTmMaVJ/ACAwxK0pYG0Xh89QpuXr7NG51ZThC8i1pBRJ90VhYJwEBIOfgSi0nGZfIUxE6dtyGNI53DhNYpRI2YtfFZ2xSVpQRky8QxWARBz3FvXV5av7G88mPIU/n5zG9a94WPdXvRUvMslQsGtQcAefgGRGrrWsfg/24x2l6T+AB8g0I+nw14nJ3LQQrCMBBA0X1OMXtBpknbJCDiyhN4gclkRgttU9IoHl+9gpvP2/xWRQCRE1P0mkVs6NU7dZgVx8zJRgmMvcYuqtmoytogKKtLiTRSF9CyJnRDyuxHi96hMAUOQmjo2R6lwrXUu8BN9gYn/fkib1q2WY7T+qJ5ymfofOwHGxARDt+g4bIsU2vy32124bJm8wF300UGngp4nJ3LQQrCMBBA0X1OMXtBptPGSUDElSfwAiEz1UBjSjqKx1ev4ObzNt+6KkjwKpSyH4WRhAMTDSwxpIlVM/HokQ5RXHravXW4tH5TuOpmcJx/Pus71XXRfXm80lLkBAPHyVNARNh9gy63WouZ/ne7ufTN3AdDMDURpgR4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wxxCiKEmvpKKEgT/pWl3ZOaHQBTOmqExd4Xafv0tHEAB2eBquPHicK8hJLEnLL8pVKDPiAgAfJAQ4NnicK8kvyEzmAgAItAIqpQJ4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wBwDX6A7XpQJ4nDM0MDAzMVEIcnV08XXVy01h+DmvecrzfVX/WeLPbc5cMevpg7J8PQD5qRAwOXicK8hJLEnLL8rlAgASrANwdnFZXD0qI0XwUxNug/64oT+jyX4="), (c) => c.charCodeAt(0));
const MAIN = "47a2d93567155255d248d26cb16ac0a6f3eb9650";
const TOPIC = "e579b1dab9b7bd1e58947acfe141156c6d194185";
const KEY = "git-backups/platform/2026-11-26-fixture.bundle";
const NOW = Date.parse("2026-11-27T00:05:00.000Z");
const MiB = 1024 * 1024;
const reason = (e: unknown) => (e instanceof GitBackupError ? e.message : `not a GitBackupError: ${e}`);
const rangeOf = (b: Uint8Array) => async (o: number, l: number) => b.slice(o, o + l);

test("VS-1. PagedSource: ranges across pages, a bounded page cache, its reads counted; it fails closed on reads, time and short ranges", async () => {
  const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
  const src = new PagedSource(data.length, rangeOf(data), { pageBytes: 64, cacheBytes: 128 });
  assert.deepEqual(await src.bytes(10, 20), data.slice(10, 20));
  assert.deepEqual(await src.bytes(60, 200), data.slice(60, 200), "across three pages");
  assert.deepEqual(await src.bytes(0, 0), new Uint8Array(0));
  const before = src.reads;
  await src.bytes(130, 140);
  assert.equal(src.reads, before, "a page in the cache is not read again");
  await src.bytes(900, 1000);
  await src.bytes(0, 10);
  assert.equal(src.reads, before + 3, "evicted pages (the cache holds two) are read again");
  await assert.rejects(src.bytes(990, 1001), (e) => reason(e) === "source_out_of_range");
  const capped = new PagedSource(data.length, rangeOf(data), { pageBytes: 64, maxReads: 2 });
  await capped.bytes(0, 128);
  await assert.rejects(capped.bytes(128, 129), (e) => reason(e) === "verify_too_many_reads");
  const late = new PagedSource(data.length, rangeOf(data), { deadline: 10, clock: () => 11 });
  await assert.rejects(late.bytes(0, 1), (e) => reason(e) === "verify_cpu_budget");
  const short = new PagedSource(data.length, async (o, l) => data.slice(o, o + l - 1));
  await assert.rejects(short.bytes(0, 1), (e) => reason(e) === "r2_range_short");
  assert.deepEqual([VERIFY_PAGE_BYTES, VERIFY_PAGE_CACHE_BYTES, MAX_VERIFY_READS, VERIFY_ELAPSED_BUDGET_MS, MAX_VERIFY_BUNDLE_BYTES, VERIFIER_VERSION],
    [4 * MiB, 8 * MiB, 900, 240_000, 256 * MiB, 4]);
});

test("VS-2. the same verification from pages as in memory, at any page size", async () => {
  const whole = await verifyBundle(GIT_BUNDLE as Uint8Array<ArrayBuffer>);
  for (const pageBytes of [64, 100, 333, 4096]) {
    const src = new PagedSource(GIT_BUNDLE.length, rangeOf(GIT_BUNDLE), { pageBytes, cacheBytes: 2 * pageBytes });
    const paged = await verifyBundleFrom(src);
    assert.deepEqual(paged, whole, `pages of ${pageBytes} B`);
    assert.ok(src.reads > 0);
  }
});

/** A bucket like R2: head, and get with a range (or, `ignoreRange`, a binding that returns the whole object). */
function rangedBucket(bytes: Uint8Array, o: { ignoreRange?: boolean } = {}) {
  const gets: Array<{ offset: number; length: number } | null> = [];
  return {
    gets,
    bucket: {
      put: async () => ({}), list: async () => ({ objects: [], truncated: false }), delete: async () => {},
      head: async (key: string) => (key === KEY ? { size: bytes.length, customMetadata: { written: "streamed" } } : null),
      get: async (key: string, opt?: { range?: { offset: number; length: number } }) => {
        if (key !== KEY) return null;
        gets.push(opt?.range ?? null);
        const part = opt?.range && !o.ignoreRange ? bytes.slice(opt.range.offset, opt.range.offset + opt.range.length) : bytes.slice();
        return { arrayBuffer: async () => part.buffer, size: bytes.length };
      },
    },
  };
}
function storedRow(db: ReturnType<typeof migratedDb>, bytes: Uint8Array) {
  const pack = bytes.subarray(new TextDecoder().decode(bytes).indexOf("\n\n") + 2);
  db.raw.prepare(`INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, r2_key, bundle_sha256, bundle_bytes, pack_bytes, pack_sha1, pack_version, objects, refs, refs_json)
    VALUES ('gbk_fixture', ?, '2026-11-26', '2026-11-26T23:00:00.000Z', 'ok', ?, ?, ?, ?, ?, 2, 9, 2, ?)`).run(
    MAIN, KEY, createHash("sha256").update(bytes).digest("hex"), bytes.length, pack.length, Buffer.from(pack.subarray(pack.length - 20)).toString("hex"),
    JSON.stringify([{ name: "refs/heads/claude/topic", sha: TOPIC }, { name: "refs/heads/main", sha: MAIN }]));
}

test("VS-3. the daily tick reads a bucket with head by range: verified, streamed, its reads counted; a binding that ignores ranges still verifies", async () => {
  for (const ignoreRange of [false, true]) {
    const db = migratedDb();
    storedRow(db, GIT_BUNDLE);
    const b = rangedBucket(GIT_BUNDLE, { ignoreRange });
    const v = await gitBackupVerifyTick({ DB: db as never, BUNDLES: b.bucket as never }, NOW, undefined, undefined, { pageBytes: 256, cacheBytes: 512 });
    assert.equal(v.outcome, "verified", JSON.stringify(v));
    assert.equal(v.streamed, true);
    assert.equal(v.verifier, 4);
    assert.ok(Number(v.r2_reads) >= Math.ceil(GIT_BUNDLE.length / 256), String(v.r2_reads));
    assert.ok(b.gets.length > 0 && b.gets.every((g) => g !== null && g.length <= 256), "every read is a range of one page");
    const row = db.raw.prepare("SELECT verify_status, verify_details FROM forge_git_backups WHERE run_id = 'gbk_fixture'").get() as any;
    assert.equal(row.verify_status, "verified");
    assert.equal(JSON.parse(row.verify_details).r2_reads, v.r2_reads);
  }
});

test("VS-4. it fails closed: too many reads, the time budget, a missing object, a bundle over the cap, a corrupted page", async () => {
  const run = async (bytes: Uint8Array, paging: Record<string, unknown>, cap?: number, bucket = rangedBucket(bytes).bucket) => {
    const db = migratedDb();
    storedRow(db, GIT_BUNDLE);
    return await gitBackupVerifyTick({ DB: db as never, BUNDLES: bucket as never }, NOW, undefined, cap, paging);
  };
  const many = await run(GIT_BUNDLE, { pageBytes: 64, maxReads: 3 });
  assert.deepEqual([many.outcome, many.reason, many.r2_reads], ["failed", "verify_too_many_reads", 4]);
  const late = await run(GIT_BUNDLE, { clock: () => Date.now() + VERIFY_ELAPSED_BUDGET_MS + 1 });
  assert.deepEqual([late.outcome, late.reason], ["failed", "verify_cpu_budget"]);
  const gone = await run(GIT_BUNDLE, {}, undefined, { ...rangedBucket(GIT_BUNDLE).bucket, head: async () => null } as never);
  assert.deepEqual([gone.outcome, gone.reason], ["failed", "bundle_missing_in_r2"]);
  const big = await run(GIT_BUNDLE, {}, 100);
  assert.deepEqual([big.outcome, big.reason], ["failed", "bundle_too_large_to_verify"]);
  const flipped = GIT_BUNDLE.slice(); flipped[400] ^= 0x10;
  const bad = await run(flipped, { pageBytes: 128 });
  assert.deepEqual([bad.outcome, bad.reason], ["failed", "sha256_mismatch"]);
});

const enc = new TextEncoder();
const catBytes = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };
const sha1Hex = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
/** A zlib stream of stored blocks (no node:zlib, which a runner may lack): header, blocks of at most 65,535 bytes, Adler-32. */
function zlibStored(d: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let i = 0; i < d.length || i === 0; i += 65_535) {
    const n = Math.min(65_535, d.length - i), last = i + n >= d.length;
    parts.push(Uint8Array.of(last ? 1 : 0, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff), d.subarray(i, i + n));
    if (!d.length) break;
  }
  const a = adler32(d);
  parts.push(Uint8Array.of(a >>> 24, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff));
  return catBytes(...parts);
}
/** A bundle of one commit, one tree and `blobs` pseudo-random 1 MiB blobs, built in memory. */
function storedBundle(blobs: number): { bytes: Uint8Array<ArrayBuffer>; objects: number } {
  const T = ["", "commit", "tree", "blob"];
  const oid = (t: number, b: Uint8Array) => sha1Hex(catBytes(enc.encode(`${T[t]} ${b.length}\0`), b));
  const hdr = (t: number, size: number) => { const o = [((t & 7) << 4) | (size & 15)]; let r = Math.floor(size / 16); while (r > 0) { o[o.length - 1] |= 0x80; o.push(r & 0x7f); r = Math.floor(r / 128); } return Uint8Array.from(o); };
  const bodies = Array.from({ length: blobs }, (_, i) => pseudoRandom(MiB, i + 1));
  const tree = catBytes(...bodies.map((b, i) => catBytes(enc.encode(`100644 f${String(i).padStart(4, "0")}\0`), Uint8Array.from(Buffer.from(oid(3, b), "hex")))));
  const commit = enc.encode(`tree ${oid(2, tree)}\nauthor S <s@example.invalid> 1794700000 +0000\ncommitter S <s@example.invalid> 1794700000 +0000\n\nc\n`);
  const objs: Array<[number, Uint8Array]> = [[1, commit], [2, tree], ...bodies.map((b) => [3, b] as [number, Uint8Array])];
  const head = new Uint8Array(12); head.set(enc.encode("PACK")); new DataView(head.buffer).setUint32(4, 2); new DataView(head.buffer).setUint32(8, objs.length);
  const pack0 = catBytes(head, ...objs.map(([t, b]) => catBytes(hdr(t, b.length), zlibStored(b))));
  const pack = catBytes(pack0, Uint8Array.from(Buffer.from(sha1Hex(pack0), "hex")));
  const cid = oid(1, commit);
  return { bytes: catBytes(enc.encode(`# v2 git bundle\n${cid} refs/heads/main\n${cid} HEAD\n\n`), pack) as Uint8Array<ArrayBuffer>, objects: objs.length };
}

test("VS-5. a bundle verifies from 4 MiB pages with about three reads a page; an 80 MiB one, in a child process, with live buffers about two pages and maxRSS growth under 64 MB", async (t) => {
  // In-process, on every runner: an 8 MiB bundle built in memory, read through the production page size and cache.
  const b = storedBundle(8);
  const src = new PagedSource(b.bytes.length, rangeOf(b.bytes));
  const v = await verifyBundleFrom(src);
  assert.equal(v.objects, b.objects);
  assert.equal(v.bundle_sha256, createHash("sha256").update(b.bytes).digest("hex"));
  assert.deepEqual(v, await verifyBundle(b.bytes), "the same verification as in memory");
  const pages = Math.ceil(b.bytes.length / VERIFY_PAGE_BYTES);
  assert.ok(src.reads >= pages && src.reads <= 3 * pages + 3, `reads ${src.reads} for ${pages} pages`);
  assert.ok(v.peak_held_bytes <= 2 * MiB, `held ${v.peak_held_bytes}`);
  // The memory needs a process of its own: the bundle built in a child, then verified in another, its maxRSS read.
  await t.test("VS-5m. 80 MiB, measured in a child process", async (st) => {
    if (!(await canSpawn())) { st.skip(NO_CHILD_PROCESS); return; }
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const child = new URL("./fixtures/verify-memory-child.mts", import.meta.url).pathname;
    const root = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
    const dir = mkdtempSync(join(tmpdir(), "vs5-"));
    const run = (args: string[], gc = false) => {
      const r = spawnSync(process.execPath, [...(gc ? ["--expose-gc"] : []), "--disable-warning=ExperimentalWarning", child, ...args], { encoding: "utf8", maxBuffer: 1 << 20 });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    };
    try {
      const file = join(dir, "b.bundle");
      const built = run(["build", root, file, "80", "0"]);
      assert.ok(built.bundle_bytes > 64 * MiB, String(built.bundle_bytes));
      const m = run(["verify-paged", root, file], true);
      assert.equal(m.objects, built.objects);
      assert.equal(m.bundle_bytes, built.bundle_bytes);
      // Sequential sweeps: the SHA-256, the pack's SHA-1, the entries; about three reads per page, nothing more here.
      const n = Math.ceil(built.bundle_bytes / VERIFY_PAGE_BYTES);
      assert.ok(m.r2_reads <= 3 * n + 3, `reads ${m.r2_reads} for ${n} pages`);
      // With a GC before each read (memory pressure does that in a 128 MB isolate; node alone lets garbage pages pile up).
      assert.ok(m.live_buffers < 24 * MiB, `live buffers ${(m.live_buffers / MiB).toFixed(1)} MiB`);
      assert.ok(m.added < 64 * 1000 * 1000, `maxRSS grew ${(m.added / MiB).toFixed(1)} MiB`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
