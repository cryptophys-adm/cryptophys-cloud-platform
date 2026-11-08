// The Forge bundler (ADR-0012 phase 3): esbuild-wasm inside the isolate, reading the repository
// snapshot (globalThis.__VFS). bundleWorker("workers/home") bundles the Worker named by that
// directory's wrangler.toml `main` the way Wrangler would (ESM, workerd conditions, node: and
// cloudflare: external) and reports its size and errors.
import * as esbuild from "./esbuild.js";
import wasm from "./esbuild.wasm";

let ready;
const norm = (p) => { const out = []; for (const s of p.split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); } return out.join("/"); };

export async function bundleWorker(dir) {
  ready ??= esbuild.initialize({ wasmModule: wasm, worker: false });
  await ready;
  const vfs = globalThis.__VFS;
  const toml = vfs[norm(dir + "/wrangler.toml")];
  if (!toml) throw new Error("no wrangler.toml in " + dir);
  const main = /^main\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!main) throw new Error("wrangler.toml has no main");
  const plugin = { name: "vfs", setup(b) {
    b.onResolve({ filter: /^(cloudflare|node):/ }, (a) => ({ path: a.path, external: true }));
    b.onResolve({ filter: /.*/ }, (a) => {
      const base = a.importer ? a.importer.split("/").slice(0, -1).join("/") : "";
      const p = norm((a.path.startsWith(".") ? base + "/" : "") + a.path);
      for (const c of [p, p + ".ts", p + ".js", p + "/index.ts", p + "/index.js"]) if (c in vfs) return { path: c, namespace: "vfs" };
      return { errors: [{ text: "cannot resolve " + a.path + " from " + (a.importer || "entry") }] };
    });
    b.onLoad({ filter: /.*/, namespace: "vfs" }, (a) => ({ contents: vfs[a.path], loader: /\.tsx?$/.test(a.path) ? "ts" : a.path.endsWith(".json") ? "json" : "js" }));
  } };
  const r = await esbuild.build({ entryPoints: [norm(dir + "/" + main)], bundle: true, format: "esm", write: false, plugins: [plugin],
    target: "es2022", logLevel: "silent", conditions: ["workerd", "worker", "browser"] });
  return { bytes: r.outputFiles[0].contents.length, errors: r.errors.length, warnings: r.warnings.length };
}
