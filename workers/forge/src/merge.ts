// ADR-0012 G3a: the Forge can merge, fast-forward only (§2.5, §5h).
//
// The Artifacts Workers binding reads commits, trees and history and mints repo-scoped tokens, but it
// cannot create commits or move refs. Refs move only through the Git smart-HTTP protocol at the
// repository's `remote`. A fast-forward needs no new objects, so the Forge speaks just enough of
// receive-pack itself:
//   1. ref discovery: GET <remote>/info/refs?service=git-receive-pack, to read the branch's current
//      value and the server's capabilities;
//   2. POST <remote>/git-receive-pack with one command pkt-line "<old> <new> refs/heads/<branch>",
//      a flush, and (for a create or an update) an empty packfile;
//   3. read report-status: "unpack ok" and "ok refs/heads/<branch>", or "ng <ref> <reason>".
// The old value sent is the one just discovered, and it must equal the caller's `from`. receive-pack
// compares it under the ref lock, so a push that lands in between fails instead of being overwritten.
//
// receive-pack does not itself refuse a non-fast-forward unless the server is configured to; git's
// client is what normally refuses. So forgeMerge checks ancestry through the binding before it pushes,
// and it only ever moves a branch from its current head to a descendant of it. Anything else is
// `not_fast_forward`: the branch must first be updated to include main (a rebase or a merge commit
// made by the contributor), and then it is checked again.
//
// G3a writes only the scratch repository `merge-spike`. forgeMerge refuses the canonical repository
// `platform` until G3b, which waits for the cut-over (G6): while GitHub is canonical, a Forge merge of
// `platform` main would diverge from the mirror.
//
// The write token is minted per merge with a 120 s TTL, sent only in the Authorization header, and never
// logged, stored, audited or returned.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import type { ArtifactsReader } from "./checks.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const ZERO_SHA = "0".repeat(40);
export const MERGE_TOKEN_TTL_S = 120;
export const NAMESPACE = "cryptophys";
export const CANONICAL_REPO = "platform";
export const SPIKE_REPO = "merge-spike";
export const SPIKE_BRANCH = "spike";
const HEX40 = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const MAX_RESPONSE_BYTES = 1_000_000;

export interface MergeResult { ok: boolean; ref: string; from: string; to: string; reason?: string }

export function validSha(v: unknown): v is string {
  return typeof v === "string" && HEX40.test(v);
}

/** A branch name the Forge will push: the ADR's charset, and no form git itself refuses. */
export function validBranch(v: unknown): v is string {
  return typeof v === "string" && BRANCH.test(v) && !v.includes("..") && !v.includes("//")
    && !v.startsWith("/") && !v.endsWith("/") && !v.startsWith("-") && !v.endsWith(".lock") && !v.endsWith(".");
}

/** The secret part of an Artifacts token: create/fork/import return it with an `?expires=` suffix. */
export function tokenSecret(token: string): string {
  const i = token.indexOf("?");
  return i === -1 ? token : token.slice(0, i);
}

/** An https remote of this account's Artifacts host for `repo` in the namespace, with no credentials. */
export function trustedRemoteFor(remote: string, repo: string, namespace = NAMESPACE): boolean {
  try {
    const url = new URL(remote);
    return url.protocol === "https:"
      && /^[0-9a-f]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname)
      && url.username === "" && url.password === "" && url.port === ""
      && url.pathname === "/git/" + namespace + "/" + repo + ".git"
      && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- pkt-line and packfile

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** One pkt-line: four lowercase hex digits of the total length (including themselves), then the data. */
export function pktLine(data: string | Uint8Array): Uint8Array {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const length = bytes.length + 4;
  if (length > 65520) throw new Error("pkt_line_too_long");
  return concat([enc.encode(length.toString(16).padStart(4, "0")), bytes]);
}

export const FLUSH = enc.encode("0000");

/** A version 2 packfile with no objects: "PACK", version 2, count 0, then the SHA-1 of those 12 bytes. */
export async function emptyPack(): Promise<Uint8Array> {
  const header = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", header));
  return concat([header, digest]);
}

/**
 * The receive-pack request for one ref update. A create has old = zero, a delete has new = zero.
 * The packfile is sent unless the only command is a delete (the protocol forbids it then).
 */
export async function receivePackBody(cmd: { from: string; to: string; ref: string }, pack?: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const del = cmd.to === ZERO_SHA;
  const caps = del ? "report-status delete-refs" : "report-status";
  const parts = [pktLine(`${cmd.from} ${cmd.to} ${cmd.ref}\0 ${caps}\n`), FLUSH];
  if (!del) parts.push(pack ?? await emptyPack());
  return concat(parts);
}

/** Split pkt-lines; a flush (0000) is returned as null. Malformed input throws. */
export function readPktLines(bytes: Uint8Array): Array<string | null> {
  const out: Array<string | null> = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new Error("pkt_truncated");
    const head = dec.decode(bytes.subarray(at, at + 4));
    if (!/^[0-9a-f]{4}$/i.test(head)) throw new Error("pkt_malformed");
    const length = parseInt(head, 16);
    if (length === 0) { out.push(null); at += 4; continue; }
    if (length < 4 || at + length > bytes.length) throw new Error("pkt_truncated");
    out.push(dec.decode(bytes.subarray(at + 4, at + length)));
    at += length;
  }
  return out;
}

export interface Advertisement { refs: Map<string, string>; capabilities: Set<string> }

/** The ref advertisement of info/refs?service=git-receive-pack (protocol v0/v1). */
export function parseAdvertisement(bytes: Uint8Array): Advertisement {
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let first = true;
  for (const line of readPktLines(bytes)) {
    if (line === null) continue;
    const text = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (text.startsWith("# service=") || text === "version 1") continue;
    let refPart = text;
    if (first) {
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        refPart = text.slice(0, nul);
        for (const c of text.slice(nul + 1).split(" ")) if (c) capabilities.add(c);
      }
      first = false;
    }
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(refPart);
    if (!m) throw new Error("advertisement_malformed");
    if (m[2] !== "capabilities^{}") refs.set(m[2], m[1]);
  }
  return { refs, capabilities };
}

export interface ReportStatus { unpack: string | null; refs: Map<string, { ok: boolean; reason?: string }> }

/** report-status: "unpack ok|<error>", then "ok <ref>" or "ng <ref> <reason>" per command. */
export function parseReportStatus(bytes: Uint8Array): ReportStatus {
  let unpack: string | null = null;
  const refs = new Map<string, { ok: boolean; reason?: string }>();
  for (const line of readPktLines(bytes)) {
    if (line === null) continue;
    const text = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (text.startsWith("unpack ")) { unpack = text.slice(7); continue; }
    const ok = /^ok (\S+)$/.exec(text);
    if (ok) { refs.set(ok[1], { ok: true }); continue; }
    const ng = /^ng (\S+)(?: (.*))?$/.exec(text);
    if (ng) { refs.set(ng[1], { ok: false, reason: ng[2] ?? "" }); continue; }
  }
  return { unpack, refs };
}

/** Reasons come from the server: printable ASCII only, bounded, so nothing odd reaches audit or a response. */
function safeText(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
}

async function readBounded(res: Response): Promise<Uint8Array> {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  return buf;
}

export function gitHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${tokenSecret(token)}`, "user-agent": "git/2 (cryptophys-forge)", ...extra };
}

export function remoteBase(remote: string): string | null {
  try {
    const url = new URL(remote);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return remote.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Ref discovery (protocol v0/v1) for receive-pack, or for upload-pack (G4: the branches of the work
 * repository, with a read token). Never follows a redirect (an Access or sign-in page is not a Git server).
 */
export async function discoverRefs(remote: string, token: string, fetchImpl: Fetch, service: "git-receive-pack" | "git-upload-pack" = "git-receive-pack"): Promise<{ ok: true; adv: Advertisement } | { ok: false; reason: string }> {
  const base = remoteBase(remote);
  if (!base) return { ok: false, reason: "invalid_remote" };
  let res: Response;
  try {
    res = await fetchImpl(`${base}/info/refs?service=${service}`, { method: "GET", redirect: "manual", headers: gitHeaders(token) });
  } catch {
    return { ok: false, reason: "discovery_unreachable" };
  }
  if (res.status !== 200) return { ok: false, reason: `discovery_http_${res.status}` };
  if (!(res.headers.get("content-type") ?? "").startsWith(`application/x-${service}-advertisement`)) return { ok: false, reason: "discovery_not_smart_http" };
  try {
    return { ok: true, adv: parseAdvertisement(await readBounded(res)) };
  } catch {
    return { ok: false, reason: "discovery_malformed" };
  }
}

/**
 * Move refs/heads/<branch> from `from` to `to` over smart HTTP. `from` = zero creates the branch,
 * `to` = zero deletes it. Refuses, without sending the update, unless the discovered value of the
 * branch is exactly `from`. It does not check ancestry: forgeMerge does that before calling it.
 */
/**
 * `pack` (transfer.ts) carries the objects `to` needs when the remote may not have them; without it an empty
 * pack is sent, which is enough for a fast-forward to objects the repository already holds.
 */
export async function fastForward(args: { remote: string; token: string; branch: string; from: string; to: string; fetchImpl: Fetch; pack?: Uint8Array }): Promise<MergeResult> {
  const { remote, token, branch, from, to, fetchImpl, pack } = args;
  const ref = `refs/heads/${typeof branch === "string" ? branch : ""}`;
  const result = (ok: boolean, reason?: string): MergeResult => ({ ok, ref, from: validSha(from) ? from : "", to: validSha(to) ? to : "", ...(reason ? { reason } : {}) });
  if (!validBranch(branch)) return result(false, "invalid_branch");
  if (!validSha(from) || !validSha(to)) return result(false, "invalid_sha");
  if (from === to) return result(false, "no_change");
  if (typeof token !== "string" || !tokenSecret(token)) return result(false, "no_token");
  const base = remoteBase(remote);
  if (!base) return result(false, "invalid_remote");

  const discovered = await discoverRefs(base, token, fetchImpl);
  if (!discovered.ok) return result(false, discovered.reason);
  const current = discovered.adv.refs.get(ref) ?? ZERO_SHA;
  if (current !== from) return result(false, current === ZERO_SHA ? "ref_missing" : "ref_moved");
  if (!discovered.adv.capabilities.has("report-status")) return result(false, "capability_missing:report-status");
  if (to === ZERO_SHA && !discovered.adv.capabilities.has("delete-refs")) return result(false, "capability_missing:delete-refs");

  let res: Response;
  try {
    res = await fetchImpl(`${base}/git-receive-pack`, {
      method: "POST",
      redirect: "manual",
      headers: gitHeaders(token, { "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result" }),
      body: await receivePackBody({ from, to, ref }, to === ZERO_SHA ? undefined : pack),
    });
  } catch {
    // The outcome is unknown: the caller re-reads the branch before it believes either answer.
    return result(false, "push_unreachable");
  }
  if (res.status !== 200) return result(false, `push_http_${res.status}`);
  let report: ReportStatus;
  try {
    report = parseReportStatus(await readBounded(res));
  } catch {
    return result(false, "report_malformed");
  }
  if (report.unpack === null) return result(false, "report_missing");
  if (report.unpack !== "ok") return result(false, `unpack_failed:${safeText(report.unpack)}`);
  const status = report.refs.get(ref);
  if (!status) return result(false, "report_missing");
  if (!status.ok) return result(false, `rejected:${safeText(status.reason ?? "")}`);
  return result(true);
}

// ---------------------------------------------------------------- ancestry through the binding

type CommitRecord = Record<string, unknown>;

/** The parent hashes of a binding commit record (`parents`, as strings or {hash}); none when absent. */
export function parentsOf(commit: CommitRecord | null): string[] {
  if (!commit) return [];
  const raw = commit.parents ?? commit.parentHashes ?? commit.parent_hashes;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? String((p as CommitRecord).hash ?? (p as CommitRecord).oid ?? (p as CommitRecord).sha ?? "") : ""))
    .filter((p) => HEX40.test(p));
}

/**
 * True when `ancestor` is `descendant` or reachable from it through parents. Reads at most `maxDepth`
 * commits; a history deeper than that, or a commit that cannot be read, answers false (fail closed).
 */
export async function isAncestor(repo: Pick<ArtifactsReader, "readCommit">, ancestor: string, descendant: string, maxDepth = 500): Promise<boolean> {
  if (!validSha(ancestor) || !validSha(descendant)) return false;
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  let reads = 0;
  while (queue.length) {
    if (reads >= maxDepth) return false;
    const sha = queue.shift() as string;
    reads++;
    const commit = await repo.readCommit(sha) as CommitRecord | null;
    if (!commit) return false;
    for (const parent of parentsOf(commit)) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
  }
  return false;
}

// ---------------------------------------------------------------- the merge

export interface MergeRepo extends ArtifactsReader {
  info(): Promise<{ remote: string } | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt: string | number }>;
}
export interface MergeBinding { get(name: string): Promise<MergeRepo> }

/** The commit a ref resolves to through the binding, or null when it does not resolve. */
export async function refHead(repo: Pick<ArtifactsReader, "log">, ref: string): Promise<string | null> {
  const row = (await repo.log({ ref, limit: 1 }))[0];
  const hash = row && typeof row.hash === "string" ? row.hash : "";
  return HEX40.test(hash) ? hash : null;
}

/**
 * Fast-forward `branch` of `repoName` from `base` to `head`. Refuses unless `base` is the branch's
 * current head (`base_not_current`) and `head` descends from it (`not_fast_forward`); a branch that
 * does not contain the current base must be updated first. After the push the branch is read back
 * through the binding and must equal `head`.
 */
/**
 * The canonical repository is refused unless `allow.canonical` is set, which only consensus-merge.ts does, after it
 * verified the consensus proposal, its policy decision and the cut-over's merge path (ADR-0012 G3b).
 */
export async function forgeMerge(binding: MergeBinding, repoName: string, opts: { head: string; base: string; branch?: string }, fetchImpl: Fetch = (i, init) => fetch(i, init), allow: { canonical?: boolean } = {}): Promise<MergeResult> {
  const branch = opts.branch ?? "main";
  const ref = `refs/heads/${branch}`;
  const { head, base } = opts;
  const refuse = (reason: string): MergeResult => ({ ok: false, ref, from: validSha(base) ? base : "", to: validSha(head) ? head : "", reason });
  if (!validBranch(branch)) return refuse("invalid_branch");
  if (!validSha(head) || !validSha(base) || head === ZERO_SHA || base === ZERO_SHA) return refuse("invalid_sha");
  if (repoName === CANONICAL_REPO && allow.canonical !== true) return refuse("canonical_not_enabled");
  if (head === base) return refuse("nothing_to_merge");
  const repo = await binding.get(repoName);
  try {
    if ((await refHead(repo, branch)) !== base) return refuse("base_not_current");
    if (!(await isAncestor(repo, base, head))) return refuse("not_fast_forward");
    const remote = (await repo.info())?.remote ?? "";
    if (!trustedRemoteFor(remote, repoName)) return refuse("untrusted_remote");
    const token = await repo.createToken("write", MERGE_TOKEN_TTL_S);
    const pushed = await fastForward({ remote, token: token.plaintext, branch, from: base, to: head, fetchImpl });
    const now = await refHead(repo, branch);
    if (!pushed.ok) return now === head ? { ...pushed, reason: `${pushed.reason}:but_branch_at_head` } : pushed;
    if (now !== head) return refuse("verify_mismatch");
    return { ok: true, ref, from: base, to: head };
  } finally {
    repo[Symbol.dispose]?.();
  }
}

// ---------------------------------------------------------------- the spike (POST /v1/forge/merge-spike)

export interface SpikeRepo extends MergeRepo {
  fork?(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<{ name: string; remote: string }>;
}
export interface SpikeBinding {
  list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: Array<{ name: string; status: string }>; cursor?: string | null }>;
  get(name: string): Promise<SpikeRepo>;
}
export interface SpikeStep { step: string; ok: boolean; ref?: string; from?: string; to?: string; reason?: string }
export interface SpikeResult { outcome: "succeeded" | "failed" | "forking"; repo: string; main: string | null; parent: string | null; steps: SpikeStep[] }

export async function repoStatus(binding: Pick<SpikeBinding, "list">, name: string): Promise<string> {
  let cursor: string | undefined;
  do {
    const page = await binding.list(cursor ? { limit: 100, cursor } : { limit: 100 });
    const found = page.repos.find((r) => r.name === name);
    if (found) return found.status;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return "missing";
}

/**
 * The G3a spike, on the scratch repository only (a fork of `platform`, made once and reused):
 * cleanup of a leftover `spike` branch, create `spike` at main's first parent P, fast-forward it to
 * main's head H with forgeMerge, check it through the binding, delete it, and check main did not move.
 * Never writes `platform`: every remote it pushes to must be the scratch repository's.
 */
export async function mergeSpike(env: { DB: D1Database; ARTIFACTS?: SpikeBinding }, actor: string, fetchImpl: Fetch): Promise<SpikeResult> {
  if (!env.ARTIFACTS) throw Object.assign(new Error("artifacts_not_configured"), { status: 503 });
  const binding = env.ARTIFACTS;
  const steps: SpikeStep[] = [];
  const done = async (outcome: SpikeResult["outcome"], main: string | null, parent: string | null): Promise<SpikeResult> => {
    await appendAuditEvent(env.DB, { event_type: "forge.merge_spike", actor, subject: SPIKE_REPO, outcome, payload: { source: CANONICAL_REPO, repo: SPIKE_REPO, branch: SPIKE_BRANCH, main, parent, steps } });
    return { outcome, repo: SPIKE_REPO, main, parent, steps };
  };

  let state = await repoStatus(binding, SPIKE_REPO);
  if (state === "missing") {
    if ((await repoStatus(binding, CANONICAL_REPO)) !== "ready") { steps.push({ step: "fork", ok: false, reason: "source_not_ready" }); return done("failed", null, null); }
    const source = await binding.get(CANONICAL_REPO);
    try {
      if (typeof source.fork !== "function") { steps.push({ step: "fork", ok: false, reason: "fork_unavailable" }); return done("failed", null, null); }
      await source.fork(SPIKE_REPO, { description: "ADR-0012 G3a merge spike (scratch; safe to delete)", defaultBranchOnly: true, readOnly: false });
      steps.push({ step: "fork", ok: true });
    } finally {
      source[Symbol.dispose]?.();
    }
    state = await repoStatus(binding, SPIKE_REPO);
  }
  if (state !== "ready") { steps.push({ step: "scratch_ready", ok: false, reason: state }); return done("forking", null, null); }

  const repo = await binding.get(SPIKE_REPO);
  let main: string | null = null;
  let parent: string | null = null;
  try {
    const remote = (await repo.info())?.remote ?? "";
    if (!trustedRemoteFor(remote, SPIKE_REPO) || trustedRemoteFor(remote, CANONICAL_REPO)) { steps.push({ step: "remote", ok: false, reason: "untrusted_remote" }); return done("failed", null, null); }
    main = await refHead(repo, "main");
    parent = main ? parentsOf(await repo.readCommit(main) as CommitRecord | null)[0] ?? null : null;
    if (!main || !parent) { steps.push({ step: "history", ok: false, reason: main ? "no_parent" : "no_main" }); return done("failed", main, parent); }
    const token = (await repo.createToken("write", MERGE_TOKEN_TTL_S)).plaintext;
    const push = async (step: string, from: string, to: string): Promise<boolean> => {
      const r = await fastForward({ remote, token, branch: SPIKE_BRANCH, from, to, fetchImpl });
      steps.push({ step, ok: r.ok, ref: r.ref, from: r.from, to: r.to, ...(r.reason ? { reason: r.reason } : {}) });
      return r.ok;
    };
    const check = async (step: string, ref: string, want: string | null): Promise<boolean> => {
      const got = await refHead(repo, ref);
      const ok = got === want;
      steps.push({ step, ok, ref, ...(ok ? {} : { reason: `resolves_to:${got ?? "nothing"}` }) });
      return ok;
    };
    const leftover = async (): Promise<string | null | undefined> => {
      const d = await discoverRefs(remote, token, fetchImpl);
      return d.ok ? d.adv.refs.get(`refs/heads/${SPIKE_BRANCH}`) ?? null : undefined;
    };

    const before = await leftover();
    if (before === undefined) { steps.push({ step: "discover", ok: false, reason: "discovery_failed" }); return done("failed", main, parent); }
    if (before && !(await push("cleanup", before, ZERO_SHA))) return done("failed", main, parent);

    let ok = await push("create", ZERO_SHA, parent) && await check("verify_create", SPIKE_BRANCH, parent);
    if (ok) {
      const merged = await forgeMerge(binding, SPIKE_REPO, { base: parent, head: main, branch: SPIKE_BRANCH }, fetchImpl);
      steps.push({ step: "fast_forward", ok: merged.ok, ref: merged.ref, from: merged.from, to: merged.to, ...(merged.reason ? { reason: merged.reason } : {}) });
      ok = merged.ok && await check("verify_fast_forward", SPIKE_BRANCH, main);
    }
    // Always try to leave no spike branch behind, from wherever it is now.
    const now = await leftover();
    const deleted = now === null ? true : now ? await push("delete", now, ZERO_SHA) && await check("verify_delete", SPIKE_BRANCH, null) : false;
    if (now === undefined) steps.push({ step: "delete", ok: false, reason: "discovery_failed" });
    const mainKept = await check("main_unchanged", "main", main);
    return done(ok && deleted && mainKept ? "succeeded" : "failed", main, parent);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

/** A failed spike is retried after this long. */
export const SPIKE_RETRY_MS = 6 * 3_600_000;

/**
 * Gate 5 without a person (2026-11-13): the tick runs the spike until one run has succeeded, then never again.
 * A failed or still-forking run is retried after SPIKE_RETRY_MS. The spike writes only the scratch repository.
 */
export async function mergeSpikeUntilProven(env: { DB: D1Database; ARTIFACTS?: SpikeBinding }, nowMs = Date.now(), fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<Record<string, unknown>> {
  if (!env.ARTIFACTS) return { outcome: "not_configured" };
  const done = await env.DB.prepare("SELECT created_at FROM audit_events WHERE event_type = 'forge.merge_spike' AND outcome = 'succeeded' ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
  if (done) return { outcome: "proven", at: done.created_at };
  const last = await env.DB.prepare("SELECT created_at FROM audit_events WHERE event_type = 'forge.merge_spike' ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
  if (last && nowMs - Date.parse(last.created_at) < SPIKE_RETRY_MS) return { outcome: "waiting", last: last.created_at };
  const result = await mergeSpike(env, "system:forge-tick", fetchImpl);
  return { outcome: result.outcome, steps: result.steps.length };
}
