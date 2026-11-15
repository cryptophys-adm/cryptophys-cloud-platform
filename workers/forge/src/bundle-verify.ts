// ADR-0012 gate 8 (owner 2026-11-15, "1 setuju"): the daily `git bundle verify` of a stored R2 bundle, in code.
//
// The Forge runs in workerd: there is no git binary and no node:zlib. This module reads a bundle the way git does when
// it verifies and restores one, with its own inflate (RFC 1950/1951) because a packfile is a run of zlib streams with
// no index, so the end of each stream (where the next entry starts) must be known exactly, which
// DecompressionStream does not tell.
//
// What verify checks (verifyBundle), in order; the first failure is the reason:
//   1. the header: the signature `# v2 git bundle` or `# v3 git bundle`; in v3 only the capability
//      `@object-format=sha1` (sha256 and `@filter=` are refused: a filtered bundle is not a full copy, and any
//      other capability is unknown, as git refuses it); `-<sha>` prerequisite lines; `<sha> <ref>` lines (HEAD or
//      refs/..., no duplicate names, at least one); the blank line that ends the header;
//   2. no prerequisites: the backup is a full clone. git checks prerequisites against the repository it runs in;
//      a bundle without any is self-contained, and this module refuses one with any (`bundle_has_prerequisites`);
//   3. the packfile (reusing git-backup.ts verifyPack): "PACK", version 2 or 3, at least one object, and the
//      trailing SHA-1 equal to the SHA-1 of every byte before it;
//   4. every entry, walking the headers: a valid type (commit, tree, blob, tag, ofs-delta, ref-delta), its size,
//      an ofs-delta's base at the start of an earlier entry; its zlib stream inflates (header, Huffman codes,
//      distances, the Adler-32) to exactly the declared size; exactly the declared number of entries, ending at
//      the trailer (no bytes left over);
//   5. every delta resolves (ofs and ref; a ref-delta whose base is not in the pack is a thin pack and fails),
//      the delta's source size equals its base and its result has the declared size; then every object's id,
//      the SHA-1 of `<type> <size>\0<content>`, as index-pack computes it;
//   6. every ref names an object in the pack, and HEAD and refs/heads/* name commits;
//   7. connectivity: everything the refs reach (commits' trees and parents, tree entries except submodules, the
//      object of an annotated tag) is in the pack with the type that points to it.
// Then, for a stored bundle (verifyStoredBundle), against the D1 row the backup wrote: the SHA-256 and the size of
// the whole object, the pack's SHA-1 and object count, HEAD and refs/heads/main equal the row's main, and the
// branches equal its refs_json. When the object's R2 metadata carries a SHA-256 it must agree too.
//
// Versus git. `git bundle verify` reads the header (1) and checks prerequisites against the local repository (2);
// it does not open the pack. What `git clone <bundle>` adds, index-pack, is 3 to 5, and its connectivity check of
// the refs is 6 and 7. So a bundle that passes here is one `git bundle verify` accepts and `git clone` restores,
// with these limits: no `git fsck` of object contents (author lines, tree entry order, tag headers are not checked
// beyond what 7 parses), no checkout, and objects no ref reaches are counted but allowed, as git allows them.
//
// Memory. Commits, trees and tags are held inflated (connectivity reads them), and a blob only while a delta still
// needs it as a base. The run fails with `pack_too_large_to_verify` when the content held at once passes
// MAX_VERIFY_INFLATED_BYTES, rather than exhausting the Worker's 128 MB with the bundle itself (at most 32 MiB of
// pack) also in memory. The result records `inflated_bytes` and `peak_held_bytes`.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { GIT_BACKUP_VERIFY_RETRY_MS, type GitBackupRef } from "../../control-plane-shared/src/git-backup.ts";
import { GitBackupError, verifyPack, type GitBackupBucket } from "./git-backup.ts";

export const MAX_VERIFY_INFLATED_BYTES = 64 * 1024 * 1024;
/** The longest header read (5,000 branches of about 100 bytes, with room). */
export const MAX_BUNDLE_HEADER_BYTES = 1024 * 1024;
const ACTOR = "system:forge-git-backup";

const fail = (reason: string): never => { throw new GitBackupError(reason); };
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const SHA = /^[0-9a-f]{40}$/;
/** The fields read (header lines, tree, parent, object and type lines, tree modes) are ASCII; other bytes may decode as U+FFFD. */
const ascii = new TextDecoder();
const REF = /^(HEAD|refs\/[\x21-\x7e]+)$/;

// ---------------------------------------------------------------- inflate (RFC 1950 zlib, RFC 1951 deflate)

const MAXBITS = 15;
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: the number of codes of each length and the symbols in code order. */
interface Huffman { count: Uint16Array; symbol: Uint16Array }

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(MAXBITS + 1);
  const symbol = new Uint16Array(n);
  for (let s = 0; s < n; s++) count[lengths[s]]++;
  if (count[0] === n) return { count, symbol };
  let left = 1;
  for (let len = 1; len <= MAXBITS; len++) {
    left = (left << 1) - count[len];
    if (left < 0) fail("inflate_oversubscribed_code");
  }
  const offs = new Uint16Array(MAXBITS + 2);
  for (let len = 1; len <= MAXBITS; len++) offs[len + 1] = offs[len] + count[len];
  for (let s = 0; s < n; s++) if (lengths[s] !== 0) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

let FIXED: [Huffman, Huffman] | null = null;
function fixed(): [Huffman, Huffman] {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED = [huffman(l, 288), huffman(new Uint8Array(30).fill(5), 30)];
  }
  return FIXED;
}

class Inflater {
  bitbuf = 0;
  bitcnt = 0;
  outPos = 0;
  pos: number;
  readonly out: Uint8Array;
  private data: Uint8Array;
  private end: number;
  constructor(data: Uint8Array, pos: number, end: number, size: number) { this.data = data; this.pos = pos; this.end = end; this.out = new Uint8Array(size); }

  private bits(n: number): number {
    let val = this.bitbuf;
    while (this.bitcnt < n) {
      if (this.pos >= this.end) fail("inflate_truncated");
      val |= this.data[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
    this.bitbuf = val >>> n;
    this.bitcnt -= n;
    return val & ((1 << n) - 1);
  }

  private decode(h: Huffman): number {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= this.bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return fail("inflate_bad_code");
  }

  private stored() {
    this.bitbuf = 0; this.bitcnt = 0; // the rest of the current byte
    const d = this.data;
    if (this.pos + 4 > this.end) fail("inflate_truncated");
    const len = d[this.pos] | (d[this.pos + 1] << 8);
    const nlen = d[this.pos + 2] | (d[this.pos + 3] << 8);
    this.pos += 4;
    if (len !== (~nlen & 0xffff)) fail("inflate_stored_length");
    if (this.pos + len > this.end) fail("inflate_truncated");
    if (this.outPos + len > this.out.length) fail("inflate_size_mismatch");
    this.out.set(d.subarray(this.pos, this.pos + len), this.outPos);
    this.pos += len;
    this.outPos += len;
  }

  private codes(lencode: Huffman, distcode: Huffman) {
    const out = this.out;
    for (;;) {
      let sym = this.decode(lencode);
      if (sym < 256) {
        if (this.outPos >= out.length) fail("inflate_size_mismatch");
        out[this.outPos++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) fail("inflate_bad_length");
        const len = LBASE[sym] + this.bits(LEXT[sym]);
        const dsym = this.decode(distcode);
        if (dsym >= 30) fail("inflate_bad_distance");
        const dist = DBASE[dsym] + this.bits(DEXT[dsym]);
        if (dist > this.outPos) fail("inflate_distance_too_far");
        if (this.outPos + len > out.length) fail("inflate_size_mismatch");
        for (let i = 0; i < len; i++, this.outPos++) out[this.outPos] = out[this.outPos - dist];
      }
    }
  }

  private dynamic() {
    const nlen = this.bits(5) + 257, ndist = this.bits(5) + 1, ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) fail("inflate_bad_counts");
    const cl = new Uint8Array(19);
    for (let i = 0; i < ncode; i++) cl[ORDER[i]] = this.bits(3);
    const lencode = huffman(cl, 19);
    const lengths = new Uint8Array(nlen + ndist);
    let index = 0;
    while (index < nlen + ndist) {
      const sym = this.decode(lencode);
      if (sym < 16) { lengths[index++] = sym; continue; }
      let len = 0, rep: number;
      if (sym === 16) {
        if (index === 0) fail("inflate_repeat_without_length");
        len = lengths[index - 1];
        rep = 3 + this.bits(2);
      } else if (sym === 17) rep = 3 + this.bits(3);
      else rep = 11 + this.bits(7);
      if (index + rep > nlen + ndist) fail("inflate_too_many_lengths");
      while (rep--) lengths[index++] = len;
    }
    if (lengths[256] === 0) fail("inflate_no_end_code");
    this.codes(huffman(lengths.subarray(0, nlen), nlen), huffman(lengths.subarray(nlen), ndist));
  }

  run() {
    let last: number;
    do {
      last = this.bits(1);
      const type = this.bits(2);
      if (type === 0) this.stored();
      else if (type === 1) { const [l, d] = fixed(); this.codes(l, d); }
      else if (type === 2) this.dynamic();
      else fail("inflate_bad_block_type");
    } while (!last);
  }
}

export function adler32(d: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < d.length;) {
    const e = Math.min(d.length, i + 5552);
    for (; i < e; i++) { a += d[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * One zlib stream starting at `start` that must inflate to exactly `size` bytes, read no further than `end`. Returns
 * the content and the offset just after the stream's Adler-32 (where a pack's next entry starts).
 */
export function inflateZlib(data: Uint8Array, start: number, size: number, end = data.length): { data: Uint8Array; next: number } {
  if (start + 2 > end) fail("inflate_truncated");
  const cmf = data[start], flg = data[start + 1];
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) fail("zlib_bad_header");
  const inf = new Inflater(data, start + 2, end, size);
  inf.run();
  if (inf.outPos !== size) fail("inflate_size_mismatch");
  const p = inf.pos;
  if (p + 4 > end) fail("inflate_truncated");
  const want = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
  if (adler32(inf.out) !== want) fail("zlib_adler32_mismatch");
  return { data: inf.out, next: p + 4 };
}

// ---------------------------------------------------------------- the bundle header

export interface BundleHeader { version: 2 | 3; capabilities: Record<string, string>; prerequisites: string[]; refs: GitBackupRef[]; packOffset: number }

/** Lines of `# v2 git bundle` / `# v3 git bundle` up to the blank line; the pack follows. */
export function parseBundleHeader(bytes: Uint8Array): BundleHeader {
  const limit = Math.min(bytes.length, MAX_BUNDLE_HEADER_BYTES);
  const lines: string[] = [];
  let at = 0;
  for (;;) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0 || nl >= limit) fail("bundle_header_unterminated");
    const line = ascii.decode(bytes.subarray(at, nl));
    at = nl + 1;
    if (!lines.length) {
      if (line !== "# v2 git bundle" && line !== "# v3 git bundle") fail("bundle_bad_signature");
      lines.push(line);
      continue;
    }
    if (line === "") break;
    lines.push(line);
  }
  const version = lines[0] === "# v3 git bundle" ? 3 : 2;
  const capabilities: Record<string, string> = {};
  const prerequisites: string[] = [];
  const refs: GitBackupRef[] = [];
  const names = new Set<string>();
  for (const line of lines.slice(1)) {
    if (line.startsWith("@")) {
      if (version !== 3) fail("bundle_capability_in_v2");
      const eq = line.indexOf("=");
      const key = eq < 0 ? line.slice(1) : line.slice(1, eq);
      const value = eq < 0 ? "" : line.slice(eq + 1);
      if (key === "object-format") { if (value !== "sha1") fail(`bundle_object_format_${value.replace(/[^a-z0-9]/g, "") || "missing"}`); }
      else if (key === "filter") fail("bundle_filtered");
      else fail("bundle_unknown_capability");
      capabilities[key] = value;
    } else if (line.startsWith("-")) {
      const sha = line.slice(1, 41);
      if (!SHA.test(sha) || (line.length > 41 && line[41] !== " ")) fail("bundle_bad_prerequisite");
      prerequisites.push(sha);
    } else {
      const sha = line.slice(0, 40);
      const name = line.slice(41);
      if (!SHA.test(sha) || line[40] !== " " || !REF.test(name)) fail("bundle_bad_ref_line");
      if (names.has(name)) fail("bundle_duplicate_ref");
      names.add(name);
      refs.push({ name, sha });
    }
  }
  if (!refs.length) fail("bundle_no_refs");
  return { version, capabilities, prerequisites, refs, packOffset: at };
}

// ---------------------------------------------------------------- the pack

const TYPE_NAME = ["", "commit", "tree", "blob", "tag"] as const;
const OFS_DELTA = 6, REF_DELTA = 7;

interface Entry { offset: number; raw: number; kind: number; data: Uint8Array; base: number; baseId: string | null; id: string | null; uses: number }
export interface PackIndex {
  version: number; objects: number; sha1: string; deltas: number;
  /** Every byte inflated or produced by a delta. */
  inflated_bytes: number;
  /** The most content held at once (what MAX_VERIFY_INFLATED_BYTES bounds). */
  peak_held_bytes: number;
  /** Object id to its type (1 commit, 2 tree, 3 blob, 4 tag) and content (empty for a blob once no delta needs it). */
  byId: Map<string, { kind: number; data: Uint8Array }>;
}

/** The size varint of a delta header (little-endian base-128). */
function deltaVarint(d: Uint8Array, at: { p: number }): number {
  let v = 0, mult = 1, c: number;
  do {
    if (at.p >= d.length) fail("delta_truncated");
    c = d[at.p++];
    v += (c & 0x7f) * mult;
    mult *= 128;
    if (mult > 2 ** 49) fail("delta_bad_size");
  } while (c & 0x80);
  return v;
}

/** git's delta format: the source and target sizes, then copy (from the base) and insert instructions. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const at = { p: 0 };
  if (deltaVarint(delta, at) !== base.length) fail("delta_base_size_mismatch");
  const size = deltaVarint(delta, at);
  const out = new Uint8Array(size);
  let o = 0;
  while (at.p < delta.length) {
    const op = delta[at.p++];
    if (op & 0x80) {
      let off = 0, len = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) { if (at.p >= delta.length) fail("delta_truncated"); off += delta[at.p++] * 2 ** (8 * i); }
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) { if (at.p >= delta.length) fail("delta_truncated"); len |= delta[at.p++] << (8 * i); }
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > size) fail("delta_copy_out_of_range");
      out.set(base.subarray(off, off + len), o);
      o += len;
    } else if (op) {
      if (at.p + op > delta.length || o + op > size) fail("delta_insert_out_of_range");
      out.set(delta.subarray(at.p, at.p + op), o);
      at.p += op;
      o += op;
    } else {
      fail("delta_reserved_opcode");
    }
  }
  if (o !== size) fail("delta_result_size_mismatch");
  return out;
}

const enc = new TextEncoder();
async function objectId(kind: number, data: Uint8Array): Promise<string> {
  const head = enc.encode(`${TYPE_NAME[kind]} ${data.length}\0`);
  const buf = new Uint8Array(head.length + data.length);
  buf.set(head, 0);
  buf.set(data, head.length);
  return hex(await crypto.subtle.digest("SHA-1", buf));
}

/**
 * index-pack in code: the checksum (verifyPack), every entry's header and zlib stream, the entry count, no trailing
 * bytes, every delta resolved, every object's id. A blob's content is released once no delta still needs it as a
 * base (connectivity needs only commits, trees and tags), so the content held stays well below the pack inflated.
 */
export async function indexPack(pack: Uint8Array<ArrayBuffer>, maxInflated = MAX_VERIFY_INFLATED_BYTES): Promise<PackIndex> {
  const info = await verifyPack(pack);
  const end = pack.length - 20;
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  /** Ref-deltas waiting for a base, by the base's id. */
  const idUses = new Map<string, number>();
  let pos = 12;
  let inflated = 0, held = 0, peak = 0;
  const hold = (n: number) => {
    held += n;
    if (held > peak) peak = held;
    if (held > maxInflated) fail("pack_too_large_to_verify");
  };
  for (let i = 0; i < info.objects; i++) {
    if (pos >= end) fail(`pack_entries_missing:${info.objects - i}`);
    const offset = pos;
    let c = pack[pos++];
    const raw = (c >> 4) & 7;
    let size = c & 0x0f, mult = 16;
    while (c & 0x80) {
      if (pos >= end) fail("pack_entry_truncated");
      c = pack[pos++];
      size += (c & 0x7f) * mult;
      mult *= 128;
      if (mult > 2 ** 49) fail("pack_entry_bad_size");
    }
    let base = -1, baseId: string | null = null;
    if (raw === OFS_DELTA) {
      if (pos >= end) fail("pack_entry_truncated");
      c = pack[pos++];
      let ofs = c & 0x7f;
      while (c & 0x80) {
        if (pos >= end) fail("pack_entry_truncated");
        c = pack[pos++];
        ofs = (ofs + 1) * 128 + (c & 0x7f);
      }
      base = offset - ofs;
      const b = byOffset.get(base);
      if (ofs <= 0 || !b) fail("pack_bad_ofs_delta");
      b!.uses++;
    } else if (raw === REF_DELTA) {
      if (pos + 20 > end) fail("pack_entry_truncated");
      baseId = hex(pack.subarray(pos, pos + 20));
      pos += 20;
      idUses.set(baseId, (idUses.get(baseId) ?? 0) + 1);
    } else if (raw < 1 || raw > 4) {
      fail(`pack_bad_object_type_${raw}`);
    }
    if (size > maxInflated) fail("pack_too_large_to_verify");
    const z = inflateZlib(pack, pos, size, end);
    pos = z.next;
    inflated += size;
    hold(size);
    const e: Entry = { offset, raw, kind: raw <= 4 ? raw : 0, data: z.data, base, baseId, id: null, uses: 0 };
    entries.push(e);
    byOffset.set(offset, e);
  }
  if (pos !== end) fail("pack_trailing_bytes");

  const byId = new Map<string, Entry>();
  const release = (e: Entry) => { if (e.kind === 3 && e.uses <= 0 && e.data.length) { held -= e.data.length; e.data = new Uint8Array(0); } };
  const named = async (e: Entry) => {
    e.id = await objectId(e.kind, e.data);
    e.uses += idUses.get(e.id) ?? 0;
    byId.set(e.id, e);
  };
  for (const e of entries) if (e.kind) await named(e);
  // A blob no delta needs is released now; the others when their last delta has been applied.
  for (const e of entries) if (e.kind) release(e);
  let pending = entries.filter((e) => !e.kind);
  const deltas = pending.length;
  while (pending.length) {
    const left: Entry[] = [];
    for (const e of pending) {
      const b = e.raw === OFS_DELTA ? byOffset.get(e.base) : byId.get(e.baseId!);
      if (!b || !b.kind) { left.push(e); continue; }
      const data = applyDelta(b.data, e.data);
      inflated += data.length;
      hold(data.length - e.data.length);
      e.kind = b.kind;
      e.data = data;
      b.uses--;
      release(b);
      await named(e);
      release(e);
    }
    if (left.length === pending.length) fail(left.some((e) => e.raw === REF_DELTA && !byId.has(e.baseId!)) ? "pack_thin_ref_delta_base_missing" : "pack_delta_unresolvable");
    pending = left;
  }
  return { version: info.version, objects: info.objects, sha1: info.sha1, deltas, inflated_bytes: inflated, peak_held_bytes: peak, byId };
}

// ---------------------------------------------------------------- refs and connectivity

const KIND: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** The ids an object points to, with the type each must have. */
function links(kind: number, data: Uint8Array, id: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  if (kind === 1 || kind === 4) {
    let end = data.length; // the header ends at the first blank line; the message follows
    for (let i = 0; i + 1 < data.length; i++) if (data[i] === 0x0a && data[i + 1] === 0x0a) { end = i; break; }
    const lines = ascii.decode(data.subarray(0, end)).split("\n");
    if (kind === 1) {
      const tree = /^tree ([0-9a-f]{40})$/.exec(lines[0] ?? "");
      if (!tree) fail(`commit_malformed:${id}`);
      out.push([tree![1], 2]);
      for (const l of lines.slice(1)) { const p = /^parent ([0-9a-f]{40})$/.exec(l); if (p) out.push([p[1], 1]); else break; }
    } else {
      const obj = /^object ([0-9a-f]{40})$/.exec(lines[0] ?? "");
      const type = /^type (commit|tree|blob|tag)$/.exec(lines[1] ?? "");
      if (!obj || !type) fail(`tag_malformed:${id}`);
      out.push([obj![1], KIND[type![1]]]);
    }
    return out;
  }
  if (kind === 2) {
    let p = 0;
    while (p < data.length) {
      const sp = data.indexOf(0x20, p);
      const nul = sp < 0 ? -1 : data.indexOf(0x00, sp);
      if (sp < 0 || nul < 0 || nul + 21 > data.length) fail(`tree_malformed:${id}`);
      const mode = ascii.decode(data.subarray(p, sp));
      const child = hex(data.subarray(nul + 1, nul + 21));
      p = nul + 21;
      if (mode === "160000") continue; // a submodule: its commit lives in another repository
      if (mode === "40000") out.push([child, 2]);
      else if (/^(100644|100755|100664|120000)$/.test(mode)) out.push([child, 3]);
      else fail(`tree_bad_mode:${id}`);
    }
  }
  return out;
}

export interface Reachability { reachable: number; commits: number; trees: number; blobs: number; tags: number }

/** Every ref names an object of the pack (HEAD and branches a commit), and everything they reach is there. */
export function checkRefs(refs: GitBackupRef[], byId: PackIndex["byId"]): Reachability {
  const stack: Array<[string, number]> = [];
  for (const r of refs) {
    const o = byId.get(r.sha);
    if (!o) fail(`ref_target_missing:${r.name}`);
    if ((r.name === "HEAD" || r.name.startsWith("refs/heads/")) && o!.kind !== 1) fail(`ref_not_a_commit:${r.name}`);
    stack.push([r.sha, o!.kind]);
  }
  const seen = new Set<string>();
  const n = { reachable: 0, commits: 0, trees: 0, blobs: 0, tags: 0 };
  while (stack.length) {
    const [id, want] = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const o = byId.get(id);
    if (!o) fail(`object_missing:${id}`);
    if (o!.kind !== want) fail(`object_type_mismatch:${id}`);
    n.reachable++;
    if (o!.kind === 1) n.commits++; else if (o!.kind === 2) n.trees++; else if (o!.kind === 3) n.blobs++; else n.tags++;
    for (const l of links(o!.kind, o!.data, id)) if (!seen.has(l[0])) stack.push(l);
  }
  return n;
}

// ---------------------------------------------------------------- verify

export interface BundleVerification extends Reachability {
  bundle_version: number; pack_version: number; objects: number; deltas: number; pack_sha1: string;
  refs: GitBackupRef[]; inflated_bytes: number; peak_held_bytes: number; bundle_bytes: number; bundle_sha256: string;
}

/** Steps 1 to 7 of the header comment, on the bytes of a bundle. Throws GitBackupError with the first failure. */
export async function verifyBundle(bytes: Uint8Array<ArrayBuffer>, maxInflated = MAX_VERIFY_INFLATED_BYTES): Promise<BundleVerification> {
  const header = parseBundleHeader(bytes);
  if (header.prerequisites.length) fail("bundle_has_prerequisites");
  const idx = await indexPack(bytes.subarray(header.packOffset), maxInflated);
  const reach = checkRefs(header.refs, idx.byId);
  idx.byId.clear();
  return {
    bundle_version: header.version, pack_version: idx.version, objects: idx.objects, deltas: idx.deltas, pack_sha1: idx.sha1,
    refs: header.refs, inflated_bytes: idx.inflated_bytes, peak_held_bytes: idx.peak_held_bytes, bundle_bytes: bytes.length,
    bundle_sha256: hex(await crypto.subtle.digest("SHA-256", bytes)), ...reach,
  };
}

/** The D1 row a backup wrote (forge_git_backups), as the verify reads it. */
export interface StoredBackup {
  run_id: string; main_sha: string; r2_key: string; bundle_sha256: string | null; bundle_bytes: number | null;
  pack_sha1: string | null; objects: number | null; refs_json: string | null;
}

/** verifyBundle, then the bundle against its record (and the object's R2 metadata, when it carries a SHA-256). */
export async function verifyStoredBundle(bytes: Uint8Array<ArrayBuffer>, row: StoredBackup, metadata: Record<string, string> | undefined, maxInflated = MAX_VERIFY_INFLATED_BYTES): Promise<BundleVerification> {
  // The SHA-256 first: a bundle that is not the one recorded fails as that, before any parsing.
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (sha256 !== row.bundle_sha256) fail("sha256_mismatch");
  if (metadata?.sha256 !== undefined && metadata.sha256 !== sha256) fail("r2_metadata_sha256_mismatch");
  if (bytes.length !== row.bundle_bytes) fail("size_mismatch");
  const v = await verifyBundle(bytes, maxInflated);
  if (v.pack_sha1 !== row.pack_sha1) fail("pack_sha1_mismatch");
  if (v.objects !== row.objects) fail("object_count_mismatch");
  const head = v.refs.find((r) => r.name === "HEAD")?.sha;
  const main = v.refs.find((r) => r.name === "refs/heads/main")?.sha;
  if (head !== row.main_sha || main !== row.main_sha) fail("main_mismatch");
  let recorded: GitBackupRef[] = [];
  try { recorded = JSON.parse(row.refs_json ?? "[]"); } catch { fail("record_refs_unreadable"); }
  const key = (rs: GitBackupRef[]) => JSON.stringify(rs.map((r) => [r.name, r.sha]).sort());
  if (key(v.refs.filter((r) => r.name !== "HEAD")) !== key(recorded)) fail("refs_mismatch");
  return v;
}

// ---------------------------------------------------------------- the daily tick

export interface VerifyBucket extends GitBackupBucket {
  get?(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size?: number; customMetadata?: Record<string, string> } | null>;
}

/** A failure of the read itself (R2 threw), not of the bundle; retried after GIT_BACKUP_VERIFY_RETRY_MS the same day. */
export const TRANSIENT_VERIFY_FAILURES: ReadonlySet<string> = new Set(["r2_get_failed"]);

/**
 * Once per UTC day, after git_backup: `git bundle verify` in code of the newest stored bundle (status ok, not
 * pruned), then the result on its row (verified_at, verify_status, verify_details; migration 0076) and the audit
 * event forge.git_backup_verified (outcome verified or failed). A failed verify is a production problem the owner
 * sees (ai-kernel owner-inbox.ts, git_backup_unverified). Never throws.
 */
export async function gitBackupVerifyTick(env: { DB: D1Database; BUNDLES?: VerifyBucket }, nowMs = Date.now(), maxInflated = MAX_VERIFY_INFLATED_BYTES): Promise<Record<string, unknown>> {
  const bucket = env.BUNDLES;
  if (!bucket || typeof bucket.get !== "function") return { outcome: "not_configured" };
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let row: StoredBackup | null;
  try {
    const last = await env.DB.prepare("SELECT verified_at, verify_status, verify_details FROM forge_git_backups WHERE verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1")
      .first<{ verified_at: string; verify_status: string; verify_details: string | null }>();
    if (last && last.verified_at.slice(0, 10) === day) {
      let reason = "";
      try { reason = String(JSON.parse(last.verify_details ?? "{}").reason ?? ""); } catch { reason = ""; }
      const retry = last.verify_status === "failed" && TRANSIENT_VERIFY_FAILURES.has(reason) && nowMs - Date.parse(last.verified_at) >= GIT_BACKUP_VERIFY_RETRY_MS;
      if (!retry) return { outcome: "not_due", last: last.verified_at, last_status: last.verify_status };
    }
    row = await env.DB.prepare(
      `SELECT run_id, main_sha, r2_key, bundle_sha256, bundle_bytes, pack_sha1, objects, refs_json FROM forge_git_backups
       WHERE status = 'ok' AND pruned_at IS NULL AND r2_key IS NOT NULL ORDER BY ran_at DESC LIMIT 1`,
    ).first<StoredBackup>() ?? null;
  } catch (e) {
    return { outcome: "failed", error: String((e as Error)?.message ?? e).slice(0, 300), recorded: false };
  }
  if (!row) return { outcome: "no_bundle" };
  const started = Date.now();
  let details: Record<string, unknown>;
  let status: "verified" | "failed";
  try {
    const obj = await bucket.get!(row.r2_key).catch(() => fail("r2_get_failed"));
    if (!obj) fail("bundle_missing_in_r2");
    const bytes = new Uint8Array(await obj!.arrayBuffer());
    const v = await verifyStoredBundle(bytes, row, obj!.customMetadata, maxInflated);
    status = "verified";
    const { refs, ...rest } = v;
    details = { ...rest, refs: refs.filter((r) => r.name !== "HEAD").length, duration_ms: Date.now() - started };
  } catch (e) {
    status = "failed";
    const reason = e instanceof GitBackupError ? e.message : `verify_error:${String((e as Error)?.message ?? e)}`;
    details = { reason: reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 200), duration_ms: Date.now() - started };
  }
  const at = new Date(nowMs).toISOString();
  try {
    await env.DB.prepare("UPDATE forge_git_backups SET verified_at = ?, verify_status = ?, verify_details = ? WHERE run_id = ?")
      .bind(at, status, JSON.stringify(details), row.run_id).run();
  } catch (e) {
    return { outcome: status, run_id: row.run_id, key: row.r2_key, ...details, recorded: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  await appendAuditEvent(env.DB, {
    event_type: "forge.git_backup_verified", actor: ACTOR, subject: row.r2_key, outcome: status,
    payload: { run_id: row.run_id, main_sha: row.main_sha, r2_key: row.r2_key, ...details },
  }).catch(() => undefined);
  return { outcome: status, run_id: row.run_id, key: row.r2_key, ...details };
}
