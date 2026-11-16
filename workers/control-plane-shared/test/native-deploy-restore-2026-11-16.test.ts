// 2026-11-16: the control-plane deploy of 6f3b831 moved five Workers, then failed on reading cryptophys-ai-kernel's
// just-uploaded version (cloudflare_api_404_100146) after four reads 2 s apart. Its restore reported only two Workers
// restored and `restored: false`: a Worker whose restore failed left no step and no reason. The reads now back off,
// and every failed restore is a step with its reason and a name in `not_restored`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  executeNativeDeploy, readUploaded, UPLOADED_READ_ATTEMPTS, UPLOADED_READ_BUDGET_MS, UPLOADED_READ_DELAYS_MS, type BundleWorker, type PlannedService,
} from "../../deployment-orchestrator/src/native-deploy.ts";
import { VERIFY_ATTEMPTS, VERIFY_DELAY_MS } from "../../deployment-orchestrator/src/native-rollback.ts";
import { unitForService } from "../src/deploy-units.ts";

const SERVICES = [...unitForService("cryptophys-policy-engine")!.services];
const KERNEL = "cryptophys-ai-kernel";
const COMMIT = "6f".repeat(20);
const TAG = COMMIT.slice(0, 12);
const OLD_TAG = "f293457aaaaa";
const NOT_FOUND = "cloudflare_api_404_100146";

const hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const moduleText = (name: string) => `export default { fetch() { return new Response("${name} ${TAG}"); } };`;

async function planFor(): Promise<PlannedService[]> {
  const plan: PlannedService[] = [];
  for (const name of SERVICES) {
    const text = moduleText(name);
    const worker: BundleWorker = {
      name, module: `${name}.mjs`, main_module: `${name}.mjs`, sha256: await hex(text), bytes: new TextEncoder().encode(text).length, config_sha256: "c".repeat(64),
      compatibility_date: "2026-11-01", compatibility_flags: [], single_module: true, assets: false, external: [], limits: false, modules: null, config: null,
    };
    plan.push({ service: name, worker, running_tag: OLD_TAG });
  }
  return plan;
}

/** A fake Workers API: `notFound(service, read)` makes the read-back of a just-uploaded version answer 404. */
function fakeCloudflare(o: { notFound?: (service: string, read: number) => boolean; restore?: (service: string) => "throw" | "stale" | null } = {}) {
  let v = 0;
  const uuid = () => `${String(++v).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const tags = new Map<string, string>();
  const active = new Map<string, { version_id: string; percentage: number }[]>();
  for (const s of SERVICES) { const id = uuid(); tags.set(id, OLD_TAG); active.set(s, [{ version_id: id, percentage: 100 }]); }
  const captured = new Map([...active].map(([s, d]) => [s, structuredClone(d)]));
  const reads = new Map<string, number>();
  const deployments: string[] = [];
  const cf = {
    async active(s: string) { return structuredClone(active.get(s)!); },
    async versionBindingSet(s: string, id: string) {
      const n = (reads.get(s) ?? 0) + 1;
      if (id !== captured.get(s)![0].version_id) {
        reads.set(s, n);
        if (o.notFound?.(s, n)) throw new Error(NOT_FOUND);
      }
      return { names: ["d1:DB"], digest: "d" };
    },
    async uploadVersion(s: string, _module: string, _text: string, metadata: { tag: string }) { const id = uuid(); tags.set(id, metadata.tag); void s; return id; },
    async deploy(s: string, versions: { version_id: string; percentage: number }[], message: string) {
      const restoring = message.includes("restoring");
      const r = restoring ? o.restore?.(s) ?? null : null;
      if (r === "throw") throw new Error("cloudflare_api_500_10013");
      deployments.push(`${restoring ? "restore" : "deploy"} ${s}`);
      if (r !== "stale") active.set(s, structuredClone(versions));
    },
  };
  const env = {
    DRIFT: { probeService: async (s: string) => ({ reachable: true, healthy: true, version_tag: tags.get(active.get(s)![0].version_id)!, error: null }) },
    REGISTRY: { recordRollback: async () => undefined, recordNativeDeploy: async () => undefined },
    BUNDLES: {
      async get(key: string) { const name = SERVICES.find((s) => key === `bundles/${COMMIT}/${s}.mjs`); return name ? { text: async () => moduleText(name) } : null; },
      async list() { return { objects: [], truncated: false }; },
    },
  };
  return { cf, env, reads, deployments, active, captured };
}

const run = async (f: ReturnType<typeof fakeCloudflare>) =>
  executeNativeDeploy(f.cf as never, f.env as never, "dep_75107ff6-51ae-479a-b2ca-6970bbaeae29", COMMIT, await planFor(), { delayMs: 0 });

test("RB1. the read-after-upload backs off over 8 reads (63 s at most), a run shares 126 s, inside the cron invocation's 15 minutes", () => {
  assert.equal(UPLOADED_READ_ATTEMPTS, 8);
  assert.deepEqual([...UPLOADED_READ_DELAYS_MS], [2_000, 3_000, 5_000, 8_000, 10_000, 15_000, 20_000]);
  assert.equal(UPLOADED_READ_DELAYS_MS.reduce((a, b) => a + b, 0), 63_000);
  assert.equal(UPLOADED_READ_BUDGET_MS, 2 * 63_000);
  // Worst case of a whole control-plane run: every read wait it may take, and every live check at its last attempt.
  const worst = UPLOADED_READ_BUDGET_MS + SERVICES.length * (VERIFY_ATTEMPTS - 1) * VERIFY_DELAY_MS;
  assert.ok(worst <= 8 * 60_000, `${worst} ms of waits leaves room for the API calls in a 15-minute invocation`);
});

test("RB2. a run's reads share the budget: a 404 is not read again once the next wait would exceed it", async () => {
  let calls = 0;
  const budget = { waitedMs: UPLOADED_READ_BUDGET_MS - 6_000 };
  await assert.rejects(readUploaded(async () => { calls++; throw new Error(NOT_FOUND); }, 0, budget), new RegExp(NOT_FOUND));
  assert.equal(calls, 3, "waits of 2 s and 3 s fit, the 5 s one does not");
  assert.equal(budget.waitedMs, UPLOADED_READ_BUDGET_MS - 1_000);
});

test("RB3. 404 on the first 6 reads of the kernel's new version, then the version: the deploy succeeds", async () => {
  const f = fakeCloudflare({ notFound: (s, n) => s === KERNEL && n <= 6 });
  const r = await run(f);
  assert.equal(r.ok, true, r.reason);
  assert.equal(f.reads.get(KERNEL), 7);
  for (const s of SERVICES) assert.equal(f.active.get(s)![0].version_id, r.versions[s], `${s} runs the new version`);
  assert.ok(r.steps.includes("desired_recorded"));
});

test("RB4. 404 on all 8 reads: the deploy fails before the kernel moves and restores ALL five changed Workers, newest first", async () => {
  const f = fakeCloudflare({ notFound: (s) => s === KERNEL });
  const r = await run(f);
  assert.deepEqual([r.ok, r.reason, r.service, r.restored, r.production_changed], [false, NOT_FOUND, KERNEL, true, true]);
  assert.equal(f.reads.get(KERNEL), UPLOADED_READ_ATTEMPTS);
  assert.ok(!f.deployments.includes(`deploy ${KERNEL}`), "the kernel never got traffic");
  const moved = SERVICES.filter((s) => s !== KERNEL);
  assert.deepEqual(f.deployments.filter((d) => d.startsWith("restore")), [...moved].reverse().map((s) => `restore ${s}`));
  assert.deepEqual(r.steps.filter((x) => x.endsWith(":restored")), [...moved].reverse().map((s) => `${s}:restored`));
  for (const s of SERVICES) assert.deepEqual(f.active.get(s), f.captured.get(s), `${s} runs its captured deployment`);
  assert.equal(r.not_restored, undefined);
});

test("RB5. a restore that fails on one Worker does not stop the others; the outcome names the Worker not restored and why", async () => {
  for (const [mode, why] of [["throw", "cloudflare_api_500_10013"], ["stale", "active_not_captured"]] as const) {
    const f = fakeCloudflare({ notFound: (s) => s === KERNEL, restore: (s) => s === "cryptophys-platform-registry" ? mode : null });
    const r = await run(f);
    assert.deepEqual([r.ok, r.restored, r.production_changed], [false, false, true], mode);
    assert.deepEqual(r.not_restored, ["cryptophys-platform-registry"], mode);
    assert.ok(r.steps.includes(`cryptophys-platform-registry:restore_failed:${why}`), mode);
    // Restored after the failure, in reverse order: the registry's failure stopped nothing.
    assert.deepEqual(r.steps.filter((x) => /:restored$|:restore_failed:/.test(x)), [
      "cryptophys-drift-detector:restored", "cryptophys-recovery-manager:restored", `cryptophys-platform-registry:restore_failed:${why}`,
      "cryptophys-audit-ledger:restored", "cryptophys-policy-engine:restored",
    ], mode);
    for (const s of ["cryptophys-policy-engine", "cryptophys-audit-ledger", "cryptophys-recovery-manager", "cryptophys-drift-detector"]) {
      assert.deepEqual(f.active.get(s), f.captured.get(s), `${mode}: ${s} restored`);
    }
    assert.notDeepEqual(f.active.get("cryptophys-platform-registry"), f.captured.get("cryptophys-platform-registry"), `${mode}: the registry still runs the new version`);
  }
});

test("RB6. the critical report of a failed native deploy carries not_restored", () => {
  const src = readFileSync(new URL("../../deployment-orchestrator/src/index.ts", import.meta.url), "utf8");
  const report = src.slice(src.indexOf('kind: "platform_digest", severity: "critical"'));
  assert.match(report.slice(0, 1200), /\.\.\.\(run\.not_restored\?\.length \? \{ not_restored: run\.not_restored \} : \{\}\)/);
});
