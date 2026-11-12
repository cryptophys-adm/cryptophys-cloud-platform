// ADR-0012 G5: Dependabot and secret scanning off GitHub. The Forge audits main's npm lockfiles against the npm
// registry's bulk advisory endpoint once a day per head (forge/src/dependency-audit.ts, migration 0051), the
// Console Code page shows the latest run, and the owner notice `dependencies` opens for a high or critical
// advisory in a Worker's or the Console UI's lockfile, or a stale audit. The secret scan of every checked commit
// (runner/core.ts) replaces GitHub secret scanning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";
import {
  ADVISORY_URL, AUDIT_INTERVAL_MS, RETENTION_DAYS, RETRY_FAILED_MS, batches, dependencyAuditTick, fetchAdvisories, findLockfiles,
  isRuntimeLockfile, lockfilePackages, matchFindings, parseRange, satisfies,
} from "../../forge/src/dependency-audit.ts";
import { DEPENDENCY_AUDIT_STALE_MS, dependencyAudit } from "../src/dependency-audit.ts";
import { collectNotices } from "../../ai-kernel/src/owner-notices.ts";
import { scanSecrets } from "../../forge/src/runner/core.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const MAIN = "9".repeat(40);
const NOW = Date.parse("2026-11-12T09:19:00.000Z");
const H = 3_600_000;

const v3 = (packages: Record<string, unknown>) => JSON.stringify({ name: "x", lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: "1.0.0" }, ...packages } });

/** An Artifacts repo whose main head holds the given files. */
function repoWith(files: Record<string, string>, head = MAIN): ArtifactsReader & { reads: string[] } {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const reads: string[] = [];
  const id = () => (n++).toString(16).padStart(40, "e");
  function build(f: Record<string, string>): string {
    const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, t] of Object.entries(f)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = id(); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t;
    }
    for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: build(sub) });
    const h = id(); trees[h] = entries; return h;
  }
  const root = build(files);
  return {
    reads,
    async readCommit(h) { return h === head ? { hash: h, treeHash: root } : null; },
    async readTree(h) { return trees[h] ?? null; },
    async readBlob(h) { reads.push(h); return h in blobs ? new Blob([blobs[h]]) : null; },
    async log() { return [{ hash: head }]; },
  };
}

/** The bulk advisory endpoint: answers from a table of advisories per name, records each request body. */
function registry(table: Record<string, unknown[]>, status = 200) {
  const bodies: Array<Record<string, string[]>> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    assert.equal(url, ADVISORY_URL);
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["content-type"], "application/json");
    assert.ok(!("authorization" in (init?.headers as Record<string, string>)), "no credential is sent");
    const body = JSON.parse(String(init?.body)) as Record<string, string[]>;
    bodies.push(body);
    if (status !== 200) return new Response("unavailable", { status });
    return new Response(JSON.stringify(Object.fromEntries(Object.keys(body).filter((k) => table[k]).map((k) => [k, table[k]]))), { status: 200 });
  };
  return { bodies, fetchImpl };
}

const LOCK_UI = v3({
  "node_modules/react": { version: "18.3.1" },
  "node_modules/vite": { version: "6.4.5", dev: true },
  "node_modules/vite/node_modules/esbuild": { version: "0.24.0", dev: true },
  "node_modules/@scope/pkg": { version: "2.0.0" },
});
const LOCK_SHARED = v3({ "node_modules/esbuild": { version: "0.28.2", dev: true }, "node_modules/@scope/pkg": { version: "2.0.0" } });
const FILES = {
  "workers/console/wrangler.toml": 'name = "cryptophys-console"\n',
  "workers/console/ui/package-lock.json": LOCK_UI,
  "workers/control-plane-shared/package-lock.json": LOCK_SHARED,
  "workers/control-plane-shared/node_modules/evil/package-lock.json": v3({ "node_modules/never": { version: "1.0.0" } }),
  "tools/forge-runner/package-lock.json": v3({ "node_modules/left-pad": { version: "1.3.0" } }),
  "README.md": "x",
};
const ADVISORIES = {
  esbuild: [{ id: 1102341, url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99", title: "esbuild dev server accepts any origin", severity: "moderate", vulnerable_versions: "<=0.24.2", cwe: ["CWE-346"], cvss: { score: 5.3 } }],
  "@scope/pkg": [{ id: 900001, url: "https://github.com/advisories/GHSA-aaaa", title: "Prototype pollution", severity: "high", vulnerable_versions: ">=2.0.0 <2.0.5" }],
  "left-pad": [{ id: 900002, url: "javascript:alert(1)", title: "Tooling only", severity: "critical", vulnerable_versions: "<2.0.0" }],
  react: [{ id: 900003, url: "https://x/a", title: "Not this version", severity: "critical", vulnerable_versions: "<16.0.0 || >=19.0.0-0 <19.0.1" }],
};

const runs = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT * FROM forge_dependency_audits ORDER BY ran_at").all().map((r: any) => ({ ...r }));
const findingRows = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT package, version, advisory_id, severity, url, lockfiles, runtime FROM forge_dependency_findings ORDER BY package, version").all().map((r: any) => ({ ...r }));

test("G5-1. lockfiles v2/v3 (nested, scoped, aliases), links and the root skipped; v1 nested dependencies; anything else refused", () => {
  const p = lockfilePackages(v3({
    "node_modules/a": { version: "1.0.0" },
    "node_modules/b/node_modules/a": { version: "2.0.0-beta.1" },
    "node_modules/@s/c": { version: "3.1.4" },
    "node_modules/alias": { name: "real-pkg", version: "4.0.0" },
    "node_modules/linked": { resolved: "packages/linked", link: true },
    "packages/linked": { name: "linked", version: "9.9.9" },
    "node_modules/git-dep": { version: "git+https://example.invalid/x.git" },
  }));
  assert.deepEqual([...p].map(([k, v]) => [k, [...v].sort()]).sort(), [["@s/c", ["3.1.4"]], ["a", ["1.0.0", "2.0.0-beta.1"]], ["real-pkg", ["4.0.0"]]]);
  const v2 = lockfilePackages(JSON.stringify({ lockfileVersion: 2, packages: { "": {}, "node_modules/x": { version: "1.2.3" } }, dependencies: { x: { version: "1.2.3" } } }));
  assert.deepEqual([...v2.keys()], ["x"]);
  const v1 = lockfilePackages(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } }, al: { version: "npm:real@3.0.0" }, f: { version: "file:../f" } } }));
  assert.deepEqual([...v1.keys()].sort(), ["a", "b", "real"]);
  assert.throws(() => lockfilePackages('{"name":"x"}'), /not_a_lockfile/);
  assert.throws(() => lockfilePackages("not json"));
  // The repository's own lockfiles parse.
  for (const f of ["workers/console/ui/package-lock.json", "workers/control-plane-shared/package-lock.json", "workers/deployment-orchestrator/package-lock.json", "workers/platform-api/package-lock.json"]) {
    assert.ok(lockfilePackages(read(f)).size > 50, f);
  }
  const workers = new Set(["console", "forge"]);
  assert.deepEqual(["workers/console/ui/package-lock.json", "workers/forge/package-lock.json", "workers/control-plane-shared/package-lock.json", "tools/x/package-lock.json", "package-lock.json"].map((f) => isRuntimeLockfile(f, workers)), [true, true, false, false, false]);
});

test("G5-2. the range matcher: comparators, AND, OR, hyphen, caret, tilde, x-ranges and *; prereleases conservatively", () => {
  const cases: Array<[string, string, boolean]> = [
    ["1.2.3", "<1.2.4", true], ["1.2.4", "<1.2.4", false], ["1.2.4", "<=1.2.4", true], ["1.2.5", "<=1.2.4", false],
    ["2.0.0", ">1.9.9", true], ["1.9.9", ">1.9.9", false], ["1.9.9", ">=1.9.9", true], ["1.9.8", ">=1.9.9", false],
    ["1.0.0", "=1.0.0", true], ["1.0.1", "1.0.0", false], ["1.5.0", ">=1.0.0 <2.0.0", true], ["2.0.0", ">=1.0.0 <2.0.0", false],
    ["0.5.0", "<1.0.0 || >=2.0.0 <2.1.0", true], ["2.0.3", "<1.0.0 || >=2.0.0 <2.1.0", true], ["1.5.0", "<1.0.0 || >=2.0.0 <2.1.0", false],
    ["9.9.9", "*", true], ["9.9.9", "", true], ["1.3.0", "1.2.0 - 1.4.0", true], ["1.4.1", "1.2.0 - 1.4.0", false],
    ["1.9.0", "^1.2.3", true], ["2.0.0", "^1.2.3", false], ["0.2.9", "^0.2.3", true], ["0.3.0", "^0.2.3", false],
    ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false], ["1.2.7", "1.2.x", true], ["1.3.0", "1.2.x", false],
    ["1.2.9", "<=1.2", true], ["1.3.0", "<=1.2", false], ["1.1.9", "<1.2", true], ["1.2.0", "<1.2", false], ["2.0.0", ">1", true], ["1.9.9", ">1", false],
    ["1.2.3", "< 1.2.4", true], ["4.17.20", ">= 4.0.0 < 4.17.21", true],
    // Prereleases by full precedence: a prerelease of an affected line is reported.
    ["2.0.0-beta.1", "<2.0.0", true], ["2.0.0-beta.1", ">=2.0.0", false], ["2.0.0-rc.1", ">=2.0.0-beta.2 <2.0.0", true],
    ["1.0.0-alpha", "<1.0.0-alpha.1", true], ["1.0.0-alpha.2", "<1.0.0-alpha.10", true], ["1.0.0-beta", "<1.0.0-alpha", false],
    // An unreadable range or version counts as affected.
    ["1.0.0", ">=banana", true], ["not-a-version", "<1.0.0", true],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} in "${r}"`);
  assert.equal(parseRange(">=banana"), null);
});

test("G5-3. requests are batched under 1000 names, in a stable order; only asked names are taken; severities normalised", async () => {
  const many = new Map<string, Set<string>>();
  for (let i = 0; i < 2000; i++) many.set(`pkg-${String(i).padStart(4, "0")}`, new Set(["1.0.1", "1.0.0"]));
  const b = batches(many);
  assert.deepEqual(b.map((x) => Object.keys(x).length), [900, 900, 200]);
  assert.ok(b.every((x) => Object.keys(x).length < 1000));
  assert.deepEqual(b[0]["pkg-0000"], ["1.0.0", "1.0.1"]);
  assert.equal(Object.keys(b[2])[0], "pkg-1800");
  const reg = registry({ a: [{ id: 1, url: "https://ok", title: "t", severity: "MEDIUM", vulnerable_versions: "<2.0.0" }, { id: 2, severity: "weird" }, { title: "no id" }], b: [{ id: 3, severity: "low" }] });
  const leaky = async (url: string, init?: RequestInit) => {
    const r = await reg.fetchImpl(url, init);
    return new Response(JSON.stringify({ ...(await r.json()), extra: [{ id: 4 }] }), { status: 200 });
  };
  const got = await fetchAdvisories(leaky as never, [{ a: ["1.0.0"] }, { b: ["1.0.0"] }]);
  assert.equal(reg.bodies.length, 2);
  assert.deepEqual(got.get("b"), [{ id: "3", url: null, title: null, severity: "low", vulnerable_versions: "*" }]);
  assert.deepEqual(got.get("a"), [
    { id: "1", url: "https://ok", title: "t", severity: "moderate", vulnerable_versions: "<2.0.0" },
    { id: "2", url: null, title: null, severity: "high", vulnerable_versions: "*" },
  ]);
  assert.equal(got.has("extra"), false, "a name that was not asked about is ignored");
  await assert.rejects(fetchAdvisories(registry({}, 503).fetchImpl as never, [{ a: ["1.0.0"] }]), /advisories_http_503/);
  const exact = matchFindings(new Map([["a", [{ id: "1", url: null, title: null, severity: "high", vulnerable_versions: "<1.5.0" }]]]), new Map([["a", new Set(["1.0.0", "2.0.0"])]]), new Map([["a@1.0.0", new Set(["l1"])], ["a@2.0.0", new Set(["l2"])]]), new Set(["l1"]));
  assert.deepEqual(exact.map((f) => [f.version, f.lockfiles, f.runtime]), [["1.0.0", ["l1"], true]], "only the affected version, with its lockfile");
});

test("G5-4. the tick records a run and its findings, with the runtime flag; once a day per head; a failure is recorded, not thrown", async () => {
  const db = migratedDb();
  const repo = repoWith(FILES);
  const found = await findLockfiles(repo, MAIN);
  assert.deepEqual(found.lockfiles.map((l) => l.path), ["tools/forge-runner/package-lock.json", "workers/console/ui/package-lock.json", "workers/control-plane-shared/package-lock.json"], "node_modules is never read");
  assert.deepEqual([...found.workerDirs], ["console"]);
  const reg = registry(ADVISORIES);
  const r = await dependencyAuditTick({ DB: db as never }, repo, NOW, reg.fetchImpl as never);
  assert.deepEqual(r, { outcome: "recorded", main_sha: MAIN, lockfiles: 3, packages: 6, advisories: 3, findings: 3 });
  // Only names and versions are sent.
  assert.equal(reg.bodies.length, 1);
  assert.deepEqual(reg.bodies[0], { "@scope/pkg": ["2.0.0"], esbuild: ["0.24.0", "0.28.2"], "left-pad": ["1.3.0"], react: ["18.3.1"], vite: ["6.4.5"] });
  const [run] = runs(db);
  assert.deepEqual([run.main_sha, run.status, run.lockfiles, run.packages, run.advisories, run.critical, run.high, run.moderate, run.low, run.info, run.error], [MAIN, "ok", 3, 6, 3, 1, 1, 1, 0, 0, null]);
  assert.deepEqual(findingRows(db), [
    { package: "@scope/pkg", version: "2.0.0", advisory_id: "900001", severity: "high", url: "https://github.com/advisories/GHSA-aaaa", lockfiles: JSON.stringify(["workers/console/ui/package-lock.json", "workers/control-plane-shared/package-lock.json"]), runtime: 1 },
    // esbuild 0.28.2 is outside "<=0.24.2"; the Console UI's nested 0.24.0 is in it.
    { package: "esbuild", version: "0.24.0", advisory_id: "1102341", severity: "moderate", url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99", lockfiles: JSON.stringify(["workers/console/ui/package-lock.json"]), runtime: 1 },
    // A tooling lockfile; the advisory's non-https URL is dropped.
    { package: "left-pad", version: "1.3.0", advisory_id: "900002", severity: "critical", url: null, lockfiles: JSON.stringify(["tools/forge-runner/package-lock.json"]), runtime: 0 },
  ], "react 18.3.1 is outside its advisory's range");
  const audit = db.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = 'forge.dependency_audit'").all() as any[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "findings");
  assert.deepEqual(JSON.parse(audit[0].payload_json).advisories, ["1102341", "900001", "900002"]);

  // Once a day per head: an hour later nothing is asked.
  assert.equal((await dependencyAuditTick({ DB: db as never }, repo, NOW + H, reg.fetchImpl as never)).outcome, "not_due");
  assert.equal(reg.bodies.length, 1);
  // A day later the same head is audited again; the same advisories add no audit event.
  assert.equal((await dependencyAuditTick({ DB: db as never }, repo, NOW + AUDIT_INTERVAL_MS + 1, reg.fetchImpl as never)).outcome, "recorded");
  assert.equal(runs(db).length, 2);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.dependency_audit'").get() as any).n, 1);

  // A new head whose advisory request fails: recorded as failed, never thrown; retried after an hour.
  const head2 = "8".repeat(40);
  const repo2 = repoWith(FILES, head2);
  const down = registry({}, 503);
  const f = await dependencyAuditTick({ DB: db as never }, repo2, NOW + 2 * AUDIT_INTERVAL_MS, down.fetchImpl as never);
  assert.deepEqual(f, { outcome: "failed", main_sha: head2, error: "advisories_http_503" });
  const failed = runs(db).at(-1);
  assert.deepEqual([failed.main_sha, failed.status, failed.error, failed.packages], [head2, "failed", "advisories_http_503", 0]);
  assert.equal((await dependencyAuditTick({ DB: db as never }, repo2, NOW + 2 * AUDIT_INTERVAL_MS + RETRY_FAILED_MS / 2, down.fetchImpl as never)).outcome, "not_due");
  assert.equal((await dependencyAuditTick({ DB: db as never }, repo2, NOW + 2 * AUDIT_INTERVAL_MS + RETRY_FAILED_MS + 1, reg.fetchImpl as never)).outcome, "recorded");
  // An unreadable lockfile fails the run with its path.
  const broken = await dependencyAuditTick({ DB: db as never }, repoWith({ ...FILES, "workers/console/ui/package-lock.json": "{" }, "7".repeat(40)), NOW + 3 * AUDIT_INTERVAL_MS, reg.fetchImpl as never);
  assert.equal(broken.outcome, "failed");
  assert.match(String(broken.error), /^lockfile_unreadable: workers\/console\/ui\/package-lock\.json/);

  // Retention: runs older than 90 days go, with their findings.
  db.raw.prepare("UPDATE forge_dependency_audits SET ran_at = ? WHERE main_sha = ?").run(new Date(NOW - (RETENTION_DAYS + 1) * 86_400_000).toISOString(), MAIN);
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES, "6".repeat(40)), NOW + 4 * AUDIT_INTERVAL_MS, reg.fetchImpl as never);
  assert.equal(runs(db).filter((x: any) => x.main_sha === MAIN).length, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM forge_dependency_findings f LEFT JOIN forge_dependency_audits a ON a.run_id = f.run_id WHERE a.run_id IS NULL").get() as any).n, 0);

  // Before migration 0051 the tick reports a failure and throws nothing.
  const bare = migratedDb();
  bare.raw.prepare("DROP TABLE forge_dependency_findings").run();
  bare.raw.prepare("DROP TABLE forge_dependency_audits").run();
  const none = await dependencyAuditTick({ DB: bare as never }, repo, NOW, reg.fetchImpl as never);
  assert.equal(none.outcome, "failed");
  assert.equal(none.recorded, false);
  assert.match(read("workers/forge/src/tick.ts"), /step\("dependency_audit"/);
});

test("G5-5. GET /v1/forge/dependency-audit for operators (read only), in the Console's read-only allowlist and on the Code page", async () => {
  const db = migratedDb();
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES), Date.now() - 60_000, registry(ADVISORIES).fetchImpl as never);
  const env = baseEnv("cryptophys-forge", db);
  const r = await call(forge, env, req("GET", "/v1/forge/dependency-audit", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200);
  const a = r.body.audit;
  assert.deepEqual([a.schema, a.status, a.stale, a.latest_run.main_sha, a.last_ok_run.run_id === a.latest_run.run_id, a.runtime_high_ids], ["dependency-audit.v1", "action_needed", false, MAIN, true, ["900001"]]);
  assert.deepEqual(a.findings.map((f: any) => [f.package, f.runtime]), [["@scope/pkg", true], ["esbuild", true], ["left-pad", false]], "runtime first, then by severity");
  assert.deepEqual(a.findings[0].lockfiles, ["workers/console/ui/package-lock.json", "workers/control-plane-shared/package-lock.json"]);
  assert.equal((await call(forge, env, req("GET", "/v1/forge/dependency-audit", undefined, OUTSIDER_JWT))).status, 403);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/dependency-audit", {}, OPERATOR_JWT))).status, 404, "nothing to write");
  const bare = migratedDb();
  bare.raw.prepare("DROP TABLE forge_dependency_findings").run();
  bare.raw.prepare("DROP TABLE forge_dependency_audits").run();
  assert.equal((await call(forge, baseEnv("cryptophys-forge", bare), req("GET", "/v1/forge/dependency-audit", undefined, OPERATOR_JWT))).body.audit, null);
  assert.match(read("workers/console/src/index.ts"), /"\/v1\/forge\/dependency-audit"/);
  assert.match(read("workers/console/src/ui/routes.ts"), /r\("forge\.dependency_audit", "forge", "GET", "\/v1\/forge\/dependency-audit", false, null\)/);
  assert.match(read("workers/console/ui/src/pages/Code.tsx"), /<DependencyAudit /);
  assert.match(read("workers/console/ui/src/pages/Code.tsx"), /call\("forge\.dependency_audit"\)/);
  assert.match(read("workers/console/ui/scripts/render-smoke.mjs"), /"\/api\/forge\/v1\/forge\/dependency-audit"/);
});

test("G5-6. the owner notice: a high or critical advisory in a build, or a stale audit; one email per set of advisories", async () => {
  const db = migratedDb();
  const notice = async (now = NOW) => (await collectNotices(db as never, now)).find((n) => n.topic === "dependencies")!;
  const none = await notice();
  assert.deepEqual([none.active, none.fingerprint, none.title], [false, "", "npm dependencies are not audited yet"]);

  // Tooling-only critical and a moderate in a build: no notice.
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES), NOW, registry({ "left-pad": ADVISORIES["left-pad"], esbuild: ADVISORIES.esbuild }).fetchImpl as never);
  const quiet = await notice(NOW + 60_000);
  assert.equal(quiet.active, false);
  assert.match(quiet.title, /No high or critical advisory in Worker or Console builds \(2 finding\(s\) in total\)/);

  // A high advisory in the Console UI's lockfile opens it, linked to the Code page.
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES, "1".repeat(40)), NOW + H, registry(ADVISORIES).fetchImpl as never);
  const open = await notice(NOW + H + 60_000);
  assert.equal(open.active, true);
  assert.match(open.title, /^Vulnerable npm dependencies: 1 high or critical advisory in Worker or Console builds$/);
  assert.ok(open.lines.some((l) => /^@scope\/pkg@2\.0\.0: high, Prototype pollution \(https:\/\/github\.com\/advisories\/GHSA-aaaa\) in workers\/console\/ui\/package-lock\.json/.test(l)));
  assert.equal(open.link, "https://nexus.cryptophys.work/console/#/code");

  // The same advisory on a newer head: same fingerprint, no second email. A failed run after it changes nothing.
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES, "2".repeat(40)), NOW + 2 * H, registry(ADVISORIES).fetchImpl as never);
  assert.equal((await notice(NOW + 2 * H + 60_000)).fingerprint, open.fingerprint);
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES, "3".repeat(40)), NOW + 3 * H, registry({}, 500).fetchImpl as never);
  assert.equal((await notice(NOW + 3 * H + 60_000)).fingerprint, open.fingerprint, "the last successful run's findings stand");

  // A new advisory changes the fingerprint.
  const more = { ...ADVISORIES, react: [{ id: 900009, url: "https://x/r", title: "React issue", severity: "critical", vulnerable_versions: "<18.3.2" }] };
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES, "4".repeat(40)), NOW + 4 * H, registry(more).fetchImpl as never);
  const changed = await notice(NOW + 4 * H + 60_000);
  assert.notEqual(changed.fingerprint, open.fingerprint);
  assert.match(changed.title, /2 high or critical advisories/);

  // Fixed: the notice closes.
  await dependencyAuditTick({ DB: db as never }, repoWith(FILES, "5".repeat(40)), NOW + 5 * H, registry({}).fetchImpl as never);
  assert.equal((await notice(NOW + 5 * H + 60_000)).active, false);

  // No successful run for 72 hours: open, with its own fingerprint.
  const stale = await notice(NOW + 5 * H + DEPENDENCY_AUDIT_STALE_MS + 60_000);
  assert.equal(stale.active, true);
  assert.match(stale.title, /has not succeeded for 72 hours/);
  assert.ok(stale.fingerprint && stale.fingerprint !== open.fingerprint);
  // Only failed runs since the first one 72 hours ago: stale too.
  const db2 = migratedDb();
  await dependencyAuditTick({ DB: db2 as never }, repoWith(FILES), NOW, registry({}, 503).fetchImpl as never);
  assert.equal((await dependencyAudit(db2 as never, NOW + H))!.status, "failing");
  assert.equal((await dependencyAudit(db2 as never, NOW + DEPENDENCY_AUDIT_STALE_MS + H))!.stale, true);
});

test("G5-7. secret scanning off GitHub: the Forge scans every checked commit, now with npm tokens too", () => {
  const npm = "np" + "m_" + "A1b2C3d4".repeat(4) + "E5f6";
  assert.deepEqual(scanSecrets({ ".npmrc": `//registry.npmjs.org/:_authToken=${npm}\n` }).findings, [{ rule: "npm_token", path: ".npmrc", line: 1 }]);
  assert.deepEqual(scanSecrets({ "a.ts": "const npm_registry_url = 1;" }).findings, []);
  assert.match(read("workers/forge/src/checks.ts"), /const secrets = scanSecrets\(snap\.snapshot\)/);
  assert.match(read("architecture/adr/0012-github-independence.md"), /### 5i\. Step G5: Dependabot and secret scanning off GitHub/);
});
