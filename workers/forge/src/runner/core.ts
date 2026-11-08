// ADR-0012 phase 3: the Forge test runner core, shared by the Forge (Dynamic Workers on Cloudflare)
// and tools/forge-runner (the same code in local workerd). Nothing here touches Node or the network:
// the repository comes in as a snapshot (repo-relative path -> text) and esbuild comes in as a
// parameter (esbuild-wasm in the isolate, or native esbuild in tools).
//
// A run bundles every control-plane test file against the snapshot, with node:test, node:sqlite,
// node:fs, node:os and node:child_process replaced by the shims in ./shims, and runs the bundles in
// fresh Dynamic Workers, a few files per Worker (one request may make at most 32 Worker invocations).

export type Snapshot = Record<string, string>;
export type ShimName = "test" | "sqlite" | "fs" | "os" | "child_process";
export type ShimSources = Record<ShimName, string>;

export interface EsbuildOutput { outputFiles?: Array<{ text: string; contents: Uint8Array }>; errors: unknown[]; warnings: unknown[] }
export interface EsbuildLike { build(options: Record<string, unknown>): Promise<EsbuildOutput> }

/** Directories never taken into a snapshot, and files kept out of it (binary or too large). */
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".wrangler"]);
export const BINARY_FILE = /\.(png|jpg|gz|wasm|ico|woff2?)$/;
export const MAX_FILE_BYTES = 2_000_000;
export const TEST_DIR = "workers/control-plane-shared/test";
/** Test files per Dynamic Worker. 43 files today, so 6 Workers per run. */
export const FILES_PER_WORKER = 8;
export const COMPATIBILITY_DATE = "2026-11-01";
const SHIMMED = /^node:(test|sqlite|fs|os|child_process)$/;
const IMPORT_META_URL = ["import", "meta", "url"].join(".");

export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Whether a repository path belongs in a snapshot (size is checked separately, once read). */
export function snapshotPathAllowed(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  return name !== "" && !parts.slice(0, -1).some((p) => SKIP_DIRS.has(p)) && !BINARY_FILE.test(name);
}

export function testFiles(snapshot: Snapshot): string[] {
  const prefix = TEST_DIR + "/";
  return Object.keys(snapshot)
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/") && p.endsWith(".test.ts"))
    .sort();
}

export function groupFiles(files: string[], size = FILES_PER_WORKER): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < files.length; i += size) groups.push(files.slice(i, i + size));
  return groups;
}

function resolveIn(snapshot: Snapshot, path: string): string | null {
  for (const candidate of [path, path + ".ts", path + ".js", path + "/index.ts", path + "/index.js"]) {
    if (Object.prototype.hasOwnProperty.call(snapshot, candidate)) return candidate;
  }
  return null;
}

function loaderFor(path: string): string {
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".json")) return "json";
  return "js";
}

interface ResolveArgs { path: string; importer: string; kind: string }
interface PluginBuild {
  onResolve(o: { filter: RegExp; namespace?: string }, f: (a: ResolveArgs) => unknown): void;
  onLoad(o: { filter: RegExp; namespace?: string }, f: (a: { path: string }) => unknown): void;
}

/**
 * An esbuild plugin that reads only from the snapshot. node:* and cloudflare:* stay external, unless
 * they are shimmed. Bare package imports are refused: the platform's Workers and tests have none,
 * and a snapshot has no node_modules.
 */
export function snapshotPlugin(snapshot: Snapshot, opts: { shims?: ShimSources; importMetaUrl?: boolean } = {}) {
  return {
    name: "forge-snapshot",
    setup(build: PluginBuild) {
      const shims = opts.shims;
      if (shims) build.onResolve({ filter: SHIMMED }, (a) => ({ path: a.path.slice("node:".length), namespace: "forge-shim" }));
      build.onResolve({ filter: /^(node|cloudflare):/ }, (a) => ({ path: a.path, external: true }));
      build.onResolve({ filter: /.*/ }, (a) => {
        const base = a.importer ? a.importer.split("/").slice(0, -1).join("/") : "";
        const relative = a.path.startsWith("./") || a.path.startsWith("../");
        if (!relative && a.kind !== "entry-point") return { errors: [{ text: `"${a.path}" is not in the snapshot (package imports are not available)` }] };
        const found = resolveIn(snapshot, normalizePath(relative ? base + "/" + a.path : a.path));
        return found ? { path: found, namespace: "forge-snapshot" } : { errors: [{ text: `cannot resolve ${a.path} from ${a.importer || "the entry point"}` }] };
      });
      if (shims) build.onLoad({ filter: /.*/, namespace: "forge-shim" }, (a) => ({ contents: shims[a.path as ShimName], loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "forge-snapshot" }, (a) => {
        let contents = snapshot[a.path];
        // Each test reads files relative to its own module, so the module URL becomes its repository
        // path. (The token is assembled so that this file survives its own rewrite when bundled.)
        if (opts.importMetaUrl && a.path.endsWith(".ts")) contents = contents.replaceAll(IMPORT_META_URL, JSON.stringify("file:///repo/" + a.path));
        return { contents, loader: loaderFor(a.path) };
      });
    },
  };
}

const RUNTIME_IMPORT = /^import .* from "(node|cloudflare):[^"]+";$/;

/**
 * Workers evaluate modules at startup, when the clock reads 0, so a test module's top level (harness
 * keys, signed JWTs) is deferred into `__load()`, which the runner entry calls per file. Runtime
 * imports stay at the top, and the bundle's trailing export block is dropped.
 */
export function deferTopLevel(bundled: string): string {
  const lines = bundled.replace(/^export \{[^}]*\};\s*$/m, "").split("\n");
  const imports = lines.filter((l) => RUNTIME_IMPORT.test(l));
  const body = lines.filter((l) => !RUNTIME_IMPORT.test(l));
  return imports.join("\n") + "\nexport async function __load() {\n" + body.join("\n") + "\n}\n";
}

const COMMON = { bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", target: "es2022" };

export async function bundleTest(esbuild: EsbuildLike, snapshot: Snapshot, shims: ShimSources, file: string): Promise<string> {
  const r = await esbuild.build({ ...COMMON, entryPoints: [file], plugins: [snapshotPlugin(snapshot, { shims, importMetaUrl: true })] });
  const text = r.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error("esbuild produced no output for " + file);
  return deferTopLevel(text);
}

/** sql.js (SQLite in WebAssembly) as one ES module, with its optional Node paths emptied. */
export async function bundleSqlJs(esbuild: EsbuildLike, sqlWasmJs: string): Promise<string> {
  const empty = { name: "empty-node", setup(b: PluginBuild) {
    b.onResolve({ filter: /^(fs|path|crypto)$/ }, () => ({ path: "empty", namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "module.exports = {};", loader: "js" }));
  } };
  const r = await esbuild.build({ ...COMMON, stdin: { contents: sqlWasmJs, loader: "js", sourcefile: "sql-wasm.js" }, define: { process: "undefined" }, plugins: [empty] });
  const text = r.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error("esbuild produced no output for sql.js");
  return text;
}

export interface WorkerBundle { bytes: number; errors: number; warnings: number }

/** Bundle a Worker as Wrangler would: the `main` from its wrangler.toml, ESM, runtime imports external. */
export async function bundleWorkerDir(esbuild: EsbuildLike, snapshot: Snapshot, dir: string): Promise<WorkerBundle> {
  const toml = snapshot[normalizePath(dir + "/wrangler.toml")];
  if (toml === undefined) throw new Error("no wrangler.toml in " + dir);
  const main = /^main\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!main) throw new Error("wrangler.toml in " + dir + " has no main");
  const r = await esbuild.build({ ...COMMON, entryPoints: [normalizePath(dir + "/" + main)], conditions: ["workerd", "worker", "browser"], plugins: [snapshotPlugin(snapshot)] });
  return { bytes: r.outputFiles?.[0]?.contents.length ?? 0, errors: r.errors.length, warnings: r.warnings.length };
}

/**
 * The main module of each test Worker. It runs the files it is given in order. Each file gets a
 * fresh test registry and scratch filesystem; sql.js and the snapshot are shared. Worker bundling
 * (TP-025) goes back to the Forge through env.BUNDLER, because the test Worker has no esbuild.
 */
export const RUNNER_ENTRY = `
import wasm from "./sql-wasm.wasm";
import snapshotText from "./snapshot.json.txt";
import initSqlJs from "./sql.js";
import files from "./files.json";
const loaders = { /*LOADERS*/ };
export default { async fetch(request, env) {
  globalThis.__VFS = JSON.parse(snapshotText);
  if (!globalThis.location) globalThis.location = { href: "http://runner/" };
  if (env && env.BUNDLER) globalThis.__FORGE_BUNDLE = (dir) => env.BUNDLER.bundleWorker(dir);
  globalThis.__SQL = await initSqlJs({ instantiateWasm(imports, done) { WebAssembly.instantiate(wasm, imports).then((i) => done(i)); return {}; } });
  await new Promise((r) => setTimeout(r, 5)); // advance the clock (it only moves on I/O)
  const report = [];
  for (const file of files) {
    globalThis.__TESTS = undefined; globalThis.__MEMFS = undefined; globalThis.__T0 = Date.now();
    const out = { file, results: [] };
    report.push(out);
    try { await (await loaders[file]()).__load(); } catch (e) { out.load_error = String(e && e.stack || e).slice(0, 800); continue; }
    const reg = globalThis.__TESTS || { tests: [], before: [], after: [] };
    for (const t of reg.tests) {
      if (t.skip || t.todo) { out.results.push({ name: t.name, status: "skip" }); continue; }
      try { for (const h of reg.before) await h(); await t.fn({}); for (const h of reg.after) await h(); out.results.push({ name: t.name, status: "pass" }); }
      catch (e) { out.results.push({ name: t.name, status: "fail", error: (String(e && e.message || e) + " | actual=" + JSON.stringify(e && e.actual)?.slice(0, 300) + " expected=" + JSON.stringify(e && e.expected)?.slice(0, 200) + " | " + String(e && e.stack || "").split("\\n").slice(1, 3).join(" ")).slice(0, 900) }); }
    }
  }
  return Response.json({ files: report });
} };`;

export function testModuleName(file: string): string {
  return "test-" + file.split("/").pop()!.replace(/\W/g, "_") + ".js";
}

export function runnerEntry(files: string[]): string {
  const loaders = files.map((f) => `${JSON.stringify(f)}: () => import(${JSON.stringify("./" + testModuleName(f))})`).join(", ");
  return RUNNER_ENTRY.replace("/*LOADERS*/", loaders);
}

export interface FileReport { file: string; load_error?: string; results?: Array<{ name: string; status: string; error?: string }> }
export interface SuiteResult { files: number; pass: number; fail: number; skip: number; failures: string[] }

export function emptyResult(): SuiteResult {
  return { files: 0, pass: 0, fail: 0, skip: 0, failures: [] };
}

/** Fold one test Worker's report into the run. A file the Worker did not report counts as a failure. */
export function tally(into: SuiteResult, expected: string[], report: { files?: FileReport[] } | null, workerError?: string): SuiteResult {
  const byFile = new Map((report?.files ?? []).map((f) => [f.file, f]));
  for (const file of expected) {
    into.files++;
    const name = file.split("/").pop();
    const f = byFile.get(file);
    if (!f) { into.fail++; into.failures.push(`${name}: RUN ${workerError ?? "no report from the test Worker"}`); continue; }
    if (f.load_error) { into.fail++; into.failures.push(`${name}: LOAD ${f.load_error}`); }
    for (const r of f.results ?? []) {
      if (r.status === "pass") into.pass++;
      else if (r.status === "skip") into.skip++;
      else { into.fail++; into.failures.push(`${name} :: ${r.name}: ${r.error ?? "failed"}`); }
    }
  }
  return into;
}

export interface TestWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, unknown>;
  env?: Record<string, unknown>;
  globalOutbound: null;
}

/** The Dynamic Worker for one group of bundled test files. Tests get no network access. */
export function testWorkerCode(group: Array<{ file: string; code: string }>, shared: { snapshotText: string; sqlJs: string; sqlWasm: unknown }, env?: Record<string, unknown>): TestWorkerCode {
  const modules: Record<string, unknown> = {
    "entry.js": runnerEntry(group.map((g) => g.file)),
    "sql.js": shared.sqlJs,
    "sql-wasm.wasm": { wasm: shared.sqlWasm },
    "snapshot.json.txt": { text: shared.snapshotText },
    "files.json": { json: group.map((g) => g.file) },
  };
  for (const g of group) modules[testModuleName(g.file)] = g.code;
  return { compatibilityDate: COMPATIBILITY_DATE, mainModule: "entry.js", modules, env, globalOutbound: null };
}

export interface SuiteDeps {
  esbuild: EsbuildLike;
  shims: ShimSources;
  sqlJs: string;
  sqlWasm: unknown;
  /** Runs one test Worker and returns its JSON report. */
  runWorker(code: TestWorkerCode): Promise<{ files?: FileReport[] }>;
  /** Passed to every test Worker as env.BUNDLER. */
  bundler?: unknown;
}

/** Bundle and run the whole suite (or `only`) against a snapshot. Never throws for a failing test. */
export async function runSuite(deps: SuiteDeps, snapshot: Snapshot, only?: string[]): Promise<SuiteResult> {
  const files = only ?? testFiles(snapshot);
  const snapshotText = JSON.stringify(snapshot);
  const result = emptyResult();
  for (const group of groupFiles(files)) {
    const bundled: Array<{ file: string; code: string }> = [];
    const unbundled: string[] = [];
    for (const file of group) {
      try { bundled.push({ file, code: await bundleTest(deps.esbuild, snapshot, deps.shims, file) }); }
      catch (e) { result.files++; result.fail++; result.failures.push(`${file.split("/").pop()}: BUNDLE ${String((e as Error)?.message ?? e).slice(0, 300)}`); unbundled.push(file); }
    }
    if (bundled.length === 0) continue;
    const expected = bundled.map((b) => b.file);
    try {
      const report = await deps.runWorker(testWorkerCode(bundled, { snapshotText, sqlJs: deps.sqlJs, sqlWasm: deps.sqlWasm }, deps.bundler ? { BUNDLER: deps.bundler } : undefined));
      tally(result, expected, report);
    } catch (e) {
      tally(result, expected, null, String((e as Error)?.message ?? e).slice(0, 300));
    }
  }
  return result;
}
