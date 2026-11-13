// ADR-0012 G2c-2 (§5l): POST /v1/forge/console-dist keeps the built Console UI of a commit in R2, from the CI
// service token only (as /v1/forge/typecheck-report), so the Orchestrator can upload it as static assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { APPROVER_JWT, CI_JWT, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import { MAX_FILE_BYTES, validateConsoleDist } from "../../forge/src/console-dist.ts";
import { readConsoleDist, buildAssetsManifest } from "../../deployment-orchestrator/src/assets-upload.ts";

const SHA = "d".repeat(40);
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const FILES = [
  { path: "index.html", content_base64: b64("<!doctype html><title>Console</title>"), content_type: "text/html; charset=utf-8" },
  { path: "assets/index-Bx1.js", content_base64: b64("export{}"), content_type: "text/javascript" },
  { path: "assets/font.woff2", content_base64: b64(new Uint8Array([0, 1, 2, 255])), content_type: "font/woff2" },
];
const body = (over: Record<string, unknown> = {}) => ({ confirm: "UPLOAD", commit: SHA, files: FILES, ...over });

function fakeBucket() {
  const objects = new Map<string, { value: Uint8Array; contentType?: string; custom?: Record<string, string> }>();
  const puts: string[] = [];
  return {
    objects, puts,
    async get(key: string) {
      const o = objects.get(key);
      return o ? { text: async () => new TextDecoder().decode(o.value), arrayBuffer: async () => o.value.slice().buffer } : null;
    },
    async put(key: string, value: string | Uint8Array, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      puts.push(key);
      objects.set(key, { value: typeof value === "string" ? new TextEncoder().encode(value) : value, contentType: opts?.httpMetadata?.contentType, custom: opts?.customMetadata });
    },
  };
}
const envWith = (bucket: ReturnType<typeof fakeBucket> | undefined, db = migratedDb()) => ({ ...baseEnv("cryptophys-forge", db), ARTIFACTS: undefined, BUNDLES: bucket });

test("FD1. CI service token with UPLOAD only, exactly as the type-check report", async () => {
  const bucket = fakeBucket();
  const env = envWith(bucket);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/console-dist", body(), OPERATOR_JWT))).body.error, "service_token_required");
  assert.equal((await call(forge, env, req("POST", "/v1/forge/console-dist", body(), APPROVER_JWT))).status, 403);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/console-dist", body(), null))).status, 403, "no Access JWT");
  assert.equal((await call(forge, env, req("POST", "/v1/forge/console-dist", body({ confirm: "yes" }), CI_JWT))).body.error, "confirmation_required");
  assert.equal(bucket.puts.length, 0, "nothing is written before authorization and confirmation");
  const r = await call(forge, env, req("POST", "/v1/forge/console-dist", body(), CI_JWT));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { commit: SHA, files: 3, total_bytes: 37 + 8 + 4, stored: true });
  assert.equal((await call(forge, envWith(undefined), req("POST", "/v1/forge/console-dist", body(), CI_JWT))).status, 503);
});

test("FD2. validation: commit, paths (no .., no absolute, no duplicates), base64, content type, index.html, size and count caps", async () => {
  const env = envWith(fakeBucket());
  const bad = async (over: Record<string, unknown>, error: string) => {
    const r = await call(forge, env, req("POST", "/v1/forge/console-dist", body(over), CI_JWT));
    assert.deepEqual([r.status, r.body.error], [400, error], JSON.stringify(over).slice(0, 120));
  };
  const f0 = FILES[0];
  await bad({ commit: "abc" }, "invalid_commit");
  await bad({ files: [] }, "invalid_files");
  await bad({ files: "x" }, "invalid_files");
  for (const path of ["../etc/passwd", "a/../b.js", "/index.html", "a//b.js", "./a.js", "a\\b.js", "a b.js", "x".repeat(513), ""]) {
    await bad({ files: [f0, { ...f0, path }] }, "invalid_path");
  }
  await bad({ files: [f0, f0] }, "duplicate_path");
  await bad({ files: [{ ...f0, content_base64: "not base64!" }] }, "invalid_content");
  await bad({ files: [{ ...f0, content_type: "text" }] }, "invalid_content_type");
  await bad({ files: [{ ...FILES[1] }] }, "index_html_missing");
  await bad({ files: [f0, null] }, "invalid_file");
  // The caps are checked by the validator directly (a 25 MiB body is not built here).
  await assert.rejects(validateConsoleDist({ commit: SHA, files: Array.from({ length: 20_001 }, (_, i) => ({ ...f0, path: `f${i}` })) }), /too_many_files/);
  await assert.rejects(validateConsoleDist({ commit: SHA, files: [f0, { ...f0, path: "big.bin", content_base64: "A".repeat(Math.ceil((MAX_FILE_BYTES + 3) / 3) * 4) }] }), /file_too_large/);
  // Exactly the cap is accepted (and checked in one pass, without a stack-hungry regular expression).
  const atCap = await validateConsoleDist({ commit: SHA, files: [f0, { ...f0, path: "max.bin", content_base64: Buffer.alloc(MAX_FILE_BYTES).toString("base64") }] });
  assert.equal(atCap.files.find((f) => f.path === "max.bin")?.size, MAX_FILE_BYTES);
  for (const s of ["QQ=", "Q===", "QQ=A", "QUJD\n"]) await bad({ files: [{ ...f0, content_base64: s }] }, "invalid_content");
  const big = await call(forge, env, req("POST", "/v1/forge/console-dist", body(), CI_JWT, { "content-length": String(64 * 1024 * 1024) }));
  assert.equal(big.status, 413, "an oversized request is refused before it is read");
});

test("FD3. storage: bundles/<sha>/console-dist/<path> with content types, the list last, an audit event; written once per commit", async () => {
  const bucket = fakeBucket();
  const db = migratedDb();
  const env = envWith(bucket, db);
  assert.equal((await call(forge, env, req("POST", "/v1/forge/console-dist", body(), CI_JWT))).status, 200);
  assert.equal(bucket.puts[bucket.puts.length - 1], `bundles/${SHA}/console-dist.json`, "the list is written last");
  assert.deepEqual(bucket.puts.slice(0, -1).sort(), [`bundles/${SHA}/console-dist/assets/font.woff2`, `bundles/${SHA}/console-dist/assets/index-Bx1.js`, `bundles/${SHA}/console-dist/index.html`]);
  const font = bucket.objects.get(`bundles/${SHA}/console-dist/assets/font.woff2`)!;
  assert.deepEqual([...font.value], [0, 1, 2, 255]);
  assert.equal(font.contentType, "font/woff2");
  assert.equal(font.custom?.sha256, createHash("sha256").update(new Uint8Array([0, 1, 2, 255])).digest("hex"));
  const list = JSON.parse(new TextDecoder().decode(bucket.objects.get(`bundles/${SHA}/console-dist.json`)!.value));
  assert.equal(list.schema, "forge-console-dist.v1");
  assert.deepEqual(list.files.map((f: any) => [f.path, f.size, f.content_type]), [["assets/font.woff2", 4, "font/woff2"], ["assets/index-Bx1.js", 8, "text/javascript"], ["index.html", 37, "text/html; charset=utf-8"]]);
  const audits = (db as any).raw.prepare("SELECT outcome, subject FROM audit_events WHERE event_type = 'forge.console_dist_stored'").all();
  assert.deepEqual(audits.map((a: any) => [a.outcome, a.subject]), [["stored", SHA]]);
  // The same files again: accepted, nothing rewritten. Different files: refused.
  const again = await call(forge, env, req("POST", "/v1/forge/console-dist", body(), CI_JWT));
  assert.deepEqual([again.status, again.body.stored], [200, false]);
  assert.equal(bucket.puts.length, 4);
  const other = await call(forge, env, req("POST", "/v1/forge/console-dist", body({ files: [{ ...FILES[0], content_base64: b64("changed") }] }), CI_JWT));
  assert.deepEqual([other.status, other.body.error], [409, "console_dist_conflict"]);
  // What the Forge stored is exactly what the Orchestrator's uploader reads back.
  const files = await readConsoleDist(bucket, SHA);
  assert.deepEqual(Object.keys((await buildAssetsManifest(files)).manifest).sort(), ["/assets/font.woff2", "/assets/index-Bx1.js", "/index.html"]);
});

test("FD4. wiring: one route line in the Forge, the handler in its own file; the build script posts the dist before the report", () => {
  const index = readFileSync(new URL("../../forge/src/index.ts", import.meta.url), "utf8");
  assert.equal(index.match(/\/v1\/forge\/console-dist"\) return await handleConsoleDist\(/g)?.length, 1);
  assert.match(index, /import \{ handleConsoleDist \} from "\.\/console-dist\.ts";/);
  const handler = readFileSync(new URL("../../forge/src/console-dist.ts", import.meta.url), "utf8");
  assert.match(handler, /identity\.type !== "service_token"\) return errorResponse\(403, "service_token_required"\)/);
  // ADR-0012 §5l step 7 (owner-visible): a build of main whose Console UI built posts its dist, then the report.
  const script = readFileSync(new URL("../../forge-typecheck/typecheck-and-report.mjs", import.meta.url), "utf8");
  assert.match(script, /new URL\("\/v1\/forge\/console-dist", forgeUrl\)/);
  assert.match(script, /JSON\.stringify\(\{ confirm: "UPLOAD", commit, files \}\)/);
  assert.match(script, /if \(uiBuild\.status === 0 && postsConsoleDist\(env\.WORKERS_CI_BRANCH\)\) \{/);
  const main = script.slice(script.indexOf("const selfUrl"));
  assert.ok(main.indexOf("await postDist(") > 0 && main.indexOf("await postDist(") < main.indexOf("await report(body, env)"), "the dist goes before the report");
  assert.match(main, /if \(distFailed\) process\.exit\(3\);/, "a failed dist post fails the build, as a failed report does");
});

test("FD5. the build script's dist post: every file of dist as the Forge validates it, headers as the report, failures refused", async () => {
  const { collectConsoleDist, distContentType, postConsoleDist, postsConsoleDist, MAX_DIST_BODY_BYTES } = await import("../../forge-typecheck/typecheck-and-report.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.deepEqual(["a.html", "a.js", "a.css", "a.svg", "a.json", "a.png", "a.woff2", "a.map", "LICENSE"].map(distContentType),
    ["text/html; charset=utf-8", "text/javascript", "text/css", "image/svg+xml", "application/json", "image/png", "font/woff2", "application/octet-stream", "application/octet-stream"]);
  assert.deepEqual(["main", "", undefined, " main ", "cr/12", "claude/x", "MAIN"].map(postsConsoleDist), [true, true, true, true, false, false, false]);
  assert.equal(MAX_DIST_BODY_BYTES, 36 * 1024 * 1024, "the Forge's request limit");

  const tmp = mkdtempSync(join(tmpdir(), "console-dist-"));
  try {
    // A fresh directory inside the temp one: the Forge's workerd runner seeds its temp directories with a file.
    const dir = join(tmp, "dist");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><script type=module src=./assets/index-a.js></script>");
    writeFileSync(join(dir, "assets", "index-a.js"), "export{}");
    // Text content only: the workerd runner's fs shim does not keep arbitrary bytes (the Forge tests above cover binary files).
    writeFileSync(join(dir, "assets", "font.woff2"), "wOF2");
    const files = collectConsoleDist(dir);
    assert.deepEqual(files.map((f: { path: string }) => f.path), ["assets/font.woff2", "assets/index-a.js", "index.html"]);
    assert.deepEqual(files.map((f: { content_base64: string }) => f.content_base64), [b64("wOF2"), b64("export{}"), b64("<!doctype html><script type=module src=./assets/index-a.js></script>")]);
    assert.deepEqual(files.map((f: { content_type: string }) => f.content_type), ["font/woff2", "text/javascript", "text/html; charset=utf-8"]);
    // What the script collects is what the Forge validates and stores.
    const valid = await validateConsoleDist({ commit: SHA, files });
    assert.equal(valid.files.length, 3);

    const seen: Array<{ url: string; init: RequestInit }> = [];
    const answer = (status: number, json: unknown) => async (url: URL, init: RequestInit) => { seen.push({ url: String(url), init }); return new Response(typeof json === "string" ? json : JSON.stringify(json), { status }); };
    const ok = await postConsoleDist(answer(200, { commit: SHA, files: 3, total_bytes: 10, stored: true }), "https://forge.example.workers.dev", "id.access", "secret", SHA, files);
    assert.equal(ok.stored, true);
    assert.equal(seen[0].url, "https://forge.example.workers.dev/v1/forge/console-dist");
    assert.equal(seen[0].init.method, "POST");
    assert.equal(seen[0].init.redirect, "manual");
    assert.deepEqual(seen[0].init.headers, { "content-type": "application/json", "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" });
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), { confirm: "UPLOAD", commit: SHA, files });
    await assert.rejects(postConsoleDist(answer(302, ""), "https://f.example", "i", "s", SHA, files), /Access refused the CI service token \(HTTP 302/);
    await assert.rejects(postConsoleDist(answer(409, { error: "console_dist_conflict" }), "https://f.example", "i", "s", SHA, files), /did not store the dist \(HTTP 409\)/);
    await assert.rejects(postConsoleDist(answer(200, { commit: "e".repeat(40) }), "https://f.example", "i", "s", SHA, files), /commit mismatch/);
    await assert.rejects(postConsoleDist(answer(200, "<html>sign in</html>"), "https://f.example", "i", "s", SHA, files), /invalid JSON/);
    const huge = [{ path: "big.js", content_base64: "A".repeat(MAX_DIST_BODY_BYTES), content_type: "text/javascript" }];
    const before = seen.length;
    await assert.rejects(postConsoleDist(answer(200, {}), "https://f.example", "i", "s", SHA, huge), /over the Forge's limit/);
    assert.equal(seen.length, before, "an oversized dist is never sent");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
