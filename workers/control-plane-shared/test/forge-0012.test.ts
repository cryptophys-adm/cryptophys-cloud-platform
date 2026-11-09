// ADR-0012 phase 1: the Forge (platform source on Cloudflare Artifacts), read-only towards production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_JWT, CI_JWT, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { MIRROR_TOKEN_TTL_S, REPO, SOURCE_URL } from "../../forge/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const SHA = "a".repeat(40);

/** A fake Artifacts namespace: imports, repo handles, tokens, history. */
function fakeArtifacts(opts: { exists?: boolean; status?: "ready" | "importing" | "forking"; remote?: string } = {}) {
  const calls: { imports: any[]; tokens: any[]; disposals: number } = { imports: [], tokens: [], disposals: 0 };
  let exists = opts.exists ?? false;
  let state: "ready" | "importing" | "forking" = opts.status ?? "ready";
  const remote = opts.remote ?? ("https://" + "a".repeat(32) + ".artifacts.cloudflare.net/git/cryptophys/platform.git");
  const repo = {
    info: async () => ({ name: REPO, remote, defaultBranch: "main", lastPushAt: "2026-11-08T05:00:00Z" }),
    createToken: async (scope: string, ttl: number) => { calls.tokens.push({ scope, ttl }); return { plaintext: "art_v1_secret", expiresAt: "2026-11-08T05:10:00Z" }; },
    log: async (o: any) => Array.from({ length: Math.min(o?.limit ?? 50, 3) }, (_, i) => ({
      hash: i === 0 ? SHA : String(i).repeat(40),
      treeHash: "f".repeat(40),
      message: "commit " + i + "\nbody",
      author: { name: "Claude", email: "claude@example.invalid" },
      committer: { name: "Claude", email: "claude@example.invalid" },
      parents: [],
      authoredAt: Date.parse("2026-11-08T04:00:00Z") / 1000,
      committedAt: Date.parse("2026-11-08T04:00:00Z") / 1000,
    })),
    [Symbol.dispose]: () => { calls.disposals++; },
  };
  return {
    calls,
    binding: {
      list: async () => ({ repos: exists ? [{ name: REPO, status: state }] : [], cursor: null }),
      get: async (name: string) => { if (!exists || name !== REPO || state !== "ready") throw new Error("NOT_READY"); return repo; },
      import: async (p: any) => { calls.imports.push(p); exists = true; state = "ready"; return { name: p.target.name, remote: "r" }; },
    },
  };
}
const env = (db: any, artifacts: any) => baseEnv("cryptophys-forge", db, { ARTIFACTS: artifacts });

test("F1. import is one-time, confirmed, audited, from the public GitHub repository", async () => {
  const db = migratedDb();
  const a = fakeArtifacts();
  const e = env(db, a.binding);
  assert.equal((await call(forge, e, req("POST", "/v1/forge/import", { confirm: "yes" }, OPERATOR_JWT))).status, 400);
  const r1 = await call(forge, e, req("POST", "/v1/forge/import", { confirm: "IMPORT" }, OPERATOR_JWT));
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { imported: true, repo: "platform" });
  assert.deepEqual(a.calls.imports, [{ source: { url: SOURCE_URL, branch: "main" }, target: { name: "platform", opts: { description: "Cryptophys cloud platform (ADR-0012 Forge)" } } }]);
  const r2 = await call(forge, e, req("POST", "/v1/forge/import", { confirm: "IMPORT" }, OPERATOR_JWT));
  assert.deepEqual(r2.body, { imported: false, repo: "platform" }, "an existing repo is never replaced");
  assert.equal(a.calls.imports.length, 1);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.imported'").get() as any).n, 1);
  assert.equal((await call(forge, e, req("POST", "/v1/forge/import", { confirm: "IMPORT" }, OUTSIDER_JWT))).status, 403);
});

test("F2. the mirror token is for the CI service token only, short-lived, audited without the token", async () => {
  const db = migratedDb();
  const a = fakeArtifacts({ exists: true });
  const e = env(db, a.binding);
  for (const jwt of [OPERATOR_JWT, APPROVER_JWT]) {
    const r = await call(forge, e, req("POST", "/v1/forge/mirror-token", { confirm: "MIRROR" }, jwt));
    assert.ok(r.status === 403, `people never get a write token (${r.status})`);
  }
  assert.equal((await call(forge, e, req("POST", "/v1/forge/mirror-token", { confirm: "PUSH" }, CI_JWT))).status, 400);
  const r = await call(forge, e, req("POST", "/v1/forge/mirror-token", { confirm: "MIRROR" }, CI_JWT));
  assert.equal(r.status, 200);
  assert.equal(r.body.token, "art_v1_secret");
  assert.match(r.body.remote, /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/cryptophys\/platform\.git$/);
  assert.deepEqual(a.calls.tokens, [{ scope: "write", ttl: MIRROR_TOKEN_TTL_S }]);
  assert.equal(MIRROR_TOKEN_TTL_S, 600);
  const bad = fakeArtifacts({ exists: true, remote: "https://evil.example/git/cryptophys/platform.git" });
  const badResult = await call(forge, env(migratedDb(), bad.binding), req("POST", "/v1/forge/mirror-token", { confirm: "MIRROR" }, CI_JWT));
  assert.equal(badResult.status, 502, "a write token is never issued for an untrusted remote");
  assert.equal(bad.calls.tokens.length, 0);
  const audit = db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'forge.mirror_token_issued'").all() as any[];
  assert.equal(audit.length, 1);
  assert.doesNotMatch(audit[0].payload_json, /art_v1/, "the token is never stored");
  const none = env(migratedDb(), fakeArtifacts().binding);
  assert.equal((await call(forge, none, req("POST", "/v1/forge/mirror-token", { confirm: "MIRROR" }, CI_JWT))).status, 409, "no repo yet: the mirror workflow skips");
});

test("F3. status and commits read main, dispose repo handles; viewers and operators read, outsiders do not", async () => {
  const a = fakeArtifacts({ exists: true });
  const e = env(migratedDb(), a.binding);
  const s = await call(forge, e, req("GET", "/v1/forge/status", undefined, OPERATOR_JWT));
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.head, { sha: SHA, title: "commit 0", author: "Claude", date: "2026-11-08T04:00:00.000Z" });
  assert.equal(s.body.repo.default_branch, "main");
  const c = await call(forge, e, req("GET", "/v1/forge/commits?limit=2", undefined, OPERATOR_JWT));
  assert.equal(c.body.commits.length, 2);
  assert.equal(a.calls.disposals, 2, "every Artifacts repository capability is disposed");
  assert.equal((await call(forge, e, req("GET", "/v1/forge/status", undefined, OUTSIDER_JWT))).status, 403);
  const before = await call(forge, env(migratedDb(), fakeArtifacts().binding), req("GET", "/v1/forge/status", undefined, OPERATOR_JWT));
  assert.deepEqual([before.status, before.body.repo], [200, null], "before the import the status says so");
});
test("F4. readiness needs the Artifacts binding, the schema and Access", async () => {
  const ok = await call(forge, env(migratedDb(), fakeArtifacts().binding), req("GET", "/ready"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.checks.artifacts_binding, true);
  const missing = await call(forge, env(migratedDb(), undefined), req("GET", "/ready"));
  assert.deepEqual([missing.status, missing.body.checks.artifacts_binding], [503, false]);
});

test("F4b. commit metadata is read defensively: hash/oid/sha/id, nested or epoch timestamps", async () => {
  const { presentCommit } = await import("../../forge/src/index.ts");
  const h = "b".repeat(40);
  assert.deepEqual(presentCommit({ hash: h, message: "t\nbody", author: { name: "A", timestamp: 1794110000 } }), { sha: h, title: "t", author: "A", date: new Date(1794110000 * 1000).toISOString() });
  assert.equal(presentCommit({ oid: h }).sha, h);
  assert.equal(presentCommit({ treeHash: h }).sha, "", "a tree hash is not a commit id");
  assert.equal(presentCommit({ something: h }).sha, "", "unknown 40-hex fields are not commit ids");
  assert.equal(presentCommit({ id: h, author: "B", authorDate: "2026-11-08T05:00:00Z" }).date, "2026-11-08T05:00:00.000Z");
  assert.equal(presentCommit({ hash: h, message: "binding commit", author: { name: "A", email: "a@example.invalid" }, committer: { name: "A", email: "a@example.invalid" }, authoredAt: 1794110000, committedAt: 1794110000 }).date, new Date(1794110000 * 1000).toISOString(), "Artifacts binding authoredAt/committedAt are parsed");
  assert.equal(presentCommit({ hash: h, authoredAt: 1e100 }).date, "", "invalid epoch values fail closed without throwing");
  assert.deepEqual(presentCommit({}), { sha: "", title: "", author: "", date: "" });
});

test("F6. an in-progress Artifacts import is not started again and is visible in status", async () => {
  const a = fakeArtifacts({ exists: true, status: "importing" });
  const e = env(migratedDb(), a.binding);
  const imported = await call(forge, e, req("POST", "/v1/forge/import", { confirm: "IMPORT" }, OPERATOR_JWT));
  assert.deepEqual(imported.body, { imported: false, repo: REPO, status: "importing" });
  assert.equal(a.calls.imports.length, 0);
  const s = await call(forge, e, req("GET", "/v1/forge/status", undefined, OPERATOR_JWT));
  assert.deepEqual(s.body.repo, { name: REPO, status: "importing" });
  assert.equal(s.body.head, null);
});

test("F5. wiring: binding, Access destination, deploy and mirror workflows, ops-dispatch", () => {
  const toml = readFileSync(new URL("workers/forge/wrangler.toml", ROOT), "utf8");
  assert.match(toml, /\[\[artifacts\]\]\nbinding = "ARTIFACTS"\nnamespace = "cryptophys"/);
  assert.match(toml, /database_id = "__CONTROL_PLANE_D1_DATABASE_ID__"/);
  assert.match(toml, /preview_urls = false/);
  assert.match(readFileSync(new URL(".github/workflows/provision-access.yml", ROOT), "utf8"), /cryptophys-home cryptophys-forge\n/);
  const deploy = readFileSync(new URL(".github/workflows/deploy-forge.yml", ROOT), "utf8");
  const order = ["resolve-access.sh", "render-d1-config.sh\" ../forge", "wait-cron-window.sh", "worker-rollback.sh\" capture", "wrangler deploy --config ../forge/wrangler.deploy.toml", "verify-worker-live.sh", "/v1/forge/import", "worker-rollback.sh\" restore"].map((k) => deploy.indexOf(k));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `deploy step order ${order}`);
  assert.match(deploy, /\[\[ "\$CONFIRM_PRODUCTION" == "DEPLOY" \]\]/);
  const mirror = readFileSync(new URL(".github/workflows/mirror-to-forge.yml", ROOT), "utf8");
  assert.match(mirror, /branches: \[main\]/);
  assert.match(mirror, /fetch-depth: 0/);
  assert.match(mirror, /persist-credentials: false/);
  assert.match(mirror, /echo "::add-mask::\$\{token\}"; echo "::add-mask::\$\{remote\}"/);
  assert.ok(mirror.indexOf("::add-mask::") < mirror.indexOf("git -c http.extraHeader"), "the token is masked before it is used");
  assert.doesNotMatch(mirror, /x:\$\{token\}@/, "the token never goes into a URL");
  assert.ok(mirror.includes("[0-9a-f]{32}\\.artifacts\\.cloudflare\\.net/git/cryptophys/platform\\.git"), "the returned remote is restricted to the canonical Artifacts repo");
  assert.ok(mirror.indexOf("untrusted Artifacts remote") < mirror.indexOf("git -c http.extraHeader"), "the remote is validated before the token is sent");
  const ops = readFileSync(new URL(".github/workflows/ops-dispatch.yml", ROOT), "utf8");
  assert.match(ops, /\|deploy-forge\.yml\) ref=main ;;/);
  assert.match(ops, /mirror-to-forge\.yml\) ref=main ;;/);
});

test("F8. the runner releases test-owned SQL.js databases after each test", () => {
  const databases = (globalThis as unknown as { __SQL_DATABASES?: Set<unknown> }).__SQL_DATABASES;
  if (!databases) return; // Native node:test uses node:sqlite, not the Forge shim.
  assert.equal(databases.size, 0, "previous tests must not leave SQLite databases open");
  const db = migratedDb();
  assert.ok(db.raw);
  assert.equal(databases.size, 1);
});

test("F9. a SQL.js database left by the previous test is closed before the next test starts", () => {
  const databases = (globalThis as unknown as { __SQL_DATABASES?: Set<unknown> }).__SQL_DATABASES;
  if (!databases) return;
  assert.equal(databases.size, 0, "the runner must clean up after every test, not only after the file");
});
