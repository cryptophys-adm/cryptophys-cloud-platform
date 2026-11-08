// ADR-0012 phase 1: the Forge (platform source on Cloudflare Artifacts), read-only towards production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_JWT, CI_JWT, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { MIRROR_TOKEN_TTL_S, REPO, SOURCE_URL } from "../../forge/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const SHA = "a".repeat(40);

/** A fake Artifacts namespace: imports, repo handles, tokens, history. */
function fakeArtifacts(opts: { exists?: boolean } = {}) {
  const calls: { imports: any[]; tokens: any[] } = { imports: [], tokens: [] };
  let exists = opts.exists ?? false;
  const repo = {
    info: async () => ({ name: REPO, remote: "https://acct.artifacts.cloudflare.net/git/cryptophys/platform.git", defaultBranch: "main", lastPushAt: "2026-11-08T05:00:00Z" }),
    createToken: async (scope: string, ttl: number) => { calls.tokens.push({ scope, ttl }); return { plaintext: "art_v1_secret", expiresAt: "2026-11-08T05:10:00Z" }; },
    log: async (o: any) => Array.from({ length: Math.min(o?.limit ?? 50, 3) }, (_, i) => ({ sha: i === 0 ? SHA : String(i).repeat(40), message: `commit ${i}\nbody`, author: { name: "Claude", date: "2026-11-08T04:00:00Z" } })),
  };
  return {
    calls,
    binding: {
      get: async (name: string) => { if (!exists || name !== REPO) throw new Error("NOT_FOUND"); return repo; },
      import: async (p: any) => { calls.imports.push(p); exists = true; return { name: p.target.name, remote: "r" }; },
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
  assert.match(r.body.remote, /^https:\/\//);
  assert.deepEqual(a.calls.tokens, [{ scope: "write", ttl: MIRROR_TOKEN_TTL_S }]);
  assert.equal(MIRROR_TOKEN_TTL_S, 600);
  const audit = db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'forge.mirror_token_issued'").all() as any[];
  assert.equal(audit.length, 1);
  assert.doesNotMatch(audit[0].payload_json, /art_v1/, "the token is never stored");
  const none = env(migratedDb(), fakeArtifacts().binding);
  assert.equal((await call(forge, none, req("POST", "/v1/forge/mirror-token", { confirm: "MIRROR" }, CI_JWT))).status, 409, "no repo yet: the mirror workflow skips");
});

test("F3. status and commits read main; viewers and operators read, outsiders do not", async () => {
  const e = env(migratedDb(), fakeArtifacts({ exists: true }).binding);
  const s = await call(forge, e, req("GET", "/v1/forge/status", undefined, OPERATOR_JWT));
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.head, { sha: SHA, title: "commit 0", author: "Claude", date: "2026-11-08T04:00:00.000Z" });
  assert.equal(s.body.repo.default_branch, "main");
  const c = await call(forge, e, req("GET", "/v1/forge/commits?limit=2", undefined, OPERATOR_JWT));
  assert.equal(c.body.commits.length, 2);
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
  assert.equal(presentCommit({ something: h }).sha, h, "any 40-hex field");
  assert.equal(presentCommit({ id: h, author: "B", authorDate: "2026-11-08T05:00:00Z" }).date, "2026-11-08T05:00:00.000Z");
  assert.deepEqual(presentCommit({}), { sha: "", title: "", author: "", date: "" });
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
  const ops = readFileSync(new URL(".github/workflows/ops-dispatch.yml", ROOT), "utf8");
  assert.match(ops, /\|deploy-forge\.yml\) ref=main ;;/);
  assert.match(ops, /mirror-to-forge\.yml\) ref=main ;;/);
});
