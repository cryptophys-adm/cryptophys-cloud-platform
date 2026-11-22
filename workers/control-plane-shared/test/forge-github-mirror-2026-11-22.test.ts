// Owner 2026-11-22 ("opsi a", then "sinkron otomatis"): the Forge keeps GitHub's main equal to canonical main, by
// fast-forward only, with the owner's fine-grained token (Forge secret GITHUB_MIRROR_TOKEN). These tests cover what the
// Forge decides and sends; the first real push is verified on the account (audit forge.github_mirror_pushed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { FLUSH, pktLine } from "../../forge/src/merge.ts";
import { GITHUB_MIRROR_REMOTE, MIRROR_FAILURE_REAUDIT_MS, githubFetch, githubMirrorTick } from "../../forge/src/github-mirror.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const MAIN = "1".repeat(40);
const PARENT = "2".repeat(40);
const MIRROR = "3".repeat(40);
const OTHER = "4".repeat(40);
const TOKEN = "github_pat_TESTONLY_not_a_real_token";
const NOW = Date.parse("2026-11-22T02:04:00.000Z");
const ARTIFACTS_REMOTE = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/cryptophys/platform.git`;

function advertisement(service: string, mainSha: string): Response {
  const parts = [pktLine(`# service=${service}\n`), FLUSH, pktLine(`${mainSha} refs/heads/main\0report-status delete-refs side-band-64k ofs-delta\n`), FLUSH];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.length; }
  return new Response(body, { status: 200, headers: { "content-type": `application/x-${service}-advertisement` } });
}

/** Canonical main is MAIN with parent PARENT; MIRROR is PARENT's parent (an ancestor) unless `diverged`. */
function artifacts(opts: { diverged?: boolean } = {}) {
  const commits: Record<string, string[]> = { [MAIN]: [PARENT], [PARENT]: opts.diverged ? [] : [MIRROR], [MIRROR]: [] };
  const repo = {
    info: async () => ({ remote: ARTIFACTS_REMOTE }),
    log: async () => [{ hash: MAIN }],
    readCommit: async (sha: string) => (sha in commits ? { hash: sha, parents: commits[sha] } : null),
    createToken: async () => ({ plaintext: "artifacts-read-token?expires=1", expiresAt: 0 }),
  };
  return { get: async () => repo } as never;
}

interface Call { url: string; method: string; auth: string | undefined; redirect: string | undefined }
function server(githubMain: string, artifactsStatus = 503) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", auth: headers.authorization, redirect: init?.redirect });
    if (url.startsWith(`${GITHUB_MIRROR_REMOTE}/info/refs?service=git-receive-pack`)) return advertisement("git-receive-pack", githubMain);
    if (url.startsWith(ARTIFACTS_REMOTE)) return new Response("unavailable", { status: artifactsStatus });
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetchImpl: fetchImpl as never };
}
const audits = async (db: ReturnType<typeof migratedDb>) =>
  ((await db.prepare("SELECT event_type, outcome, payload_json FROM audit_events WHERE event_type LIKE 'forge.github_mirror_%' ORDER BY rowid").all()).results ?? []) as Array<{ event_type: string; outcome: string; payload_json: string }>;

test("GM1. without the token (or without Artifacts) the mirror step does nothing at all", async () => {
  const db = migratedDb();
  const s = server(MAIN);
  assert.deepEqual(await githubMirrorTick({ DB: db as never, ARTIFACTS: artifacts() }, NOW, s.fetchImpl), { outcome: "not_configured" });
  assert.deepEqual(await githubMirrorTick({ DB: db as never, GITHUB_MIRROR_TOKEN: TOKEN }, NOW, s.fetchImpl), { outcome: "not_configured" });
  assert.equal(s.calls.length, 0);
  assert.equal((await audits(db)).length, 0);
});

test("GM2. the token goes only to github.com, as Basic x-access-token credentials, never following a redirect", async () => {
  const seen: Array<{ url: string; auth: string; redirect: string | undefined }> = [];
  const gh = githubFetch((async (u: string, init?: RequestInit) => { seen.push({ url: u, auth: (init?.headers as Record<string, string>).authorization, redirect: init?.redirect }); return new Response("ok"); }) as never, TOKEN);
  await gh(`${GITHUB_MIRROR_REMOTE}/info/refs?service=git-receive-pack`, { headers: { authorization: "Bearer github" }, redirect: "follow" });
  assert.equal(seen[0].auth, `Basic ${btoa(`x-access-token:${TOKEN}`)}`);
  assert.equal(seen[0].redirect, "manual");
  await assert.rejects(gh(`${ARTIFACTS_REMOTE}/info/refs`, {}), /github_fetch_host_refused/);
  await assert.rejects(gh("http://github.com/x", {}), /github_fetch_host_refused/);
  await assert.rejects(gh("https://github.com.evil.example/x", {}), /github_fetch_host_refused/);
  assert.equal(seen.length, 1);
});

test("GM3. GitHub's main equal to canonical main: one ref discovery, no push, no audit", async () => {
  const db = migratedDb();
  const s = server(MAIN);
  const r = await githubMirrorTick({ DB: db as never, ARTIFACTS: artifacts(), GITHUB_MIRROR_TOKEN: TOKEN }, NOW, s.fetchImpl);
  assert.equal(r.outcome, "unchanged");
  assert.deepEqual(s.calls.map((c) => [c.method, c.url.split("?")[0].replace(GITHUB_MIRROR_REMOTE, "github")]), [["GET", "github/info/refs"]]);
  assert.equal((await audits(db)).length, 0);
});

test("GM4. GitHub's main not an ancestor of canonical main: never pushed (no force), audited once per pair", async () => {
  const db = migratedDb();
  const s = server(OTHER);
  const env = { DB: db as never, ARTIFACTS: artifacts({ diverged: true }), GITHUB_MIRROR_TOKEN: TOKEN };
  const r = await githubMirrorTick(env, NOW, s.fetchImpl);
  assert.deepEqual([r.outcome, r.from, r.to, r.reason], ["diverged", OTHER, MAIN, "mirror_not_ancestor_of_main"]);
  await githubMirrorTick(env, NOW + 15 * 60_000, s.fetchImpl);
  await githubMirrorTick(env, NOW + MIRROR_FAILURE_REAUDIT_MS * 4, s.fetchImpl);
  assert.equal(s.calls.filter((c) => c.method === "POST").length, 0, "nothing is sent to receive-pack");
  const a = await audits(db);
  assert.deepEqual(a.map((x) => [x.event_type, x.outcome]), [["forge.github_mirror_diverged", "diverged"]]);
});

test("GM5. a fast-forward that cannot fetch its pack fails safely: no push, audited once per reason per 6 hours, no token anywhere", async () => {
  const db = migratedDb();
  const s = server(MIRROR, 503);
  const env = { DB: db as never, ARTIFACTS: artifacts(), GITHUB_MIRROR_TOKEN: TOKEN };
  const r = await githubMirrorTick(env, NOW, s.fetchImpl);
  assert.deepEqual([r.outcome, r.from, r.to], ["failed", MIRROR, MAIN]);
  assert.match(r.reason!, /^pack_discovery_failed:discovery_http_503$/);
  await githubMirrorTick(env, NOW + 15 * 60_000, s.fetchImpl);
  await githubMirrorTick(env, NOW + MIRROR_FAILURE_REAUDIT_MS + 60_000, s.fetchImpl);
  assert.equal((await audits(db)).length, 2, "the same failure is audited again only after 6 hours");
  assert.equal(s.calls.filter((c) => c.method === "POST" && c.url.startsWith(GITHUB_MIRROR_REMOTE)).length, 0, "no push without a pack");
  // The GitHub token never goes to Artifacts, and Artifacts' token never goes to GitHub.
  for (const c of s.calls) {
    if (c.url.startsWith(GITHUB_MIRROR_REMOTE)) assert.equal(c.auth, `Basic ${btoa(`x-access-token:${TOKEN}`)}`);
    else assert.equal(c.auth, "Bearer artifacts-read-token");
  }
  for (const a of await audits(db)) assert.ok(!a.payload_json.includes(TOKEN) && !a.payload_json.includes("artifacts-read-token"), "no token in the audit");
});

test("GM6. wired into the Forge tick behind the token; only refs/heads/main is ever written, by fast-forward", () => {
  const tick = read("workers/forge/src/tick.ts");
  assert.match(tick, /if \(env\.ARTIFACTS && env\.GITHUB_MIRROR_TOKEN\) await step\("github_mirror", \(\) => githubMirrorTick\(env as never, nowMs\(\)\)\);/);
  const src = read("workers/forge/src/github-mirror.ts");
  assert.equal([...src.matchAll(/fastForward\(/g)].length, 1);
  assert.match(src, /fastForward\(\{ remote: GITHUB_MIRROR_REMOTE, token: "github", branch: "main", from: mirror, to: main,/);
  assert.doesNotMatch(src, /\+refs\/|force:\s*true|to: ZERO_SHA/, "no forced or deleting ref update");
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*TOKEN/, "the token is never logged");
  assert.match(read("docs/SSOT.md"), /GitHub mirror sync/);
});

test("GM7. a failed discovery (no `from`) is audited once per 6 hours too, not at every tick (22 Nov 04:37Z and 04:49Z)", async () => {
  const db = migratedDb();
  const refused = (async () => new Response("forbidden", { status: 403 })) as never;
  const env = { DB: db as never, ARTIFACTS: artifacts(), GITHUB_MIRROR_TOKEN: TOKEN };
  const r = await githubMirrorTick(env, NOW, refused);
  assert.deepEqual([r.outcome, r.from, r.reason], ["failed", undefined, "mirror_discovery_http_403"]);
  await githubMirrorTick(env, NOW + 15 * 60_000, refused);
  await githubMirrorTick(env, NOW + 30 * 60_000, refused);
  assert.equal((await audits(db)).length, 1);
  await githubMirrorTick(env, NOW + MIRROR_FAILURE_REAUDIT_MS + 60_000, refused);
  assert.equal((await audits(db)).length, 2);
});
