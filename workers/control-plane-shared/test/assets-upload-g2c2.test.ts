// ADR-0012 G2c-2 (§5l): the Console's static assets uploaded through the Workers API, without GitHub.
// A fake Workers API checks every request the uploader makes: the manifest, the session JWT on uploads
// (never the API token), the multipart parts, and the completion token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AssetsUploader, assetHash, assetsMetadata, buildAssetsManifest, extensionOf, parseConsoleDistList, readConsoleDist, toBase64,
  CONSOLE_DIST_SCHEMA, type AssetFileMap,
} from "../../deployment-orchestrator/src/assets-upload.ts";

const ACCOUNT = "a".repeat(32);
const TOKEN = "cf-deploy-token-value";
const SESSION = "eyJzZXNzaW9u.eyJ1cGxvYWQ.c2ln";
const DONE = "eyJjb21wbGV0ZQ.eyJkb25l.c2ln";
const FILES: AssetFileMap = {
  "index.html": { text: "<!doctype html><script type=module src=/console/assets/app.js></script>", contentType: "text/html" },
  "assets/app-1a2b.js": { text: "console.log(1)", contentType: "application/javascript" },
  "assets/logo.svg": { bytes: new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x2f, 0x3e, 0xff, 0x00]), contentType: "image/svg+xml" },
};

/** The rule from Cloudflare's direct-upload example, computed independently with node:crypto. */
const reference = (bytes: Uint8Array, path: string) => createHash("sha256").update(Buffer.from(bytes).toString("base64") + (path.includes(".") ? path.split(".").pop() : "")).digest("hex").slice(0, 32);

interface Seen { url: string; method: string; auth: string | null; body: unknown; parts?: Array<{ name: string; type: string; value: string; filename: string }> }
function fakeApi(opts: { buckets?: (hashes: string[]) => string[][]; completeOn?: "last" | "first" | "never"; status?: number } = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.endsWith(`/accounts/${ACCOUNT}/workers/scripts/cryptophys-console/assets-upload-session`)) {
      const body = JSON.parse(String(init?.body));
      seen.push({ url, method: String(init?.method), auth, body });
      const hashes = Object.values(body.manifest as Record<string, { hash: string }>).map((m) => m.hash);
      return Response.json({ success: true, result: { jwt: SESSION, buckets: opts.buckets ? opts.buckets(hashes) : [hashes] } });
    }
    if (url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/assets/upload?base64=true`) {
      const form = init?.body as FormData;
      const parts: NonNullable<Seen["parts"]> = [];
      for (const [name, v] of form.entries()) {
        const f = v as File;
        parts.push({ name, type: f.type, value: await f.text(), filename: f.name });
      }
      seen.push({ url, method: String(init?.method), auth, body: null, parts });
      const uploads = seen.filter((s) => s.parts).length;
      const total = seen[0] ? (opts.buckets ? opts.buckets(Object.values((seen[0].body as any).manifest).map((m: any) => m.hash)) : [1]).length : 1;
      const complete = opts.completeOn === "first" ? uploads === 1 : opts.completeOn === "never" ? false : uploads === total;
      return complete ? Response.json({ success: true, result: { jwt: DONE } }, { status: opts.status ?? 201 }) : Response.json({ success: true, result: {} }, { status: 202 });
    }
    return Response.json({ success: false, errors: [{ code: 404 }] }, { status: 404 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

test("AU1. the hash rule is Cloudflare's: sha256(base64(content) + extension).hex[0:32], isolated in one function", async () => {
  assert.equal(extensionOf("index.html"), "html");
  assert.equal(extensionOf("assets/app.min.js"), "js");
  assert.equal(extensionOf(".nojekyll"), "");
  assert.equal(extensionOf("dir.d/README"), "");
  const bytes = new TextEncoder().encode("hello");
  assert.equal(await assetHash(toBase64(bytes), "a/b.txt"), reference(bytes, "b.txt"));
  assert.match(await assetHash(toBase64(bytes), "a/b.txt"), /^[0-9a-f]{32}$/);
  assert.notEqual(await assetHash(toBase64(bytes), "b.txt"), await assetHash(toBase64(bytes), "b.css"), "the extension is part of the hash");
  const big = new Uint8Array(200_000).map((_, i) => i % 251);
  assert.equal(toBase64(big), Buffer.from(big).toString("base64"), "chunked base64 equals Node's");
});

test("AU2. the manifest: /<path> -> {hash, size}; paths, sizes, counts and content types are checked", async () => {
  const p = await buildAssetsManifest(FILES);
  assert.deepEqual(Object.keys(p.manifest), ["/assets/app-1a2b.js", "/assets/logo.svg", "/index.html"]);
  assert.deepEqual(p.manifest["/assets/logo.svg"], { hash: reference(FILES["assets/logo.svg"].bytes!, "logo.svg"), size: 8 });
  assert.equal(p.manifest["/index.html"].size, new TextEncoder().encode(FILES["index.html"].text!).length);
  for (const [files, err] of [
    [{}, /assets_empty/],
    [{ "../x.html": FILES["index.html"] }, /asset_path_invalid/],
    [{ "a/./b.js": FILES["index.html"] }, /asset_path_invalid/],
    [{ "/abs.js": FILES["index.html"] }, /asset_path_invalid/],
    [{ "a\\b.js": FILES["index.html"] }, /asset_path_invalid/],
    [{ "x.js": { contentType: "text/javascript" } }, /asset_content_missing/],
    [{ "x.js": { text: "1", contentType: "not a type" } }, /asset_content_type_invalid/],
    [{ "x.bin": { bytes: new Uint8Array(25 * 1024 * 1024 + 1), contentType: "application/octet-stream" } }, /asset_too_large/],
  ] as Array<[AssetFileMap, RegExp]>) await assert.rejects(buildAssetsManifest(files), err);
  const many: AssetFileMap = {};
  for (let i = 0; i <= 20_000; i++) many[`f${i}.txt`] = { text: "", contentType: "text/plain" };
  await assert.rejects(buildAssetsManifest(many), /assets_too_many_files/);
  // The same content under the same extension is one hash, uploaded once.
  const dup = await buildAssetsManifest({ "a.js": { text: "x", contentType: "text/javascript" }, "b/a.js": { text: "x", contentType: "text/javascript" } });
  assert.equal(dup.byHash.size, 1);
});

test("AU3. a full upload: session with the API token, buckets with the session JWT only, completion JWT returned", async () => {
  const api = fakeApi({ buckets: (h) => [[h[0], h[1]], [h[2]]] });
  const up = new AssetsUploader(TOKEN, ACCOUNT, api.fetchImpl);
  const r = await up.upload("cryptophys-console", FILES);
  assert.deepEqual([r.jwt, r.uploaded, r.buckets], [DONE, 3, 2]);
  const [session, b1, b2] = api.seen;
  assert.equal(session.auth, `Bearer ${TOKEN}`);
  assert.equal(session.method, "POST");
  assert.deepEqual(Object.keys((session.body as any).manifest).sort(), ["/assets/app-1a2b.js", "/assets/logo.svg", "/index.html"]);
  for (const b of [b1, b2]) {
    assert.equal(b.auth, `Bearer ${SESSION}`, "uploads carry the session JWT");
    assert.ok(!JSON.stringify(b).includes(TOKEN), "the API token never goes to the upload endpoint");
  }
  const logoHash = (session.body as any).manifest["/assets/logo.svg"].hash;
  const part = [...b1.parts!, ...b2.parts!].find((p) => p.name === logoHash)!;
  assert.deepEqual([part.type, part.value, part.filename], ["image/svg+xml", Buffer.from(FILES["assets/logo.svg"].bytes!).toString("base64"), logoHash]);
  assert.deepEqual(assetsMetadata(r.jwt, { not_found_handling: "single-page-application", run_worker_first: true }), { jwt: DONE, config: { not_found_handling: "single-page-application", run_worker_first: true } });
  assert.throws(() => assetsMetadata("not-a-jwt", {}), /assets_jwt_invalid/);
});

test("AU4. nothing to upload: the session JWT is the completion token", async () => {
  const api = fakeApi({ buckets: () => [] });
  const r = await new AssetsUploader(TOKEN, ACCOUNT, api.fetchImpl).upload("cryptophys-console", FILES);
  assert.deepEqual([r.jwt, r.uploaded, api.seen.length], [SESSION, 0, 1]);
});

test("AU5. fail closed: unknown or repeated hashes, a missing, early or non-201 completion, API errors", async () => {
  const run = (opts: Parameters<typeof fakeApi>[0]) => new AssetsUploader(TOKEN, ACCOUNT, fakeApi(opts).fetchImpl).upload("cryptophys-console", FILES);
  await assert.rejects(run({ buckets: (h) => [[...h, "f".repeat(32)]] }), /assets_unknown_bucket_hash/, "a hash rule disagreeing with Cloudflare's shows here");
  await assert.rejects(run({ buckets: (h) => [[h[0]], [h[0]]] }), /assets_duplicate_bucket_hash/);
  await assert.rejects(run({ buckets: (h) => [[h[0]], [h[1], h[2]]], completeOn: "never" }), /assets_no_completion_token/);
  await assert.rejects(run({ buckets: (h) => [[h[0]], [h[1], h[2]]], completeOn: "first" }), /assets_completion_before_last_bucket/);
  await assert.rejects(run({ status: 200 }), /assets_completion_unreadable/);
  await assert.rejects(new AssetsUploader(TOKEN, ACCOUNT, fakeApi().fetchImpl).upload("Bad Name", FILES), /invalid_script_name/);
  const failing = (async () => Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(new AssetsUploader(TOKEN, ACCOUNT, failing).upload("cryptophys-console", FILES), /cloudflare_api_403_10007/);
  const badSession = (async () => Response.json({ success: true, result: { jwt: SESSION, buckets: [["not-hex"]] } })) as unknown as typeof fetch;
  await assert.rejects(new AssetsUploader(TOKEN, ACCOUNT, badSession).upload("cryptophys-console", FILES), /assets_session_unreadable/);
  assert.throws(() => new AssetsUploader(TOKEN, "acct", fakeApi().fetchImpl), /invalid_account_id/);
});

test("AU6. the Forge's stored dist reads back into a file map, every file checked against its SHA-256 and size", async () => {
  const commit = "b".repeat(40);
  const enc = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  const entries = [];
  for (const [path, f] of Object.entries(FILES)) {
    const bytes = f.bytes ?? enc.encode(f.text!);
    store.set(`bundles/${commit}/console-dist/${path}`, bytes);
    entries.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, content_type: f.contentType });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const list = { schema: CONSOLE_DIST_SCHEMA, commit, stored_at: "2026-11-12T00:00:00.000Z", total_bytes: entries.reduce((n, e) => n + e.size, 0), files: entries };
  store.set(`bundles/${commit}/console-dist.json`, enc.encode(JSON.stringify(list)));
  const bucket = { get: async (k: string) => { const v = store.get(k); return v ? { text: async () => new TextDecoder().decode(v), arrayBuffer: async () => v.slice().buffer } : null; } };
  const files = await readConsoleDist(bucket, commit);
  assert.deepEqual(Object.keys(files).sort(), Object.keys(FILES).sort());
  assert.deepEqual([...files["assets/logo.svg"].bytes!], [...FILES["assets/logo.svg"].bytes!]);
  assert.deepEqual((await buildAssetsManifest(files)).manifest, (await buildAssetsManifest(FILES)).manifest);
  store.set(`bundles/${commit}/console-dist/index.html`, enc.encode("tampered"));
  await assert.rejects(readConsoleDist(bucket, commit), /console_dist_hash_mismatch/);
  await assert.rejects(readConsoleDist(bucket, "c".repeat(40)), /console_dist_missing/);
  await assert.rejects(readConsoleDist(bucket, "nope"), /invalid_commit_sha/);
  assert.equal(parseConsoleDistList(JSON.stringify({ ...list, total_bytes: 1 }), commit), null);
  assert.equal(parseConsoleDistList(JSON.stringify({ ...list, files: [{ ...entries[0], path: "../x" }] }), commit), null);
  assert.equal(parseConsoleDistList(JSON.stringify(list), "c".repeat(40)), null, "the list names its own commit");
});
