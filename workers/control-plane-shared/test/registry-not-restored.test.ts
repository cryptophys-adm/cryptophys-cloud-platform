// Owner 2026-11-19 (after dep_01b18773, 2026-11-18 21:57): a failed native deploy left the AI Kernel, the Drift Detector
// and the Policy Engine on its commit while the registry kept the old tag, so every later plan compared the target with
// a version that no longer ran. The Registry now records the commit for the Workers a failed native deploy names as
// not restored, under the same request checks as recordNativeDeploy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { recordNotRestored } from "../../platform-registry/src/index.ts";

const NEW = "ab".repeat(20);
const id = (k: number) => `dep_${String(k).repeat(8)}-1111-4111-8111-111111111111`;

test("NR1. the Registry records the commit only for named Workers of a running native deploy's unit", async () => {
  const db = migratedDb();
  const insert = (k: number, status: string, details: object, version = NEW, created = new Date().toISOString(), service = "cryptophys-policy-engine") => db.raw.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, ?, 'x', ?, NULL, ?, ?, ?, ?)`).run(id(k), service, version, status, id(k), JSON.stringify(details), created, created);
  insert(1, "running", { executor: "native:rollback" });
  insert(2, "failed", { executor: "native:deploy" });
  insert(3, "running", { executor: "native:deploy" }, NEW, new Date(Date.now() - 2 * 3_600_000).toISOString());
  insert(6, "running", { executor: "native:deploy" });
  const reg = { DB: db } as never;
  const before = (s: string) => (db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(s) as any)?.desired_version;
  const forge = before("cryptophys-forge");
  await assert.rejects(recordNotRestored(reg, "dep_bad", ["cryptophys-ai-kernel"]), /invalid_request_id/);
  await assert.rejects(recordNotRestored(reg, id(9), ["cryptophys-ai-kernel"]), /deploy_request_not_found/);
  await assert.rejects(recordNotRestored(reg, id(1), ["cryptophys-ai-kernel"]), /not_a_native_deploy/);
  await assert.rejects(recordNotRestored(reg, id(2), ["cryptophys-ai-kernel"]), /deploy_not_running/);
  await assert.rejects(recordNotRestored(reg, id(3), ["cryptophys-ai-kernel"]), /deploy_request_expired/);
  await assert.rejects(recordNotRestored(reg, id(6), []), /invalid_services/);
  await assert.rejects(recordNotRestored(reg, id(6), ["cryptophys-forge"]), /invalid_services/, "not a Worker of the unit");
  await assert.rejects(recordNotRestored(reg, id(6), ["cryptophys-ai-kernel", "cryptophys-ai-kernel"]), /invalid_services/);
  const kernelBefore = before("cryptophys-ai-kernel");
  const auditBefore = before("cryptophys-audit-ledger");
  assert.deepEqual(await recordNotRestored(reg, id(6), ["cryptophys-ai-kernel", "cryptophys-drift-detector"]),
    { desired_version: NEW.slice(0, 12), services: ["cryptophys-ai-kernel", "cryptophys-drift-detector"] });
  assert.equal(before("cryptophys-ai-kernel"), NEW.slice(0, 12));
  assert.equal(before("cryptophys-drift-detector"), NEW.slice(0, 12));
  assert.equal(before("cryptophys-audit-ledger"), auditBefore, "a Worker not named keeps its record");
  assert.equal(before("cryptophys-forge"), forge);
  const sets = db.raw.prepare("SELECT subject, actor, payload_json FROM audit_events WHERE event_type = 'registry.desired_version_set'").all() as any[];
  assert.deepEqual(sets.map((s) => [s.subject, s.actor]), [["cryptophys-ai-kernel", `native-deploy-not-restored:${id(6)}`], ["cryptophys-drift-detector", `native-deploy-not-restored:${id(6)}`]]);
  assert.deepEqual(JSON.parse(sets[0].payload_json), { previous: kernelBefore, desired_version: NEW.slice(0, 12), reason: "not_restored" });
});

test("NR2. wiring: the Registry's RPC exposes recordNotRestored and the native deploy calls it after the restores", () => {
  const root = new URL("../../../", import.meta.url);
  assert.match(readFileSync(new URL("workers/platform-registry/src/worker.ts", root), "utf8"), /async recordNotRestored\(requestId: string, services: string\[\]\)/);
  const nd = readFileSync(new URL("workers/deployment-orchestrator/src/native-deploy.ts", root), "utf8");
  assert.ok(nd.indexOf("const notRestored: string[] = []") < nd.indexOf("env.REGISTRY.recordNotRestored(requestId, live)"));
});
