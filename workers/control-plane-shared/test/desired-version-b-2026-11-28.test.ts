// desired_version option B (the coordinator, 2026-11-28; option A's observation as the second source): an external
// organ's desired version is proposed only when its DNA's deploy_commit (Forge census) and its health version.tag
// (Drift Detector) agree. Drift reads the tag from HTTP /health and the health RPC; the census keeps deploy_commit;
// the Supervisor proposes the routine set_desired_version, one per cycle and per organ per 6 hours; external organs
// never get a recovery plan for a version change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { externalVersionTag, probeExternalRpc, probeHttp } from "../../drift-detector/src/index.ts";
import { addExternalOrgans, deployCommitOf } from "../../forge/src/census.ts";
import { EXTERNAL_ORIGINS } from "../src/organism.ts";
import { DESIRED_VERSION_COOLDOWN_MS, nextDesiredVersion, sameCommit, type RegistryState } from "../src/desired-version.ts";

const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const TAG = "0a1b2c3d4e5f";
const FULL = `${TAG}${"9".repeat(28)}`;
const http = (body: unknown, status = 200) => ({ fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) }) as never;

test("DV1. drift reads version.tag (7 to 40 hex) from an external /health body and from the health RPC; anything else is no version", async () => {
  assert.deepEqual(await probeHttp(http({ status: "ok", version: { tag: TAG } }), "/health"), { reachable: true, healthy: true, version_tag: TAG, error: null });
  for (const tag of [undefined, "", "abc", "0A1B2C3D", "not-a-commit", 12345678, `${TAG}${"0".repeat(40)}`]) {
    assert.equal((await probeHttp(http({ status: "ok", version: { tag } }), "/health")).version_tag, null, String(tag));
  }
  assert.equal((await probeHttp(http({ status: "degraded", version: { tag: TAG } }), "/health")).version_tag, null, "an unhealthy answer reports no version");
  assert.equal((await probeHttp(http({ status: "ok", version: { tag: TAG } }), "/")).version_tag, null, "only /health carries a version");
  const rpc = await probeExternalRpc({ health: async () => ({ ok: true, service: "cryptophys-cta", version: { tag: TAG } }) }, "cryptophys-cta");
  assert.deepEqual([rpc.healthy, rpc.version_tag], [true, TAG]);
  assert.equal((await probeExternalRpc({ health: async () => ({ ok: true, service: "cryptophys-cta" }) }, "cryptophys-cta")).version_tag, null);
  assert.equal(externalVersionTag({ version: { tag: FULL } }), FULL);
});

test("DV2. the census keeps an external organ's deploy_commit from its DNA; an invalid one is left out", async () => {
  const organ = (service: string, extra: Record<string, unknown> = {}) => ({
    $schema_version: 1, service, display_name: service, kind: "service", deploy_unit: null, access: false, rollback: false, drift: null, agents: [], engines: [], ...extra,
  });
  const dna = { schema: XAUUSD.schema, organs: [organ("xauusd-ai-trading-assistant", { deploy_commit: TAG }), organ("xauusd-omega", { deploy_commit: "XYZ" }), organ("xauusd-nexus-dashboard")] };
  assert.equal(deployCommitOf(dna, "xauusd-ai-trading-assistant"), TAG);
  assert.equal(deployCommitOf(dna, "xauusd-omega"), null);
  const out = await addExternalOrgans(new Map(), [{ origin: XAUUSD, dna: async () => dna }]);
  assert.deepEqual([...out.deployCommits], [["xauusd-ai-trading-assistant", TAG]]);
  const census = read("workers/forge/src/census.ts");
  assert.match(census, /deployCommits\.has\(d\.service\) \? \{ deploy_commit: deployCommits\.get\(d\.service\) \} : \{\}/, "kept in the census genome next to the organ");
});

test("DV3. a proposal only when both sources agree and the registry differs; never on disagreement, a missing source, or a platform Worker", () => {
  const reg = (o: Partial<RegistryState> = {}): RegistryState => ({ service_id: "xauusd-ai-trading-assistant", status: "registered", desired_version: null, observed_version: TAG, ...o });
  const g = (o: Record<string, unknown> = {}) => [{ service: "xauusd-ai-trading-assistant", origin: "xauusd", deploy_commit: FULL, ...o }];
  assert.deepEqual(nextDesiredVersion(g(), [reg()], new Set()), { service: "xauusd-ai-trading-assistant", version: TAG, deploy_commit: FULL }, "the observed tag, agreeing with the DNA's full commit");
  assert.equal(nextDesiredVersion(g(), [reg({ desired_version: TAG })], new Set()), null, "already recorded");
  assert.equal(nextDesiredVersion(g({ deploy_commit: "fedcba9876" }), [reg()], new Set()), null, "the sources disagree");
  assert.equal(nextDesiredVersion(g({ deploy_commit: undefined }), [reg()], new Set()), null, "no DNA commit");
  assert.equal(nextDesiredVersion(g(), [reg({ observed_version: null })], new Set()), null, "no observed tag");
  assert.equal(nextDesiredVersion(g(), [reg({ status: "disabled" })], new Set()), null, "a disabled organ");
  assert.equal(nextDesiredVersion(g(), [], new Set()), null, "not in the registry");
  assert.equal(nextDesiredVersion([{ service: "cryptophys-ai-kernel", origin: "xauusd", deploy_commit: TAG }], [reg({ service_id: "cryptophys-ai-kernel" })], new Set()), null, "never a platform Worker");
  assert.equal(nextDesiredVersion(g({ origin: undefined }), [reg()], new Set()), null, "an organ main declares is not external");
  assert.equal(nextDesiredVersion(g(), [reg()], new Set(["xauusd-ai-trading-assistant"])), null, "within the 6-hour cooldown");
  assert.equal(DESIRED_VERSION_COOLDOWN_MS, 6 * 3_600_000);
  assert.deepEqual([sameCommit(TAG, FULL), sameCommit(FULL, TAG), sameCommit("0a1b2c3", TAG), sameCommit("0a1b2c", TAG), sameCommit(TAG, "1a1b2c3d4e5f")], [true, true, true, false, false]);
});

test("DV4. wiring: the Supervisor proposes set_desired_version from the newest census and the registry, one per cycle; an external organ's version change gets no recovery plan", () => {
  const sup = read("workers/ai-kernel/src/supervisor.ts");
  assert.match(sup, /SELECT genome FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1/);
  assert.match(sup, /SELECT target FROM consensus_proposals WHERE action = 'set_desired_version' AND created_at >= \?/);
  assert.match(sup, /proposeConsensus\(\{ action: "set_desired_version", target: next\.service, params: \{ version: next\.version \} \}\)/);
  assert.match(sup, /EXTERNAL_SERVICE_IDS\.has\(s\.service_id\) && s\.reasons\.every\(\(r\) => r === "version_mismatch" \|\| r === "observed_version_unavailable"\)/);
  const ssot = read("docs/SSOT.md");
  assert.ok(ssot.includes("- **External desired versions** (option B, 2026-11-28"));
});
