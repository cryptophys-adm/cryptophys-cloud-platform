// ADR-0012 phase 3: run the control-plane test suite in workerd (the Workers runtime) instead of Node.
//
// Each test file is bundled with esbuild; node:test, node:sqlite (sql.js), node:fs (a snapshot of the
// repository's text files), node:os and node:child_process are shimmed (shims/). Every file runs in a
// fresh workerd process. The same shims are what the Forge runner loads into Dynamic Workers.
//
//   node tools/forge-runner/run.mjs [file.test.ts]   (from the repository root, after npm ci in
//                                                     workers/control-plane-shared)
// Exit code 0 only if every test passes except the KNOWN_GAPS below, which need an in-isolate
// bundler (next step). Node CI still runs every test.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, relative, dirname } from "node:path";
const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = join(HERE, "../..");
const SHARED = join(REPO, "workers/control-plane-shared");
const req = createRequire(join(SHARED, "package.json"));
const esbuild = req("esbuild");
const WORKERD = join(SHARED, "node_modules/workerd/bin/workerd");

// 1. Repository snapshot (text files only; no node_modules, .git, build output).
const vfs = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", ".wrangler"].includes(name)) continue;
    const p = join(dir, name); const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.size < 2_000_000 && !/\.(png|jpg|gz|wasm|ico|woff2?)$/.test(name)) vfs[relative(REPO, p)] = readFileSync(p, "utf8");
  }
})(REPO);
const vfsText = JSON.stringify(vfs);
const TMP = mkdtempSync(join(tmpdir(), "forge-runner-"));
/** Tests that need an in-isolate bundler (Wrangler dry-run); they still run in Node CI. */
const KNOWN_GAPS = ["home-tp025.test.ts :: TP-025 Home Worker Wrangler dry-run bundle:"];

// 2. Bundle one test file per module, with node:* shims and per-file import.meta.url.
const alias = { "node:test": "node-test.js", "node:sqlite": "node-sqlite.js", "node:fs": "node-fs.js", "node:os": "node-os.js", "node:child_process": "node-child_process.js" };
const shimPlugin = {
  name: "forge-shims",
  setup(b) {
    b.onResolve({ filter: /^node:(test|sqlite|fs|os|child_process)$/ }, (a) => ({ path: join(HERE, "shims", alias[a.path]) }));
    b.onLoad({ filter: /\.ts$/ }, (a) => ({
      contents: readFileSync(a.path, "utf8").replaceAll("import.meta.url", JSON.stringify("file:///repo/" + relative(REPO, a.path))),
      loader: "ts",
    }));
  },
};
async function bundle(file) {
  const r = await esbuild.build({ entryPoints: [file], bundle: true, format: "esm", platform: "neutral", write: false, plugins: [shimPlugin],
    external: ["node:*", "cloudflare:*"], mainFields: ["module", "main"], conditions: ["workerd", "worker", "import"], logLevel: "silent", target: "es2022" });
  // workerd evaluates every configured module at startup, when Date.now() is 0. Defer the test
  // module's top level (harness keys, signed JWTs) into a function the entry calls per request.
  const text = r.outputFiles[0].text.replace(/^export \{[^}]*\};\s*$/m, "");
  const lines = text.split("\n");
  const imports = lines.filter((l) => /^import .* from "(node|cloudflare):[^"]+";$/.test(l));
  const body = lines.filter((l) => !/^import .* from "(node|cloudflare):[^"]+";$/.test(l));
  return imports.join("\n") + "\nexport async function __load() {\n" + body.join("\n") + "\n}\n";
}
const sqlJs = await esbuild.build({ entryPoints: [req.resolve("sql.js/dist/sql-wasm.js")], bundle: true, format: "esm", platform: "neutral", write: false,
  logLevel: "silent", define: { "process": "undefined" },
  plugins: [{ name: "empty-node", setup(b) { b.onResolve({ filter: /^(fs|path|crypto)$/ }, () => ({ path: "empty", namespace: "empty" })); b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "module.exports = {};", loader: "js" })); } }] });
const sqlJsText = sqlJs.outputFiles[0].text;
const sqlWasm = readFileSync(req.resolve("sql.js/dist/sql-wasm.wasm"));

const entry = `
import wasm from "./sql-wasm.wasm";
import vfsText from "./vfs.json.txt";
import initSqlJs from "./sql.js";
export default { async fetch() {
  globalThis.__VFS = JSON.parse(vfsText);
  if (!globalThis.location) globalThis.location = { href: "http://runner/" };
  globalThis.__SQL = await initSqlJs({ instantiateWasm(imports, done) { WebAssembly.instantiate(wasm, imports).then((i) => done(i)); return {}; } });
  const out = [];
  await new Promise((r) => setTimeout(r, 5)); // advance the workerd clock (it only moves on I/O)
  globalThis.__T0 = Date.now();
  try { await (await import("./test.js")).__load(); } catch (e) { return Response.json({ load_error: String(e && e.stack || e).slice(0, 800) }); }
  const reg = globalThis.__TESTS;
  for (const t of reg.tests) {
    if (t.skip || t.todo) { out.push({ name: t.name, status: "skip" }); continue; }
    try { for (const h of reg.before) await h(); await t.fn({}); for (const h of reg.after) await h(); out.push({ name: t.name, status: "pass" }); }
    catch (e) { out.push({ name: t.name, status: "fail", error: (String(e && e.message || e) + " | actual=" + JSON.stringify(e && e.actual)?.slice(0, 300) + " expected=" + JSON.stringify(e && e.expected)?.slice(0, 200) + " | " + String(e && e.stack || "").split("\\n").slice(1, 3).join(" ")).slice(0, 900) }); }
  }
  return Response.json({ results: out });
} };`;

const files = (process.argv[2] ? [process.argv[2]] : readdirSync(join(SHARED, "test")).filter((f) => f.endsWith(".test.ts")).sort());
let pass = 0, fail = 0, skip = 0; const failures = [];
for (const f of files) {
  let code;
  try { code = await bundle(join(SHARED, "test", f)); } catch (e) { failures.push(`${f}: BUNDLE ${String(e.message).slice(0, 300)}`); fail++; continue; }
  const dir = join(TMP, f.replace(/\W/g, "_")); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entry.js"), entry); writeFileSync(join(dir, "test.js"), code);
  writeFileSync(join(dir, "sql.js"), sqlJsText); writeFileSync(join(dir, "sql-wasm.wasm"), sqlWasm); writeFileSync(join(dir, "vfs.json.txt"), vfsText);
  const port = 18000 + Math.floor(Math.random() * 2000);
  writeFileSync(join(dir, "config.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "runner", worker = .w) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "runner") ],
);
const w :Workerd.Worker = (
  modules = [
    (name = "entry.js", esModule = embed "entry.js"),
    (name = "test.js", esModule = embed "test.js"),
    (name = "sql.js", esModule = embed "sql.js"),
    (name = "sql-wasm.wasm", wasm = embed "sql-wasm.wasm"),
    (name = "vfs.json.txt", text = embed "vfs.json.txt"),
  ],
  compatibilityDate = "2026-11-01",
  compatibilityFlags = ["nodejs_compat"],
);`);
  const proc = spawn(WORKERD, ["serve", join(dir, "config.capnp"), "--experimental"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; proc.stderr.on("data", (d) => { stderr += d; });
  try {
    let body = null;
    for (let i = 0; i < 100 && !body; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { const res = await fetch(`http://127.0.0.1:${port}/`); body = await res.json(); } catch {}
      if (proc.exitCode !== null) break;
    }
    if (!body) { failures.push(`${f}: RUN workerd did not answer: ${stderr.slice(0, 400)}`); fail++; }
    else {
      if (body.load_error) { failures.push(`${f}: LOAD ${body.load_error}`); fail++; }
      for (const r of body.results ?? []) {
        if (r.status === "pass") pass++; else if (r.status === "skip") skip++; else { fail++; failures.push(`${f} :: ${r.name}: ${r.error}`); }
      }
    }
  } finally { proc.kill("SIGKILL"); }
}
const isGap = (x) => KNOWN_GAPS.some((g) => x.startsWith(g));
const unexpected = failures.filter((x) => !isGap(x));
console.log(JSON.stringify({ runtime: "workerd", files: files.length, pass, fail, skip, known_gaps: failures.length - unexpected.length, unexpected: unexpected.length }));
for (const x of failures) console.log(isGap(x) ? "GAP " : "FAIL", String(x).replace(/\n/g, " ⏎ ").slice(0, 600));
process.exit(unexpected.length === 0 ? 0 : 1);
