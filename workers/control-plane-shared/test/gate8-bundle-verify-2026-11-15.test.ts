// Gate 8 (owner 2026-11-15, "1 setuju"): `git bundle verify` of a stored R2 bundle, in code, once per UTC day, with a
// report. The Forge has no git binary (workerd), so forge/src/bundle-verify.ts parses the bundle header, checks the
// pack's SHA-1, inflates every entry with its own inflate, resolves every delta, computes every object id, checks the
// refs and their connectivity, and compares the bundle with its D1 row (SHA-256, size, pack SHA-1, objects, main,
// branches). The result goes on the row (migration 0072) and into the audit chain (forge.git_backup_verified); a
// failure is a production problem on the Owner page (git_backup_unverified). The fixtures are git's own bundles
// (test/fixtures/gate8-bundles.json) and packs built here from known bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, deflateSync } from "node:zlib";
import { OPERATOR_JWT, baseEnv, call, migratedDb, req, lastReviewedRecord } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import { forgeTick } from "../../forge/src/tick.ts";
import { GitBackupError } from "../../forge/src/git-backup.ts";
import {
  MAX_VERIFY_INFLATED_BYTES, TRANSIENT_VERIFY_FAILURES, VERIFIER_VERSION, adler32, applyDelta, checkRefs, gitBackupVerifyTick, indexPack, inflateZlib, parseBundleHeader,
  verifyBundle, verifyStoredBundle, type StoredBackup, type VerifyBucket,
} from "../../forge/src/bundle-verify.ts";
import { GIT_BACKUP_VERIFY_RETRY_MS, gitBackup, latestGitBackupVerify } from "../src/git-backup.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const FX = JSON.parse(readFileSync(new URL("./fixtures/gate8-bundles.json", import.meta.url), "utf8"));
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const V2 = b64(FX.v2_base64);
const V3 = b64(FX.v3_base64);
// The 9-object bundle of forge-git-backup-gate8.test.ts: `git bundle create --all` (git 2.43.0), main and claude/topic.
const GB1 = b64("IyB2MiBnaXQgYnVuZGxlCmU1NzliMWRhYjliN2JkMWU1ODk0N2FjZmUxNDExNTZjNmQxOTQxODUgcmVmcy9oZWFkcy9jbGF1ZGUvdG9waWMKNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCByZWZzL2hlYWRzL21haW4KNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCBIRUFECgpQQUNLAAAAAgAAAAmeDXicnctNDsIgEEDhPadgb2IGyvCTmMaVJ/ACAwxK0pYG0Xh89QpuXr7NG51ZThC8i1pBRJ90VhYJwEBIOfgSi0nGZfIUxE6dtyGNI53DhNYpRI2YtfFZ2xSVpQRky8QxWARBz3FvXV5av7G88mPIU/n5zG9a94WPdXvRUvMslQsGtQcAefgGRGrrWsfg/24x2l6T+AB8g0I+nw14nJ3LQQrCMBBA0X1OMXtBpknbJCDiyhN4gclkRgttU9IoHl+9gpvP2/xWRQCRE1P0mkVs6NU7dZgVx8zJRgmMvcYuqtmoytogKKtLiTRSF9CyJnRDyuxHi96hMAUOQmjo2R6lwrXUu8BN9gYn/fkib1q2WY7T+qJ5ymfofOwHGxARDt+g4bIsU2vy32124bJm8wF300UGngp4nJ3LQQrCMBBA0X1OMXtBptPGSUDElSfwAiEz1UBjSjqKx1ev4ObzNt+6KkjwKpSyH4WRhAMTDSwxpIlVM/HokQ5RXHravXW4tH5TuOpmcJx/Pus71XXRfXm80lLkBAPHyVNARNh9gy63WouZ/ne7ufTN3AdDMDURpgR4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wxxCiKEmvpKKEgT/pWl3ZOaHQBTOmqExd4Xafv0tHEAB2eBquPHicK8hJLEnLL8pVKDPiAgAfJAQ4NnicK8kvyEzmAgAItAIqpQJ4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wBwDX6A7XpQJ4nDM0MDAzMVEIcnV08XXVy01h+DmvecrzfVX/WeLPbc5cMevpg7J8PQD5qRAwOXicK8hJLEnLL8rlAgASrANwdnFZXD0qI0XwUxNug/64oT+jyX4=");
const enc = new TextEncoder();
const hexOf = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha1 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-1", b as Uint8Array<ArrayBuffer>));
const sha256 = async (b: Uint8Array) => hexOf(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of parts) { o.set(p, a); a += p.length; } return o; };
const headerEnd = (b: Uint8Array) => new TextDecoder().decode(b).indexOf("\n\n") + 2;
const reason = (e: unknown) => (e instanceof GitBackupError ? e.message : `not a GitBackupError: ${e}`);
async function rejects(p: Promise<unknown>, re: RegExp, label: string) {
  try { await p; } catch (e) { assert.match(reason(e), re, label); return; }
  assert.fail(`${label}: verified, expected ${re}`);
}

// ---------------------------------------------------------------- packs from known bytes

const TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const oid = async (type: string, body: Uint8Array) => hexOf(await sha1(cat(enc.encode(`${type} ${body.length}\0`), body)));
/** A pack entry header: type and size (base-128, 4 bits in the first byte). */
function entryHeader(type: number, size: number): Uint8Array {
  const out = [((type & 7) << 4) | (size & 0x0f)];
  let rest = Math.floor(size / 16);
  while (rest > 0) { out[out.length - 1] |= 0x80; out.push(rest & 0x7f); rest = Math.floor(rest / 128); }
  return Uint8Array.from(out);
}
const varint = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return Uint8Array.from(o); };
type PackEntry = { type: number; body: Uint8Array; base?: Uint8Array };
/** "PACK", version 2, the count, the entries (zlib), and the SHA-1 trailer. */
async function pack(entries: PackEntry[], count = entries.length): Promise<Uint8Array<ArrayBuffer>> {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"));
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, count);
  const body = cat(head, ...entries.map((e) => cat(entryHeader(e.type, e.body.length), e.base ?? new Uint8Array(0), new Uint8Array(deflateSync(e.body)))));
  return cat(body, await sha1(body)) as Uint8Array<ArrayBuffer>;
}
const bundleOf = (refs: Array<[string, string]>, p: Uint8Array, extra = "") => cat(enc.encode(`# v2 git bundle\n${extra}${refs.map(([n, s]) => `${s} ${n}\n`).join("")}\n`), p) as Uint8Array<ArrayBuffer>;
/** A tree with one blob and one subtree, a root commit and a child, and a ref-delta blob (built from the first). */
async function tinyRepo() {
  const blobA = enc.encode("gate 8 blob A, long enough to be a delta base for blob B\n".repeat(4));
  const blobB = cat(blobA, enc.encode("one more line\n"));
  const a = await oid("blob", blobA), b = await oid("blob", blobB);
  const sub = cat(enc.encode("100644 b.txt\0"), Uint8Array.from(Buffer.from(b, "hex")));
  const subId = await oid("tree", sub);
  const tree = cat(enc.encode("100644 a.txt\0"), Uint8Array.from(Buffer.from(a, "hex")), enc.encode("40000 sub\0"), Uint8Array.from(Buffer.from(subId, "hex")));
  const treeId = await oid("tree", tree);
  const c1 = enc.encode(`tree ${treeId}\nauthor F <f@x> 1794700000 +0000\ncommitter F <f@x> 1794700000 +0000\n\nfirst\n`);
  const c1Id = await oid("commit", c1);
  const c2 = enc.encode(`tree ${treeId}\nparent ${c1Id}\nauthor F <f@x> 1794700100 +0000\ncommitter F <f@x> 1794700100 +0000\n\nsecond\n`);
  const c2Id = await oid("commit", c2);
  // blob B as a ref-delta on blob A: copy all of A, then insert the extra line.
  const extra = enc.encode("one more line\n");
  const copy = Uint8Array.of(0x80 | 0x10 | 0x20, blobA.length & 0xff, (blobA.length >> 8) & 0xff); // offset 0, size = all of A
  const delta = cat(varint(blobA.length), varint(blobB.length), copy, Uint8Array.of(extra.length), extra);
  assert.deepEqual(applyDelta(blobA, delta), blobB);
  const entries: Record<string, PackEntry> = {
    c2: { type: 1, body: c2 }, c1: { type: 1, body: c1 }, tree: { type: 2, body: tree }, sub: { type: 2, body: sub },
    a: { type: 3, body: blobA }, bDelta: { type: 7, body: delta, base: Uint8Array.from(Buffer.from(a, "hex")) },
  };
  return { ids: { a, b, subId, treeId, c1Id, c2Id }, sizeA: blobA.length, entries, all: [entries.c2, entries.c1, entries.tree, entries.sub, entries.a, entries.bDelta] };
}

test("BV1. the inflate equals zlib's: every block type, the exact end of each stream, and its checks (header, Adler-32, size)", async () => {
  const text = enc.encode(Array.from({ length: 3000 }, (_, i) => `line ${i % 97} of a gate 8 inflate test ${i * 7919 % 1000}\n`).join(""));
  let x = 12345;
  const noise = Uint8Array.from({ length: 70_000 }, () => (x = (x * 1103515245 + 12345) >>> 0) >>> 24);
  const cases: Array<[string, Uint8Array, object]> = [
    ["stored", noise, { level: 0 }], ["fast", text, { level: 1 }], ["default", text, { level: 6 }], ["best", cat(text, noise.subarray(0, 5000)), { level: 9 }],
    ["fixed", text, { strategy: constants.Z_FIXED }], ["huffman only", text, { strategy: constants.Z_HUFFMAN_ONLY }], ["rle", text, { strategy: constants.Z_RLE }],
    ["empty", new Uint8Array(0), {}], ["one byte", Uint8Array.of(42), {}], ["long run", new Uint8Array(100_000).fill(7), { level: 9 }],
  ];
  for (const [label, data, opts] of cases) {
    const z = new Uint8Array(deflateSync(data, opts));
    const two = cat(z, enc.encode("NEXT"));
    const out = inflateZlib(two, 0, data.length);
    assert.deepEqual(out.data, data, label);
    assert.equal(out.next, z.length, `${label}: the stream's exact end (where the next pack entry starts)`);
  }
  assert.equal(adler32(enc.encode("Wikipedia")), 0x11e60398);
  const z = new Uint8Array(deflateSync(text));
  const badAdler = z.slice(); badAdler[badAdler.length - 1] ^= 1;
  assert.throws(() => inflateZlib(badAdler, 0, text.length), /zlib_adler32_mismatch/);
  assert.throws(() => inflateZlib(z, 0, text.length + 1), /inflate_size_mismatch/);
  assert.throws(() => inflateZlib(z, 0, text.length - 1), /inflate_size_mismatch/);
  assert.throws(() => inflateZlib(z.subarray(0, z.length - 10), 0, text.length), /inflate_truncated/);
  assert.throws(() => inflateZlib(Uint8Array.of(0x78, 0x00, 0, 0), 0, 0), /zlib_bad_header/);
  const flipped = z.slice(); flipped[40] ^= 0x55;
  assert.throws(() => inflateZlib(flipped, 0, text.length), GitBackupError, "a flipped bit in the stream fails (code, distance, size or Adler-32)");
});

test("BV2. a good bundle verifies: git's own v2 and v3 bundles (with deltas and a tag) and a pack with a ref-delta built from known bytes", async () => {
  for (const [label, bytes, version] of [["v2", V2, 2], ["v3", V3, 3]] as const) {
    const v = await verifyBundle(bytes as Uint8Array<ArrayBuffer>);
    assert.deepEqual([v.bundle_version, v.pack_version, v.objects, v.deltas, v.reachable, v.commits, v.trees, v.blobs, v.tags], [version, 2, FX.objects, FX.deltas, FX.objects, FX.commits, FX.trees, FX.blobs, FX.tags], label);
    assert.ok(v.deltas > 0, "the fixture has deltas, so delta resolution is exercised");
    assert.deepEqual(v.refs.map((r) => [r.name, r.sha]), [["refs/heads/claude/topic", FX.topic], ["refs/heads/main", FX.main], ["refs/tags/v1", FX.tag], ["HEAD", FX.main]]);
    assert.equal(v.bundle_sha256, await sha256(bytes));
    assert.equal(v.pack_sha1, hexOf(bytes.slice(-20)));
    assert.ok(v.peak_held_bytes <= v.inflated_bytes && v.peak_held_bytes > 0);
  }
  assert.deepEqual(parseBundleHeader(V3).capabilities, { "object-format": "sha1" });
  const g = await verifyBundle(GB1 as Uint8Array<ArrayBuffer>);
  assert.deepEqual([g.objects, g.reachable, g.commits, g.refs.length], [9, 9, 3, 3]);

  const r = await tinyRepo();
  const p = await pack(r.all);
  const idx = await indexPack(p);
  assert.equal(idx.deltas, 1);
  assert.deepEqual([...idx.byId.keys()].sort(), Object.values(r.ids).sort(), "every object id, the ref-delta's included, as index-pack computes it");
  const v = await verifyBundle(bundleOf([["refs/heads/main", r.ids.c2Id], ["HEAD", r.ids.c2Id]], p));
  assert.deepEqual([v.objects, v.deltas, v.reachable, v.commits, v.trees, v.blobs], [6, 1, 6, 2, 2, 2]);
  // An object no ref reaches is counted in the pack and allowed, as git allows it.
  const extraBlob: PackEntry = { type: 3, body: enc.encode("unreachable\n") };
  const loose = await verifyBundle(bundleOf([["refs/heads/main", r.ids.c2Id]], await pack([...r.all, extraBlob])));
  assert.deepEqual([loose.objects, loose.reachable], [7, 6]);
});

test("BV3. a truncated or corrupted pack fails: the checksum, a damaged zlib stream, the entry count walked against the header", async () => {
  const start = headerEnd(V2);
  for (const cut of [V2.length - 1, V2.length - 20, start + 40, start + 12, start + 3]) {
    await rejects(verifyBundle(V2.slice(0, cut)), /pack_checksum_mismatch|pack_too_short|not_a_pack/, `truncated at ${cut}`);
  }
  await rejects(verifyBundle(V2.slice(0, start - 1)), /bundle_header_unterminated|not_a_pack|pack_too_short/, "the header only");
  const flipped = V2.slice(); flipped[start + 200] ^= 0x01;
  await rejects(verifyBundle(flipped), /pack_checksum_mismatch/, "one bit in the pack");
  // With the trailer recomputed (a pack that is self-consistent but damaged inside), the entry walk catches it.
  const refix = async (b: Uint8Array) => { const out = b.slice(); out.set(await sha1(out.subarray(start, out.length - 20)), out.length - 20); return out as Uint8Array<ArrayBuffer>; };
  const inner = V2.slice(); inner[start + 30] ^= 0x10;
  await rejects(verifyBundle(await refix(inner)), /inflate_|zlib_|pack_/, "a damaged zlib stream");
  const more = V2.slice(); new DataView(more.buffer).setUint32(start + 8, FX.objects + 1);
  await rejects(verifyBundle(await refix(more)), /pack_entries_missing:1/, "the header counts one object more than the pack holds");
  const fewer = V2.slice(); new DataView(fewer.buffer).setUint32(start + 8, FX.objects - 1);
  await rejects(verifyBundle(await refix(fewer)), /pack_trailing_bytes/, "the header counts one object fewer");
  const v4 = V2.slice(); v4[start + 7] = 4;
  await rejects(verifyBundle(await refix(v4)), /pack_version_4/, "pack version 4");

  const r = await tinyRepo();
  const refs: Array<[string, string]> = [["refs/heads/main", r.ids.c2Id]];
  await rejects(verifyBundle(bundleOf(refs, await pack([r.entries.c2, r.entries.c1, r.entries.tree, r.entries.sub, r.entries.bDelta]))), /pack_thin_ref_delta_base_missing/, "a thin pack (ref-delta base not in it)");
  const badType = await pack([{ type: 5, body: enc.encode("x") }]);
  await rejects(verifyBundle(bundleOf(refs, badType)), /pack_bad_object_type_5/, "type 5 is reserved");
  const badDelta: PackEntry = { ...r.entries.bDelta, body: cat(varint(r.sizeA + 1), r.entries.bDelta.body.subarray(varint(r.sizeA).length)) };
  await rejects(verifyBundle(bundleOf(refs, await pack([...r.all.slice(0, 5), badDelta]))), /delta_base_size_mismatch/, "a delta for another base");
  assert.throws(() => applyDelta(enc.encode("abc"), cat(varint(3), varint(4), Uint8Array.of(0x00))), /delta_reserved_opcode/);
  assert.throws(() => applyDelta(enc.encode("abc"), cat(varint(3), varint(4), Uint8Array.of(0x90, 4))), /delta_copy_out_of_range/);
  // A pack that inflates past the bound fails as too large rather than exhausting memory.
  await rejects(indexPack(await pack(r.all), 100), /pack_too_large_to_verify/, "the memory bound");
  assert.equal(MAX_VERIFY_INFLATED_BYTES, 32 * 1024 * 1024, "32 MiB since 2026-11-26 (was 64 MiB): the measured peak in a 128 MB Worker");
});

test("BV4. the header: the signature, v3 capabilities, prerequisites, ref lines", async () => {
  const p = V2.subarray(headerEnd(V2));
  const h = (text: string) => cat(enc.encode(text), p) as Uint8Array<ArrayBuffer>;
  const M = FX.main;
  await rejects(verifyBundle(h(`# v4 git bundle\n${M} refs/heads/main\n\n`)), /bundle_bad_signature/, "v4");
  await rejects(verifyBundle(h(`<html>\n\n`)), /bundle_bad_signature/, "not a bundle");
  await rejects(verifyBundle(h(`# v3 git bundle\n@object-format=sha256\n${M} refs/heads/main\n\n`)), /bundle_object_format_sha256/, "sha256 repository");
  await rejects(verifyBundle(h(`# v3 git bundle\n@filter=blob:none\n${M} refs/heads/main\n\n`)), /bundle_filtered/, "a partial (filtered) bundle is not a full copy");
  await rejects(verifyBundle(h(`# v3 git bundle\n@future=1\n${M} refs/heads/main\n\n`)), /bundle_unknown_capability/, "unknown capability");
  await rejects(verifyBundle(h(`# v2 git bundle\n@object-format=sha1\n${M} refs/heads/main\n\n`)), /bundle_capability_in_v2/, "capabilities are v3 only");
  await rejects(verifyBundle(h(`# v2 git bundle\n-${FX.topic} an older commit\n${M} refs/heads/main\n\n`)), /bundle_has_prerequisites/, "prerequisites: not a full clone");
  await rejects(verifyBundle(h(`# v2 git bundle\n${M} refs/heads/main\n${M} refs/heads/main\n\n`)), /bundle_duplicate_ref/, "duplicate ref");
  await rejects(verifyBundle(h(`# v2 git bundle\n${M} refs/heads/a b\n\n`)), /bundle_bad_ref_line/, "a ref name with a space");
  await rejects(verifyBundle(h(`# v2 git bundle\n${M} main\n\n`)), /bundle_bad_ref_line/, "a ref outside refs/");
  await rejects(verifyBundle(h(`# v2 git bundle\n\n`)), /bundle_no_refs/, "no refs");
  await rejects(verifyBundle(enc.encode(`# v2 git bundle\n${M} refs/heads/main\n`) as Uint8Array<ArrayBuffer>), /bundle_header_unterminated/, "no blank line");
  // The same pack under a header naming only main verifies (claude/topic and v1 are then unreachable, but present).
  const only = await verifyBundle(h(`# v2 git bundle\n${M} refs/heads/main\n\n`));
  assert.deepEqual([only.objects, only.reachable < only.objects], [FX.objects, true]);
});

test("BV5. a ref pointing to a missing object fails, and so does anything a ref reaches that is missing or of the wrong type", async () => {
  const p = V2.subarray(headerEnd(V2));
  const missing = "0123456789abcdef0123456789abcdef01234567";
  await rejects(verifyBundle(cat(enc.encode(`# v2 git bundle\n${missing} refs/heads/main\n\n`), p) as Uint8Array<ArrayBuffer>), /ref_target_missing:refs\/heads\/main/, "a branch to an object not in the pack");
  await rejects(verifyBundle(cat(enc.encode(`# v2 git bundle\n${FX.main} refs/heads/main\n${missing} HEAD\n\n`), p) as Uint8Array<ArrayBuffer>), /ref_target_missing:HEAD/, "HEAD to an object not in the pack");
  await rejects(verifyBundle(cat(enc.encode(`# v2 git bundle\n${FX.tag} refs/heads/main\n\n`), p) as Uint8Array<ArrayBuffer>), /ref_not_a_commit:refs\/heads\/main/, "a branch to a tag object");
  // A tag ref may name an annotated tag.
  await verifyBundle(cat(enc.encode(`# v2 git bundle\n${FX.main} refs/heads/main\n${FX.tag} refs/tags/v1\n\n`), p) as Uint8Array<ArrayBuffer>);

  const r = await tinyRepo();
  const refs: Array<[string, string]> = [["refs/heads/main", r.ids.c2Id]];
  // The parent commit left out (a shallow history): main's commit is there, its parent is not.
  await rejects(verifyBundle(bundleOf(refs, await pack([r.entries.c2, r.entries.tree, r.entries.sub, r.entries.a, r.entries.bDelta]))), new RegExp(`object_missing:${r.ids.c1Id}`), "a missing parent");
  // A missing blob in a tree.
  const noBlobB = await pack([r.entries.c2, r.entries.c1, r.entries.tree, r.entries.sub, r.entries.a]);
  await rejects(verifyBundle(bundleOf(refs, noBlobB)), new RegExp(`object_missing:${r.ids.b}`), "a missing blob");
  // A tree entry that names a blob as a subtree.
  const wrong = cat(enc.encode("40000 a.txt\0"), Uint8Array.from(Buffer.from(r.ids.a, "hex")));
  const wrongId = await oid("tree", wrong);
  const c = enc.encode(`tree ${wrongId}\nauthor F <f@x> 1 +0000\ncommitter F <f@x> 1 +0000\n\nx\n`);
  const cId = await oid("commit", c);
  await rejects(verifyBundle(bundleOf([["refs/heads/main", cId]], await pack([{ type: 1, body: c }, { type: 2, body: wrong }, r.entries.a]))), new RegExp(`object_type_mismatch:${r.ids.a}`), "a blob named as a tree");
  const broken = enc.encode("not a commit\n");
  const bId = await oid("commit", broken);
  await rejects(verifyBundle(bundleOf([["refs/heads/main", bId]], await pack([{ type: 1, body: broken }]))), /commit_malformed/, "a commit without a tree line");
  // checkRefs alone, on an index: every ref is looked up.
  assert.throws(() => checkRefs([{ name: "refs/heads/x", sha: missing }], new Map()), /ref_target_missing:refs\/heads\/x/);
});

// ---------------------------------------------------------------- the stored bundle and the daily tick

const KEY = (day: string, sha: string) => `git-backups/platform/${day}-${sha}.bundle`;
function bucketWith(objects: Map<string, { bytes: Uint8Array; meta?: Record<string, string> }>, opts: { throwGet?: () => boolean } = {}) {
  const gets: string[] = [];
  const bucket: VerifyBucket = {
    async put() { return null; },
    async list() { return { objects: [], truncated: false }; },
    async delete() {},
    async get(key) {
      gets.push(key);
      if (opts.throwGet?.()) throw new Error("R2 internal error");
      const o = objects.get(key);
      return o ? { size: o.bytes.length, customMetadata: o.meta, arrayBuffer: async () => o.bytes.slice().buffer } : null;
    },
  };
  return { bucket, gets };
}
/** The row gitBackupTick writes for a bundle (forge_git_backups, migration 0054). */
async function rowFor(bytes: Uint8Array, day: string, ranAt: string, runId: string) {
  const refs = parseBundleHeader(bytes).refs;
  const main = refs.find((r) => r.name === "HEAD")!.sha;
  return {
    run_id: runId, main_sha: main, day, ran_at: ranAt, r2_key: KEY(day, main), bundle_sha256: await sha256(bytes), bundle_bytes: bytes.length,
    pack_sha1: hexOf(bytes.slice(-20)), objects: new DataView(bytes.buffer, bytes.byteOffset + headerEnd(bytes) + 8, 4).getUint32(0),
    refs_json: JSON.stringify(refs.filter((r) => r.name !== "HEAD")),
  };
}
function insert(db: ReturnType<typeof migratedDb>, r: Awaited<ReturnType<typeof rowFor>>) {
  db.raw.prepare(`INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status, r2_key, bundle_sha256, bundle_bytes, pack_bytes, pack_sha1, pack_version, objects, refs, refs_json)
    VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, 0, ?, 2, ?, 0, ?)`).run(r.run_id, r.main_sha, r.day, r.ran_at, r.r2_key, r.bundle_sha256, r.bundle_bytes, r.pack_sha1, r.objects, r.refs_json);
}
const verifyAudits = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = 'forge.git_backup_verified' ORDER BY rowid").all().map((r: any) => ({ ...r, payload: JSON.parse(r.payload_json) }));
const row = (db: ReturnType<typeof migratedDb>, id: string) => ({ ...(db.raw.prepare("SELECT verified_at, verify_status, verify_details FROM forge_git_backups WHERE run_id = ?").get(id) as any) });

test("BV6. a wrong SHA-256 fails, and so does any other difference from the record (size, pack SHA-1, objects, main, branches, R2 metadata)", async () => {
  const good = await rowFor(V2, "2026-11-15", "2026-11-15T00:04:00.000Z", "gbk_a");
  const ok = await verifyStoredBundle(V2 as Uint8Array<ArrayBuffer>, good as StoredBackup, { sha256: good.bundle_sha256 });
  assert.equal(ok.objects, FX.objects);
  const cases: Array<[Partial<StoredBackup>, RegExp, Record<string, string> | undefined]> = [
    [{ bundle_sha256: "0".repeat(64) }, /sha256_mismatch/, undefined],
    [{ bundle_sha256: null }, /sha256_mismatch/, undefined],
    [{}, /r2_metadata_sha256_mismatch/, { sha256: "f".repeat(64) }],
    [{ bundle_bytes: V2.length + 1 }, /size_mismatch/, undefined],
    [{ pack_sha1: "0".repeat(40) }, /pack_sha1_mismatch/, undefined],
    [{ objects: FX.objects - 1 }, /object_count_mismatch/, undefined],
    [{ main_sha: FX.topic }, /main_mismatch/, undefined],
    [{ refs_json: JSON.stringify([{ name: "refs/heads/main", sha: FX.main }]) }, /refs_mismatch/, undefined],
    [{ refs_json: "{" }, /record_refs_unreadable/, undefined],
  ];
  for (const [patch, re, meta] of cases) await rejects(verifyStoredBundle(V2 as Uint8Array<ArrayBuffer>, { ...good, ...patch } as StoredBackup, meta), re, JSON.stringify(patch));
  // The same bundle with one changed byte is not the recorded one: the SHA-256 says so before any parsing.
  const changed = V2.slice(); changed[headerEnd(V2) + 100] ^= 1;
  await rejects(verifyStoredBundle(changed as Uint8Array<ArrayBuffer>, good as StoredBackup, undefined), /sha256_mismatch/, "a changed byte");
});

test("BV7. the daily verify: once per UTC day, the newest stored bundle, recorded on its row, audited, shown by GET /v1/forge/git-backup", async () => {
  const db = migratedDb();
  const DAY1 = Date.parse("2026-11-15T00:04:00.000Z");
  const older = await rowFor(GB1, "2026-11-14", "2026-11-14T00:04:00.000Z", "gbk_old");
  const newest = await rowFor(V2, "2026-11-15", "2026-11-15T00:04:00.000Z", "gbk_new");
  insert(db, older); insert(db, newest);
  const objects = new Map<string, { bytes: Uint8Array; meta?: Record<string, string> }>([[older.r2_key, { bytes: GB1 }], [newest.r2_key, { bytes: V2, meta: { sha256: newest.bundle_sha256 } }]]);
  const b = bucketWith(objects);
  const env = { DB: db as never, BUNDLES: b.bucket };

  const before = await call(forge, baseEnv("cryptophys-forge", db), req("GET", "/v1/forge/git-backup", undefined, OPERATOR_JWT));
  assert.equal(before.body.backup.verify, null, "no verify yet");

  const first = await gitBackupVerifyTick(env, DAY1 + 30_000);
  assert.equal(first.outcome, "verified", String(first.reason ?? ""));
  assert.deepEqual([first.run_id, first.key, first.objects, first.deltas, first.reachable, first.refs], ["gbk_new", newest.r2_key, FX.objects, FX.deltas, FX.objects, 3]);
  assert.deepEqual(b.gets, [newest.r2_key], "the newest stored bundle only");
  const r1 = row(db, "gbk_new");
  assert.deepEqual([r1.verified_at, r1.verify_status], ["2026-11-15T00:04:30.000Z", "verified"]);
  assert.equal(JSON.parse(r1.verify_details).bundle_sha256, newest.bundle_sha256);
  assert.equal(row(db, "gbk_old").verified_at, null);
  const [ev] = verifyAudits(db);
  assert.deepEqual([ev.subject, ev.outcome, ev.payload.run_id, ev.payload.main_sha, ev.payload.objects], [newest.r2_key, "verified", "gbk_new", FX.main, FX.objects]);

  // Once per UTC day: every later tick of the same day is not due, whatever happens to the bundle.
  for (const later of [DAY1 + 15 * 60_000, DAY1 + 6 * 3_600_000, Date.parse("2026-11-15T23:59:00.000Z")]) {
    assert.equal((await gitBackupVerifyTick(env, later)).outcome, "not_due");
  }
  assert.equal(b.gets.length, 1, "R2 was read once that day");
  assert.equal(verifyAudits(db).length, 1);

  // The view: GET /v1/forge/git-backup carries verified_at, verify_status and the details.
  const r = await call(forge, baseEnv("cryptophys-forge", db), req("GET", "/v1/forge/git-backup", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200);
  const v = r.body.backup.verify;
  assert.deepEqual([v.run_id, v.r2_key, v.verified_at, v.verify_status, v.details.objects, v.details.reachable], ["gbk_new", newest.r2_key, "2026-11-15T00:04:30.000Z", "verified", FX.objects, FX.objects]);
  assert.equal(r.body.backup.runs.find((x: any) => x.run_id === "gbk_new").verify_status, "verified");
  assert.deepEqual(await unhandledProblems(db as never, DAY1 + 60_000).then((ps) => ps.filter((p) => p.code === "git_backup_unverified")), [], "a verified bundle is no problem");

  // The next UTC day it runs again, on the newest bundle then stored.
  const DAY2 = Date.parse("2026-11-16T00:04:10.000Z");
  const third = await rowFor(GB1, "2026-11-16", "2026-11-16T00:04:00.000Z", "gbk_day2");
  insert(db, third);
  objects.set(third.r2_key, { bytes: GB1 });
  const second = await gitBackupVerifyTick(env, DAY2);
  assert.deepEqual([second.outcome, second.run_id], ["verified", "gbk_day2"]);
  assert.equal((await gitBackupVerifyTick(env, DAY2 + 3_600_000)).outcome, "not_due");
  assert.equal(verifyAudits(db).length, 2, "one verify per UTC day");
});

test("BV8. a failed verify is recorded and audited, becomes an Owner page problem, is not retried the same day, and closes when a later verify succeeds", async () => {
  const db = migratedDb();
  const DAY1 = Date.parse("2026-11-15T00:04:00.000Z");
  const good = await rowFor(V2, "2026-11-15", "2026-11-15T00:04:00.000Z", "gbk_bad");
  insert(db, good);
  const corrupted = V2.slice(); corrupted[headerEnd(V2) + 300] ^= 0x40;
  const objects = new Map<string, { bytes: Uint8Array; meta?: Record<string, string> }>([[good.r2_key, { bytes: corrupted }]]);
  const env = { DB: db as never, BUNDLES: bucketWith(objects).bucket };
  const r = await gitBackupVerifyTick(env, DAY1);
  assert.deepEqual([r.outcome, r.reason], ["failed", "sha256_mismatch"]);
  assert.deepEqual([row(db, "gbk_bad").verify_status, JSON.parse(row(db, "gbk_bad").verify_details).reason], ["failed", "sha256_mismatch"]);
  const [ev] = verifyAudits(db);
  assert.deepEqual([ev.outcome, ev.payload.reason], ["failed", "sha256_mismatch"]);
  const problems = (await unhandledProblems(db as never, DAY1 + 60_000)).filter((p) => p.code === "git_backup_unverified");
  assert.equal(problems.length, 1);
  assert.deepEqual([problems[0].subject, problems[0].link, problems[0].since], ["gbk_bad", "#/code", "2026-11-15T00:04:00.000Z"]);
  assert.match(problems[0].detail, /failed git bundle verify .*sha256_mismatch/);
  assert.match(read("workers/console/ui/src/pages/Owner.tsx"), /git_backup_unverified: "git backup failed verify"/);
  // A failure of the bundle itself is not retried the same day (the next day's verify reads it again).
  assert.equal((await gitBackupVerifyTick(env, DAY1 + 2 * GIT_BACKUP_VERIFY_RETRY_MS)).outcome, "not_due");

  // A missing object in R2 fails as such.
  objects.delete(good.r2_key);
  const DAY2 = Date.parse("2026-11-16T00:04:00.000Z");
  assert.deepEqual([(await gitBackupVerifyTick(env, DAY2)).reason], ["bundle_missing_in_r2"]);

  // An R2 read error is transient: retried after an hour the same day, not before.
  const DAY3 = Date.parse("2026-11-17T00:04:00.000Z");
  objects.set(good.r2_key, { bytes: V2 });
  let throwing = true;
  const flaky = { DB: db as never, BUNDLES: bucketWith(objects, { throwGet: () => throwing }).bucket };
  assert.deepEqual([(await gitBackupVerifyTick(flaky, DAY3)).reason], ["r2_get_failed"]);
  assert.ok(TRANSIENT_VERIFY_FAILURES.has("r2_get_failed"));
  assert.equal((await gitBackupVerifyTick(flaky, DAY3 + GIT_BACKUP_VERIFY_RETRY_MS - 60_000)).outcome, "not_due");
  throwing = false;
  const retried = await gitBackupVerifyTick(flaky, DAY3 + GIT_BACKUP_VERIFY_RETRY_MS);
  assert.equal(retried.outcome, "verified");
  assert.deepEqual((await unhandledProblems(db as never, DAY3 + GIT_BACKUP_VERIFY_RETRY_MS + 60_000)).filter((p) => p.code === "git_backup_unverified"), [], "a later successful verify closes the problem");
  assert.deepEqual(verifyAudits(db).map((e) => e.outcome), ["failed", "failed", "failed", "verified"]);
});

test("BV12. a failure recorded by an older verifier (no `verifier`, or another version) is retried the same day after an hour, once; this version's own failure is not", async () => {
  // 2026-11-20: the 00:05 verify of 664c236 failed pack_too_large_to_verify under version 1; version 2 (indexPack no
  // longer holds the pack's content) deployed at 02:23. Without this, the bundle would be read again only the next day.
  const db = migratedDb();
  const good = await rowFor(V2, "2026-11-20", "2026-11-20T00:04:00.000Z", "gbk_v1");
  insert(db, good);
  const objects = new Map<string, { bytes: Uint8Array; meta?: Record<string, string> }>([[good.r2_key, { bytes: V2 }]]);
  const env = { DB: db as never, BUNDLES: bucketWith(objects).bucket };
  const AT = Date.parse("2026-11-20T00:05:20.445Z");
  db.raw.prepare("UPDATE forge_git_backups SET verified_at = ?, verify_status = 'failed', verify_details = ? WHERE run_id = ?")
    .run(new Date(AT).toISOString(), JSON.stringify({ reason: "pack_too_large_to_verify", duration_ms: 1200 }), "gbk_v1");
  assert.equal(VERIFIER_VERSION, 3, "3 since 2026-11-26 (no whole-input digest copies, the 32 MiB bound)");
  assert.ok(!TRANSIENT_VERIFY_FAILURES.has("pack_too_large_to_verify"), "the reason itself is not transient");
  assert.equal((await gitBackupVerifyTick(env, AT + GIT_BACKUP_VERIFY_RETRY_MS - 60_000)).outcome, "not_due", "not before the hour");
  const r = await gitBackupVerifyTick(env, AT + GIT_BACKUP_VERIFY_RETRY_MS);
  assert.deepEqual([r.outcome, r.run_id, r.verifier], ["verified", "gbk_v1", VERIFIER_VERSION]);
  assert.equal(JSON.parse(row(db, "gbk_v1").verify_details).verifier, VERIFIER_VERSION, "recorded with its version");
  assert.deepEqual((await unhandledProblems(db as never, AT + GIT_BACKUP_VERIFY_RETRY_MS + 60_000)).filter((p) => p.code === "git_backup_unverified"), [], "the problem closes");
  assert.equal((await gitBackupVerifyTick(env, AT + 3 * GIT_BACKUP_VERIFY_RETRY_MS)).outcome, "not_due", "a verified day is done");

  // Another version's failure is retried too; this version's own failure of the bundle is not (no loop).
  const DAY2 = Date.parse("2026-11-21T00:05:00.000Z");
  db.raw.prepare("UPDATE forge_git_backups SET verified_at = ?, verify_status = 'failed', verify_details = ? WHERE run_id = ?")
    .run(new Date(DAY2).toISOString(), JSON.stringify({ reason: "pack_delta_unresolvable", verifier: 1 }), "gbk_v1");
  assert.equal((await gitBackupVerifyTick(env, DAY2 + GIT_BACKUP_VERIFY_RETRY_MS)).outcome, "verified");
  const DAY3 = Date.parse("2026-11-22T00:05:00.000Z");
  const corrupted = V2.slice(); corrupted[headerEnd(V2) + 300] ^= 0x40;
  objects.set(good.r2_key, { bytes: corrupted });
  const f = await gitBackupVerifyTick(env, DAY3);
  assert.deepEqual([f.outcome, f.reason, f.verifier], ["failed", "sha256_mismatch", VERIFIER_VERSION]);
  assert.equal((await gitBackupVerifyTick(env, DAY3 + 2 * GIT_BACKUP_VERIFY_RETRY_MS)).outcome, "not_due", "its own failure waits for the next day");
  assert.match(read("workers/forge/src/bundle-verify.ts"), /export const VERIFIER_VERSION = 3;/);
});

test("BV9. the Forge tick runs git_backup_verify after git_backup when the bucket is bound; nothing to verify, no get(), and before migration 0072", async () => {
  const db = migratedDb();
  const steps = await forgeTick({ DB: db as never, BUNDLES: bucketWith(new Map()).bucket as never }, "platform", null);
  assert.deepEqual(steps.git_backup_verify, { outcome: "no_bundle" });
  const plain = await forgeTick({ DB: db as never, BUNDLES: { put: async () => null, list: async () => ({ objects: [], truncated: false }), delete: async () => {} } as never }, "platform", null);
  assert.deepEqual(plain.git_backup_verify, { outcome: "not_configured" });
  const none = await forgeTick({ DB: db as never }, "platform", null);
  assert.equal(none.git_backup_verify, undefined, "no bucket, no step");
  const tick = read("workers/forge/src/tick.ts");
  assert.ok(tick.indexOf('step("git_backup"') < tick.indexOf('step("git_backup_verify"'), "after the backup step");
  // Before migration 0072: the view has no verify, the tick reports and throws nothing.
  const old = migratedDb();
  for (const c of ["verified_at", "verify_status", "verify_details"]) {
    old.raw.exec("DROP INDEX IF EXISTS idx_forge_git_backups_verified");
    old.raw.exec(`ALTER TABLE forge_git_backups DROP COLUMN ${c}`);
  }
  insert(old, await rowFor(V2, "2026-11-15", "2026-11-15T00:04:00.000Z", "gbk_pre"));
  assert.equal(await latestGitBackupVerify(old as never), undefined);
  const view = (await gitBackup(old as never, Date.parse("2026-11-15T01:00:00.000Z")))!;
  assert.deepEqual([view.status, view.verify, view.runs.length], ["ok", null, 1]);
  const t = await gitBackupVerifyTick({ DB: old as never, BUNDLES: bucketWith(new Map()).bucket }, Date.now());
  assert.deepEqual([t.outcome, t.recorded], ["failed", false]);
});

test("BV10. migration 0072 is additive (three nullable columns, a CHECK on verify_status), and the change touches no guard path", () => {
  const sql = read("workers/control-plane-migrations/0072_forge_git_backup_verify.sql");
  const code = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(code, /\b(DROP|DELETE|UPDATE|RENAME|INSERT)\b/i, "additive only: the native migration path applies it");
  assert.equal((code.match(/ALTER TABLE forge_git_backups ADD COLUMN/g) ?? []).length, 3);
  const db = migratedDb();
  const cols = (db.raw.prepare("PRAGMA table_info(forge_git_backups)").all() as any[]).map((c) => c.name);
  assert.deepEqual(cols.slice(-3), ["verified_at", "verify_status", "verify_details"]);
  db.raw.prepare("INSERT INTO forge_git_backups (run_id, main_sha, day, ran_at, status) VALUES ('x', 'm', 'd', 't', 'ok')").run();
  db.raw.prepare("UPDATE forge_git_backups SET verify_status = 'verified' WHERE run_id = 'x'").run();
  db.raw.prepare("UPDATE forge_git_backups SET verify_status = 'failed' WHERE run_id = 'x'").run();
  assert.throws(() => db.raw.prepare("UPDATE forge_git_backups SET verify_status = 'ok' WHERE run_id = 'x'").run(), /CHECK/);
  for (const p of [
    "workers/forge/src/bundle-verify.ts", "workers/forge/src/tick.ts", "workers/control-plane-shared/src/git-backup.ts", "workers/ai-kernel/src/owner-inbox.ts",
    "workers/control-plane-migrations/0072_forge_git_backup_verify.sql", "workers/console/ui/src/components/GitBackup.tsx", "workers/console/ui/src/pages/Owner.tsx",
    "workers/control-plane-shared/test/gate8-bundle-verify-2026-11-15.test.ts", "workers/control-plane-shared/test/fixtures/gate8-bundles.json",
  ]) assert.equal(criticalPathReason(p), null, p);
  // The docs say what verify covers and when the gate is met.
  const cutover = read("docs/GITHUB-CUTOVER.md");
  assert.match(cutover, /[Mm]et once the first scheduled verify succeeds live/);
  assert.match(cutover, /git_backup_verify/);
  assert.match(lastReviewedRecord(), /Last reviewed: (?:[^\n]*\); )?2026-11-15 \([^\n]*git_backup_verify/, "the 2026-11-15 entry (newer entries come first)");
  assert.match(read("workers/console/ui/src/components/GitBackup.tsx"), /b\?\.verify/);
});

test("BV11. against the git CLI (where it exists): git's bundles of a repository with deltas and a tag verify here, and a shallow-history bundle git cannot restore fails", async () => {
  const git = (() => { try { return spawnSync("git", ["--version"], { encoding: "utf8" }); } catch { return null; } })();
  if (!git || git.status !== 0) { console.log("git is not available here: the committed git bundles of BV2 stand in"); return; }
  const dir = mkdtempSync(join(tmpdir(), "gate8-verify-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Forge Test", GIT_AUTHOR_EMAIL: "forge@example.invalid", GIT_COMMITTER_NAME: "Forge Test", GIT_COMMITTER_EMAIL: "forge@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const g = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString();
  };
  try {
    const src = join(dir, "src");
    g(dir, ["init", "-q", "-b", "main", src]);
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(src, "big.txt"), Array.from({ length: 400 + i * 9 }, (_, k) => `row ${k} ${k % (i + 3)}\n`).join(""));
      writeFileSync(join(src, `f${i % 4}.txt`), `file ${i}\n`.repeat(30 + i));
      g(src, ["add", "."]); g(src, ["commit", "-q", "-m", `commit ${i}`]);
    }
    g(src, ["tag", "-a", "v1", "-m", "v1"]);
    g(src, ["repack", "-adf", "-q", "--window=50", "--depth=20"]);
    const file = join(dir, "all.bundle");
    g(src, ["bundle", "create", "-q", file, "--all"]);
    g(src, ["bundle", "verify", "-q", file]);
    const bytes = new Uint8Array(readFileSync(file));
    const v = await verifyBundle(bytes);
    const count = g(src, ["rev-list", "--objects", "--all"]).trim().split("\n").length;
    assert.equal(v.reachable, count, "every object git lists is reached");
    assert.ok(v.deltas > 0, `deltas resolved: ${v.deltas}`);
    // A shallow clone's bundle lacks the parents beyond its boundary: git clone of it fails, and so does verify here.
    const shallow = join(dir, "shallow");
    g(dir, ["clone", "-q", "--depth=2", `file://${src}`, shallow]);
    const sfile = join(dir, "shallow.bundle");
    g(shallow, ["bundle", "create", "-q", sfile, "main"]);
    await rejects(verifyBundle(new Uint8Array(readFileSync(sfile))), /object_missing:/, "a shallow history");
    console.log(`git CLI cross-check: ${v.objects} objects, ${v.deltas} deltas, ${v.reachable} reachable; shallow bundle refused`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
