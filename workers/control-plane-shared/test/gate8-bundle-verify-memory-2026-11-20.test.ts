// Gate 8, git backup verify memory (2026-11-20). The 00:05 verify of 664c236 failed `pack_too_large_to_verify`: the
// old indexPack held every entry's inflated content at once (then every commit and tree), so the peak grew with the
// repository (26.4 MB on 16 Nov to 57.5 MB on 19 Nov, about 10 MB a day) until it passed MAX_VERIFY_INFLATED_BYTES.
// Now an entry's content is dropped once it is named, the index keeps only types and links, and the deltas are
// resolved family by family with a bounded cache. These tests build packs whose content is far above the bound while
// every object is below it, with ofs- and ref-deltas (forward ref-deltas included), and check that they verify with a
// small peak that does not grow with the history, and that every failure the verify reported before still fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { GitBackupError } from "../../forge/src/git-backup.ts";
import {
  LINK_BYTES, MAX_DELTA_DEPTH, MAX_VERIFY_INFLATED_BYTES, VERIFY_CACHE_BYTES, applyDelta, indexPack, verifyBundle, verifyStoredBundle, type StoredBackup,
} from "../../forge/src/bundle-verify.ts";

const enc = new TextEncoder();
const sha1hex = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of parts) { o.set(p, a); a += p.length; } return o; };
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const TYPE = ["", "commit", "tree", "blob", "tag"];
const oid = (type: number, body: Uint8Array) => sha1hex(cat(enc.encode(`${TYPE[type]} ${body.length}\0`), body));
const reason = (e: unknown) => (e instanceof GitBackupError ? e.message : `not a GitBackupError: ${e}`);
async function rejects(p: Promise<unknown>, re: RegExp, label: string) {
  try { await p; } catch (e) { assert.match(reason(e), re, label); return; }
  assert.fail(`${label}: verified, expected ${re}`);
}

// ---------------------------------------------------------------- a pack writer with ofs- and ref-deltas

const varint = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return o; };
/** git's delta: the source and target sizes, a copy of the common prefix, the middle inserted, a copy of the common suffix. */
function makeDelta(base: Uint8Array, target: Uint8Array, opts: { sourceSize?: number; copyPastEnd?: boolean } = {}): Uint8Array {
  let p = 0;
  while (p < base.length && p < target.length && base[p] === target[p]) p++;
  let s = 0;
  while (s < base.length - p && s < target.length - p && base[base.length - 1 - s] === target[target.length - 1 - s]) s++;
  const out: number[] = [...varint(opts.sourceSize ?? base.length), ...varint(target.length)];
  const copy = (off: number, len: number) => {
    const op = [0x80];
    for (let i = 0; i < 4; i++) { const b = Math.floor(off / 2 ** (8 * i)) & 0xff; if (b) { op[0] |= 1 << i; op.push(b); } }
    for (let i = 0; i < 3; i++) { const b = (len >>> (8 * i)) & 0xff; if (b) { op[0] |= 0x10 << i; op.push(b); } }
    out.push(...op);
  };
  if (p) copy(opts.copyPastEnd ? base.length - p + 1 : 0, p);
  for (let i = p; i < target.length - s; i += 127) { const chunk = target.subarray(i, Math.min(i + 127, target.length - s)); out.push(chunk.length, ...chunk); }
  if (s) copy(base.length - s, s);
  return Uint8Array.from(out);
}

type Entry =
  | { kind: "whole"; type: number; body: Uint8Array }
  | { kind: "ofs"; base: number; delta: Uint8Array }
  | { kind: "ref"; baseId: string; delta: Uint8Array };
function entryHeader(type: number, size: number): number[] {
  const out = [((type & 7) << 4) | (size & 0x0f)];
  let rest = Math.floor(size / 16);
  while (rest > 0) { out[out.length - 1] |= 0x80; out.push(rest & 0x7f); rest = Math.floor(rest / 128); }
  return out;
}
/** An ofs-delta's distance to its base, as git writes it. */
function ofsBytes(ofs: number): number[] {
  const out = [ofs & 0x7f];
  while ((ofs = Math.floor(ofs / 128)) > 0) { ofs--; out.unshift(0x80 | (ofs & 0x7f)); }
  return out;
}
function writePack(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"));
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, entries.length);
  const parts: Uint8Array[] = [head];
  const offsets: number[] = [];
  let at = 12;
  for (const e of entries) {
    offsets.push(at);
    const body = e.kind === "whole" ? e.body : e.delta;
    const h = e.kind === "whole" ? entryHeader(e.type, body.length) : e.kind === "ofs" ? [...entryHeader(6, body.length), ...ofsBytes(at - offsets[e.base])] : [...entryHeader(7, body.length), ...fromHex(e.baseId)];
    const part = cat(Uint8Array.from(h), new Uint8Array(deflateSync(body)));
    parts.push(part);
    at += part.length;
  }
  const all = cat(...parts);
  return cat(all, fromHex(sha1hex(all))) as Uint8Array<ArrayBuffer>;
}
const bundleOf = (refs: Array<[string, string]>, p: Uint8Array) => cat(enc.encode(`# v2 git bundle\n${refs.map(([n, s]) => `${s} ${n}\n`).join("")}\n`), p) as Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------- a synthetic history

const LINE = 64;
const lineOf = (file: string, n: number, version: number) => enc.encode(`${file} line ${n} version ${version} `.padEnd(LINE - 1, ".") + "\n");
const fileOf = (file: string, lines: number) => cat(...Array.from({ length: lines }, (_, n) => lineOf(file, n, 0)));
/** One line replaced: the size stays the same, so objects do not grow with the history. */
const edit = (body: Uint8Array, file: string, i: number) => { const n = (i * 37) % (body.length / LINE); const out = body.slice(); out.set(lineOf(file, n, i), n * LINE); return out; };
const treeOf = (items: Array<[string, string, string]>) => cat(...items.map(([mode, name, id]) => cat(enc.encode(`${mode} ${name}\0`), fromHex(id))));

interface Synth { pack: Uint8Array<ArrayBuffer>; head: string; objects: number; ofs: number; ref: number; inflated: number; firstPass: number; largest: number; ids: Record<string, string>; bodies: Map<string, Uint8Array> }
/**
 * `n` commits of a repository: doc.md (51 KB) edited every commit and stored as ofs-deltas in families of 8 (a whole
 * copy, then 1 on 0, 2 on 1, and each later one on the version two before it, so a base can have two deltas that are
 * bases in turn), notes.txt as a ref-delta chain on the previous version, README.md changed every 10th commit
 * and stored as forward ref-deltas on the next version (the newest whole, last in the pack), src/a.txt whole, the
 * root tree as an ofs-delta on the previous root (whole every 5th), and the commits. Options break one thing.
 */
function synth(n: number, opt: { badDeltaAt?: number; badRefDeltaAt?: number; omitBlobAt?: number; wrongTypeAt?: number; omitReadmeBase?: boolean } = {}): Synth {
  const entries: Entry[] = [];
  const bodies = new Map<string, Uint8Array>();
  const ids: Record<string, string> = {};
  let ofs = 0, ref = 0, inflated = 0, firstPass = 0, largest = 0;
  const put = (e: Entry, type: number, body: Uint8Array): { id: string; index: number } => {
    entries.push(e);
    const id = oid(type, body);
    bodies.set(id, body);
    inflated += body.length + (e.kind === "whole" ? 0 : e.delta.length);
    firstPass += e.kind === "whole" ? body.length : e.delta.length;
    largest = Math.max(largest, body.length);
    if (e.kind === "ofs") ofs++;
    if (e.kind === "ref") ref++;
    return { id, index: entries.length - 1 };
  };
  const readmes: Uint8Array[] = [];
  for (let r = 0; r * 10 < n; r++) readmes.push(r ? edit(readmes[r - 1], "README.md", r) : fileOf("README.md", 40));
  const readmeIds = readmes.map((b) => oid(3, b));
  let doc = fileOf("doc.md", 800), notes = fileOf("notes.txt", 64);
  let docFamily: Array<{ body: Uint8Array; index: number }> = [];
  let notesPrev: { body: Uint8Array; id: string } | null = null;
  let rootPrev: { body: Uint8Array; index: number } | null = null;
  let parent: string | null = null;
  for (let i = 0; i < n; i++) {
    if (i) { doc = edit(doc, "doc.md", i); notes = edit(notes, "notes.txt", i); }
    const k = i % 8;
    const docBase = k ? docFamily[k <= 2 ? k - 1 : k - 2] : null;
    if (!k) docFamily = [];
    const d: { id: string; index: number } = docBase
      ? put({ kind: "ofs", base: docBase.index, delta: makeDelta(docBase.body, doc, i === opt.badDeltaAt ? { sourceSize: docBase.body.length + 1 } : {}) }, 3, doc)
      : put({ kind: "whole", type: 3, body: doc }, 3, doc);
    docFamily.push({ body: doc, index: d.index });
    const nt: { id: string; index: number } = notesPrev
      ? put({ kind: "ref", baseId: notesPrev.id, delta: makeDelta(notesPrev.body, notes, i === opt.badRefDeltaAt ? { copyPastEnd: true } : {}) }, 3, notes)
      : put({ kind: "whole", type: 3, body: notes }, 3, notes);
    notesPrev = { body: notes, id: nt.id };
    const r = Math.floor(i / 10);
    if (i % 10 === 0 && r < readmes.length - 1) put({ kind: "ref", baseId: readmeIds[r + 1], delta: makeDelta(readmes[r + 1], readmes[r]) }, 3, readmes[r]);
    const a = enc.encode(`a ${i}\n`);
    const aId = oid(3, a);
    if (i !== opt.omitBlobAt) put({ kind: "whole", type: 3, body: a }, 3, a);
    const src = treeOf([["100644", "a.txt", aId]]);
    const srcId = put({ kind: "whole", type: 2, body: src }, 2, src).id;
    const root = treeOf([["100644", "README.md", readmeIds[r]], ["100644", "doc.md", d.id], [i === opt.wrongTypeAt ? "40000" : "100644", "notes.txt", nt.id], ["40000", "src", srcId]]);
    const t: { id: string; index: number } = rootPrev && i % 5 ? put({ kind: "ofs", base: rootPrev.index, delta: makeDelta(rootPrev.body, root) }, 2, root) : put({ kind: "whole", type: 2, body: root }, 2, root);
    rootPrev = { body: root, index: t.index };
    const commit = enc.encode(`tree ${t.id}\n${parent ? `parent ${parent}\n` : ""}author S <s@example.invalid> ${1794700000 + i} +0000\ncommitter S <s@example.invalid> ${1794700000 + i} +0000\n\ncommit ${i}\n`);
    parent = put({ kind: "whole", type: 1, body: commit }, 1, commit).id;
    if (i === opt.omitBlobAt) ids.omitted = aId;
    if (i === opt.wrongTypeAt) ids.wrongType = nt.id;
  }
  const last = readmes[readmes.length - 1];
  if (!opt.omitReadmeBase) put({ kind: "whole", type: 3, body: last }, 3, last);
  ids.readme = readmeIds[readmeIds.length - 1];
  return { pack: writePack(entries), head: parent!, objects: entries.length, ofs, ref, inflated, firstPass, largest, ids, bodies };
}

const BOUND = 1024 * 1024;
const refsOf = (s: Synth): Array<[string, string]> => [["refs/heads/main", s.head], ["HEAD", s.head]];

test("GM1. a pack whose content is far above the bound, every object below it, with ofs- and ref-deltas, verifies with a small peak", async () => {
  const s = synth(200);
  assert.ok(s.ofs > 100 && s.ref > 200, `ofs-deltas ${s.ofs}, ref-deltas ${s.ref}`);
  assert.ok(s.largest < BOUND / 16, "every object is far below the bound");
  const v = await verifyBundle(bundleOf(refsOf(s), s.pack), BOUND);
  assert.equal(v.objects, s.objects);
  assert.equal(v.deltas, s.ofs + s.ref);
  assert.equal(v.reachable, s.objects, "every object is reached from main");
  assert.deepEqual([v.commits, v.trees], [200, 400]);
  assert.equal(v.inflated_bytes, s.inflated, "every entry inflated and every delta result produced, once each");
  assert.ok(v.inflated_bytes > 10 * BOUND, `the content (${v.inflated_bytes}) is more than ten times the bound`);
  // A delta family's frontier (a base with two deltas that are bases in turn) holds a few objects at once, never the pack.
  assert.ok(v.peak_held_bytes < 8 * s.largest && v.peak_held_bytes < BOUND / 4, `peak held ${v.peak_held_bytes} B: a few objects, not the pack`);
  assert.ok(v.peak_held_bytes >= s.largest, "the largest object was held");
  assert.ok(v.reinflated_bytes > 0 && v.reinflated_bytes < v.inflated_bytes / 2, `re-inflated ${v.reinflated_bytes} B`);
  assert.ok(v.link_bytes > 0 && v.link_bytes % LINK_BYTES === 0);
  // The old indexPack held every entry inflated at once (and then more): this pack would have failed at this bound,
  // as 664c236 did at 64 MiB.
  assert.ok(s.firstPass > BOUND, `the entries alone inflate to ${s.firstPass} B`);
  // The ids are git's: the index has every object's id, its type, and its content back from the pack.
  const idx = await indexPack(s.pack, BOUND);
  assert.deepEqual([...idx.byId.keys()].sort(), [...s.bodies.keys()].sort());
  for (const id of [s.head, s.ids.readme, ...[...s.bodies.keys()].filter((_, k) => k % 97 === 0)]) {
    const o = idx.readObject(id)!;
    assert.deepEqual(o.data, s.bodies.get(id), id);
    assert.equal(o.kind, idx.byId.get(id)!.kind);
  }
  assert.equal(idx.readObject("0".repeat(40)), null);
  console.log(`GM1: ${v.objects} objects (${s.ofs} ofs-, ${s.ref} ref-deltas), inflated ${v.inflated_bytes} B, peak held ${v.peak_held_bytes} B, re-inflated ${v.reinflated_bytes} B, links ${v.link_bytes} B, bound ${BOUND} B`);
});

test("GM2. git agrees: index-pack accepts the synthetic pack and gives the ids indexPack gives (where git exists)", async () => {
  const git = (() => { try { return spawnSync("git", ["--version"], { encoding: "utf8" }); } catch { return null; } })();
  // Where git does not exist (the Forge's test Workers, whose node:test shim has no t.skip), there is nothing to compare.
  if (!git || git.status !== 0) return;
  const s = synth(60);
  const dir = mkdtempSync(join(tmpdir(), "gate8-memory-"));
  try {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    assert.equal(spawnSync("git", ["init", "-q", dir], { env }).status, 0);
    const file = join(dir, "synth.pack");
    writeFileSync(file, s.pack);
    const ix = spawnSync("git", ["index-pack", "-o", join(dir, "synth.idx"), file], { cwd: dir, env, encoding: "utf8" });
    assert.equal(ix.status, 0, ix.stderr);
    const vp = spawnSync("git", ["verify-pack", "-v", join(dir, "synth.idx")], { cwd: dir, env, encoding: "utf8", maxBuffer: 1 << 26 });
    assert.equal(vp.status, 0, vp.stderr);
    const listed = vp.stdout.split("\n").map((l) => /^([0-9a-f]{40}) /.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(listed.sort(), [...s.bodies.keys()].sort());
    assert.deepEqual([...(await indexPack(s.pack, BOUND)).byId.keys()].sort(), listed);
    assert.match(vp.stdout, /chain length = [1-9]/, "git sees delta chains");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GM3. the peak does not grow with the history: twice the commits, twice the content, a similar peak", async () => {
  const small = synth(120), large = synth(240);
  const a = await verifyBundle(bundleOf(refsOf(small), small.pack), BOUND);
  const b = await verifyBundle(bundleOf(refsOf(large), large.pack), BOUND);
  assert.ok(b.inflated_bytes > 1.9 * a.inflated_bytes, `content ${a.inflated_bytes} -> ${b.inflated_bytes}`);
  assert.ok(b.peak_held_bytes <= 1.1 * a.peak_held_bytes, `peak ${a.peak_held_bytes} -> ${b.peak_held_bytes}`);
  assert.deepEqual([a.objects, b.objects, a.reachable, b.reachable], [small.objects, large.objects, small.objects, large.objects]);
  // At the production bound and cache budget too.
  const c = await verifyBundle(bundleOf(refsOf(large), large.pack));
  assert.ok(c.peak_held_bytes <= 1.1 * a.peak_held_bytes, `peak at the production bound: ${c.peak_held_bytes}`);
  assert.ok(VERIFY_CACHE_BYTES * 4 <= MAX_VERIFY_INFLATED_BYTES);
  console.log(`GM3: 120 commits: inflated ${a.inflated_bytes} B, peak ${a.peak_held_bytes} B; 240 commits: inflated ${b.inflated_bytes} B, peak ${b.peak_held_bytes} B (${c.peak_held_bytes} B at the production bound)`);
});

test("GM4. with no cache at all every base is inflated again from the pack: the same result, more work, still within the bound", async () => {
  const s = synth(80);
  const cached = await indexPack(s.pack, BOUND);
  const none = await indexPack(s.pack, BOUND, 0);
  assert.deepEqual([...none.byId.keys()].sort(), [...cached.byId.keys()].sort());
  assert.equal(none.inflated_bytes, cached.inflated_bytes);
  assert.ok(none.reinflated_bytes > cached.reinflated_bytes, `${cached.reinflated_bytes} -> ${none.reinflated_bytes}`);
  assert.ok(none.peak_held_bytes < 8 * s.largest);
  for (const id of [s.head, s.ids.readme]) assert.deepEqual(none.readObject(id)!.data, s.bodies.get(id));
});

test("GM5. every failure still fails with its reason: a corrupted ofs- or ref-delta, a missing object, a wrong type, a thin pack, a bad checksum", async () => {
  const bad = (o: Parameters<typeof synth>[1]) => { const s = synth(60, o); return { s, bundle: bundleOf(refsOf(s), s.pack) }; };
  await rejects(verifyBundle(bad({ badDeltaAt: 13 }).bundle, BOUND), /^delta_base_size_mismatch$/, "an ofs-delta for another base");
  await rejects(verifyBundle(bad({ badRefDeltaAt: 21 }).bundle, BOUND), /^delta_copy_out_of_range$/, "a ref-delta copying past its base");
  const missing = bad({ omitBlobAt: 30 });
  await rejects(verifyBundle(missing.bundle, BOUND), new RegExp(`^object_missing:${missing.s.ids.omitted}$`), "a blob a tree names is not in the pack");
  const wrong = bad({ wrongTypeAt: 40 });
  await rejects(verifyBundle(wrong.bundle, BOUND), new RegExp(`^object_type_mismatch:${wrong.s.ids.wrongType}$`), "a blob named as a subtree");
  await rejects(verifyBundle(bad({ omitReadmeBase: true }).bundle, BOUND), /^pack_thin_ref_delta_base_missing$/, "the forward ref-deltas' base is not in the pack");
  const good = synth(60);
  const flipped = good.pack.slice(); flipped[flipped.length >> 1] ^= 0x01;
  await rejects(verifyBundle(bundleOf(refsOf(good), flipped), BOUND), /^pack_checksum_mismatch$/, "one bit in the pack");
  const trailer = good.pack.slice(); trailer[trailer.length - 1] ^= 0x80;
  await rejects(verifyBundle(bundleOf(refsOf(good), trailer), BOUND), /^pack_checksum_mismatch$/, "one bit in the trailer");
  // A damaged zlib stream with the trailer recomputed: the entry walk catches it, before any delta.
  const inner = good.pack.slice(0, -20); inner[200] ^= 0x10;
  await rejects(verifyBundle(bundleOf(refsOf(good), cat(inner, fromHex(sha1hex(inner)))), BOUND), /^(inflate_|zlib_|pack_)/, "a damaged stream");
  // The stored-bundle checks against the D1 row are unchanged.
  const bytes = bundleOf(refsOf(good), good.pack);
  const row: StoredBackup = {
    run_id: "gbk_m", main_sha: good.head, r2_key: "k", bundle_sha256: createHash("sha256").update(bytes).digest("hex"), bundle_bytes: bytes.length,
    pack_sha1: Buffer.from(good.pack.subarray(-20)).toString("hex"), objects: good.objects, refs_json: JSON.stringify([{ name: "refs/heads/main", sha: good.head }]),
  };
  assert.equal((await verifyStoredBundle(bytes, row, undefined, BOUND)).objects, good.objects);
  await rejects(verifyStoredBundle(bytes, { ...row, objects: good.objects + 1 }, undefined, BOUND), /^object_count_mismatch$/, "the row's object count");
  await rejects(verifyStoredBundle(bytes, { ...row, pack_sha1: "0".repeat(40) }, undefined, BOUND), /^pack_sha1_mismatch$/, "the row's pack SHA-1");
});

test("GM6. the bound still holds: an object larger than it fails, so does a delta whose result would be, and so does a chain deeper than git writes", async () => {
  const big = new Uint8Array(BOUND + 1).fill(0x61);
  await rejects(indexPack(writePack([{ kind: "whole", type: 3, body: big }]), BOUND), /^pack_too_large_to_verify$/, "a blob above the bound");
  // A small delta that declares a result above the bound fails before the result is allocated.
  const base = enc.encode("base\n");
  const huge = Uint8Array.from([...varint(base.length), ...varint(BOUND + 1), 0x80 | 0x10 | 0x20 | 0x40, 0xff, 0xff, 0xff]);
  assert.throws(() => applyDelta(base, huge), /delta_copy_out_of_range/, "applyDelta itself is unchanged");
  await rejects(indexPack(writePack([{ kind: "whole", type: 3, body: base }, { kind: "ofs", base: 0, delta: huge }]), BOUND), /^pack_too_large_to_verify$/, "a delta result above the bound");
  // A chain of MAX_DELTA_DEPTH deltas resolves; one more fails cleanly (git's pack-objects clamps --depth to 4095).
  const chain = (depth: number) => {
    const es: Entry[] = [{ kind: "whole", type: 3, body: enc.encode("v0\n") }];
    let prev = enc.encode("v0\n");
    for (let d = 1; d <= depth; d++) { const next = enc.encode(`v${d}\n`); es.push({ kind: "ofs", base: d - 1, delta: makeDelta(prev, next) }); prev = next; }
    return { pack: writePack(es), last: oid(3, prev) };
  };
  const ok = chain(MAX_DELTA_DEPTH);
  const idx = await indexPack(ok.pack, BOUND);
  assert.equal(idx.deltas, MAX_DELTA_DEPTH);
  assert.equal(new TextDecoder().decode(idx.readObject(ok.last)!.data), `v${MAX_DELTA_DEPTH}\n`);
  await rejects(indexPack(chain(MAX_DELTA_DEPTH + 1).pack, BOUND), /^pack_delta_chain_too_deep$/, "one delta more than git writes");
});
