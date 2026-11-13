// ADR-0012 G4: contributors push to the work repository cryptophys/platform-work instead of opening GitHub
// pull requests. The Forge forks it once (approver route), discovers its branches over Git smart HTTP, and
// registers each as a forge-sourced change request checked from platform-work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { FORGE_MIGRATIONS } from "../../forge/src/index.ts";
import { FLUSH, ZERO_SHA, pktLine, type Fetch } from "../../forge/src/merge.ts";
import { MAX_REGISTRATIONS_PER_TICK, WORK_READ_TOKEN_TTL_S, workBranchesTick, workChangeId } from "../../forge/src/work-repo.ts";
import { forgeTick } from "../../forge/src/tick.ts";
import { changeVerdict, listChanges, nextChangeHead, registerChange, NOT_BASED_ON_MAIN, TYPECHECK_NOT_CONFIGURED } from "../../forge/src/changes.ts";
import { crBuildsTick } from "../../forge/src/cr-builds.ts";
import type { ArtifactsTreeEntry, CheckDeps } from "../../forge/src/checks.ts";

const ROOT = new URL("../../../", import.meta.url);
const HOST = "a".repeat(32) + ".artifacts.cloudflare.net";
const remoteOf = (repo: string) => `https://${HOST}/git/cryptophys/${repo}.git`;
const SECRET = "art_v1_G4READTOKENSECRET";
const TOKEN = SECRET + "?expires=1794200000";

// Commits: M0 <- M1 (canonical main). A <- M1 and B <- A (based on main). OLD <- M0 (not based on main).
const sha = (c: string) => c.repeat(40);
const M0 = sha("1"); const M1 = sha("2"); const A = sha("3"); const B = sha("4"); const OLD = sha("5"); const GH = sha("6"); const M2 = sha("7");
const BASE_FILES: Record<string, string> = {
  "README.md": "x",
  "workers/forge/src/a.ts": "export const a = 1;",
  "workers/control-plane-shared/test/x.test.ts": "assert.equal(1, 1);\nassert.ok(true);\n",
};
const COMMITS: Record<string, { parents: string[]; files: Record<string, string>; message: string }> = {
  [M0]: { parents: [], files: BASE_FILES, message: "main 0" },
  [M1]: { parents: [M0], files: { ...BASE_FILES, "README.md": "y" }, message: "main 1" },
  [M2]: { parents: [M1], files: { ...BASE_FILES, "README.md": "z" }, message: "main 2" },
  [A]: { parents: [M1], files: { ...BASE_FILES, "README.md": "y", "workers/forge/src/b.ts": "new" }, message: "forge: add b\n\nbody" },
  [B]: { parents: [A], files: { ...BASE_FILES, "README.md": "y", "workers/forge/src/b.ts": "new", "architecture/adr/0012-github-independence.md": "edit" }, message: "docs: edit ADR-0012" },
  [OLD]: { parents: [M0], files: { ...BASE_FILES, "workers/forge/src/c.ts": "old base" }, message: "old work" },
  [GH]: { parents: [M1], files: { ...BASE_FILES, "README.md": "y", "workers/forge/src/gh.ts": "gh" }, message: "gh pull request" },
};

/** Content-addressed trees and blobs for every commit; each repo sees only its own commits. */
function objectStore() {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; const roots: Record<string, string> = {};
  const hash = (s: string) => { let h = 0n; for (const ch of s) h = (h * 131n + BigInt(ch.codePointAt(0)!)) % (1n << 160n); return h.toString(16).padStart(40, "0"); };
  function build(files: Record<string, string>): string {
    const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, text] of Object.entries(files)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = hash("blob:" + text); blobs[h] = text; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = text;
    }
    for (const [dir, sub] of Object.entries(here)) entries.push({ name: dir, type: "tree", mode: "40000", hash: build(sub) });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const h = hash("tree:" + entries.map((e) => `${e.type} ${e.name} ${e.hash}`).join("\n")); trees[h] = entries; return h;
  }
  for (const [c, def] of Object.entries(COMMITS)) roots[c] = build(def.files);
  return { trees, blobs, roots };
}

interface FakeRepo { commits: Set<string>; refs: Map<string, string> }

function namespace(init: Record<string, { commits: string[]; refs: Record<string, string> }>, opts: { forkStatus?: "ready" | "forking" } = {}) {
  const store = objectStore();
  const repos = new Map<string, FakeRepo>(Object.entries(init).map(([k, v]) => [k, { commits: new Set(v.commits), refs: new Map(Object.entries(v.refs)) }]));
  const status = new Map<string, string>([...repos.keys()].map((k) => [k, "ready"]));
  const calls = { gets: [] as string[], tokens: [] as Array<{ repo: string; scope: string; ttl: number }>, forks: [] as any[], disposals: 0, commitReads: [] as Array<[string, string]> };
  const handle = (name: string): any => {
    const r = repos.get(name)!;
    return {
      info: async () => ({ name, remote: remoteOf(name), defaultBranch: "main" }),
      createToken: async (scope: string, ttl: number) => { calls.tokens.push({ repo: name, scope, ttl }); return { plaintext: TOKEN, expiresAt: "2026-11-12T10:02:00Z" }; },
      log: async (o: any) => {
        const head = r.refs.get(`refs/heads/${o?.ref ?? "main"}`);
        return head ? [{ hash: head, treeHash: store.roots[head], message: COMMITS[head].message }] : [];
      },
      readCommit: async (h: string) => {
        calls.commitReads.push([name, h]);
        return r.commits.has(h) ? { hash: h, treeHash: store.roots[h], parents: COMMITS[h].parents, message: COMMITS[h].message, author: { name: "Claude", email: "noreply@example.com" } } : null;
      },
      readTree: async (h: string) => store.trees[h] ?? null,
      readBlob: async (h: string) => (h in store.blobs ? new Blob([store.blobs[h]]) : null),
      fork: async (target: string, o: any) => {
        calls.forks.push({ from: name, target, opts: o });
        repos.set(target, { commits: new Set(r.commits), refs: new Map([["refs/heads/main", r.refs.get("refs/heads/main")!]]) });
        status.set(target, opts.forkStatus ?? "ready");
        // Artifacts may return a token with a fork: it must never reach a response or the audit chain.
        return { name: target, remote: remoteOf(target), token: TOKEN };
      },
      [Symbol.dispose]: () => { calls.disposals++; },
    };
  };
  const binding = {
    list: async () => ({ repos: [...status.entries()].map(([name, s]) => ({ name, status: s })), cursor: null }),
    get: async (name: string) => { calls.gets.push(name); if (status.get(name) !== "ready") throw new Error("NOT_READY"); return handle(name); },
    import: async () => { throw new Error("import must not be called"); },
  };
  /** A contributor's `git push`: the objects and the ref land in the repo. */
  const push = (repo: string, branch: string, head: string | null, objects: string[] = []) => {
    const r = repos.get(repo)!;
    for (const o of objects) r.commits.add(o);
    if (head) r.refs.set(`refs/heads/${branch}`, head); else r.refs.delete(`refs/heads/${branch}`);
  };
  return { binding, repos, status, calls, push };
}

/** A smart-HTTP upload-pack advertisement server for every repo of the namespace. */
function gitServer(repos: Map<string, FakeRepo>, opts: { status?: number } = {}) {
  const seen: Array<{ method: string; url: string; auth: string | null }> = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ method: init?.method ?? "GET", url, auth });
    if (opts.status) return new Response("no", { status: opts.status });
    const m = /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/cryptophys\/([a-z-]+)\.git\/info\/refs\?service=git-upload-pack$/.exec(url);
    const repo = m ? repos.get(m[1]) : undefined;
    if (!repo) return new Response("not found", { status: 404 });
    if (auth !== `Bearer ${SECRET}`) return new Response("unauthorized", { status: 401 });
    const refs = [...repo.refs.entries()];
    const caps = "multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/main agent=git/artifacts";
    const head = repo.refs.get("refs/heads/main") ?? ZERO_SHA;
    const lines = [pktLine(`${head} HEAD\0${caps}\n`), ...refs.map(([ref, s]) => pktLine(`${s} ${ref}\n`)), pktLine(`${M0} refs/tags/v1\n`)];
    return new Response(Buffer.concat([pktLine("# service=git-upload-pack\n"), FLUSH, ...lines, FLUSH]), { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
  };
  return { seen, fetchImpl };
}

const standard = () => namespace({
  platform: { commits: [M0, M1, GH], refs: { "refs/heads/main": M1, "refs/heads/cr/9": GH } },
  "platform-work": { commits: [M0, M1], refs: { "refs/heads/main": M0 } },
});
const rowsOf = (db: any) => db.raw.prepare("SELECT * FROM forge_change_requests ORDER BY cr_id").all().map((r: any) => ({ ...r }));
const auditOf = (db: any) => db.raw.prepare("SELECT event_type, actor, subject, outcome, payload_json FROM audit_events ORDER BY rowid").all().map((r: any) => ({ ...r }));

async function withFetch<T>(fetchImpl: Fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((i: RequestInfo | URL, init?: RequestInit) => (String(i).includes(".artifacts.cloudflare.net") ? fetchImpl(String(i), init) : real(i, init))) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// ---------------------------------------------------------------- the work repository route

test("G4-1. POST /v1/forge/work-repo is approver-only and needs CREATE", async () => {
  const ns = standard();
  ns.repos.delete("platform-work"); ns.status.delete("platform-work");
  const e = baseEnv("cryptophys-forge", migratedDb(), { ARTIFACTS: ns.binding, APPROVER_IDENTITIES: APPROVER_EMAIL });
  for (const jwt of [OPERATOR_JWT, OUTSIDER_JWT, CI_JWT]) assert.equal((await call(forge, e, req("POST", "/v1/forge/work-repo", { confirm: "CREATE" }, jwt))).status, 403);
  assert.equal((await call(forge, e, req("POST", "/v1/forge/work-repo", { confirm: "CREATE" }, null))).status, 403, "no Access JWT");
  assert.equal((await call(forge, e, req("POST", "/v1/forge/work-repo", { confirm: "yes" }, APPROVER_JWT))).status, 400);
  assert.equal((await call(forge, e, req("GET", "/v1/forge/work-repo", undefined, APPROVER_JWT))).status, 405);
  const unset = baseEnv("cryptophys-forge", migratedDb(), { ARTIFACTS: ns.binding });
  assert.equal((await call(forge, unset, req("POST", "/v1/forge/work-repo", { confirm: "CREATE" }, APPROVER_JWT))).status, 503, "no approvers configured fails closed");
  const noBinding = baseEnv("cryptophys-forge", migratedDb(), { APPROVER_IDENTITIES: APPROVER_EMAIL });
  assert.equal((await call(forge, noBinding, req("POST", "/v1/forge/work-repo", { confirm: "CREATE" }, APPROVER_JWT))).status, 503);
  assert.deepEqual(ns.calls.forks, []);
  assert.equal((e.DB.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.work_repo'").get() as any).n, 0);
});

test("G4-2. the route forks platform once (202 while forking, then 200), reports name and host only, audits without the token", async () => {
  const ns = standard();
  ns.repos.delete("platform-work"); ns.status.delete("platform-work");
  const slow = namespace({ platform: { commits: [M0, M1], refs: { "refs/heads/main": M1 } } }, { forkStatus: "forking" });
  for (const [space, first] of [[ns, 200], [slow, 202]] as const) {
    const e = baseEnv("cryptophys-forge", migratedDb(), { ARTIFACTS: space.binding, APPROVER_IDENTITIES: APPROVER_EMAIL });
    const r = await call(forge, e, req("POST", "/v1/forge/work-repo", { confirm: "CREATE" }, APPROVER_JWT));
    assert.equal(r.status, first, JSON.stringify(r.body));
    assert.deepEqual(space.calls.forks, [{ from: "platform", target: "platform-work", opts: { description: "ADR-0012 G4 work repository: contributor branches (cr/, claude/, agent/)", defaultBranchOnly: true, readOnly: false } }]);
    if (first === 200) assert.deepEqual(r.body, { outcome: "ready", repo: "platform-work", source: "platform", forked: true, remote_host: HOST });
    else {
      assert.deepEqual(r.body, { outcome: "forking", repo: "platform-work", source: "platform", forked: true, remote_host: null });
      space.status.set("platform-work", "ready");
    }
    // Idempotent: the next call finds the repo and does not fork again.
    const again = await call(forge, e, req("POST", "/v1/forge/work-repo", { confirm: "CREATE" }, APPROVER_JWT));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { outcome: "ready", repo: "platform-work", source: "platform", forked: false, remote_host: HOST });
    assert.equal(space.calls.forks.length, 1);
    assert.equal(space.calls.tokens.length, 0, "the route mints no token");
    const audit = auditOf(e.DB).filter((a: any) => a.event_type === "forge.work_repo");
    assert.deepEqual(audit.map((a: any) => [a.actor, a.subject, a.outcome]), [[APPROVER_EMAIL, "platform-work", first === 200 ? "ready" : "forking"], [APPROVER_EMAIL, "platform-work", "ready"]]);
    for (const blob of [JSON.stringify(r.body), JSON.stringify(again.body), ...audit.map((a: any) => a.payload_json)]) assert.doesNotMatch(blob, /SECRET|art_v1|expires=/, "the fork's token never leaves the binding call");
    assert.ok(space.calls.disposals >= space.calls.gets.length);
  }
  // A canonical repo that is not ready cannot be forked.
  const none = namespace({});
  const e = baseEnv("cryptophys-forge", migratedDb(), { ARTIFACTS: none.binding, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const r = await call(forge, e, req("POST", "/v1/forge/work-repo", { confirm: "CREATE" }, APPROVER_JWT));
  assert.equal(r.status, 502);
  assert.equal(r.body.reason, "source_not_ready");
});

// ---------------------------------------------------------------- discovery and registration

test("G4-3. discovery lists refs/heads/* of platform-work with a 120 s read token: main, tags and invalid names are skipped", async () => {
  const ns = standard();
  ns.push("platform-work", "claude/feature-x", A, [A]);
  ns.push("platform-work", "cr/41", A);
  ns.push("platform-work", "agent/pi.fix_1", A);
  ns.push("platform-work", "feature/not-ours", A);
  ns.push("platform-work", "claude/a..b", A);
  ns.push("platform-work", "claude/x.lock", A);
  ns.push("platform-work", "agent/" + "x".repeat(81), A);
  const server = gitServer(ns.repos);
  const db = migratedDb();
  const out = await workBranchesTick({ DB: db as never, ARTIFACTS: ns.binding as never }, Date.now(), server.fetchImpl);
  assert.deepEqual(out, {
    outcome: "discovered", main: M1, branches: 3, ignored: 4, registered: ["fg-agent-pi.fix_1", "fg-claude-feature-x", "fg-cr-41"],
    blocked: 0, deferred: 0, closed: [], collisions: [], unreadable: [],
  });
  assert.deepEqual(ns.calls.tokens, [{ repo: "platform-work", scope: "read", ttl: WORK_READ_TOKEN_TTL_S }]);
  assert.equal(WORK_READ_TOKEN_TTL_S, 120);
  assert.deepEqual(server.seen, [{ method: "GET", url: remoteOf("platform-work") + "/info/refs?service=git-upload-pack", auth: `Bearer ${SECRET}` }], "the secret part only, in the header");
  const rows = rowsOf(db);
  assert.deepEqual(rows.map((r: any) => [r.cr_id, r.source, r.number, r.branch, r.source_branch, r.repo, r.head_sha, r.base_sha, r.github_ci, r.status, r.blocked_reason]), [
    ["fg-agent-pi.fix_1", "forge", 0, "agent/pi.fix_1", "agent/pi.fix_1", "platform-work", A, M1, null, "open", null],
    ["fg-claude-feature-x", "forge", 0, "claude/feature-x", "claude/feature-x", "platform-work", A, M1, null, "open", null],
    ["fg-cr-41", "forge", 0, "cr/41", "cr/41", "platform-work", A, M1, null, "open", null],
  ]);
  assert.deepEqual([rows[0].title, rows[0].author], ["forge: add b", "Claude"], "title from the commit subject; author name only, no e-mail");
  assert.deepEqual(JSON.parse(rows[0].changed_paths), ["A workers/forge/src/b.ts"]);
  assert.deepEqual(JSON.parse(rows[0].critical), []);
  assert.equal(workChangeId("claude/a/b"), "fg-claude-a-b");
  // Unchanged branches are not registered again.
  const again = await workBranchesTick({ DB: db as never, ARTIFACTS: ns.binding as never }, Date.now(), server.fetchImpl);
  assert.deepEqual([again.registered, again.closed], [[], []]);
  assert.equal(auditOf(db).filter((a: any) => a.event_type === "forge.change_registered").length, 3);
});

test("G4-3b. the tick calls ARTIFACTS.list as a method of the binding, never through Function.prototype.bind (an RPC stub has no local bind)", async () => {
  const ns = standard();
  ns.push("platform-work", "claude/feature-x", A, [A]);
  const realList = (ns.binding as any).list;
  // A Workers RPC stub turns any property access, `bind` included, into a remote method name.
  const list = function (this: unknown, opts?: unknown) { assert.equal(this, stub, "called with the binding as receiver"); return realList.call(ns.binding, opts); };
  Object.defineProperty(list, "bind", { get() { throw new Error('The RPC receiver does not implement the method "bind".'); } });
  const stub = { get: (n: string) => (ns.binding as any).get(n), list };
  const out = await workBranchesTick({ DB: migratedDb() as never, ARTIFACTS: stub as never }, Date.now(), gitServer(ns.repos).fetchImpl);
  assert.deepEqual([out.outcome, out.registered], ["discovered", ["fg-claude-feature-x"]]);
});

test("G4-4. base = canonical main when it is an ancestor of the head; otherwise blocked not_based_on_main (and never checked)", async () => {
  const ns = standard();
  ns.push("platform-work", "claude/based", B, [A, B]);
  ns.push("platform-work", "claude/stale", OLD, [OLD]);
  const server = gitServer(ns.repos);
  const db = migratedDb();
  const out = await workBranchesTick({ DB: db as never, ARTIFACTS: ns.binding as never }, Date.now(), server.fetchImpl);
  assert.deepEqual([out.registered, out.blocked], [["fg-claude-based", "fg-claude-stale"], 1]);
  const [based, stale] = rowsOf(db);
  assert.deepEqual([based.base_sha, based.blocked_reason], [M1, null]);
  assert.deepEqual(JSON.parse(based.changed_paths), ["A architecture/adr/0012-github-independence.md", "A workers/forge/src/b.ts"]);
  assert.deepEqual(JSON.parse(based.critical), ["adr_0009_0012: architecture/adr/0012-github-independence.md"], "owner-only reasons from the same code as GitHub-sourced requests");
  assert.deepEqual([stale.base_sha, stale.blocked_reason, stale.changed_paths, stale.critical], [M1, "not_based_on_main", null, null]);
  assert.ok(ns.calls.commitReads.every(([repo]) => repo === "platform-work" || repo === "platform") && ns.calls.commitReads.some(([repo, h]) => repo === "platform-work" && h === M1), "ancestry is read through platform-work");
  const listed = (await listChanges(db as never, 10)).changes;
  const s = listed.find((c: any) => c.cr_id === "fg-claude-stale")!;
  assert.deepEqual([s.source, s.repo, s.verdict, s.reasons], ["forge", "platform-work", "blocked", [NOT_BASED_ON_MAIN]]);
  assert.deepEqual(changeVerdict({ blocked_reason: "not_based_on_main" }, null, null), { verdict: "blocked", reasons: [NOT_BASED_ON_MAIN] });
  const work = await ns.binding.get("platform-work");
  assert.equal(await nextChangeHead(db as never, work as never, Date.now(), "platform-work"), B, "the blocked head is skipped");
  assert.equal(await nextChangeHead(db as never, work as never, Date.now(), "platform"), null, "forge-sourced heads are never read from platform");

  // The contributor merges main into the stale branch and pushes: it is re-registered, no longer blocked.
  const MERGED = sha("8");
  COMMITS[MERGED] = { parents: [OLD, M1], files: { ...BASE_FILES, "README.md": "y", "workers/forge/src/c.ts": "old base" }, message: "merge main" };
  try {
    const ns2 = namespace({ platform: { commits: [M0, M1], refs: { "refs/heads/main": M1 } }, "platform-work": { commits: [M0, M1, OLD, MERGED], refs: { "refs/heads/main": M0, "refs/heads/claude/stale": MERGED } } });
    await workBranchesTick({ DB: db as never, ARTIFACTS: ns2.binding as never }, Date.now(), gitServer(ns2.repos).fetchImpl);
    const after = rowsOf(db).find((r: any) => r.cr_id === "fg-claude-stale");
    assert.deepEqual([after.head_sha, after.base_sha, after.blocked_reason, JSON.parse(after.changed_paths)], [MERGED, M1, null, ["A workers/forge/src/c.ts"]]);
    // fg-claude-based vanished from ns2: it is closed with its verdict frozen.
    assert.equal(rowsOf(db).find((r: any) => r.cr_id === "fg-claude-based").status, "closed");
  } finally { delete COMMITS[MERGED]; }
});

test("G4-5. main moving re-evaluates open requests; a branch whose main is not in platform-work is not based on main", async () => {
  const ns = standard();
  ns.push("platform-work", "claude/based", A, [A]);
  const server = gitServer(ns.repos);
  const db = migratedDb();
  await workBranchesTick({ DB: db as never, ARTIFACTS: ns.binding as never }, Date.now(), server.fetchImpl);
  assert.equal(rowsOf(db)[0].blocked_reason, null);
  // Canonical main moves to M2, which nobody pushed to platform-work: the branch must be updated first.
  ns.repos.get("platform")!.commits.add(M2);
  ns.repos.get("platform")!.refs.set("refs/heads/main", M2);
  const out = await workBranchesTick({ DB: db as never, ARTIFACTS: ns.binding as never }, Date.now(), server.fetchImpl);
  assert.deepEqual([out.main, out.registered, out.blocked], [M2, ["fg-claude-based"], 1]);
  assert.deepEqual([rowsOf(db)[0].base_sha, rowsOf(db)[0].blocked_reason], [M2, "not_based_on_main"]);
  const audit = auditOf(db).filter((a: any) => a.event_type === "forge.change_registered");
  assert.deepEqual(audit.map((a: any) => [a.actor, a.outcome]), [["system:forge-work", "opened"], ["system:forge-work", "base_changed"]]);
});

test("G4-6. a vanished branch closes its request (verdict frozen); a returning one reopens; failed discovery closes nothing", async () => {
  const ns = standard();
  ns.push("platform-work", "claude/one", A, [A]);
  ns.push("platform-work", "claude/two", A);
  const server = gitServer(ns.repos);
  const db = migratedDb();
  const env = { DB: db as never, ARTIFACTS: ns.binding as never };
  await workBranchesTick(env, Date.now(), server.fetchImpl);
  ns.push("platform-work", "claude/two", null);
  // Discovery that fails throws (the tick audits it) and changes nothing.
  await assert.rejects(workBranchesTick(env, Date.now(), gitServer(ns.repos, { status: 401 }).fetchImpl), /work_discovery_failed:discovery_http_401/);
  await assert.rejects(workBranchesTick(env, Date.now(), async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })), /work_discovery_failed:discovery_not_smart_http/);
  assert.deepEqual(rowsOf(db).map((r: any) => r.status), ["open", "open"]);
  const out = await workBranchesTick(env, Date.now(), server.fetchImpl);
  assert.deepEqual(out.closed, ["fg-claude-two"]);
  const two = rowsOf(db).find((r: any) => r.cr_id === "fg-claude-two");
  assert.deepEqual([two.status, two.verdict_at_outcome, two.agrees, two.merge_sha], ["closed", "pending", null, null]);
  const outcome = auditOf(db).find((a: any) => a.event_type === "forge.change_outcome");
  assert.deepEqual([outcome.subject, outcome.outcome, JSON.parse(outcome.payload_json).reason], ["fg-claude-two", "closed", "branch_deleted"]);
  assert.equal((await listChanges(db as never, 10)).parity.compared, 0, "a closed forge request never counts towards merge parity");
  ns.push("platform-work", "claude/two", A);
  const back = await workBranchesTick(env, Date.now(), server.fetchImpl);
  assert.deepEqual(back.registered, ["fg-claude-two"]);
  assert.deepEqual(rowsOf(db).map((r: any) => r.status), ["open", "open"]);
});

test("G4-7. bounded per tick, slug collisions keep the first owner, unreadable heads wait, untrusted remotes are refused", async () => {
  const ns = standard();
  ns.push("platform-work", "claude/a/b", A, [A]);
  ns.push("platform-work", "claude/a-b", A);
  for (let i = 0; i < MAX_REGISTRATIONS_PER_TICK + 2; i++) ns.push("platform-work", `agent/n${i}`, A);
  ns.push("platform-work", "cr/unpushed", sha("9"));
  const server = gitServer(ns.repos);
  const db = migratedDb();
  const env = { DB: db as never, ARTIFACTS: ns.binding as never };
  const first = await workBranchesTick(env, Date.now(), server.fetchImpl);
  assert.equal((first.registered as string[]).length, MAX_REGISTRATIONS_PER_TICK);
  assert.ok((first.deferred as number) > 0);
  let out = first;
  for (let i = 0; i < 4 && ((out.deferred as number) > 0 || out === first); i++) out = await workBranchesTick(env, Date.now(), server.fetchImpl);
  assert.equal(out.deferred, 0);
  assert.deepEqual(out.collisions, ["claude/a/b"], "claude/a-b sorts first and owns fg-claude-a-b");
  assert.deepEqual(out.unreadable, ["cr/unpushed"]);
  assert.equal(rowsOf(db).find((r: any) => r.cr_id === "fg-claude-a-b").branch, "claude/a-b");
  assert.equal(rowsOf(db).length, MAX_REGISTRATIONS_PER_TICK + 2 + 1);

  // A work repo whose remote is not this account's Artifacts host for platform-work is refused before any token.
  const bad = standard();
  const get = bad.binding.get;
  bad.binding.get = async (name: string) => { const h = await get(name); if (name === "platform-work") h.info = async () => ({ remote: remoteOf("platform") }); return h; };
  await assert.rejects(workBranchesTick({ DB: migratedDb() as never, ARTIFACTS: bad.binding as never }, Date.now(), server.fetchImpl), /untrusted_work_remote/);
  assert.deepEqual(bad.calls.tokens, []);
  // No work repo yet, or no listing on the binding: nothing to do, nothing fails.
  const none = namespace({ platform: { commits: [M0, M1], refs: { "refs/heads/main": M1 } } });
  assert.deepEqual(await workBranchesTick({ DB: migratedDb() as never, ARTIFACTS: none.binding as never }, Date.now(), server.fetchImpl), { outcome: "no_work_repo", status: "missing" });
  assert.deepEqual(await workBranchesTick({ DB: migratedDb() as never, ARTIFACTS: { get: none.binding.get } as never }), { outcome: "not_configured" });
});

// ---------------------------------------------------------------- checks read the right repository

const deps = async (): Promise<CheckDeps> => ({
  esbuild: { async build() { return { outputFiles: [{ text: "x", contents: new Uint8Array() }], errors: [], warnings: [] }; } },
  shims: {} as never, sqlJs: "", sqlWasm: null,
  async runWorker(code) { return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: "pass" }] })) }; },
  typecheck: async () => ({ status: "pending" }),
});

test("G4-8. checks read forge-sourced heads from platform-work and GitHub ones from platform; the forge type-check is not_configured", async () => {
  const ns = standard();
  ns.push("platform-work", "claude/feature", A, [A]);
  const server = gitServer(ns.repos);
  const db = migratedDb();
  // A GitHub-sourced request, as forge-change-request.yml registers it (head on cr/9 of platform).
  const platform = await ns.binding.get("platform");
  await registerChange(db as never, platform as never, { number: 9, source_branch: "claude/gh", title: "gh", author: "cryptophys-adm", head_sha: GH, base_sha: M1, github_ci: "success" }, CI_CLIENT_ID);
  ns.calls.gets.length = 0; ns.calls.commitReads.length = 0;

  const tick = () => withFetch(server.fetchImpl, () => forgeTick({ DB: db as never, ARTIFACTS: ns.binding as never }, "platform", deps));
  const t1 = await tick();
  assert.deepEqual((t1.work_branches as any).registered, ["fg-claude-feature"]);
  assert.deepEqual([(t1.change_checks as any).outcome, (t1.change_checks as any).commit, (t1.change_checks as any).repo], ["checked", GH, undefined], "GitHub-sourced heads first, from platform");
  assert.ok(ns.calls.commitReads.some(([repo, h]) => repo === "platform" && h === GH));
  assert.ok(!ns.calls.commitReads.some(([repo, h]) => repo === "platform-work" && h === GH), "a GitHub head is never read from platform-work");

  ns.calls.commitReads.length = 0;
  const t2 = await tick();
  assert.deepEqual([(t2.change_checks as any).outcome, (t2.change_checks as any).commit, (t2.change_checks as any).repo], ["checked", A, "platform-work"]);
  assert.ok(ns.calls.commitReads.some(([repo, h]) => repo === "platform-work" && h === A));
  assert.ok(!ns.calls.commitReads.some(([repo, h]) => repo === "platform" && h === A), "a forge head is never read from platform");
  const steps = (id: string) => JSON.parse((db.raw.prepare("SELECT steps FROM forge_check_runs WHERE commit_sha = ?").get(id) as any).steps);
  assert.equal(steps(A).typecheck.status, "not_configured");
  assert.equal(steps(GH).typecheck.status, "pending", "GitHub-sourced behaviour unchanged");
  const listed = (await listChanges(db as never, 10)).changes;
  const fg = listed.find((c: any) => c.cr_id === "fg-claude-feature")!;
  const gh = listed.find((c: any) => c.cr_id === "gh-9")!;
  assert.deepEqual([fg.source, fg.repo, fg.check?.status, fg.verdict, fg.reasons], ["forge", "platform-work", "passed", "pending", [TYPECHECK_NOT_CONFIGURED]], "cannot reach would_merge without a type-check source");
  assert.deepEqual([gh.source, gh.repo, gh.verdict, gh.reasons], ["github", "platform", "pending", ["the type-check of this head has not reported"]]);
  const t3 = await tick();
  assert.equal((t3.change_checks as any).outcome, "up_to_date");

  // The secret-free change-request type-check reader looks up GitHub-sourced requests only.
  // With gh-9 closed, only the forge-sourced request is open: there is nothing to look up, and no API call.
  db.raw.prepare("UPDATE forge_change_requests SET status = 'closed' WHERE cr_id = 'gh-9'").run();
  const urls: string[] = [];
  const builds = await crBuildsTick({ DB: db as never, CF_BUILDS_API_TOKEN: "test-token" }, Date.now(), (async (u: string) => { urls.push(u); return Response.json({ success: true, result: [] }); }) as never);
  assert.deepEqual([builds.outcome, urls], ["up_to_date", []], "fg-claude-feature has no cr/<n> build to read");

  // The token never reaches the audit chain or a tick result.
  for (const blob of [...auditOf(db).map((a: any) => a.payload_json), JSON.stringify(t1), JSON.stringify(t2)]) assert.doesNotMatch(blob, /SECRET|art_v1|expires=/);
});

test("G4-9. migration 0052: source admits forge with repo platform-work only; existing rows keep repo platform; the Forge requires it", () => {
  assert.ok((FORGE_MIGRATIONS as readonly string[]).includes("0052_forge_work_change_requests.sql"));
  const db = migratedDb();
  const ins = (id: string, source: string, repo: string, ci: string | null, blocked: string | null) => () => db.raw.prepare(
    `INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, created_at, updated_at, repo, blocked_reason)
     VALUES (?, ?, 0, 'b', 'b', 't', 'a', ?, ?, ?, 'open', 'n', 'n', ?, ?)`).run(id, source, A, M1, ci, repo, blocked);
  ins("fg-ok", "forge", "platform-work", null, "not_based_on_main")();
  assert.throws(ins("fg-x", "forge", "platform", null, null), /CHECK/, "a forge request is read from platform-work");
  assert.throws(ins("fg-y", "forge", "platform-work", "success", null), /CHECK/, "no GitHub CI for a forge request");
  assert.throws(ins("gh-1", "github", "platform-work", null, null), /CHECK/, "a GitHub request is read from platform");
  assert.throws(ins("gh-2", "github", "platform", null, "not_based_on_main"), /CHECK/);
  assert.throws(ins("x-1", "gitlab", "platform", null, null), /CHECK/);
  db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, status, created_at, updated_at)
    VALUES ('gh-3', 'github', 3, 'cr/3', 'b', 't', 'a', ?, ?, 'open', 'n', 'n')`).run(A, M1);
  assert.deepEqual({ ...(db.raw.prepare("SELECT repo, blocked_reason FROM forge_change_requests WHERE cr_id = 'gh-3'").get() as any) }, { repo: "platform", blocked_reason: null });
  const sql = readFileSync(new URL("workers/control-plane-migrations/0052_forge_work_change_requests.sql", ROOT), "utf8");
  assert.match(sql, /INSERT INTO forge_change_requests_new[\s\S]+SELECT[\s\S]+FROM forge_change_requests;/, "every existing row is copied");
  assert.match(read("workers/forge/src/tick.ts"), /step\("work_branches"/);
});

function read(p: string) { return readFileSync(new URL(p, ROOT), "utf8"); }
