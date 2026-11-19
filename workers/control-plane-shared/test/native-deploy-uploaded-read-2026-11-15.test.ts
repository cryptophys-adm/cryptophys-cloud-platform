// 2026-11-15: the control-plane deploy of d300ee1 failed on reading cryptophys-platform-registry's just-uploaded
// version (cloudflare_api_404_100146) and restored the services already moved. A 404 on that read is read again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UPLOADED_READ_ATTEMPTS, readUploaded } from "../../deployment-orchestrator/src/native-deploy.ts";

test("UR1. a 404 on the uploaded version is read again; the first answer wins", async () => {
  let calls = 0;
  const v = await readUploaded(async () => { calls++; if (calls < 3) throw new Error("cloudflare_api_404_100146"); return "ok"; }, 0);
  assert.equal(v, "ok");
  assert.equal(calls, 3);
});

test("UR2. a 404 that persists fails after UPLOADED_READ_ATTEMPTS reads, with the original error", async () => {
  let calls = 0;
  await assert.rejects(readUploaded(async () => { calls++; throw new Error("cloudflare_api_404_100146"); }, 0), /cloudflare_api_404_100146/);
  assert.equal(calls, UPLOADED_READ_ATTEMPTS);
});

test("UR3. any other failure is not retried", async () => {
  for (const msg of ["cloudflare_api_403_10000", "cloudflare_api_500_error", "planned_bindings_differ: x", "cloudflare_api_4040_1"]) {
    let calls = 0;
    await assert.rejects(readUploaded(async () => { calls++; throw new Error(msg); }, 0));
    assert.equal(calls, 1, msg);
  }
});

test("UR4. both reads of the just-uploaded version go through readUploaded, before anything is deployed", () => {
  const src = readFileSync(new URL("../../deployment-orchestrator/src/native-deploy.ts", import.meta.url), "utf8");
  assert.match(src, /readUploaded\(\(\) => cf\.version\(service, versionId\)/);
  assert.match(src, /readUploaded\(\(\) => cf\.versionBindingSet\(service, versionId\)/);
  assert.ok(src.indexOf("readUploaded(() => cf.version(service, versionId)") < src.indexOf("await cf.deploy(service"), "read before deploy");
});
