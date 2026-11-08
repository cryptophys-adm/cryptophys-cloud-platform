#!/usr/bin/env bash
# ADR-0012 §5c: build the Forge type-check Container and run this repository's type-check in it,
# as the Forge does: no network, 1 GiB (the "basic" instance), the files under workers/ sent over
# HTTP. Fails if the image does not build, the toolchain is not the locked one, or a type error exists.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
image="forge-typecheck:ci"
name="forge-typecheck-smoke"
work="$(mktemp -d)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

docker build --quiet --tag "$image" "$root/workers/forge/typecheck" >/dev/null
node --input-type=module - "$root" "$work/payload.json" <<'JS'
import fs from "node:fs";
import path from "node:path";
const [root, out] = process.argv.slice(2);
const skip = new Set(["node_modules", "dist", ".wrangler", ".git"]);
const files = {};
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!skip.has(e.name)) walk(rel); continue; }
    if (!e.isFile() || fs.statSync(path.join(root, rel)).size >= 2_000_000) continue;
    const buf = fs.readFileSync(path.join(root, rel));
    if (buf.includes(0)) continue;
    files[rel] = buf.toString("utf8");
  }
})("workers");
fs.writeFileSync(out, JSON.stringify({ files, config: "workers/control-plane-tsconfig.json", modules: "workers/control-plane-shared/node_modules" }));
console.log(`payload: ${Object.keys(files).length} files`);
JS

docker run --detach --name "$name" --network none --memory 1g --cpus 1 "$image" >/dev/null
docker cp "$work/payload.json" "$name:/tmp/payload.json"
lock="$root/workers/control-plane-shared/package-lock.json"
docker exec -e LOCKED="$(node -e 'const l=require(process.argv[1]).packages;console.log(JSON.stringify({typescript:l["node_modules/typescript"].version,"@types/node":l["node_modules/@types/node"].version}))' "$lock")" "$name" node -e '
(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch("http://127.0.0.1:8080/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  try { await fetch("https://registry.npmjs.org/", { signal: AbortSignal.timeout(3000) }); console.error("::error::the type-check Container reached the internet"); process.exit(1); } catch {}
  const res = await fetch("http://127.0.0.1:8080/typecheck", { method: "POST", headers: { "content-type": "application/json" }, body: require("fs").readFileSync("/tmp/payload.json") });
  const body = await res.json();
  console.log(JSON.stringify({ status: res.status, toolchain: body.toolchain, files: body.files, errors: body.errors, ms: body.ms }));
  for (const d of body.diagnostics ?? []) console.log(d);
  if (res.status !== 200) { console.error("::error::type-check Container answered " + res.status + ": " + body.error); process.exit(1); }
  if (JSON.stringify(body.toolchain) !== JSON.stringify(JSON.parse(process.env.LOCKED))) { console.error("::error::Container toolchain " + JSON.stringify(body.toolchain) + " is not the locked " + process.env.LOCKED); process.exit(1); }
  if (body.errors !== 0) { console.error("::error::" + body.errors + " type error(s) in the Container type-check"); process.exit(1); }
})();'
echo "Type-check Container smoke passed."
