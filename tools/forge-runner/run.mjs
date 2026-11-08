// ADR-0012 phase 3: run the Forge checks locally, in workerd (the Workers runtime), with the Forge's
// own code (workers/forge/src/checks.ts and runner/): the suite is bundled by esbuild-wasm inside the
// isolate and run in Dynamic Workers, exactly as the Forge Worker does on Cloudflare. The only
// stand-in is the Artifacts repo, which this script builds from the working tree (tracked and
// untracked, not ignored files).
//
//   node tools/forge-runner/run.mjs [file.test.ts]   (from the repository root, after npm ci in
//                                                     workers/control-plane-shared)
// Prints one JSON summary line, then one FAIL line per failure. Exit code 0 only if every test passes.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = join(HERE, "../..");
const SHARED = join(REPO, "workers/control-plane-shared");
const req = createRequire(join(SHARED, "package.json"));
const esbuild = req("esbuild");
const WORKERD = join(SHARED, "node_modules/workerd/bin/workerd");
const TMP = mkdtempSync(join(tmpdir(), "forge-runner-"));
const only = process.argv[2];

// 1. A stand-in Artifacts repo: git-style trees over the working tree, hashed by content.
const sha1 = (data) => createHash("sha1").update(data).digest("hex");
const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO }).toString().split("\0").filter(Boolean);
const dump = { head: "", commits: {}, trees: {}, blobs: {} };
const root = {};
for (const p of paths) {
  let st;
  try { st = lstatSync(join(REPO, p)); } catch { continue; } // deleted but still in the index
  let node = root;
  const parts = p.split("/");
  for (const dir of parts.slice(0, -1)) node = (node[dir] ??= {});
  const name = parts[parts.length - 1];
  if (st.isSymbolicLink()) { node[name] = { type: "symlink", mode: "120000", hash: sha1("link " + p) }; continue; }
  const bytes = readFileSync(join(REPO, p));
  const hash = sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
  node[name] = { type: st.mode & 0o111 ? "exec" : "blob", mode: st.mode & 0o111 ? "100755" : "100644", hash };
  if (!/\.(png|jpg|gz|wasm|ico|woff2?)$/.test(name)) dump.blobs[hash] = bytes.toString("utf8");
}
function writeTree(node) {
  const entries = Object.keys(node).sort().map((name) => {
    const v = node[name];
    return v.type ? { name, mode: v.mode, hash: v.hash, type: v.type } : { name, mode: "40000", hash: writeTree(v), type: "tree" };
  });
  const hash = sha1("tree " + JSON.stringify(entries));
  dump.trees[hash] = entries;
  return hash;
}
const treeHash = writeTree(root);
dump.head = sha1("commit " + treeHash);
dump.commits[dump.head] = { hash: dump.head, treeHash };
writeFileSync(join(TMP, "repo.json.txt"), JSON.stringify(dump));

// 2. Bundle the harness (the Forge checks code) the way Wrangler bundles the Forge Worker: wasm
//    imports become wasm modules, the runner shims and the sql.js glue become text.
const wasm = new Map();
const assetsPlugin = {
  name: "forge-assets",
  setup(b) {
    b.onResolve({ filter: /\.wasm$/ }, (a) => {
      const abs = join(a.resolveDir, a.path);
      wasm.set(basename(abs), abs);
      return { path: "./" + basename(abs), external: true };
    });
    b.onResolve({ filter: /^\.\/repo\.json\.txt$/ }, () => ({ path: "./repo.json.txt", external: true }));
    b.onLoad({ filter: /(runner\/shims\/[^/]+\.js|sql\.js\/dist\/sql-wasm\.js)$/ }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
  },
};
await esbuild.build({ entryPoints: [join(HERE, "harness.ts")], outfile: join(TMP, "harness.js"), bundle: true, format: "esm", platform: "neutral",
  external: ["cloudflare:*", "node:*"], mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"], target: "es2022", logLevel: "error", plugins: [assetsPlugin] });
for (const [name, abs] of wasm) copyFileSync(abs, join(TMP, name));

// 3. Serve it from workerd with a Worker Loader binding, and run the suite once.
const port = 18000 + Math.floor(Math.random() * 2000);
writeFileSync(join(TMP, "config.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "forge", worker = .w) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "forge") ],
);
const w :Workerd.Worker = (
  modules = [
    (name = "harness.js", esModule = embed "harness.js"),
    (name = "repo.json.txt", text = embed "repo.json.txt"),
${[...wasm.keys()].map((n) => `    (name = "${n}", wasm = embed "${n}"),`).join("\n")}
  ],
  bindings = [ (name = "LOADER", workerLoader = ()) ],
  compatibilityDate = "2026-11-01",
);`);
const proc = spawn(WORKERD, ["serve", join(TMP, "config.capnp"), "--experimental"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
proc.stderr.on("data", (d) => { stderr += d; });
let run = null;
try {
  for (let i = 0; i < 100 && !run; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/` + (only ? "?only=" + encodeURIComponent(only) : ""), { signal: AbortSignal.timeout(15 * 60_000) });
      run = res.ok ? await res.json() : { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}` };
    } catch (e) { if (!String(e?.cause?.code ?? e).includes("ECONNREFUSED")) run = { error: String(e).slice(0, 400) }; }
  }
} finally { proc.kill("SIGKILL"); }
if (!run || run.error) {
  console.log(JSON.stringify({ runtime: "workerd", error: run?.error ?? "workerd did not answer" }));
  console.log("FAIL", stderr.replace(/\n/g, " ⏎ ").slice(0, 1200));
  process.exit(1);
}
console.log(JSON.stringify({ runtime: "workerd", runner: "forge", files: run.files, pass: run.pass, fail: run.fail, skip: run.skip, unexpected: run.fail, duration_ms: run.duration_ms, snapshot_files: run.snapshot_files }));
for (const x of run.failures) console.log("FAIL", String(x).replace(/\n/g, " ⏎ ").slice(0, 600));
process.exit(run.fail === 0 ? 0 : 1);
