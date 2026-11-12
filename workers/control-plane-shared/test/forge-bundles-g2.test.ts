// ADR-0012 G2a (owner 2026-11-12: "lanjutkan G2 sambil menunggu deploy"): the Forge keeps the Worker modules
// of every passed main commit in R2 with a manifest, so the deploy no longer needs GitHub Actions to build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { tickWith, type ArtifactsReader, type ArtifactsTreeEntry, type CheckDeps } from "../../forge/src/checks.ts";
import { BUNDLE_PREFIX, BUNDLE_RETENTION_DAYS, manifestEntry, migrationsOf, pruneBundles, storeBundles, type BundleBucket } from "../../forge/src/bundles.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const SHA = "d".repeat(40);
const TOML = `name = "cryptophys-demo"\nmain = "src/index.ts"\ncompatibility_date = "2026-11-01"\ncompatibility_flags = ["nodejs_compat"]\n`;

function bucket() {
  const objects = new Map<string, { value: string; uploaded: Date; meta?: unknown }>();
  const b: BundleBucket & { objects: typeof objects } = {
    objects,
    async put(key, value, options) { objects.set(key, { value, uploaded: new Date(), meta: options }); return {}; },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return { objects: page.map((key) => ({ key, uploaded: objects.get(key)!.uploaded })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
    async delete(keys) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return b;
}

function repoWith(files: Record<string, string>): ArtifactsReader {
  const hex = (n: number) => n.toString(16).padStart(40, "0");
  const blobs: Record<string, string> = {}; const trees: Record<string, ArtifactsTreeEntry[]> = {}; const byKey: Record<string, string> = {};
  const root: ArtifactsTreeEntry[] = []; let n = 100;
  for (const [p, text] of Object.entries(files)) {
    const parts = p.split("/"); let level = root; let key = "";
    for (const dir of parts.slice(0, -1)) {
      key += dir + "/";
      if (!byKey[key]) { const h = hex(n++); byKey[key] = h; trees[h] = []; level.push({ name: dir, type: "tree", mode: "40000", hash: h }); }
      level = trees[byKey[key]];
    }
    const h = hex(n++); blobs[h] = text; level.push({ name: parts[parts.length - 1], type: "blob", mode: "100644", hash: h });
  }
  const treeHash = hex(1);
  return {
    async readCommit(hash) { return { hash, treeHash }; },
    async readTree(hash) { return hash === treeHash ? root : trees[hash] ?? null; },
    async readBlob(hash) { return hash in blobs ? new Blob([blobs[hash]]) : null; },
    async log() { return []; },
  };
}

const FILES = {
  "workers/control-plane-shared/test/a.test.ts": "x",
  "workers/demo/wrangler.toml": TOML,
  "workers/demo/src/index.ts": "export default {}",
  "workers/control-plane-migrations/0002_b.sql": "SELECT 2;",
  "workers/control-plane-migrations/0001_a.sql": "SELECT 1;",
  "workers/control-plane-migrations/test_migrations.py": "",
};
function deps(testStatus: "pass" | "fail") {
  return async (): Promise<CheckDeps> => ({
    esbuild: { async build() { return { outputFiles: [{ text: "export default { fetch() {} };", contents: new Uint8Array(30) }], errors: [], warnings: [] }; } },
    shims: {} as never, sqlJs: "", sqlWasm: null,
    async runWorker(code) { return { files: (code.modules["files.json"] as { json: string[] }).json.map((file) => ({ file, results: [{ name: "t", status: testStatus }] })) }; },
  });
}

test("G2a-1. the manifest names each Worker's module, its hashes and what the module alone cannot carry", async () => {
  const e = await manifestEntry({ dir: "workers/demo", text: "export default {};", toml: TOML, external: [] });
  assert.deepEqual([e.name, e.module, e.main_module, e.compatibility_date, e.compatibility_flags, e.single_module, e.assets], ["cryptophys-demo", "cryptophys-demo.mjs", "cryptophys-demo.mjs", "2026-11-01", ["nodejs_compat"], true, false]);
  assert.match(e.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(e.config_sha256, e.sha256);
  const wasm = await manifestEntry({ dir: "workers/forge", text: "x", toml: TOML + "\n[assets]\ndirectory = \"dist\"\n", external: ["b.wasm", "a.js"] });
  assert.deepEqual([wasm.single_module, wasm.external, wasm.assets], [false, ["a.js", "b.wasm"], true]);
  await assert.rejects(manifestEntry({ dir: "workers/x", text: "x", toml: "main = \"a.ts\"", external: [] }), /invalid worker name/);
});

test("G2a-2. a passed, clean commit of main is stored; a failed one, or a change request, is not", async () => {
  const db = migratedDb();
  const b = bucket();
  const env = { DB: db as never, ARTIFACTS: { get: async () => repoWith(FILES) }, BUNDLES: b };
  const r = await tickWith(env, "platform", deps("pass"), () => Date.now(), async () => SHA, "main");
  assert.equal((r as { status: string }).status, "passed");
  const manifest = JSON.parse(b.objects.get(`${BUNDLE_PREFIX}${SHA}/manifest.json`)!.value);
  assert.deepEqual([manifest.schema, manifest.commit, manifest.workers.map((w: { name: string }) => w.name)], ["forge-bundles.v1", SHA, ["cryptophys-demo"]]);
  assert.equal(b.objects.get(`${BUNDLE_PREFIX}${SHA}/cryptophys-demo.mjs`)!.value, "export default { fetch() {} };");
  // G2b: the commit's D1 migrations, sorted, so the deploy can tell a code-only change from a migration.
  assert.deepEqual(manifest.migrations, ["0001_a.sql", "0002_b.sql"]);
  assert.equal((db as any).raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.bundles_stored'").get().n, 1);
  // The check's own record never holds module text.
  assert.doesNotMatch(String((db as any).raw.prepare("SELECT steps FROM forge_check_runs WHERE commit_sha = ?").get(SHA).steps), /fetch\(\)/);

  const failedDb = migratedDb();
  const fb = bucket();
  await tickWith({ DB: failedDb as never, ARTIFACTS: { get: async () => repoWith(FILES) }, BUNDLES: fb }, "platform", deps("fail"), () => Date.now(), async () => SHA, "main");
  assert.equal(fb.objects.size, 0, "a failed check stores nothing");
  const crDb = migratedDb();
  const cb = bucket();
  await tickWith({ DB: crDb as never, ARTIFACTS: { get: async () => repoWith(FILES) }, BUNDLES: cb }, "platform", deps("pass"), () => Date.now(), async () => SHA, "change");
  assert.equal(cb.objects.size, 0, "a change request is not a deploy candidate");
});

test("G2a-3. bundles older than the retention are deleted; the manifest is written last; wiring", async () => {
  const b = bucket();
  const order: string[] = [];
  const put = b.put.bind(b);
  b.put = async (k, v, o) => { order.push(k); return put(k, v, o); };
  await storeBundles(b, SHA, [{ dir: "workers/demo", text: "x", toml: TOML, external: [] }]);
  assert.equal(order.at(-1), `${BUNDLE_PREFIX}${SHA}/manifest.json`);
  for (const o of b.objects.values()) o.uploaded = new Date(Date.now() - (BUNDLE_RETENTION_DAYS + 1) * 86_400_000);
  await storeBundles(b, "e".repeat(40), [{ dir: "workers/demo", text: "y", toml: TOML, external: [] }]);
  assert.equal(await pruneBundles(b), 2);
  assert.deepEqual([...b.objects.keys()].sort(), [`${BUNDLE_PREFIX}${"e".repeat(40)}/cryptophys-demo.mjs`, `${BUNDLE_PREFIX}${"e".repeat(40)}/manifest.json`]);
  await assert.rejects(storeBundles(b, "nope", []), /invalid_commit_sha/);
  assert.match(read("workers/forge/wrangler.toml"), /\[\[r2_buckets\]\]\nbinding = "BUNDLES"\nbucket_name = "cryptophys-forge-bundles"/);
});

test("G2b-0. the manifest's migrations are the commit's control-plane migration files, sorted; absent when not given", async () => {
  assert.deepEqual(migrationsOf(["workers/control-plane-migrations/0010_x.sql", "workers/control-plane-migrations/0002_y.sql", "workers/control-plane-migrations/test_migrations.py", "workers/other/0001.sql", "workers/control-plane-migrations/sub/0003.sql"]), ["0002_y.sql", "0010_x.sql"]);
  const b = bucket();
  const without = await storeBundles(b, SHA, [{ dir: "workers/demo", text: "x", toml: TOML, external: [] }]);
  assert.equal("migrations" in without, false, "schema v1 stays compatible: the field is new and optional");
  const withList = await storeBundles(b, SHA, [{ dir: "workers/demo", text: "x", toml: TOML, external: [] }], Date.now(), ["0002.sql", "0001.sql"]);
  assert.deepEqual([withList.schema, withList.migrations], ["forge-bundles.v1", ["0001.sql", "0002.sql"]]);
});
