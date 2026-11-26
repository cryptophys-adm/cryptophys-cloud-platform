// A child process for forge-git-backup-stream-2026-11-26.test.ts GS-4m: an 80 MiB synthetic pack through the streamed
// writer (BundleStreamWriter) into an upload that hashes each part and drops it, with the process's memory read after a
// GC at every part. A plain script (no node --test, no D1), as the verify children are; it prints one line of JSON.
import { createHash } from "node:crypto";
const [root] = process.argv.slice(2);
const { BundleStreamWriter, STREAM_PART_BYTES, bundleHeader } = await import(`${root}/workers/forge/src/git-backup.ts`);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) { console.log(JSON.stringify({ failed: "no_gc" })); process.exit(0); }
const MAIN = "47a2d93567155255d248d26cb16ac0a6f3eb9650", TOPIC = "e579b1dab9b7bd1e58947acfe141156c6d194185";
const header = bundleHeader([{ name: "refs/heads/claude/topic", sha: TOPIC }, { name: "refs/heads/main", sha: MAIN }, { name: "HEAD", sha: MAIN }]);
const PACK_BYTES = 80 * 1024 * 1024;
const head = Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1);
const sha1 = createHash("sha1"), want = createHash("sha256");
want.update(header);
const block = new Uint8Array(65_000);
let x = 7; for (let i = 0; i < block.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; block[i] = x & 0xff; }
gc();
const base = process.memoryUsage();
const buffers: number[] = [], heap: number[] = [];
const stored = createHash("sha256");
let size = 0;
const upload = {
  async uploadPart(partNumber: number, value: Uint8Array) {
    stored.update(value); size += value.length;
    gc!(); const m = process.memoryUsage(); buffers.push(m.arrayBuffers - base.arrayBuffers); heap.push(m.heapUsed - base.heapUsed);
    return { partNumber, etag: `e${partNumber}` };
  },
  async complete() { return { size }; },
  async abort() {},
};
const nodeHasher = (a: string) => { const h = createHash(a === "SHA-1" ? "sha1" : "sha256"); return { update: (b: Uint8Array) => { h.update(b); }, digest: async () => h.digest("hex") }; };
const w = new BundleStreamWriter(upload, header, { hasher: nodeHasher });
sha1.update(head); want.update(head); await w.write(head);
const body = PACK_BYTES - 12 - 20;
for (let sent = 0; sent < body;) {
  const n = Math.min(block.length, body - sent);
  const p = new Uint8Array(block.subarray(0, n)); p[0] = sent & 0xff;
  sha1.update(p); want.update(p); await w.write(p);
  sent += n;
}
const trailer = new Uint8Array(sha1.digest()); want.update(trailer); await w.write(trailer);
const r = await w.finish();
console.log(JSON.stringify({ bundle_bytes: r.bundle_bytes, parts: r.parts, peak_held_bytes: r.peak_held_bytes, sha256: r.sha256, want: want.digest("hex"), stored: stored.digest("hex"), part_bytes: STREAM_PART_BYTES, buffers, heap }));
