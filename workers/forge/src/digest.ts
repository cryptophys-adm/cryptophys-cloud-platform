// Incremental SHA-1 and SHA-256 for the streamed git backup (git-backup-stream.ts, review 2026-11-26). In workerd,
// crypto.DigestStream hashes natively; where it is missing (node, the tests) a small JS implementation does the same,
// byte for byte (a test checks both against node:crypto). Nothing here holds more than one 64-byte block.

export type DigestAlgorithm = "SHA-1" | "SHA-256";
export interface Hasher { update(bytes: Uint8Array): Promise<void> | void; digest(): Promise<string> }
export type HasherFactory = (algorithm: DigestAlgorithm) => Hasher;

const HEX = Array.from({ length: 256 }, (_, x) => x.toString(16).padStart(2, "0"));
export const hexOf = (b: ArrayBuffer | Uint8Array) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i++) s += HEX[u[i]]; return s; };

/** The native DigestStream when the runtime has it, else the JS hasher. */
export const defaultHasher: HasherFactory = (algorithm) => {
  const DS = (globalThis.crypto as unknown as { DigestStream?: new (a: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } } | undefined)?.DigestStream;
  if (typeof DS === "function") {
    const stream = new DS(algorithm);
    const writer = stream.getWriter();
    return {
      update: (bytes) => writer.write(bytes),
      digest: async () => { await writer.close(); return hexOf(await stream.digest); },
    };
  }
  return jsHasher(algorithm);
};

export const jsHasher: HasherFactory = (algorithm) => (algorithm === "SHA-1" ? new Sha1() : new Sha256());

/** The Merkle–Damgård frame shared by both: a 64-byte block buffer, the length in bits, big-endian padding. */
abstract class BlockHash implements Hasher {
  private block = new Uint8Array(64);
  private used = 0;
  private length = 0;
  private done = false;
  protected readonly w: Int32Array;
  constructor(words: number) { this.w = new Int32Array(words); }
  protected abstract compress(block: Uint8Array): void;
  protected abstract state(): number[];

  update(bytes: Uint8Array): void {
    if (this.done) throw new Error("digest_already_read");
    this.length += bytes.length;
    let i = 0;
    if (this.used) {
      const k = Math.min(64 - this.used, bytes.length);
      this.block.set(bytes.subarray(0, k), this.used);
      this.used += k; i = k;
      if (this.used < 64) return;
      this.compress(this.block); this.used = 0;
    }
    for (; i + 64 <= bytes.length; i += 64) this.compress(bytes.subarray(i, i + 64));
    if (i < bytes.length) { this.block.set(bytes.subarray(i), 0); this.used = bytes.length - i; }
  }

  async digest(): Promise<string> {
    if (this.done) throw new Error("digest_already_read");
    const bits = this.length * 8;
    const tail = new Uint8Array(((this.used + 9 + 63) >> 6) << 6);
    tail.set(this.block.subarray(0, this.used));
    tail[this.used] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let i = 0; i < tail.length; i += 64) this.compress(tail.subarray(i, i + 64));
    this.done = true;
    const out = new Uint8Array(this.state().length * 4);
    const o = new DataView(out.buffer);
    this.state().forEach((v, i) => o.setUint32(i * 4, v >>> 0));
    return hexOf(out);
  }
}

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

export class Sha1 extends BlockHash {
  private h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  constructor() { super(80); }
  protected state() { return this.h; }
  protected compress(b: Uint8Array): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = (b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3];
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, bb, c, d, e] = this.h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(bb, 30); bb = a; a = t;
    }
    this.h = [(this.h[0] + a) | 0, (this.h[1] + bb) | 0, (this.h[2] + c) | 0, (this.h[3] + d) | 0, (this.h[4] + e) | 0];
  }
}

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256 extends BlockHash {
  private h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  constructor() { super(64); }
  protected state() { return this.h; }
  protected compress(b: Uint8Array): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = (b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    const s = this.h;
    this.h = [(s[0] + a) | 0, (s[1] + bb) | 0, (s[2] + c) | 0, (s[3] + d) | 0, (s[4] + e) | 0, (s[5] + f) | 0, (s[6] + g) | 0, (s[7] + h) | 0];
  }
}
