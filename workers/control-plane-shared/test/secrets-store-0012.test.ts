// ADR-0012 §4, phase 4 backlog: Worker secrets may come from Cloudflare Secrets Store. The entry
// points resolve a `NAME_STORE` binding into `env.NAME`; the Worker secret stays the fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSecrets, secretSources } from "../src/secrets.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const store = (value: string | Error) => ({ get: async () => { if (value instanceof Error) throw value; return value; } });

test("SS1. a store binding wins; the Worker secret is the fallback; without a store binding env is returned as is", async () => {
  const plain = { GH_ACTIONS_TOKEN: "worker-secret", DB: {} };
  assert.equal(await resolveSecrets(plain, ["GH_ACTIONS_TOKEN"]), plain, "nothing to resolve: the same object");
  const both = { GH_ACTIONS_TOKEN: "worker-secret", GH_ACTIONS_TOKEN_STORE: store("from-store"), CF_DEPLOY_TOKEN: "deploy", DB: { id: 1 } };
  const out = await resolveSecrets(both, ["GH_ACTIONS_TOKEN", "CF_DEPLOY_TOKEN"]);
  assert.deepEqual([out.GH_ACTIONS_TOKEN, out.CF_DEPLOY_TOKEN, out.DB], ["from-store", "deploy", both.DB]);
  assert.equal(both.GH_ACTIONS_TOKEN, "worker-secret", "the original env is not changed");
  const onlyStore = await resolveSecrets({ ACCESS_GROUPS_TOKEN_STORE: store("s") } as Record<string, unknown>, ["ACCESS_GROUPS_TOKEN"]);
  assert.equal(onlyStore.ACCESS_GROUPS_TOKEN, "s");
  for (const broken of [store(new Error("store unavailable")), store(""), store("   ")]) {
    const r = await resolveSecrets({ GH_ACTIONS_TOKEN: "worker-secret", GH_ACTIONS_TOKEN_STORE: broken }, ["GH_ACTIONS_TOKEN"]);
    assert.equal(r.GH_ACTIONS_TOKEN, "worker-secret", "a failing or empty store falls back");
  }
  const none = await resolveSecrets({ GH_ACTIONS_TOKEN_STORE: store(new Error("x")) } as Record<string, unknown>, ["GH_ACTIONS_TOKEN"]);
  assert.equal(none.GH_ACTIONS_TOKEN, undefined, "no value from anywhere stays missing");
});

test("SS2. sources are reported without values", () => {
  assert.deepEqual(secretSources({ A: "x", B_STORE: store("y"), C: "" }, ["A", "B", "C"]), { A: "worker_secret", B: "secrets_store", C: "missing" });
});

test("SS3. wiring: every Orchestrator and Registry entry point resolves its secrets; secrets.ts is an owner-only path in the Forge", () => {
  const orch = read("workers/deployment-orchestrator/src/worker.ts");
  assert.match(orch, /STORE_SECRETS = \["GH_ACTIONS_TOKEN", "CF_DEPLOY_TOKEN"\]/);
  assert.match(orch, /return worker\.fetch\(request, await resolved\(env\)\)/);
  assert.match(orch, /return worker\.scheduled\(event, await resolved\(env\), ctx\)/);
  const rpc = orch.slice(orch.indexOf("export class DeployRpc"), orch.indexOf("export class VoteRpc"));
  assert.doesNotMatch(rpc.replace(/await resolved\(this\.env\)/g, ""), /this\.env/, "every DeployRpc method resolves its secrets");
  const reg = read("workers/platform-registry/src/worker.ts");
  assert.match(reg, /STORE_SECRETS = \["ACCESS_GROUPS_TOKEN"\]/);
  assert.match(reg, /return worker\.fetch\(request, await resolved\(env\)\)/);
  assert.match(reg, /applyConsensus\(await resolved\(this\.env\)/);
  assert.match(read("workers/control-plane-shared/src/guard-paths.ts"), /secrets\\\.ts\$\/, "secrets"/);
});
