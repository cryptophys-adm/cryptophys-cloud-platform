// A child process for forge-git-backup-stream-2026-11-26.test.ts GS-7: "build" writes a bundle of about <bundleMiB>
// of incompressible 1 MiB blobs plus one compressible blob of <bigMiB> (inflating to that size); "verify" reads it and
// reports the process's peak resident memory (maxRSS) over its memory before the verify. Run as its own process so the
// high-water mark is the verify's, not the test runner's.
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
const [mode, root, file, bundleMiB, bigMiB] = process.argv.slice(2);
const enc = new TextEncoder();
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
const T = ["", "commit", "tree", "blob"];
const oid = (t: number, b: Uint8Array) => sha1(cat(enc.encode(`${T[t]} ${b.length}\0`), b));
const hdr = (t: number, size: number) => { const o = [((t & 7) << 4) | (size & 15)]; let r = Math.floor(size / 16); while (r > 0) { o[o.length - 1] |= 0x80; o.push(r & 0x7f); r = Math.floor(r / 128); } return Uint8Array.from(o); };
if (mode === "build") {
  const blobs: Uint8Array[] = [];
  const target = Number(bundleMiB) * 1048576;
  let total = 0;
  if (Number(bigMiB) > 0) { const z = new Uint8Array(Number(bigMiB) * 1048576); blobs.push(z); total += deflateSync(z).length; }
  while (total < target - 1048576) { const b = new Uint8Array(randomBytes(1048576)); blobs.push(b); total += b.length + 64; }
  const tree = cat(...blobs.map((b, i) => cat(enc.encode(`100644 f${String(i).padStart(4, "0")}\0`), Uint8Array.from(Buffer.from(oid(3, b), "hex")))));
  const treeId = oid(2, tree);
  const commit = enc.encode(`tree ${treeId}\nauthor S <s@example.invalid> 1794700000 +0000\ncommitter S <s@example.invalid> 1794700000 +0000\n\nc\n`);
  const objs: Array<[number, Uint8Array]> = [[1, commit], [2, tree], ...blobs.map((b) => [3, b] as [number, Uint8Array])];
  const head = new Uint8Array(12); head.set(enc.encode("PACK")); new DataView(head.buffer).setUint32(4, 2); new DataView(head.buffer).setUint32(8, objs.length);
  const pack0 = cat(head, ...objs.map(([t, b]) => cat(hdr(t, b.length), new Uint8Array(deflateSync(b)))));
  const pack = cat(pack0, Uint8Array.from(Buffer.from(sha1(pack0), "hex")));
  const cid = oid(1, commit);
  const bundle = cat(enc.encode(`# v2 git bundle\n${cid} refs/heads/main\n${cid} HEAD\n\n`), pack);
  writeFileSync(file, bundle);
  console.log(JSON.stringify({ bundle_bytes: bundle.length, objects: objs.length }));
} else {
  const { verifyBundle, MAX_VERIFY_INFLATED_BYTES } = await import(`${root}/workers/forge/src/bundle-verify.ts`);
  const bytes = new Uint8Array(readFileSync(file));
  (globalThis as any).gc?.();
  const before = process.memoryUsage().rss;
  let v: any;
  try { v = await verifyBundle(bytes, MAX_VERIFY_INFLATED_BYTES); } catch (e) { console.log(JSON.stringify({ failed: String((e as Error).message) })); process.exit(0); }
  const peak = process.resourceUsage().maxRSS * 1024;
  console.log(JSON.stringify({ objects: v.objects, bundle_bytes: bytes.length, rss_before: before, max_rss: peak, added: peak - before, peak_held_bytes: v.peak_held_bytes, worker_estimate: bytes.length + Math.max(0, peak - before) }));
}
