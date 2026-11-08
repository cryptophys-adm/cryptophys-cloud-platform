// ADR-0012 §5c, owner decision 2026-11-08: the type-check runs in a Cloudflare Container, the only
// Container in the platform, because the compiler needs ~190 MB and a Workers isolate has 128 MB.
// These tests pin the Forge side (typecheck.ts, checks.ts) and the Container's locked toolchain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { checkCommit, listChecks, record, type CheckDeps } from "../../forge/src/checks.ts";
import {
  TYPECHECK_CONFIG, TYPECHECK_LOCKFILE, TYPECHECK_MODULES, forwardTypecheck, lockedToolchain, runTypecheck, typecheckFiles,
  type ContainerApi, type TypecheckCall,
} from "../../forge/src/typecheck.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const LOCK = read(TYPECHECK_LOCKFILE);
const SNAP = { [TYPECHECK_LOCKFILE]: LOCK, [TYPECHECK_CONFIG]: "{}", "workers/a.ts": "export {}", "docs/x.md": "# x" };
const LOCKED = lockedToolchain(SNAP)!;
const answer = (body: unknown, status = 200): TypecheckCall => async () => Response.json(body, { status });

test("TC1. the Container's compiler is the one the lockfile pins (what GitHub CI's npm ci installs)", () => {
  assert.ok(LOCKED && /^\d+\.\d+\.\d+$/.test(LOCKED.typescript) && /^\d+\.\d+\.\d+$/.test(LOCKED["@types/node"]));
  const pkg = JSON.parse(read("workers/forge/typecheck/package.json"));
  assert.deepEqual(pkg.dependencies, { "@types/node": LOCKED["@types/node"], typescript: LOCKED.typescript }, "exact versions, no ranges");
  const lock = JSON.parse(read("workers/forge/typecheck/package-lock.json"));
  for (const name of ["typescript", "@types/node", "undici-types"]) {
    const control = JSON.parse(LOCK).packages[`node_modules/${name}`];
    assert.equal(lock.packages[`node_modules/${name}`].version, control.version, name);
    assert.equal(lock.packages[`node_modules/${name}`].integrity, control.integrity, `${name} integrity`);
  }
  assert.equal(lockedToolchain({ [TYPECHECK_LOCKFILE]: "not json" }), null);
  assert.equal(lockedToolchain({}), null);
});

test("TC2. the image: base pinned by digest, locked install without scripts, non-root, no internet at runtime", () => {
  const docker = read("workers/forge/typecheck/Dockerfile");
  assert.match(docker, /^FROM node:[\d.]+-slim@sha256:[0-9a-f]{64}$/m);
  assert.match(docker, /npm ci --omit=dev --ignore-scripts/);
  assert.match(docker, /^USER node$/m);
  const toml = read("workers/forge/wrangler.toml");
  assert.match(toml, /\[\[containers\]\]\nclass_name = "TypecheckContainer"\nimage = "\.\/typecheck\/Dockerfile"\ninstance_type = "basic"\nmax_instances = 1/);
  assert.match(toml, /\[\[durable_objects\.bindings\]\]\nname = "TYPECHECK"\nclass_name = "TypecheckContainer"/);
  assert.match(toml, /new_sqlite_classes = \["TypecheckContainer"\]/);
  assert.match(read("workers/forge/src/worker.ts"), /export \{ TypecheckContainer \} from "\.\/typecheck-container\.ts"/);
  const server = read("workers/forge/typecheck/server.mjs");
  assert.match(server, /safePath\(p\)/, "paths are checked before anything is written");
  assert.match(server, /fs\.rm\(root, \{ recursive: true, force: true \}\)/, "each check's files are removed");
});

test("TC3. runTypecheck: passed, failed with diagnostics, and every infrastructure problem is an error, never a pass", async () => {
  let sent: any = null;
  const ok = await runTypecheck(async (body) => { sent = body; return Response.json({ toolchain: LOCKED, files: 276, errors: 0, diagnostics: [], ms: 3000 }); }, SNAP);
  assert.equal(ok.status, "passed");
  assert.deepEqual(Object.keys(sent.files).sort(), [TYPECHECK_LOCKFILE, TYPECHECK_CONFIG, "workers/a.ts"].sort(), "only files under workers/");
  assert.equal(sent.config, TYPECHECK_CONFIG);
  assert.equal(sent.modules, TYPECHECK_MODULES);
  const bad = await runTypecheck(answer({ toolchain: LOCKED, files: 277, errors: 2, diagnostics: ["a.ts(1,1): error TS2322: x", "b.ts(2,2): error TS2304: y"] }), SNAP);
  assert.deepEqual([bad.status, bad.errors, bad.diagnostics?.length], ["failed", 2, 2]);
  assert.equal((await runTypecheck(undefined, SNAP)).status, "not_configured");
  const cases: Array<[TypecheckCall, Record<string, string>, RegExp]> = [
    [answer({ toolchain: { ...LOCKED, typescript: "9.9.9" }, errors: 0 }), SNAP, /toolchain_mismatch/],
    [answer({ error: "container_not_ready" }, 503), SNAP, /container_503: container_not_ready/],
    [async () => { throw new Error("network lost"); }, SNAP, /network lost/],
    [answer({ toolchain: LOCKED, errors: -1 }), SNAP, /invalid_response/],
    [answer({ toolchain: LOCKED, errors: 0 }), { [TYPECHECK_CONFIG]: "{}" }, /lockfile_missing/],
    [answer({ toolchain: LOCKED, errors: 0 }), { [TYPECHECK_LOCKFILE]: LOCK }, /tsconfig_missing/],
  ];
  for (const [call, snap, reason] of cases) {
    const r = await runTypecheck(call, snap);
    assert.equal(r.status, "error");
    assert.match(String(r.reason), reason);
  }
  assert.deepEqual(Object.keys(typecheckFiles(SNAP)).sort(), [TYPECHECK_LOCKFILE, TYPECHECK_CONFIG, "workers/a.ts"].sort());
});

test("TC4. forwardTypecheck starts the Container without internet, waits for it, forwards one check, then stops it", async () => {
  const log: string[] = [];
  let healthy = 0;
  const container: ContainerApi = {
    running: false,
    start(opts) { log.push(`start internet=${opts?.enableInternet}`); this.running = true; },
    getTcpPort(port) {
      log.push(`port ${port}`);
      return {
        async fetch(input, init) {
          if (input.endsWith("/health")) { if (healthy++ < 2) throw new Error("ECONNREFUSED"); return new Response("{}"); }
          log.push(`check ${String(init?.body).length}`);
          return Response.json({ errors: 0 }, { status: 200 });
        },
      };
    },
    async destroy() { log.push("destroy"); },
  };
  const waits: number[] = [];
  const res = await forwardTypecheck(container, new Request("http://typecheck/typecheck", { method: "POST", body: '{"files":{}}' }), async (ms) => { waits.push(ms); });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { errors: 0 });
  assert.deepEqual(log, ["start internet=false", "port 8080", "check 12", "destroy"]);
  assert.equal(waits.length, 2, "waited until the health check answered");
  assert.equal((await forwardTypecheck(undefined, new Request("http://t/typecheck", { method: "POST" }))).status, 503);
  assert.equal((await forwardTypecheck(container, new Request("http://t/other", { method: "POST" }))).status, 404);
  const never: ContainerApi = { running: true, start() {}, getTcpPort() { return { async fetch() { throw new Error("down"); } }; }, async destroy() { log.push("destroy2"); } };
  const down = await forwardTypecheck(never, new Request("http://t/typecheck", { method: "POST", body: "{}" }), async () => {});
  assert.deepEqual([down.status, (await down.json()).error], [503, "container_not_ready"]);
  assert.ok(log.includes("destroy2"), "a Container that never answered is stopped too");
});

/** A one-commit Artifacts repo holding the given files at the root tree (paths with one directory level). */
function repoWith(files: Record<string, string>): ArtifactsReader {
  const hex = (n: number) => n.toString(16).padStart(40, "0");
  const blobs: Record<string, string> = {};
  const dirs: Record<string, ArtifactsTreeEntry[]> = {};
  const root: ArtifactsTreeEntry[] = [];
  let n = 100;
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    let level = root;
    let key = "";
    for (const dir of parts.slice(0, -1)) {
      key += dir + "/";
      if (!dirs[key]) { dirs[key] = []; const h = hex(n++); level.push({ name: dir, type: "tree", mode: "40000", hash: h }); (dirs as any)[h] = dirs[key]; }
      level = dirs[key];
    }
    const h = hex(n++);
    blobs[h] = text;
    level.push({ name: parts[parts.length - 1], type: "blob", mode: "100644", hash: h });
  }
  const tree = hex(1);
  return {
    async readCommit(hash) { return { hash, treeHash: tree }; },
    async readTree(hash) { return hash === tree ? root : (dirs as any)[hash] ?? null; },
    async readBlob(hash) { return hash in blobs ? new Blob([blobs[hash]]) : null; },
    async log() { return []; },
  };
}

function deps(typecheck?: TypecheckCall) {
  return async (): Promise<CheckDeps> => ({
    esbuild: { async build() { return { outputFiles: [{ text: "x", contents: new Uint8Array() }], errors: [], warnings: [] }; } },
    shims: {} as never, sqlJs: "", sqlWasm: null,
    async runWorker(code) { return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: "pass" }] })) }; },
    typecheck,
  });
}

test("TC5. a type error fails the Forge check (as it fails GitHub CI); a Container error is recorded but decides nothing", async () => {
  const files = { [TYPECHECK_LOCKFILE]: LOCK, [TYPECHECK_CONFIG]: "{}", "workers/control-plane-shared/test/a.test.ts": "x" };
  const commit = "c".repeat(40);
  const passed = await checkCommit(repoWith(files), commit, deps(answer({ toolchain: LOCKED, files: 3, errors: 0, diagnostics: [] })));
  assert.deepEqual([passed.status, passed.steps.typecheck?.status], ["passed", "passed"]);
  const typeErr = await checkCommit(repoWith(files), commit, deps(answer({ toolchain: LOCKED, files: 3, errors: 1, diagnostics: ["workers/x.ts(1,1): error TS2322: no"] })));
  assert.deepEqual([typeErr.status, typeErr.fail], ["failed", 0], "the tests passed; the type-check failed the check");
  assert.ok(typeErr.failures.includes("typecheck workers/x.ts(1,1): error TS2322: no"));
  const infra = await checkCommit(repoWith(files), commit, deps(answer({ error: "boom" }, 500)));
  assert.deepEqual([infra.status, infra.steps.typecheck?.status], ["passed", "error"]);
  assert.ok(infra.failures.some((f) => f.startsWith("typecheck error: container_500")));
  const none = await checkCommit(repoWith(files), commit, deps(undefined));
  assert.equal(none.steps.typecheck?.status, "not_configured");

  const db = migratedDb();
  db.raw.prepare("INSERT INTO forge_check_runs (commit_sha, status, runner, started_at) VALUES (?, 'running', 'r', ?)").run(commit, "2026-11-08T21:00:00Z");
  await record(db as never, typeErr, Date.parse("2026-11-08T21:01:00Z"));
  const listed = (await listChecks(db as never, 5)).checks[0];
  assert.deepEqual(listed.typecheck, { status: "failed", errors: 1, reason: null });
});

test("TC6. CI builds the image and runs this repository's type-check in it, with no network", () => {
  const ci = read(".github/workflows/validate-control-plane.yml");
  assert.match(ci, /typecheck-container:/);
  assert.match(ci, /\.github\/scripts\/typecheck-container-smoke\.sh/);
  const smoke = read(".github/scripts/typecheck-container-smoke.sh");
  assert.match(smoke, /docker run[^\n]*--network none/);
  assert.match(smoke, /--memory 1g/, "the same memory as the basic instance");
});
