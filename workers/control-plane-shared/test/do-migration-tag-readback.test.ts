// 2026-11-18 incident (dep_01b18773, control-plane at bf94be1): the kernel's Durable Object migration v8→v9 went live,
// but the migration tag read right after still said v8, so the native deploy failed and tried a restore that Cloudflare
// refuses across a DO migration. deployWithDoMigration now reads the tag again a few times before it calls the migration
// not applied; a tag that never arrives still fails, with the tag it last read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATION_TAG_ATTEMPTS, deployWithDoMigration, type TopologyPlan } from "../../deployment-orchestrator/src/topology.ts";

function fakeCf(tags: (string | null)[]) {
  const calls = { deploy: 0, tag: 0 };
  const cf = {
    async deployScript() { calls.deploy++; },
    async active() { return [{ version_id: "ver-new", percentage: 100 }]; },
    async migrationTag() { const t = tags[Math.min(calls.tag, tags.length - 1)]; calls.tag++; return t; },
  };
  return { cf: cf as never, calls };
}
const plan = { migration: { old_tag: "v8", new_tag: "v9", steps: [{ new_sqlite_classes: ["ConsoleHub"] }] }, scriptSettings: undefined } as unknown as TopologyPlan;
const upload = { module: "index.js", text: "export default {}", metadata: {} as never, extra: [] };
const captured = [{ version_id: "ver-old", percentage: 100 }] as never;

test("DT1. a migration tag that lags the deployment is read again until it is the new tag", async () => {
  const { cf, calls } = fakeCf(["v8", "v8", "v9"]);
  assert.equal(await deployWithDoMigration(cf, "cryptophys-ai-kernel", upload, plan, captured, { delayMs: 0 }), "ver-new");
  assert.deepEqual(calls, { deploy: 1, tag: 3 }, "one upload, the tag read three times");
});

test("DT2. a tag that never becomes the new one still fails, after MIGRATION_TAG_ATTEMPTS reads, naming the tag read", async () => {
  const { cf, calls } = fakeCf(["v8"]);
  await assert.rejects(deployWithDoMigration(cf, "cryptophys-ai-kernel", upload, plan, captured, { delayMs: 0 }), /do_migration_tag_not_applied: v8/);
  assert.equal(calls.tag, MIGRATION_TAG_ATTEMPTS);
  assert.ok(MIGRATION_TAG_ATTEMPTS >= 5 && MIGRATION_TAG_ATTEMPTS <= 10, "a bounded wait, about 14 s at the default delay");
});

test("DT3. a tag already right on the first read costs one read, as before", async () => {
  const { cf, calls } = fakeCf(["v9"]);
  assert.equal(await deployWithDoMigration(cf, "cryptophys-ai-kernel", upload, plan, captured, { delayMs: 0 }), "ver-new");
  assert.equal(calls.tag, 1);
});
