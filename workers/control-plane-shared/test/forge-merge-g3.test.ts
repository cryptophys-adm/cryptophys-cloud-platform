// ADR-0012 G3a: the Forge can merge (fast-forward only) over Git smart HTTP, and the spike that proves
// it on the scratch repository merge-spike. The canonical repository platform is never written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { APPROVER_EMAIL, APPROVER_JWT, CI_JWT, OPERATOR_JWT, OUTSIDER_JWT, accessCertsResponse, baseEnv, call, isAccessCerts, migratedDb, req } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import {
  FLUSH, MERGE_TOKEN_TTL_S, ZERO_SHA, emptyPack, fastForward, forgeMerge, isAncestor, parseAdvertisement, parseReportStatus,
  pktLine, receivePackBody, tokenSecret, validBranch, type Fetch,
} from "../../forge/src/merge.ts";

const HOST = "a".repeat(32) + ".artifacts.cloudflare.net";
const remoteOf = (repo: string) => `https://${HOST}/git/cryptophys/${repo}.git`;
const C0 = "0".repeat(39) + "1";
const P = "1".repeat(40);
const H = "2".repeat(40);
const SIDE = "3".repeat(40);
const SECRET = "art_v1_SECRETTOKENVALUE";
const TOKEN = SECRET + "?expires=1794200000";
const b = (s: string) => new TextEncoder().encode(s);
const text = (u: Uint8Array) => new TextDecoder().decode(u);
const EMPTY_PACK_SHA1 = "029d08823bd8a8eab510ad6ac75c823cfd3ed31e"; // git's well-known empty pack name

/** Commits shared by every repo: C0 <- P <- H (main), and SIDE, a child of C0 that is not on main. */
const COMMITS: Record<string, string[]> = { [C0]: [], [P]: [C0], [H]: [P], [SIDE]: [C0] };

interface GitRepo { refs: Map<string, string>; caps: string[] }
interface Seen { method: string; url: string; auth: string | null; body?: Uint8Array }

/**
 * A smart-HTTP receive-pack server for the remotes of `repos`, plus the URLs and headers it saw.
 * It applies an update only when the old value matches, as receive-pack does under the ref lock.
 */
function gitServer(repos: Map<string, GitRepo>, opts: { reply?: (cmdRef: string) => string[] | null } = {}) {
  const seen: Seen[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : undefined;
    seen.push({ method: init?.method ?? "GET", url, auth, body });
    const m = /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/cryptophys\/([a-z-]+)\.git\/(info\/refs\?service=git-receive-pack|git-receive-pack)$/.exec(url);
    const repo = m ? repos.get(m[1]) : undefined;
    if (!m || !repo) return new Response("not found", { status: 404 });
    if (auth !== `Bearer ${SECRET}`) return new Response("unauthorized", { status: 401 });
    if (m[2].startsWith("info/refs")) {
      const refs = [...repo.refs.entries()];
      const caps = repo.caps.join(" ");
      const lines = refs.length
        ? refs.map(([ref, sha], i) => pktLine(i === 0 ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`))
        : [pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`)];
      const out = Buffer.concat([pktLine("# service=git-receive-pack\n"), FLUSH, ...lines, FLUSH]);
      return new Response(out, { headers: { "content-type": "application/x-git-receive-pack-advertisement" } });
    }
    // receive-pack: one command, a flush, then the pack unless it is a delete.
    const len = parseInt(text(body!.subarray(0, 4)), 16);
    const cmd = text(body!.subarray(4, len));
    const [line] = cmd.split("\0");
    const [from, to, ref] = line.split(" ");
    assert.equal(text(body!.subarray(len, len + 4)), "0000");
    const rest = body!.subarray(len + 4);
    if (to === ZERO_SHA) assert.equal(rest.length, 0, "a delete sends no pack");
    else assert.deepEqual([...rest], [...(await emptyPack())], "a ref update sends the empty pack");
    const scripted = opts.reply?.(ref);
    let report: string[];
    if (scripted) report = scripted;
    else if ((repo.refs.get(ref) ?? ZERO_SHA) !== from) report = ["unpack ok\n", `ng ${ref} stale info\n`];
    else {
      if (to === ZERO_SHA) repo.refs.delete(ref); else repo.refs.set(ref, to);
      report = ["unpack ok\n", `ok ${ref}\n`];
    }
    return new Response(Buffer.concat([...report.map((l) => pktLine(l)), FLUSH]), { headers: { "content-type": "application/x-git-receive-pack-result" } });
  };
  return { seen, fetchImpl };
}

/** An Artifacts namespace whose repos read their refs from the same state the git server writes. */
function fakeNamespace(repos: Map<string, GitRepo>, opts: { forkStatus?: "ready" | "forking"; noFork?: boolean; parentsField?: string } = {}) {
  const calls = { forks: [] as any[], tokens: [] as any[], gets: [] as string[], disposals: 0 };
  const status = new Map<string, string>([...repos.keys()].map((k) => [k, "ready"]));
  const handle = (name: string): any => {
    const state = repos.get(name)!;
    const h: any = {
      info: async () => ({ name, remote: remoteOf(name), defaultBranch: "main" }),
      createToken: async (scope: string, ttl: number) => { calls.tokens.push({ repo: name, scope, ttl }); return { plaintext: TOKEN, expiresAt: "2026-11-12T10:02:00Z" }; },
      log: async (o: any) => {
        const ref = o?.ref ?? "HEAD";
        const sha = state.refs.get(`refs/heads/${ref}`) ?? (COMMITS[ref] ? ref : undefined);
        return sha ? [{ hash: sha, treeHash: "f".repeat(40), message: "m", parents: COMMITS[sha] }] : [];
      },
      readCommit: async (sha: string) => (COMMITS[sha] ? { hash: sha, treeHash: "f".repeat(40), [opts.parentsField ?? "parents"]: COMMITS[sha] } : null),
      readTree: async () => [],
      readBlob: async () => null,
      [Symbol.dispose]: () => { calls.disposals++; },
    };
    if (!opts.noFork) {
      h.fork = async (target: string, o: any) => {
        calls.forks.push({ from: name, target, opts: o });
        repos.set(target, { refs: new Map(state.refs), caps: state.caps });
        status.set(target, opts.forkStatus ?? "ready");
        return { name: target, remote: remoteOf(target) };
      };
    }
    return h;
  };
  return {
    calls,
    status,
    binding: {
      list: async () => ({ repos: [...status.entries()].map(([name, s]) => ({ name, status: s })), cursor: null }),
      get: async (name: string) => { calls.gets.push(name); if (status.get(name) !== "ready") throw new Error("NOT_READY"); return handle(name); },
      import: async () => { throw new Error("import must not be called"); },
    },
  };
}
const CAPS = ["report-status", "delete-refs", "ofs-delta", "agent=artifacts"];
const repoAt = (refs: Record<string, string>, caps = CAPS): GitRepo => ({ refs: new Map(Object.entries(refs)), caps });

// ---------------------------------------------------------------- protocol pieces

test("G3a-1. pkt-lines: four lowercase hex digits of the whole length, then the data; flush is 0000", () => {
  assert.equal(text(pktLine("a\n")), "0006a\n");
  assert.equal(text(pktLine("")), "0004");
  assert.equal(text(pktLine("x".repeat(26))), "001e" + "x".repeat(26));
  assert.equal(text(pktLine("# service=git-receive-pack\n")), "001f# service=git-receive-pack\n");
  assert.equal(text(FLUSH), "0000");
  assert.throws(() => pktLine("x".repeat(65517)), /pkt_line_too_long/);
});

test("G3a-2. the empty pack: PACK, version 2, zero objects, and the SHA-1 of those 12 bytes", async () => {
  const pack = await emptyPack();
  assert.equal(pack.length, 32);
  const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  assert.deepEqual(Buffer.from(pack.subarray(0, 12)), header);
  assert.equal(Buffer.from(pack.subarray(12)).toString("hex"), createHash("sha1").update(header).digest("hex"));
  assert.equal(Buffer.from(pack.subarray(12)).toString("hex"), EMPTY_PACK_SHA1);
});

test("G3a-3. request bodies are exact for a create, a fast-forward and a delete", async () => {
  const ref = "refs/heads/spike";
  const pack = Buffer.from("5041434b0000000200000000" + EMPTY_PACK_SHA1, "hex");
  const create = await receivePackBody({ from: ZERO_SHA, to: P, ref });
  assert.deepEqual(Buffer.from(create), Buffer.concat([Buffer.from(`0076${ZERO_SHA} ${P} ${ref}\0 report-status\n0000`), pack]));
  const ff = await receivePackBody({ from: P, to: H, ref });
  assert.deepEqual(Buffer.from(ff), Buffer.concat([Buffer.from(`0076${P} ${H} ${ref}\0 report-status\n0000`), pack]));
  const del = await receivePackBody({ from: H, to: ZERO_SHA, ref });
  assert.deepEqual(Buffer.from(del), Buffer.from(`0082${H} ${ZERO_SHA} ${ref}\0 report-status delete-refs\n0000`), "a delete carries delete-refs and no pack");
});

test("G3a-4. report-status and the ref advertisement are parsed; ng and unpack errors are refusals", async () => {
  const report = (lines: string[]) => Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
  const ok = parseReportStatus(report(["unpack ok\n", "ok refs/heads/main\n"]));
  assert.equal(ok.unpack, "ok");
  assert.deepEqual(ok.refs.get("refs/heads/main"), { ok: true });
  const ng = parseReportStatus(report(["unpack ok\n", "ng refs/heads/main non-fast-forward\n"]));
  assert.deepEqual(ng.refs.get("refs/heads/main"), { ok: false, reason: "non-fast-forward" });
  assert.equal(parseReportStatus(report(["unpack index-pack abnormal exit\n", "ng refs/heads/main unpacker error\n"])).unpack, "index-pack abnormal exit");
  assert.throws(() => parseReportStatus(b("zzzz")), /pkt_malformed/);
  assert.throws(() => parseReportStatus(b("00ffshort")), /pkt_truncated/);

  const adv = parseAdvertisement(Buffer.concat([pktLine("# service=git-receive-pack\n"), FLUSH, pktLine(`${H} refs/heads/main\0report-status delete-refs\n`), pktLine(`${P} refs/heads/x\n`), FLUSH]));
  assert.deepEqual([...adv.refs], [["refs/heads/main", H], ["refs/heads/x", P]]);
  assert.deepEqual([...adv.capabilities], ["report-status", "delete-refs"]);
  const empty = parseAdvertisement(Buffer.concat([pktLine(`${ZERO_SHA} capabilities^{}\0report-status\n`), FLUSH]));
  assert.equal(empty.refs.size, 0);

  // Through fastForward: the server's refusal and an unpack error come back as reasons, never as success.
  for (const [lines, reason] of [
    [["unpack ok\n", "ng refs/heads/main non-fast-forward\n"], "rejected:non-fast-forward"],
    [["unpack index-pack failed\n", "ng refs/heads/main unpacker error\n"], "unpack_failed:index-pack failed"],
    [["unpack ok\n"], "report_missing"],
  ] as Array<[string[], string]>) {
    const server = gitServer(new Map([["merge-spike", repoAt({ "refs/heads/main": P })]]), { reply: () => lines });
    const r = await fastForward({ remote: remoteOf("merge-spike"), token: TOKEN, branch: "main", from: P, to: H, fetchImpl: server.fetchImpl });
    assert.deepEqual(r, { ok: false, ref: "refs/heads/main", from: P, to: H, reason });
  }
});

test("G3a-5. fastForward refuses before the POST when the discovered ref is not `from`, and validates its input", async () => {
  const repos = new Map([["merge-spike", repoAt({ "refs/heads/main": H })]]);
  const server = gitServer(repos);
  const moved = await fastForward({ remote: remoteOf("merge-spike"), token: TOKEN, branch: "main", from: P, to: H, fetchImpl: server.fetchImpl });
  assert.deepEqual(moved, { ok: false, ref: "refs/heads/main", from: P, to: H, reason: "ref_moved" });
  const missing = await fastForward({ remote: remoteOf("merge-spike"), token: TOKEN, branch: "nope", from: P, to: H, fetchImpl: server.fetchImpl });
  assert.equal(missing.reason, "ref_missing");
  assert.deepEqual(server.seen.map((s) => s.method), ["GET", "GET"], "only ref discovery, never the update");
  assert.equal(repos.get("merge-spike")!.refs.get("refs/heads/main"), H);

  const before = server.seen.length;
  for (const [args, reason] of [
    [{ branch: "../main" }, "invalid_branch"], [{ branch: "a..b" }, "invalid_branch"], [{ branch: "x y" }, "invalid_branch"], [{ branch: "" }, "invalid_branch"],
    [{ branch: "x".repeat(101) }, "invalid_branch"], [{ from: "abc" }, "invalid_sha"], [{ to: "A".repeat(40) }, "invalid_sha"], [{ from: H, to: H }, "no_change"],
    [{ remote: "http://" + HOST + "/git/cryptophys/merge-spike.git" }, "invalid_remote"], [{ remote: remoteOf("merge-spike") + "?x=1" }, "invalid_remote"],
  ] as Array<[Record<string, string>, string]>) {
    const r = await fastForward({ remote: remoteOf("merge-spike"), token: TOKEN, branch: "main", from: P, to: H, fetchImpl: server.fetchImpl, ...args });
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason, JSON.stringify(args));
  }
  assert.equal(server.seen.length, before, "invalid input never reaches the network");
  assert.ok(validBranch("cr/12") && validBranch("main") && !validBranch("x.lock") && !validBranch("/x") && !validBranch("x/"));

  // A server that lacks a capability the command needs is refused before the update.
  const nocap = gitServer(new Map([["merge-spike", repoAt({ "refs/heads/spike": H }, ["report-status"])]]));
  const del = await fastForward({ remote: remoteOf("merge-spike"), token: TOKEN, branch: "spike", from: H, to: ZERO_SHA, fetchImpl: nocap.fetchImpl });
  assert.equal(del.reason, "capability_missing:delete-refs");
  assert.deepEqual(nocap.seen.map((s) => s.method), ["GET"]);
  // A redirect (an Access sign-in page) is not a Git server.
  const redirect: Fetch = async () => new Response(null, { status: 302, headers: { location: "https://login.example/" } });
  assert.equal((await fastForward({ remote: remoteOf("merge-spike"), token: TOKEN, branch: "main", from: P, to: H, fetchImpl: redirect })).reason, "discovery_http_302");
});

test("G3a-6. the token is sent only as the secret part in Authorization, and never returned", async () => {
  const repos = new Map([["merge-spike", repoAt({ "refs/heads/main": P })]]);
  const server = gitServer(repos);
  assert.equal(tokenSecret(TOKEN), SECRET);
  const r = await fastForward({ remote: remoteOf("merge-spike"), token: TOKEN, branch: "main", from: P, to: H, fetchImpl: server.fetchImpl });
  assert.deepEqual(r, { ok: true, ref: "refs/heads/main", from: P, to: H });
  assert.deepEqual(server.seen.map((s) => [s.method, s.url.replace(remoteOf("merge-spike"), "")]), [["GET", "/info/refs?service=git-receive-pack"], ["POST", "/git-receive-pack"]]);
  assert.ok(server.seen.every((s) => s.auth === `Bearer ${SECRET}` && !s.url.includes("SECRET")));
  assert.doesNotMatch(JSON.stringify(r), /SECRET|art_v1/);
  assert.equal(repos.get("merge-spike")!.refs.get("refs/heads/main"), H);
});

// ---------------------------------------------------------------- ancestry and forgeMerge

test("G3a-7. isAncestor walks parents through the binding and fails closed", async () => {
  const ns = fakeNamespace(new Map([["merge-spike", repoAt({})]]));
  const repo = await ns.binding.get("merge-spike");
  assert.equal(await isAncestor(repo, P, H), true);
  assert.equal(await isAncestor(repo, C0, H), true);
  assert.equal(await isAncestor(repo, H, H), true);
  assert.equal(await isAncestor(repo, H, P), false, "a descendant is not an ancestor");
  assert.equal(await isAncestor(repo, SIDE, H), false, "a sibling is not an ancestor");
  assert.equal(await isAncestor(repo, C0, H, 1), false, "a history deeper than maxDepth answers false");
  assert.equal(await isAncestor(repo, P, "9".repeat(40)), false, "an unreadable commit answers false");
  const noParents = fakeNamespace(new Map([["merge-spike", repoAt({})]]), { parentsField: "unknownField" });
  assert.equal(await isAncestor(await noParents.binding.get("merge-spike"), P, H), false, "unknown commit metadata answers false");
});

test("G3a-8. forgeMerge fast-forwards only from the current base to a descendant, then reads the branch back", async () => {
  const repos = new Map([["merge-spike", repoAt({ "refs/heads/main": P })], ["platform", repoAt({ "refs/heads/main": P })]]);
  const ns = fakeNamespace(repos);
  const server = gitServer(repos);
  const merge = (o: { head: string; base: string; branch?: string }, repo = "merge-spike") => forgeMerge(ns.binding as never, repo, o, server.fetchImpl);

  assert.deepEqual(await merge({ base: H, head: H }), { ok: false, ref: "refs/heads/main", from: H, to: H, reason: "nothing_to_merge" });
  assert.equal((await merge({ base: C0, head: H })).reason, "base_not_current", "the base must be the branch's head");
  assert.equal((await merge({ base: P, head: SIDE })).reason, "not_fast_forward", "a head that does not contain main is refused: update the branch first");
  assert.equal((await merge({ base: P, head: H, branch: "a..b" })).reason, "invalid_branch");
  assert.equal((await merge({ base: P, head: ZERO_SHA })).reason, "invalid_sha");
  assert.equal((await merge({ base: P, head: H }, "platform")).reason, "canonical_not_enabled", "G3b waits for the cut-over");
  assert.equal(server.seen.length, 0, "no refusal touches the network");
  assert.equal(ns.calls.tokens.length, 0, "no refusal mints a token");
  assert.ok(!ns.calls.gets.includes("platform"));

  const ok = await merge({ base: P, head: H });
  assert.deepEqual(ok, { ok: true, ref: "refs/heads/main", from: P, to: H });
  assert.deepEqual(ns.calls.tokens, [{ repo: "merge-spike", scope: "write", ttl: MERGE_TOKEN_TTL_S }]);
  assert.equal(MERGE_TOKEN_TTL_S, 120);
  assert.equal(repos.get("merge-spike")!.refs.get("refs/heads/main"), H);
  assert.equal(repos.get("platform")!.refs.get("refs/heads/main"), P);
  assert.ok(server.seen.every((s) => s.url.startsWith(remoteOf("merge-spike") + "/")));
  assert.equal(ns.calls.disposals, ns.calls.gets.length, "every repo handle is disposed");

  // The server acknowledges but the branch did not move: not a success.
  const liar = gitServer(new Map([["merge-spike", repoAt({ "refs/heads/main": P })]]), { reply: (ref) => ["unpack ok\n", `ok ${ref}\n`] });
  const liarRepos = new Map([["merge-spike", repoAt({ "refs/heads/main": P })]]);
  const r = await forgeMerge(fakeNamespace(liarRepos).binding as never, "merge-spike", { base: P, head: H }, liar.fetchImpl);
  assert.equal(r.reason, "verify_mismatch");
});

// ---------------------------------------------------------------- the spike route

const spikeEnv = (ns: any) => baseEnv("cryptophys-forge", migratedDb(), { ARTIFACTS: ns.binding, APPROVER_IDENTITIES: APPROVER_EMAIL });

async function withFetch<T>(fetchImpl: Fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((i: RequestInfo | URL, init?: RequestInit) => fetchImpl(String(i), init)) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("G3a-9. the spike is approver-only and needs SPIKE", async () => {
  const repos = new Map([["platform", repoAt({ "refs/heads/main": H })]]);
  const ns = fakeNamespace(repos);
  const server = gitServer(repos);
  const e = spikeEnv(ns);
  await withFetch(server.fetchImpl, async () => {
    for (const jwt of [OPERATOR_JWT, OUTSIDER_JWT, CI_JWT]) assert.equal((await call(forge, e, req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, jwt))).status, 403);
    assert.equal((await call(forge, e, req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, null))).status, 403, "no Access JWT");
    assert.equal((await call(forge, e, req("POST", "/v1/forge/merge-spike", { confirm: "yes" }, APPROVER_JWT))).status, 400);
    assert.equal((await call(forge, e, req("GET", "/v1/forge/merge-spike", undefined, APPROVER_JWT))).status, 405);
    const unset = baseEnv("cryptophys-forge", migratedDb(), { ARTIFACTS: ns.binding });
    assert.equal((await call(forge, unset, req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, APPROVER_JWT))).status, 503, "no approvers configured fails closed");
  });
  assert.deepEqual(ns.calls.forks, []);
  assert.deepEqual(server.seen, []);
  assert.equal((e.DB.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.merge_spike'").get() as any).n, 0);
});

test("G3a-10. the spike forks platform once, then create, fast-forward, delete on merge-spike only; audited without the token", async () => {
  const repos = new Map([["platform", repoAt({ "refs/heads/main": H })]]);
  const ns = fakeNamespace(repos);
  const server = gitServer(repos);
  const e = spikeEnv(ns);
  const r = await withFetch(server.fetchImpl, () => call(forge, e, req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, APPROVER_JWT)));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, "succeeded");
  assert.deepEqual([r.body.repo, r.body.main, r.body.parent], ["merge-spike", H, P]);
  assert.deepEqual(r.body.steps.map((s: any) => [s.step, s.ok]), [
    ["fork", true], ["create", true], ["verify_create", true], ["fast_forward", true], ["verify_fast_forward", true], ["delete", true], ["verify_delete", true], ["main_unchanged", true],
  ]);
  assert.deepEqual(r.body.steps.find((s: any) => s.step === "fast_forward"), { step: "fast_forward", ok: true, ref: "refs/heads/spike", from: P, to: H });
  assert.deepEqual(ns.calls.forks, [{ from: "platform", target: "merge-spike", opts: { description: "ADR-0012 G3a merge spike (scratch; safe to delete)", defaultBranchOnly: true, readOnly: false } }]);
  assert.ok(ns.calls.tokens.every((t: any) => t.repo === "merge-spike" && t.scope === "write" && t.ttl === 120), "write tokens only for the scratch repo");

  // Every Git request went to the scratch repo; platform's refs are as they were.
  assert.ok(server.seen.length > 0);
  for (const s of server.seen) {
    assert.ok(s.url.startsWith(remoteOf("merge-spike") + "/"), s.url);
    assert.doesNotMatch(s.url, /\/platform\.git/);
  }
  assert.deepEqual([...repos.get("platform")!.refs], [["refs/heads/main", H]]);
  assert.deepEqual([...repos.get("merge-spike")!.refs], [["refs/heads/main", H]], "the spike branch is gone and main did not move");

  const audit = e.DB.raw.prepare("SELECT outcome, actor, payload_json FROM audit_events WHERE event_type = 'forge.merge_spike'").all() as any[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "succeeded");
  assert.equal(audit[0].actor, APPROVER_EMAIL);
  assert.equal(JSON.parse(audit[0].payload_json).steps.length, 8);
  for (const blob of [audit[0].payload_json, JSON.stringify(r.body)]) assert.doesNotMatch(blob, /SECRET|art_v1|expires=/, "the token is never audited or returned");

  // A second run reuses the scratch repo: no second fork.
  const again = await withFetch(server.fetchImpl, () => call(forge, e, req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, APPROVER_JWT)));
  assert.equal(again.body.outcome, "succeeded");
  assert.equal(again.body.steps[0].step, "create");
  assert.equal(ns.calls.forks.length, 1);
});

test("G3a-11. a leftover spike branch is cleaned up first; a fork still in progress answers 202; no fork is a failure", async () => {
  const repos = new Map([["platform", repoAt({ "refs/heads/main": H })], ["merge-spike", repoAt({ "refs/heads/main": H, "refs/heads/spike": SIDE })]]);
  const ns = fakeNamespace(repos);
  const server = gitServer(repos);
  const r = await withFetch(server.fetchImpl, () => call(forge, spikeEnv(ns), req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, APPROVER_JWT)));
  assert.equal(r.body.outcome, "succeeded");
  assert.deepEqual(r.body.steps[0], { step: "cleanup", ok: true, ref: "refs/heads/spike", from: SIDE, to: ZERO_SHA });
  assert.equal(repos.get("merge-spike")!.refs.has("refs/heads/spike"), false);

  const forkingRepos = new Map([["platform", repoAt({ "refs/heads/main": H })]]);
  const forking = fakeNamespace(forkingRepos, { forkStatus: "forking" });
  const f = await withFetch(gitServer(forkingRepos).fetchImpl, () => call(forge, spikeEnv(forking), req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, APPROVER_JWT)));
  assert.equal(f.status, 202);
  assert.equal(f.body.outcome, "forking");

  const noForkRepos = new Map([["platform", repoAt({ "refs/heads/main": H })]]);
  const noFork = fakeNamespace(noForkRepos, { noFork: true });
  const nf = gitServer(noForkRepos);
  const n = await withFetch(nf.fetchImpl, () => call(forge, spikeEnv(noFork), req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, APPROVER_JWT)));
  assert.equal(n.status, 502);
  assert.deepEqual(n.body.steps, [{ step: "fork", ok: false, reason: "fork_unavailable" }]);
  assert.deepEqual(nf.seen, [], "without the scratch repo nothing is pushed anywhere");
});

test("G3a-12. a refused fast-forward still removes the spike branch and reports failure", async () => {
  const repos = new Map([["platform", repoAt({ "refs/heads/main": H })], ["merge-spike", repoAt({ "refs/heads/main": H })]]);
  const ns = fakeNamespace(repos);
  let posts = 0;
  // The second update (the fast-forward) is refused by the server; create and delete are applied.
  const server = gitServer(repos, { reply: () => (++posts === 2 ? ["unpack ok\n", "ng refs/heads/spike hook declined\n"] : null) });
  const r = await withFetch(server.fetchImpl, () => call(forge, spikeEnv(ns), req("POST", "/v1/forge/merge-spike", { confirm: "SPIKE" }, APPROVER_JWT)));
  assert.equal(r.status, 502);
  assert.equal(r.body.outcome, "failed");
  assert.deepEqual(r.body.steps.find((s: any) => s.step === "fast_forward"), { step: "fast_forward", ok: false, ref: "refs/heads/spike", from: P, to: H, reason: "rejected:hook declined" });
  assert.deepEqual(r.body.steps.find((s: any) => s.step === "delete"), { step: "delete", ok: true, ref: "refs/heads/spike", from: P, to: ZERO_SHA });
  assert.equal(repos.get("merge-spike")!.refs.has("refs/heads/spike"), false);
});
