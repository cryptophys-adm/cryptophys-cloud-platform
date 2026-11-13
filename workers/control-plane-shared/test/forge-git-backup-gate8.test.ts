// ADR-0012 gate 8 (§5m): the off-Artifacts copy of the canonical repository. Once per UTC day per head of main the
// Forge clones cryptophys/platform over Git smart HTTP (upload-pack), writes the pack to R2 as a git bundle v2,
// records its SHA-256, size, refs and object count in D1 (migration 0054), audits it, and keeps the newest bundle
// of each of the last 30 days. GET /v1/forge/git-backup and the Console Code page show it (a stale backup is
// shown on the Console only, owner 2026-11-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import { FLUSH, pktLine, readPktLines, type Fetch } from "../../forge/src/merge.ts";
import {
  BUNDLE_SIGNATURE, GIT_BACKUP_RETRY_MS, GIT_BACKUP_TOKEN_TTL_S, MAX_REFS, assembleBundle, bundleHeader, bundleKey, chooseCapabilities, gitBackupTick,
  pruneGitBackups, receivePack, redact, selectRefs, uploadPackRequest, verifyPack, type GitBackupBucket,
} from "../../forge/src/git-backup.ts";
import { GIT_BACKUP_PREFIX, GIT_BACKUP_RETAINED_DAYS, GIT_BACKUP_STALE_MS, gitBackup } from "../src/git-backup.ts";
import { forgeTick } from "../../forge/src/tick.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const HOST = "b".repeat(32) + ".artifacts.cloudflare.net";
const REMOTE = `https://${HOST}/git/cryptophys/platform.git`;
// Split so the Forge's own secret scan (artifacts_token) does not flag the test literal.
const SECRET = "art_v1_" + "GATE8READTOKENSECRETVALUE";
const TOKEN = SECRET + "?expires=1794300000";
const NOW = Date.parse("2026-11-13T00:04:00.000Z");
const DAY = 86_400_000;

// `git bundle create x.bundle --all` (git 2.43.0) of a repository with main (2 commits) and claude/topic (1 more),
// fixed author and committer dates. 875 bytes: the header, then a 9-object pack.
const GIT_BUNDLE_B64 = "IyB2MiBnaXQgYnVuZGxlCmU1NzliMWRhYjliN2JkMWU1ODk0N2FjZmUxNDExNTZjNmQxOTQxODUgcmVmcy9oZWFkcy9jbGF1ZGUvdG9waWMKNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCByZWZzL2hlYWRzL21haW4KNDdhMmQ5MzU2NzE1NTI1NWQyNDhkMjZjYjE2YWMwYTZmM2ViOTY1MCBIRUFECgpQQUNLAAAAAgAAAAmeDXicnctNDsIgEEDhPadgb2IGyvCTmMaVJ/ACAwxK0pYG0Xh89QpuXr7NG51ZThC8i1pBRJ90VhYJwEBIOfgSi0nGZfIUxE6dtyGNI53DhNYpRI2YtfFZ2xSVpQRky8QxWARBz3FvXV5av7G88mPIU/n5zG9a94WPdXvRUvMslQsGtQcAefgGRGrrWsfg/24x2l6T+AB8g0I+nw14nJ3LQQrCMBBA0X1OMXtBpknbJCDiyhN4gclkRgttU9IoHl+9gpvP2/xWRQCRE1P0mkVs6NU7dZgVx8zJRgmMvcYuqtmoytogKKtLiTRSF9CyJnRDyuxHi96hMAUOQmjo2R6lwrXUu8BN9gYn/fkib1q2WY7T+qJ5ymfofOwHGxARDt+g4bIsU2vy32124bJm8wF300UGngp4nJ3LQQrCMBBA0X1OMXtBptPGSUDElSfwAiEz1UBjSjqKx1ev4ObzNt+6KkjwKpSyH4WRhAMTDSwxpIlVM/HokQ5RXHravXW4tH5TuOpmcJx/Pus71XXRfXm80lLkBAPHyVNARNh9gy63WouZ/ne7ufTN3AdDMDURpgR4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wxxCiKEmvpKKEgT/pWl3ZOaHQBTOmqExd4Xafv0tHEAB2eBquPHicK8hJLEnLL8pVKDPiAgAfJAQ4NnicK8kvyEzmAgAItAIqpQJ4nDM0MDAzMVEIcnV08XXVy01hWH8+0lAvt9Btcw7HhyW1LTPOPn4wBwDX6A7XpQJ4nDM0MDAzMVEIcnV08XXVy01h+DmvecrzfVX/WeLPbc5cMevpg7J8PQD5qRAwOXicK8hJLEnLL8rlAgASrANwdnFZXD0qI0XwUxNug/64oT+jyX4=";
const GIT_BUNDLE = Uint8Array.from(atob(GIT_BUNDLE_B64), (c) => c.charCodeAt(0));
const MAIN = "47a2d93567155255d248d26cb16ac0a6f3eb9650";
const TOPIC = "e579b1dab9b7bd1e58947acfe141156c6d194185";
const HEADER_END = new TextDecoder().decode(GIT_BUNDLE).indexOf("\n\n") + 2;
const PACK = GIT_BUNDLE.slice(HEADER_END);
const hexOf = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** A stream that yields `bytes` in chunks of `size`, so pkt-lines and side-band packets straddle chunks. */
const streamOf = (bytes: Uint8Array, size = 7) => new ReadableStream<Uint8Array>({
  start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); },
});
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of parts) { o.set(p, a); a += p.length; } return o; };
/** Side-band-64k framing of `data` in packets of `size`, with a progress line between packets. */
function sideband(data: Uint8Array, size = 100, extra: Uint8Array[] = []): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) {
    parts.push(pktLine(cat(Uint8Array.of(1), data.subarray(i, i + size))));
    parts.push(pktLine(cat(Uint8Array.of(2), new TextEncoder().encode(`Counting objects: ${i}\r`))));
  }
  return cat(...parts, ...extra, FLUSH);
}

interface ServerOpts { refs?: Array<[string, string]>; caps?: string; pack?: Uint8Array; sideband?: boolean; tail?: Uint8Array[]; ack?: string; status?: number }
/** A fake Artifacts upload-pack endpoint (pkt-line); records every request (URL, headers, body). */
function fakeServer(o: ServerOpts = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: Uint8Array | null }> = [];
  const refs = o.refs ?? [["refs/heads/claude/topic", TOPIC], ["refs/heads/main", MAIN], ["refs/tags/v1", TOPIC]];
  const caps = o.caps ?? "multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag agent=git/2.43.0 symref=HEAD:refs/heads/main";
  const fetchImpl: Fetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body instanceof Uint8Array ? init.body : null });
    if (headers.authorization !== `Bearer ${SECRET}`) return new Response("denied", { status: 401 });
    if (url === `${REMOTE}/info/refs?service=git-upload-pack`) {
      const adv = cat(pktLine("# service=git-upload-pack\n"), FLUSH, pktLine(`${MAIN} HEAD\0${caps}\n`), ...refs.map(([n, s]) => pktLine(`${s} ${n}\n`)), FLUSH);
      return new Response(adv, { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    }
    if (url === `${REMOTE}/git-upload-pack` && init?.method === "POST") {
      if (o.status) return new Response("x", { status: o.status });
      const pack = o.pack ?? PACK;
      const ack = pktLine(o.ack ?? "NAK\n");
      const body = o.sideband === false ? cat(ack, pack) : cat(ack, sideband(pack, 100, o.tail ?? []));
      return new Response(streamOf(body), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

/** The Artifacts binding's repo handle for platform: main's head, its remote and a read token. */
function repoAt(head: string, tokens: Array<{ scope: string; ttl: number }> = []) {
  return {
    log: async () => [{ hash: head }],
    readCommit: async () => null, readTree: async () => null, readBlob: async () => null,
    info: async () => ({ remote: REMOTE }),
    createToken: async (scope: "read" | "write", ttl: number) => { tokens.push({ scope, ttl }); return { plaintext: TOKEN, expiresAt: "2026-11-13T00:06:00Z" }; },
  };
}

function fakeBucket(clock: () => number = () => NOW) {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; options: any; uploaded: Date }>();
  const deleted: string[] = [];
  const bucket: GitBackupBucket = {
    async put(key, value, options) { const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value); objects.set(key, { bytes, options, uploaded: new Date(clock()) }); return { key, size: bytes.length }; },
    async list(o) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).sort();
      const start = o?.cursor ? Number(o.cursor) : 0; const limit = o?.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      return { objects: page.map((k) => ({ key: k, uploaded: objects.get(k)!.uploaded })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) { objects.delete(k); deleted.push(k); } },
  };
  return { bucket, objects, deleted };
}

const rows = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT * FROM forge_git_backups ORDER BY ran_at").all().map((r: any) => ({ ...r }));
const audits = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT event_type, subject, outcome, payload_json FROM audit_events WHERE event_type LIKE 'forge.git_backup%' ORDER BY rowid").all().map((r: any) => ({ ...r }));
/** Every value stored anywhere this step writes, for the token check. */
function everything(db: ReturnType<typeof migratedDb>, b: ReturnType<typeof fakeBucket>, results: unknown[]): string {
  const audit = db.raw.prepare("SELECT * FROM audit_events").all();
  const meta = [...b.objects.entries()].map(([k, o]) => ({ k, m: o.options, head: new TextDecoder().decode(o.bytes.subarray(0, 400)) }));
  return JSON.stringify([rows(db), audit, meta, results]);
}

test("GB1. the bundle format equals git's own bundle; packs are checked (signature, version, count, SHA-1 trailer)", async () => {
  // The writer, given git's refs and pack, reproduces `git bundle create --all` byte for byte.
  const refs = selectRefs({ refs: new Map([["HEAD", MAIN], ["refs/heads/main", MAIN], ["refs/heads/claude/topic", TOPIC], ["refs/tags/v1", TOPIC], ["refs/heads/bad..name", TOPIC]]), capabilities: new Set() });
  assert.deepEqual(refs.refs.map((r) => r.name), ["refs/heads/claude/topic", "refs/heads/main", "HEAD"]);
  assert.equal(refs.skipped, 1, "a branch name git refuses is left out and counted");
  const built = await assembleBundle(refs.refs, { chunks: [PACK.slice(0, 50), PACK.slice(50)], bytes: PACK.length, progress_lines: 0 });
  assert.deepEqual(built.bundle, GIT_BUNDLE);
  assert.equal(built.sha256, hexOf(await crypto.subtle.digest("SHA-256", GIT_BUNDLE)));
  assert.deepEqual([built.pack.version, built.pack.objects, built.pack_bytes], [2, 9, PACK.length]);
  assert.ok(new TextDecoder().decode(built.bundle).startsWith(BUNDLE_SIGNATURE));

  const bad = PACK.slice(); bad[40] ^= 0xff;
  await assert.rejects(verifyPack(bad), /pack_checksum_mismatch/);
  const v4 = PACK.slice(); v4[7] = 4;
  await assert.rejects(verifyPack(v4), /pack_version_4/);
  await assert.rejects(verifyPack(new TextEncoder().encode("<html>sign in</html>".padEnd(40, " "))), /not_a_pack/);
  await assert.rejects(verifyPack(PACK.slice(0, 20)), /pack_too_short/);
  const empty = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  await assert.rejects(verifyPack(cat(empty, new Uint8Array(await crypto.subtle.digest("SHA-1", empty)), new Uint8Array(8)).subarray(0, 32) as never), /pack_(empty|checksum_mismatch)/);
  assert.throws(() => bundleHeader([{ name: "refs/heads/a b", sha: MAIN }]), /invalid_ref/);
  assert.throws(() => selectRefs({ refs: new Map([["refs/heads/dev", MAIN]]), capabilities: new Set() }), /main_not_advertised/);
  const many = new Map<string, string>([["refs/heads/main", MAIN]]);
  for (let i = 0; i < MAX_REFS; i++) many.set(`refs/heads/cr/${i}`, TOPIC);
  assert.throws(() => selectRefs({ refs: many, capabilities: new Set() }), /too_many_refs/, "never a bundle that silently leaves branches out");

  // The request: capabilities on the first want only, a flush, done, and no have lines (a full clone).
  const { caps, sideband: sb } = chooseCapabilities(new Set(["multi_ack", "side-band", "side-band-64k", "ofs-delta", "no-progress", "thin-pack", "agent=git/2"]));
  assert.deepEqual([caps, sb], [["side-band-64k", "ofs-delta", "no-progress", "agent=cryptophys-forge/1"], "side-band-64k"]);
  assert.deepEqual(chooseCapabilities(new Set(["ofs-delta"])), { caps: ["ofs-delta"], sideband: null });
  const lines = readPktLines(uploadPackRequest([TOPIC, MAIN, MAIN], caps));
  assert.deepEqual(lines, [`want ${TOPIC} side-band-64k ofs-delta no-progress agent=cryptophys-forge/1\n`, `want ${MAIN}\n`, null, "done\n"]);
});

test("GB2. the response: NAK, side-band demultiplexing across chunk boundaries, raw packs, remote errors and the size cap", async () => {
  const framed = (o: { ack?: string; sb?: boolean; tail?: Uint8Array[] } = {}) => streamOf(o.sb === false ? cat(pktLine(o.ack ?? "NAK\n"), PACK) : cat(pktLine(o.ack ?? "NAK\n"), sideband(PACK, 33, o.tail ?? [])), 5);
  const got = await receivePack(framed(), "side-band-64k");
  assert.deepEqual(cat(...got.chunks), PACK);
  assert.ok(got.progress_lines > 0, "progress (band 2) is read and dropped");
  assert.deepEqual(cat(...(await receivePack(framed({ sb: false }), null)).chunks), PACK);
  assert.deepEqual(cat(...(await receivePack(streamOf(cat(pktLine(`ACK ${MAIN} common\n`), pktLine(`ACK ${MAIN}\n`), sideband(PACK))), "side-band")).chunks), PACK);
  await assert.rejects(receivePack(streamOf(cat(pktLine("ERR access denied\n"))), "side-band-64k"), /remote_error:access denied/);
  await assert.rejects(receivePack(framed({ tail: [pktLine(cat(Uint8Array.of(3), new TextEncoder().encode("fatal: out of memory")))] }), "side-band-64k"), /remote_error:fatal: out of memory/);
  await assert.rejects(receivePack(streamOf(cat(pktLine("NAK\n"), pktLine(cat(Uint8Array.of(1), PACK.subarray(0, 40))))), "side-band-64k"), /sideband_unterminated/);
  await assert.rejects(receivePack(streamOf(cat(pktLine("NAK\n"), new TextEncoder().encode("00"))), "side-band-64k"), /response_truncated/);
  await assert.rejects(receivePack(streamOf(new TextEncoder().encode("<!doctype html>")), "side-band-64k"), /pkt_malformed/);
  await assert.rejects(receivePack(framed(), "side-band-64k", 400), /pack_too_large/, "fails closed instead of truncating");
  assert.equal(redact(`token ${SECRET} and ${TOKEN}`, TOKEN), "token [redacted] and [redacted]");
});

test("GB3. the tick: a full clone over upload-pack becomes a bundle in R2, a D1 row and an audit event; once per UTC day per head; the token appears nowhere", async () => {
  const db = migratedDb();
  const b = fakeBucket();
  const server = fakeServer();
  const tokens: Array<{ scope: string; ttl: number }> = [];
  const results: unknown[] = [];
  const r = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN, tokens) as never, NOW, server.fetchImpl);
  results.push(r);
  const key = `${GIT_BACKUP_PREFIX}2026-11-13-${MAIN}.bundle`;
  assert.equal(key, bundleKey("2026-11-13", MAIN));
  const sha256 = hexOf(await crypto.subtle.digest("SHA-256", GIT_BUNDLE));
  assert.deepEqual(r, { outcome: "written", main_sha: MAIN, key, bundle_sha256: sha256, bundle_bytes: GIT_BUNDLE.length, objects: 9, refs: 2, pruned: 0 });
  assert.deepEqual(tokens, [{ scope: "read", ttl: GIT_BACKUP_TOKEN_TTL_S }]);
  // Ref discovery, then one POST: wants for every branch (not the tag), done, no have; the secret only in the header.
  assert.deepEqual(server.calls.map((c) => [c.method, c.url.replace(REMOTE, "")]), [["GET", "/info/refs?service=git-upload-pack"], ["POST", "/git-upload-pack"]]);
  assert.ok(server.calls.every((c) => c.headers.authorization === `Bearer ${SECRET}` && !c.url.includes(SECRET)));
  const sent = readPktLines(server.calls[1].body!);
  assert.deepEqual(sent, [`want ${TOPIC} side-band-64k ofs-delta no-progress agent=cryptophys-forge/1\n`, `want ${MAIN}\n`, null, "done\n"]);
  assert.ok(!sent.some((l) => l?.startsWith("have")));
  // The stored object is exactly git's bundle of the same refs, with its measurements in customMetadata.
  const stored = b.objects.get(key)!;
  assert.deepEqual(stored.bytes, GIT_BUNDLE);
  assert.equal(stored.options.httpMetadata.contentType, "application/x-git-bundle");
  assert.deepEqual(
    (({ sha256: s, bytes, objects, refs, main_sha, pack_version, format }) => ({ s, bytes, objects, refs, main_sha, pack_version, format }))(stored.options.customMetadata),
    { s: sha256, bytes: String(GIT_BUNDLE.length), objects: "9", refs: "2", main_sha: MAIN, pack_version: "2", format: "git-bundle-v2" },
  );
  assert.equal(stored.options.customMetadata.pack_sha1, hexOf(PACK.slice(-20).buffer));
  const [row] = rows(db);
  assert.deepEqual([row.status, row.main_sha, row.day, row.r2_key, row.bundle_sha256, row.bundle_bytes, row.pack_bytes, row.objects, row.refs, row.error, row.pruned_at],
    ["ok", MAIN, "2026-11-13", key, sha256, GIT_BUNDLE.length, PACK.length, 9, 2, null, null]);
  assert.deepEqual(JSON.parse(row.refs_json), [{ name: "refs/heads/claude/topic", sha: TOPIC }, { name: "refs/heads/main", sha: MAIN }]);
  const [ev] = audits(db);
  assert.deepEqual([ev.event_type, ev.subject, ev.outcome, JSON.parse(ev.payload_json).bundle_sha256, JSON.parse(ev.payload_json).sideband], ["forge.git_backup_written", key, "succeeded", sha256, "side-band-64k"]);

  // Once per UTC day per head: later the same day nothing is fetched.
  results.push(await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW + 5 * 3_600_000, server.fetchImpl));
  assert.equal((results.at(-1) as any).outcome, "not_due");
  assert.equal(server.calls.length, 2);
  // The next UTC day the same head is backed up again, under that day's key.
  results.push(await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW + DAY, server.fetchImpl));
  assert.equal((results.at(-1) as any).key, bundleKey("2026-11-14", MAIN));

  // A server without side-band: the raw pack after NAK gives the same bundle.
  const raw = fakeServer({ caps: "ofs-delta agent=git/2.43.0", sideband: false });
  results.push(await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW + 2 * DAY, raw.fetchImpl));
  assert.equal((results.at(-1) as any).bundle_sha256, sha256);
  assert.deepEqual(readPktLines(raw.calls[1].body!)[0], `want ${TOPIC} ofs-delta agent=cryptophys-forge/1\n`);

  // The token is in no result, row, audit payload, R2 key or metadata.
  const all = everything(db, b, results);
  assert.ok(!all.includes(SECRET) && !all.includes("art_v1_"), "the token never leaves the Authorization header");

  // Read side: the latest runs, newest first.
  const view = (await gitBackup(db as never, NOW + 2 * DAY + 60_000))!;
  assert.deepEqual([view.schema, view.status, view.stale, view.runs.length, view.retained_bundles, view.retained_days, view.stale_after_hours], ["git-backup.v1", "ok", false, 3, 3, GIT_BACKUP_RETAINED_DAYS, 48]);
  assert.deepEqual(view.last_ok_run!.ref_list.map((x) => x.name), ["refs/heads/claude/topic", "refs/heads/main"]);
  assert.equal((await gitBackup(db as never, NOW + 2 * DAY + GIT_BACKUP_STALE_MS + 60_000))!.status, "stale", "no success for 48 h");
});

test("GB4. a corrupted pack, a server error or a remote ERR fails the run: nothing written, nothing 'latest'; retried after an hour", async () => {
  const db = migratedDb();
  const b = fakeBucket();
  const bad = PACK.slice(); bad[60] ^= 0x01;
  const results: unknown[] = [];
  const f = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW, fakeServer({ pack: bad }).fetchImpl);
  results.push(f);
  assert.deepEqual(f, { outcome: "failed", main_sha: MAIN, error: "pack_checksum_mismatch" });
  assert.equal(b.objects.size, 0, "nothing reaches R2");
  assert.deepEqual(rows(db).map((r: any) => [r.status, r.error, r.r2_key, r.bundle_sha256]), [["failed", "pack_checksum_mismatch", null, null]]);
  assert.deepEqual(audits(db).map((a: any) => [a.event_type, a.outcome, JSON.parse(a.payload_json).error]), [["forge.git_backup_failed", "failed", "pack_checksum_mismatch"]]);
  const view = (await gitBackup(db as never, NOW + 60_000))!;
  assert.deepEqual([view.status, view.last_ok_run, view.latest_run!.status], ["failing", null, "failed"]);

  // Within the hour the same head is not retried; after it, it is.
  const good = fakeServer();
  assert.equal((await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW + GIT_BACKUP_RETRY_MS / 2, good.fetchImpl)).outcome, "not_due");
  assert.equal(good.calls.length, 0);
  // A new head of main is due at once, even within the hour.
  const other = "c".repeat(40);
  const moved = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(other) as never, NOW + GIT_BACKUP_RETRY_MS / 2, good.fetchImpl);
  results.push(moved);
  assert.deepEqual(moved, { outcome: "failed", main_sha: other, error: "main_moved_during_backup" }, "the bundle's main must be the head it was taken for");
  assert.equal(b.objects.size, 0);
  const retried = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, NOW + GIT_BACKUP_RETRY_MS + 1, good.fetchImpl);
  assert.equal(retried.outcome, "written");

  // Other failures, each recorded with its reason and nothing written.
  const day2 = NOW + DAY;
  const cases: Array<[ServerOpts, string]> = [
    [{ status: 500 }, "fetch_http_500"],
    [{ ack: "ERR repository not found\n" }, "remote_error:repository not found"],
    [{ tail: [pktLine(cat(Uint8Array.of(3), new TextEncoder().encode(`denied for ${SECRET}`)))] }, "remote_error:denied for [redacted]"],
    [{ refs: [["refs/heads/dev", MAIN]] }, "main_not_advertised"],
  ];
  for (const [i, [opts, reason]] of cases.entries()) {
    const out = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, day2 + i * (GIT_BACKUP_RETRY_MS + 1), fakeServer(opts).fetchImpl);
    results.push(out);
    assert.deepEqual([out.outcome, out.error], ["failed", reason]);
  }
  const big = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(MAIN) as never, day2 + 10 * (GIT_BACKUP_RETRY_MS + 1), fakeServer().fetchImpl, 300);
  assert.equal(big.error, "pack_too_large");
  // A remote that is not this account's Artifacts host is never asked.
  const spy = fakeServer();
  const untrusted = { ...repoAt(MAIN), info: async () => ({ remote: "https://evil.example.com/git/cryptophys/platform.git" }) };
  const u = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, untrusted as never, day2 + 11 * (GIT_BACKUP_RETRY_MS + 1), spy.fetchImpl);
  assert.deepEqual([u.error, spy.calls.length], ["untrusted_remote", 0]);
  assert.equal([...b.objects.keys()].filter((k) => k.includes("2026-11-14")).length, 0, "no failed run writes a bundle");
  assert.ok(!everything(db, b, results).includes(SECRET));
  // Without the bucket the step does nothing.
  assert.deepEqual(await gitBackupTick({ DB: db as never }, repoAt(MAIN) as never, NOW, spy.fetchImpl), { outcome: "not_configured" });
});

test("GB5. retention keeps the newest bundle of each of the last 30 days and marks pruned rows", async () => {
  let clock = NOW - 40 * DAY;
  const b = fakeBucket(() => clock);
  // 40 days of bundles, two per day (an earlier and a later head), plus an unrelated object under the prefix.
  for (let d = 0; d < 40; d++) {
    const day = new Date(NOW - (39 - d) * DAY).toISOString().slice(0, 10);
    clock = NOW - (39 - d) * DAY; await b.bucket.put(bundleKey(day, "1".repeat(40)), new Uint8Array(1));
    clock += 3_600_000; await b.bucket.put(bundleKey(day, "2".repeat(40)), new Uint8Array(1));
  }
  await b.bucket.put(`${GIT_BACKUP_PREFIX}README.txt`, new Uint8Array(1));
  const deleted = await pruneGitBackups(b.bucket, null, GIT_BACKUP_RETAINED_DAYS, 1000);
  assert.equal(deleted.length, 40 + 10);
  const left = [...b.objects.keys()].filter((k) => k.endsWith(".bundle"));
  assert.equal(left.length, 30);
  assert.ok(left.every((k) => k.includes("2".repeat(40))), "the newest bundle of each day is kept");
  assert.ok(left.includes(bundleKey(new Date(NOW).toISOString().slice(0, 10), "2".repeat(40))));
  assert.ok(b.objects.has(`${GIT_BACKUP_PREFIX}README.txt`), "other names are left alone");
  // Bounded per call; and the bundle just written is never deleted.
  const again = fakeBucket(() => NOW);
  await again.bucket.put(bundleKey("2026-11-13", "3".repeat(40)), new Uint8Array(1));
  assert.deepEqual(await pruneGitBackups(again.bucket, bundleKey("2026-11-13", "3".repeat(40)), 0), []);

  // Through the tick: a second head the same day supersedes the first bundle, whose row is marked pruned.
  const db = migratedDb();
  const t = fakeBucket(() => clock);
  clock = NOW;
  await gitBackupTick({ DB: db as never, BUNDLES: t.bucket }, repoAt(MAIN) as never, NOW, fakeServer().fetchImpl);
  const NEXT = "d".repeat(40);
  clock = NOW + 3_600_000;
  const r = await gitBackupTick({ DB: db as never, BUNDLES: t.bucket }, repoAt(NEXT) as never, clock, fakeServer({ refs: [["refs/heads/main", NEXT], ["refs/heads/claude/topic", TOPIC]] }).fetchImpl);
  // The fake server serves the same pack for the new head; only the bookkeeping is under test here.
  assert.equal(r.outcome, "written");
  assert.equal(r.pruned, 1);
  assert.deepEqual([...t.objects.keys()], [bundleKey("2026-11-13", NEXT)]);
  assert.deepEqual(rows(db).map((x: any) => [x.main_sha, x.pruned_at !== null]), [[MAIN, true], [NEXT, false]]);
  assert.equal((await gitBackup(db as never, clock))!.retained_bundles, 1);
});

test("GB6. GET /v1/forge/git-backup for operators (read only), in the Console allow-list and on the Code page; Console only, never an owner notice", async () => {
  const db = migratedDb();
  await gitBackupTick({ DB: db as never, BUNDLES: fakeBucket().bucket }, repoAt(MAIN) as never, Date.now() - 60_000, fakeServer().fetchImpl);
  const env = baseEnv("cryptophys-forge", db);
  const r = await call(forge, env, req("GET", "/v1/forge/git-backup", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200);
  const v = r.body.backup;
  assert.deepEqual([v.schema, v.status, v.latest_run.main_sha, v.last_ok_run.objects, v.last_ok_run.bundle_bytes], ["git-backup.v1", "ok", MAIN, 9, GIT_BUNDLE.length]);
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  assert.equal((await call(forge, env, req("GET", "/v1/forge/git-backup", undefined, OUTSIDER_JWT))).status, 403);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/git-backup", {}, OPERATOR_JWT))).status, 404, "nothing to write");
  assert.match(read("workers/console/src/index.ts"), /"\/v1\/forge\/git-backup"/);
  assert.match(read("workers/console/src/ui/routes.ts"), /r\("forge\.git_backup", "forge", "GET", "\/v1\/forge\/git-backup", false, null\)/);
  assert.match(read("workers/console/ui/src/pages/Code.tsx"), /<GitBackup /);
  assert.match(read("workers/console/ui/src/pages/Code.tsx"), /call\("forge\.git_backup"/);
  // The panel renders measured values only: render-smoke checks them on #/code, and a missing value is a dash.
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  assert.match(smoke, /"\/api\/forge\/v1\/forge\/git-backup"/);
  assert.match(smoke, /git backup panel does not show/);
  const panel = read("workers/console/ui/src/components/GitBackup.tsx");
  assert.match(panel, /: "—"\)/);
  assert.doesNotMatch(panel, /\?\? 0\b/, "no missing value drawn as 0");
  // Owner 2026-11-13: a stale backup is a Console signal, not an owner notice (no email, no Telegram).
  assert.doesNotMatch(read("workers/ai-kernel/src/owner-notices.ts"), /git_backup|git-backup/);
  // Before migration 0054 the route answers null.
  db.raw.prepare("DROP TABLE forge_git_backups").run();
  assert.equal((await call(forge, env, req("GET", "/v1/forge/git-backup", undefined, OPERATOR_JWT))).body.backup, null);
  const none = await gitBackupTick({ DB: db as never, BUNDLES: fakeBucket().bucket }, repoAt(MAIN) as never, Date.now(), fakeServer().fetchImpl);
  assert.deepEqual([none.outcome, none.recorded], ["failed", false], "the tick reports it and throws nothing");
});

test("GB7. the Forge tick runs git_backup when the bucket is bound; a failure is contained", async () => {
  const db = migratedDb();
  const repo = { ...repoAt(MAIN), log: async () => [] };
  const steps = await forgeTick({ DB: db as never, ARTIFACTS: { get: async () => repo as never }, BUNDLES: fakeBucket().bucket as never }, "platform", null);
  assert.deepEqual(steps.git_backup, { outcome: "no_main" });
  assert.match(read("workers/forge/src/tick.ts"), /step\("git_backup"/);
  assert.match(read("workers/forge/src/tick.ts"), /if \(env\.ARTIFACTS && env\.BUNDLES\)/);
});

test("GB8. a real git server: upload-pack's answer becomes a bundle that `git bundle verify` accepts and `git clone` restores", async () => {
  const git = (() => { try { return spawnSync("git", ["--version"], { encoding: "utf8" }); } catch { return null; } })();
  if (!git || git.status !== 0) {
    // The Forge runner has no git process (no child_process in workerd): the same writer is proven against git's
    // own bundle bytes in GB1 and GB3 there. Here the git CLI part runs wherever git exists (GitHub CI, Node).
    const built = await assembleBundle(selectRefs({ refs: new Map([["refs/heads/main", MAIN], ["refs/heads/claude/topic", TOPIC]]), capabilities: new Set() }).refs, { chunks: [PACK], bytes: PACK.length, progress_lines: 0 });
    assert.deepEqual(built.bundle, GIT_BUNDLE);
    console.log("git is not available here: checked against git's bundle bytes instead");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "forge-git-backup-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Forge Test", GIT_AUTHOR_EMAIL: "forge@example.invalid", GIT_COMMITTER_NAME: "Forge Test", GIT_COMMITTER_EMAIL: "forge@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROTOCOL: "" };
  const g = (cwd: string, args: string[], input?: Uint8Array) => {
    const r = spawnSync("git", args, { cwd, env, input, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout as unknown as Buffer;
  };
  try {
    const src = join(dir, "src");
    g(dir, ["init", "-q", "-b", "main", src]);
    for (let i = 0; i < 5; i++) { writeFileSync(join(src, `f${i}.txt`), `file ${i}\n`.repeat(50 + i)); g(src, ["add", "."]); g(src, ["commit", "-q", "-m", `commit ${i}`]); }
    g(src, ["checkout", "-q", "-b", "claude/topic"]);
    writeFileSync(join(src, "topic.txt"), "topic\n"); g(src, ["add", "."]); g(src, ["commit", "-q", "-m", "topic"]);
    g(src, ["checkout", "-q", "-b", "cr/42", "main"]);
    writeFileSync(join(src, "f0.txt"), "changed\n"); g(src, ["commit", "-q", "-am", "cr 42"]);
    g(src, ["checkout", "-q", "main"]);
    const main = g(src, ["rev-parse", "main"]).toString().trim();
    const topic = g(src, ["rev-parse", "claude/topic"]).toString().trim();
    // The smart-HTTP endpoints as git http-backend serves them, answered by the real git upload-pack.
    const fetchImpl: Fetch = async (url, init) => {
      assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${SECRET}`);
      if (url.endsWith("/info/refs?service=git-upload-pack")) {
        const adv = g(dir, ["upload-pack", "--stateless-rpc", "--advertise-refs", src]);
        return new Response(cat(pktLine("# service=git-upload-pack\n"), FLUSH, new Uint8Array(adv)), { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
      }
      const out = g(dir, ["upload-pack", "--stateless-rpc", src], init!.body as Uint8Array);
      return new Response(streamOf(new Uint8Array(out), 4096), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    };
    const db = migratedDb();
    const b = fakeBucket();
    const r = await gitBackupTick({ DB: db as never, BUNDLES: b.bucket }, repoAt(main) as never, NOW, fetchImpl);
    assert.equal(r.outcome, "written", String(r.error ?? ""));
    assert.equal(r.refs, 3);
    assert.equal(JSON.parse(audits(db)[0].payload_json).sideband, "side-band-64k", "git upload-pack's side-band answer was demultiplexed");
    const stored = b.objects.get(r.key as string)!;
    assert.equal(hexOf(await crypto.subtle.digest("SHA-256", stored.bytes)), r.bundle_sha256);
    const file = join(dir, "platform.bundle");
    writeFileSync(file, stored.bytes);
    const verify = spawnSync("git", ["bundle", "verify", file], { cwd: src, env, encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout + verify.stderr, /The bundle contains these 4 refs|is okay/);
    g(dir, ["clone", "-q", file, join(dir, "platform-restore")]);
    const restored = join(dir, "platform-restore");
    assert.equal(g(restored, ["rev-parse", "HEAD"]).toString().trim(), main, "the clone checks out main");
    assert.equal(g(restored, ["rev-parse", "refs/remotes/origin/claude/topic"]).toString().trim(), topic);
    g(restored, ["fsck", "--full", "--strict"]);
    assert.equal(g(restored, ["rev-list", "--count", "--all"]).toString().trim(), "7");
    console.log(`git bundle verify and git clone: ok (${stored.bytes.length} bytes, ${r.objects} objects, ${r.refs} branches)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
