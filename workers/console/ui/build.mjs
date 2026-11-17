// The Console UI build: esbuild bundles src/main.tsx, Tailwind 4 (through PostCSS) builds src/index.css, and
// dist/index.html links the hashed files. It replaces vite (2026-11-17, owner: "Ganti vite ke esbuild"): every vite
// release depends on picomatch, which has an unfixed high npm advisory (GHSA-fc5q-39xc-vjpf) that the Forge's
// dependency audit reports for this lockfile; Tailwind 3 depended on it too, so Tailwind moves to 4 as well.
//
// What the Console Worker expects (workers/console/src, wrangler.toml [assets] ./ui/dist), as with vite:
//   - dist/ served as Workers Static Assets, the hashed files under assets/, the HTML shell revalidated;
//   - relative URLs only (ADR-0010: the same build works at nexus.cryptophys.work/console/ and at / on workers.dev);
//   - CSP `script-src 'self'; style-src 'self'`: external module scripts and stylesheets only, no inline script.
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = `${root}/dist`;

/** Each imported .css file goes through PostCSS with Tailwind 4 before esbuild bundles it. */
const tailwindPlugin = {
  name: "tailwind",
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await readFile(args.path, "utf8");
      const out = await postcss([tailwind({ base: root, optimize: { minify: true } })]).process(css, { from: args.path });
      return { contents: out.css, loader: "css" };
    });
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/assets`, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { index: "src/main.tsx" },
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "dist/assets",
  entryNames: "[name]-[hash]",
  chunkNames: "chunk-[hash]",
  assetNames: "[name]-[hash]",
  jsx: "automatic",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  logLevel: "warning",
  plugins: [tailwindPlugin],
});

// The entry's script and stylesheet, by their hashed names, linked relatively (./assets/...).
const outputs = Object.entries(result.metafile.outputs);
const entry = outputs.find(([, o]) => o.entryPoint === "src/main.tsx");
if (!entry) throw new Error("no entry output");
const [jsPath, jsOut] = entry;
const cssPath = jsOut.cssBundle;
const href = (p) => `./${relative(dist, `${root}/${p}`).split("\\").join("/")}`;

const html = await readFile(`${root}/index.html`, "utf8");
const tag = '<script type="module" src="/src/main.tsx"></script>';
if (!html.includes(tag)) throw new Error("index.html no longer has the entry script tag");
const shell = html
  .replace(`${tag}\n`, "")
  .replace(tag, "")
  .replace("</head>", `<script type="module" crossorigin src="${href(jsPath)}"></script>\n${cssPath ? `<link rel="stylesheet" crossorigin href="${href(cssPath)}">\n` : ""}</head>`);
await writeFile(`${dist}/index.html`, shell);

const kib = (p) => `${(result.metafile.outputs[p].bytes / 1024).toFixed(1)} KiB`;
for (const [p] of outputs) console.log(`${p}  ${kib(p)}`);
console.log("dist/index.html");
